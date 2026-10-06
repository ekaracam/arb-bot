/**
 * Arbitraj tarayıcısı — iki aşamalı.
 *
 * AŞAMA 1 (ucuz, sık): Her ~50ms'de yalnızca fiyatı DEĞİŞMİŞ çiftler taranır
 * (PriceStore.flushDirty). Her çift için tüm borsalardaki en iyi alış ve en
 * iyi satış bulunur ve L1 üzerinden kaba bir kâr tahmini yapılır. Bu adım
 * tamamen bellekte, allocation'sız ve mikrosaniyeler mertebesinde.
 *
 * AŞAMA 2 (pahalı, seyrek): Ön-eşiği geçen az sayıda aday için L2 derinlik
 * çekilir, gerçek VWAP hesaplanır, komisyon + çekim ücreti + transfer durumu
 * uygulanır. Ancak buradan geçen bir şey "fırsat" sayılır.
 *
 * Bu ayrım olmasa ya her tick'te REST çağrısı yapıp rate-limit yerdik ya da
 * ham spread'e bakıp gerçekleşmeyecek sinyaller üretirdik.
 */

import type {
  AppConfig,
} from '../core/config.ts';
import {
  DEX_CHAIN,
  isCex,
  isDex,
  type CexId,
  type ChainId,
  type DexId,
  type Leg,
  type Opportunity,
  type OpportunityKind,
  type PairKey,
  type VenueId,
} from '../core/types.ts';
import type { PriceStore } from '../book/price-store.ts';
import type { DepthCache } from '../book/depth-cache.ts';
import type { SymbolRegistry } from '../normalize/symbol-registry.ts';
import { TRANSFER_TABLE_STALE_MS, type TransferInfoProvider } from './transfer-info.ts';
import { buyWithQuote, sellBase, l1Fill, type FillResult } from './vwap.ts';
import type { DexLegQuoter } from '../feeds/dex/leg-quoter.ts';
import type { CaprazKontrol, CaprazSonuc } from '../feeds/dex/capraz.ts';
import { Deduper } from '../notify/dedup.ts';

/**
 * Bir fırsat bu süreden uzun süredir aynı şekilde duruyorsa şüphelidir.
 *
 * Canlı testte gözlenen davranış: PYBOBO/USDT'de mexc→kucoin yönünde %11 net
 * kâr 75 saniye boyunca RAKAMI HİÇ DEĞİŞMEDEN durdu. Gerçek bir arbitraj
 * fırsatı bu kadar yaşamaz — piyasa onu saniyeler içinde kapatır. Kapanmıyorsa
 * kârlı olduğu için değil, ULAŞILAMAZ olduğu için oradadır: çekim kapalı,
 * coin delist sürecinde veya defter hayalet emirlerle dolu.
 */
const SUSPICIOUS_PERSISTENCE_MS = 45_000;

/**
 * Bu net kârın üstü gerçek sayılmaz.
 *
 * Kalibrasyon raporundaki eşikle AYNI olmalı (`scripts/calibrate.ts`) — rapor
 * "veri hatası" dediği bir sinyali motor sessizce onaylıyorsa iki katman
 * birbiriyle çelişir ve hangisine güveneceğimiz belirsizleşir.
 */
const IMPLAUSIBLE_NET_PCT = 0.20;

/** Teşhis tablosunun üst sınırı — araç bellek sızdırmamalı. */
const NET_KAYIT_MAX = 500;

/**
 * Aşama 1'de kuyruğa alınacak azami HAM fark.
 *
 * ÖLÇÜLEN GEREKÇE: kuyruk ham farka göre sıralanıyor ve bozuk fiyatların ham
 * farkı her zaman gerçek fırsatlarınkinden büyük — dolayısıyla tepeyi HER
 * ZAMAN onlar işgal ediyor. 7 dakikalık ölçümde kâr hesabına ulaşan 12 çiftin
 * 12'si de bozuk bir kaynaktan geliyordu ve net oranları %-17 ile %-99.95
 * arasındaydı (`FIGHT|jupiter->raydium ×53 @ %-87.71`,
 * `ANTFUN|raydium->kucoin ×22 @ %-99.95`). Yani doğrulama bütçesinin TAMAMI,
 * yapısal olarak sinyale dönüşemeyecek adaylara gidiyordu.
 *
 * %20 üstü bir HAM fark neredeyse her zaman veri hatasıdır: ticker çakışması
 * (aynı sembol, farklı varlık), ölü defter, ya da tek havuzun bozuk orta
 * fiyatı. Motor bunu NET için zaten kabul ediyor (`IMPLAUSIBLE_NET_PCT`) ama
 * orada yalnızca UYARI — çünkü o noktada aday zaten doğrulanmış, maliyeti
 * ödenmiştir. Burada ise eleme doğru olan: doğrulama kapasitesi kıt ve bu
 * adaylar onu tüketiyor.
 *
 * ELEME DEĞİL ÖNCELİK DÜŞÜRME — ve bu ayrım kritik. İlk denemede bu aday
 * `continue` ile kuyruğa hiç alınmıyordu; o sürüm `IMPLAUSIBLE_NET_PCT`
 * uyarısını ULAŞILAMAZ hale getirdi (var olan bir test bunu yakaladı). O uyarı
 * kasten eleme değil: net %20'yi aşan bir sinyal, sebebi bilinmese bile
 * GÖRÜNÜR kalmalı — ölçülmüş RWA %77.8 vakasının dersi bu.
 *
 * Sorun zaten adayın doğrulanması değildi, DİĞERLERİNİ AÇ BIRAKMASIYDI: kuyruk
 * ham farka göre sıralı olduğu için bozuk fiyat tepeyi hep işgal ediyor.
 * Önceliği dibe çekmek ikisini birden çözüyor — kapasite varsa doğrulanır ve
 * uyarısıyla yayınlanır, kapasite yoksa ilk atılan o olur.
 */
const IMPLAUSIBLE_RAW_PCT = 0.20;

/**
 * Aşama 2'de `DexLegQuoter` ile (kotalı HTTP quote) doğrulanan DEX venue'ları —
 * "DEX fiyatı değişmediyse yeniden kuyruk yok" kuralı YALNIZCA bunlara uygulanır.
 *
 * Neden yalnızca bunlar: kural Jupiter `/swap/v1/quote` kotasını korumak için
 * var (ölçüldü: ~39 istek/dk, limit 30/dk). EVM DEX'ler (aerodrome, uniswap-v3,
 * camelot, cow-base) Aşama 2'de quoter'a gitmez — feed'in yazdığı gerçek
 * miktarla değerlenir, yeniden doğrulamanın maliyeti yalnızca CEX derinliğidir.
 * Orada CEX defteri değişince hemen yeniden doğrulamak kota tasarrufundan
 * değerli.
 *
 * Elle yazılı bir liste ama eksik kalmasının yönü güvenli: listede olmayan
 * venue eski davranışa (yalnızca süre soğuması) düşer — fazladan quote, kapsam
 * kaybı değil. `VenueLegQuoter`'a yeni venue eklenirse buraya da eklenmeli.
 */
const QUOTE_ILE_DOGRULANAN: readonly DexId[] = ['jupiter', 'raydium'];

/**
 * Makul olmayan adayın önceliğinden düşülen sabit.
 *
 * Ham farktan çıkarılıyor, sabit bir değere EZİLMİYOR: böylece bu adaylar
 * kendi aralarındaki sıralamayı korur ve hepsi birden eşitlenmiş olmaz.
 * Değerin büyüklüğü, en kötü gerçek adayın bile her zaman üstte kalmasını
 * garanti edecek kadar olmalı.
 */
const ONCELIK_CEZASI = 1_000_000;

/**
 * Aşama 2 quote'unda kabul edilen azami FİYAT ETKİSİ.
 *
 * Bunun üstü, havuzun işlem büyüklüğünü taşımadığı anlamına gelir. Eşik
 * gevşek tutuldu (%5): kâr hesabı zaten etkiyi içeren gerçek miktarla
 * yapılıyor, yani buradaki eleme DOĞRULUK için değil BÜTÇE için — aynı bozuk
 * havuzu her turda yeniden sormayı bırakıyoruz. Daraltmak, yüksek farkı olan
 * gerçek bir fırsatı da eleyebilir; ölçülen ZEUS vakasında etki %250
 * mertebesinde, yani eşiğin yerini tartışmalı yapacak bir yakınlık yok.
 */
const MAX_FIYAT_ETKISI = 0.05;

/**
 * İnce havuz bilgisinin saklanma süresi.
 *
 * ÖLÇÜLEN GEREKÇE: 7 dakikada 440 quote çağrısı ince havuz yüzünden elendi,
 * ama token bazında ölçüldüğünde sorunlu token sayısı ~56. Yani aynı gerçeği
 * defalarca öğreniyorduk. Likidite dakikalar içinde büyük değişmiyor;
 * bir kez öğrenilen bilgi bu süre boyunca geçerli sayılabilir.
 *
 * Kod tabanının kendi deseni: `EvmDexFeed` fiyatlanamayan tokeni 20 tur sonra
 * sorgudan düşürüp 100 turda bir yeniden deniyor. Süre SONLU olmak zorunda —
 * likidite geri gelebilir ve tokenın kalıcı olarak kör kalması, düzeltmenin
 * amacını aşardı.
 */
const INCE_HAVUZ_TTL_MS = 10 * 60_000;

/**
 * `pickChain`'in sonucu — başarısızlıkta GEREKÇESİYLE birlikte.
 *
 * Gerekçe dönüş değerinde taşınıyor çünkü sayacı `pickChain`'in içinde
 * artırmak, çağıran tarafın "rota yok" görüp kendi sayacını da artırmasını
 * engellemiyordu: tek eleme iki kovaya birden yazılıyordu.
 */
type ChainPick =
  | {
      ok: true;
      chain: ChainId;
      withdrawFee: number;
      verified: boolean;
      unverifiedVenues: VenueId[];
    }
  | { ok: false; reason: 'transfer' | 'address' };

/** Aşama 1'in ürettiği ham aday. */
interface Candidate {
  pair: PairKey;
  pairIndex: number;
  buyVenue: VenueId;
  sellVenue: VenueId;
  buySlot: number;
  sellSlot: number;
  rawPct: number;
  /**
   * Kuyruk sırası. Normalde `rawPct`'e eşit; ham farkı makul olmayan adayda
   * ondan çok düşük — böylece hem en son doğrulanır hem ilk atılan o olur.
   */
  oncelik: number;
}

/** Fırsatın hangi mekan tiplerini birleştirdiği. */
function classify(buy: VenueId, sell: VenueId): OpportunityKind {
  if (isCex(buy) && isCex(sell)) return 'cex-cex';
  if (isDex(buy) && isDex(sell)) return 'dex-dex';
  return 'cex-dex';
}

/**
 * DEX quote sonucunu `FillResult`'a çevirir.
 *
 * DEX'te defter yok: quoter zaten slippage dahil gerçekleşecek miktarı verir,
 * dolayısıyla dolum her zaman tamdır. Kayma, geniş taramanın verdiği orta
 * fiyata göre ölçülür — CEX tarafındaki "en iyi fiyata göre kayma" ile aynı
 * anlam ve aynı birim, böylece `Opportunity.slippage` iki mekan tipinde de
 * karşılaştırılabilir kalır.
 */
function dexFill(base: number, quote: number, referans: number, yon: 'buy' | 'sell'): FillResult {
  const vwap = quote / base;
  const ham = referans > 0 ? (yon === 'buy' ? vwap - referans : referans - vwap) / referans : 0;
  return {
    vwap,
    filledBase: base,
    filledQuote: quote,
    complete: true,
    // Negatif kayma (quote'un orta fiyattan İYİ çıkması) kâr değil ölçüm
    // gürültüsüdür; sıfırlanıyor ki rapor yanıltmasın.
    slippage: Math.max(0, ham),
  };
}

export interface ScannerOptions {
  /** Aynı anda kaç aday derinlik doğrulamasından geçsin. */
  readonly maxConcurrentChecks?: number;
  /**
   * Doğrulama kuyruğunun azami boyutu.
   *
   * Kuyruk sınırsız büyürse sıradaki adaylar işlenene kadar fiyatları bayatlar
   * ve REST kotasını hiçbir işe yaramayan doğrulamalara harcarız. Sınıra
   * gelindiğinde en düşük kârlı adaylar atılır — kaybettiğimiz her zaman en
   * değersiz aday olur.
   */
  readonly maxQueueDepth?: number;
}

export type OpportunityHandler = (opp: Opportunity) => void;

export class Scanner {
  private readonly dirtyBuf: number[] = [];
  private readonly venues: VenueId[];
  private readonly handlers: OpportunityHandler[] = [];

  /** Doğrulama aşamasında olan adaylar — aynı çifti tekrar sıraya almayız. */
  private readonly verifying = new Set<string>();
  private inFlight = 0;
  private readonly queue: Candidate[] = [];
  private readonly maxConcurrent: number;

  private timer: NodeJS.Timeout | null = null;

  /**
   * Fırsatların ne kadar süredir açık olduğunu izler. Yayın kararı vermez
   * (o tüketicilerin işi) — yalnızca "bu fırsat şüpheli derecede uzun süredir
   * duruyor" uyarısını üretmek için kullanılır.
   *
   * Kurulumu constructor gövdesinde: `episodeGapMs` config'ten türetiliyor ve
   * alan başlatıcılarının parametre özelliklerine göre çalışma sırası
   * TypeScript hedefine bağlı — `venueMaxAge` ile aynı yolu izliyoruz.
   */
  private readonly tracker: Deduper;
  /** Tracker'ın en son budandığı an. */
  private lastPruneAt = 0;

  // Metrikler
  private evalCount = 0;
  private candidateCount = 0;
  private opportunityCount = 0;
  private rejectedByDepth = 0;
  /** L2 defteri ÇEKİLEMEDİĞİ için elenen bacak — ince defterden ayrı teşhis. */
  private rejectedByDepthFetch = 0;
  private lastDepthFetchError: string | null = null;
  private rejectedByTransfer = 0;
  /** Ham farkı makul olmayan (muhtemel veri hatası) diye önceliği düşürülen aday. */
  private makulDegilAday = 0;
  /** İşlem büyüklüğünü taşımayan havuz yüzünden elenen bacak. */
  private rejectedByImpact = 0;
  private sonInceHavuz: string | null = null;
  /**
   * "Bu slot işlem büyüklüğünü taşımıyor" bilgisinin son kullanma anı.
   *
   * Slot indeksli bir tipli dizi: Aşama 1 hot path'inde Map araması ya da
   * string birleştirme yapılmaz (allocation'sız kalma kuralı).
   */
  private readonly inceHavuzSonu: Float64Array;
  /** Hafızadaki ince havuz yüzünden önceliği düşürülen aday. */
  private inceHavuzOnceliksiz = 0;
  private rejectedByStale = 0;
  /**
   * Kimlik çakışması yüzünden elenen adaylar (aynı ticker, farklı kontrat).
   *
   * `rejectedByTransfer` içine katılmadı: "çekim kapalı" operasyonel bir
   * durumdur ve yarın değişebilir, "farklı token" ise kalıcı bir veri
   * gerçeğidir. Aynı kovaya konsalardı ticker çakışmasının varlığı panelde
   * hiç görünmezdi — bu projede tekrar eden hata sınıfı tam olarak budur.
   */
  private rejectedByAddress = 0;
  private staleVenueSkips = 0;
  private skippedByCooldown = 0;
  /**
   * DEX bacaklı adayın, DEX fiyatı son kuyruğa alınmadan beri YENİDEN
   * YAZILMADIĞI için atlandığı durumlar. Eleme değil erteleme — ayrıntı
   * `evaluate()` içinde.
   */
  private skippedByDexUnchanged = 0;
  private persistentCount = 0;
  private droppedCount = 0;
  private lastEvalDurationUs = 0;
  /** `verify()` içinde yakalanan istisnalar — sessiz kalmamalı. */
  private verifyErrors = 0;
  private lastVerifyError: string | null = null;

  // DEX quote sayaçları.
  //
  // NEDEN AYRI: bu projenin tekrar eden hata sınıfı SESSİZ başarısızlık.
  // `DexQuoter` aylarca yazılıydı ama hiçbir yerden çağrılmıyordu ve her
  // Solana bacağı `rejectedByDepth` ile eleniyordu — panelde hiçbir iz
  // bırakmadan. Tek bir kova ("elendi") "likidite yok" ile "boru hattı
  // bozuk" arasında ayrım yapmadığı için o hatayı göremiyorduk. Üç kova
  // bu ayrımı görünür kılar: `tried=0` bağlantı hiç kurulmadı, `error>0`
  // boru hattı bozuk, `empty>0` rota gerçekten yok.
  /**
   * Kâr hesabına KADAR gelebilen aday sayısı ve görülen EN İYİ net oran.
   *
   * NEDEN VAR: "0 sinyal" tek başına teşhis etmiyor — eşiğin az mı yoksa çok
   * mu altında kaldığımızı söylemiyor, hatta kâr hesabına hiç ulaşılıp
   * ulaşılmadığını bile söylemiyor. Ölçüldü: 4.5 saatlik iki koşuda hiç sinyal
   * çıkmadı ve eşik dörtte birine indirildiğinde de çıkmadı; o noktada elde
   * "elenenler" dışında hiçbir sayı yoktu. `netHesaplanan` boru hattının
   * sonuna kaç adayın vardığını, `enIyiNetPct` oraya varanların ne kadar
   * yaklaştığını söyler — ikisi olmadan eşik ayarı körlemesine yapılır.
   */
  private netHesaplanan = 0;
  private enIyiNetPct = Number.NEGATIVE_INFINITY;

  /**
   * Kâr hesabına ULAŞAN çiftlerin dökümü: "COIN|al->sat" → kaç kez, en iyi net.
   *
   * NEDEN VAR: eşiği geçmeyen aday bugüne kadar hiçbir iz bırakmadan
   * siliniyordu, dolayısıyla "doğrulama bütçesi nereye gidiyor" sorusunun
   * cevabı yoktu. Ölçüm bunu zorunlu kıldı: 5 dakikada 39901 adayın yalnızca
   * 117'si kâr hesabına ulaştı ve görülen en iyi net %-17.6 idi — yani boru
   * hattının sonuna gelen adaylar eşiğin BİRAZ altında değil, yapısal olarak
   * zararda. Hangi çiftlerin bu kapasiteyi yaktığını bilmeden ne eşik ne de
   * ön filtre ayarlanabilir.
   *
   * Tablo sınırlı: teşhis aracı bellek sızdırmamalı.
   */
  private readonly netKayit = new Map<string, { adet: number; enIyi: number }>();

  private dexQuoteTried = 0;
  private dexQuoteOk = 0;
  private dexQuoteEmpty = 0;
  private dexQuoteError = 0;
  private lastDexQuoteError: string | null = null;

  constructor(
    private readonly cfg: AppConfig,
    private readonly store: PriceStore,
    private readonly registry: SymbolRegistry,
    private readonly depth: DepthCache,
    private readonly transfers: TransferInfoProvider,
    venues: readonly VenueId[],
    opts: ScannerOptions = {},
    /**
     * DEX bacağı doğrulayıcısı. Verilmezse Solana bacakları doğrulanamaz ve
     * `rejectedByDepth` ile elenir — bot yine çalışır, yalnızca CEX↔DEX
     * fırsatı üretmez.
     */
    private readonly legQuoter: DexLegQuoter | null = null,
    /**
     * DEX bacağının bağımsız ikinci kaynakla karşılaştırılması (bugün CoW).
     * Verilmezse kontrol yapılmaz — fırsat yine yayınlanır, yalnızca `capraz`
     * alanı boş kalır.
     */
    private readonly capraz: CaprazKontrol | null = null,
  ) {
    this.venues = [...venues];
    this.inceHavuzSonu = new Float64Array(store.pairCount * store.venueCount);
    this.maxConcurrent = opts.maxConcurrentChecks ?? 8;
    this.maxQueue = opts.maxQueueDepth ?? 40;

    // Bayatlık eşiği venue TÜRÜNE göre değişir ve kurulumda hesaplanır:
    // hot path'te tek bir tipli dizi okumasına iner, dallanma ya da Map
    // araması olmaz.
    //
    // Neden farklı: CEX fiyatı WebSocket'ten push edilir (ms mertebesi), DEX
    // fiyatı ise HTTP ile çekilir ve kaynağın dakikalık limiti periyodu
    // belirler — 109 mint GeckoTerminal'de 10 sn'de bir güncelleniyor. Tek
    // eşik kullanınca (3 sn) her DEX okuması bayat sayılıyor ve CEX↔DEX
    // fırsatı YAPISAL OLARAK üretilemiyordu; DEX bacağı sessizce ölü ağırlıktı.
    //
    // Gevşetmek güvenli, çünkü Aşama 1 fiyatı kâr hesabına girmez: yalnızca
    // hangi çiftin doğrulanacağını seçer ve Aşama 2 DEX fiyatını canlı quote
    // ile yeniden alır.
    // Epizot boşluğu: bu kadar süre hiç görülmeyen fırsat KAPANMIŞ sayılır ve
    // yaş sayacı sıfırlanır.
    //
    // Doğrulama soğumasından türetiliyor çünkü açık duran bir fırsatın ne
    // sıklıkta yeniden görülebileceğini o belirliyor: aynı çift
    // `verifyCooldownMs`'den daha sık doğrulanmaz. Beş pencere üst üste
    // ıskalanmışsa fark gerçekten kapanmıştır. Alt sınır 15 sn, çünkü yük
    // altında kuyruk sırası gecikebilir ve kısa boşluk kesintisiz bir farkı
    // yanlışlıkla "yeni epizot" sayıp uyarıyı kaçırırdı.
    //
    // Yön seçimi bilinçli: fazla uzun tutmak sahte "kapanmıyor" uyarısı
    // üretir (düzelttiğimiz hatanın ta kendisi), fazla kısa tutmak gerçek
    // uyarıyı kaçırır. 15 sn ile 45 sn'lik eşiğe ulaşmak için farkın en az
    // üç kez üst üste görülmesi gerekiyor.
    this.tracker = new Deduper({
      cooldownMs: 0,
      improveDeltaPct: 0,
      episodeGapMs: Math.max(5 * cfg.scan.verifyCooldownMs, 15_000),
    });

    // DEX tarafının kimlik tablosu — "SYMBOL|chain" → adres. Kurulumda bir kez
    // kuruluyor: `venueAddress` doğrulama yolunda çağrılıyor ve her seferinde
    // tokens.json'ı taramak gereksiz.
    for (const t of cfg.tokens) {
      const addr = t.address.startsWith('0x') ? t.address.toLowerCase() : t.address;
      this.tokenAddresses.set(`${t.symbol.toUpperCase()}|${t.chain}`, addr);
    }

    this.lastQueuedAt = new Float64Array(store.pairCount);
    this.lastQueuedBuySlot = new Int32Array(store.pairCount).fill(-1);
    this.lastQueuedSellSlot = new Int32Array(store.pairCount).fill(-1);
    this.venueMaxAge = new Float64Array(store.venueCount);
    this.venueIsDex = new Uint8Array(store.venueCount);
    this.venueQuoteIle = new Uint8Array(store.venueCount);
    for (let v = 0; v < store.venueCount; v++) {
      const id = store.venueAt(v);
      const dex = Boolean(id && isDex(id));
      this.venueIsDex[v] = dex ? 1 : 0;
      this.venueQuoteIle[v] =
        dex && QUOTE_ILE_DOGRULANAN.includes(id as DexId) ? 1 : 0;
      this.venueMaxAge[v] = dex ? cfg.scan.maxDexPriceAgeMs : cfg.scan.maxPriceAgeMs;
    }
  }

  private readonly venueMaxAge: Float64Array;
  /** Venue indeksi → DEX mi (1/0). Hot path'te `isDex(string)` çağırmamak için. */
  private readonly venueIsDex: Uint8Array;
  /**
   * Venue indeksi → Aşama 2'de kotalı quote ile mi doğrulanıyor (1/0), yani
   * "DEX değişmedi" kuralına tabi mi. Bkz. `QUOTE_ILE_DOGRULANAN`.
   */
  private readonly venueQuoteIle: Uint8Array;
  /** Çift başına son kuyruğa alınma zamanı — allocation'sız soğuma takibi. */
  private readonly lastQueuedAt: Float64Array;
  /**
   * Çift başına son kuyruğa alınan adayın alış/satış slotu (-1: yok).
   * DEX değişmedi kuralı yalnızca AYNI bacak kombinasyonu için geçerli —
   * en iyi ask/bid başka venue'ya geçtiyse o rota hiç doğrulanmamıştır.
   */
  private readonly lastQueuedBuySlot: Int32Array;
  private readonly lastQueuedSellSlot: Int32Array;
  /** DEX tarafı kimlik tablosu: "SYMBOL|chain" → kontrat/mint adresi. */
  private readonly tokenAddresses = new Map<string, string>();

  private readonly maxQueue: number;

  onOpportunity(h: OpportunityHandler): void {
    this.handlers.push(h);
  }

  get stats() {
    return {
      evalCount: this.evalCount,
      candidateCount: this.candidateCount,
      opportunityCount: this.opportunityCount,
      rejectedByDepth: this.rejectedByDepth,
      rejectedByDepthFetch: this.rejectedByDepthFetch,
      lastDepthFetchError: this.lastDepthFetchError,
      rejectedByTransfer: this.rejectedByTransfer,
      makulDegilAday: this.makulDegilAday,
      rejectedByImpact: this.rejectedByImpact,
      inceHavuzOnceliksiz: this.inceHavuzOnceliksiz,
      sonInceHavuz: this.sonInceHavuz,
      rejectedByAddress: this.rejectedByAddress,
      rejectedByStale: this.rejectedByStale,
      staleVenueSkips: this.staleVenueSkips,
      skippedByCooldown: this.skippedByCooldown,
      skippedByDexUnchanged: this.skippedByDexUnchanged,
      persistentCount: this.persistentCount,
      droppedCount: this.droppedCount,
      lastEvalDurationUs: this.lastEvalDurationUs,
      verifyErrors: this.verifyErrors,
      lastVerifyError: this.lastVerifyError,
      queueDepth: this.queue.length,
      netHesaplanan: this.netHesaplanan,
      enIyiNetPct: this.enIyiNetPct,
      /** Kâr hesabına en çok ulaşan çiftler — en fazla 12 satır. */
      netKayit: [...this.netKayit.entries()]
        .sort((a, b) => b[1].adet - a[1].adet)
        .slice(0, 12)
        .map(([anahtar, v]) => ({ anahtar, adet: v.adet, enIyi: v.enIyi })),
      dexQuoteTried: this.dexQuoteTried,
      dexQuoteOk: this.dexQuoteOk,
      dexQuoteEmpty: this.dexQuoteEmpty,
      dexQuoteError: this.dexQuoteError,
      lastDexQuoteError: this.lastDexQuoteError,
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.evaluate(), this.cfg.scan.evalIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // -------------------------------------------------------------------------
  // Aşama 1 — L1 ön-filtre
  // -------------------------------------------------------------------------

  private evaluate(): void {
    const t0 = process.hrtime.bigint();
    const dirty = this.store.flushDirty(this.dirtyBuf);
    if (dirty.length === 0) return;

    this.evalCount++;
    const now = Date.now();
    const venueCount = this.store.venueCount;

    // Tracker'ın budanması: `main.ts` yalnızca `recordGate`'i buduyordu, bu
    // tablo hiç temizlenmiyordu. Epizot sıfırlaması yaşı zaten düzelttiği
    // için bu artık bellek hijyeni — sınıra dayanınca EN ESKİ kayıt atılır ve
    // o kayıt hâlâ canlı bir fırsat olabilirdi.
    if (now - this.lastPruneAt > 60_000) {
      this.lastPruneAt = now;
      this.tracker.prune(30 * 60_000, now);
    }

    for (let d = 0; d < dirty.length; d++) {
      const pairIndex = dirty[d]!;
      const base = pairIndex * venueCount;

      // En düşük ask (alacağımız yer) ve en yüksek bid (satacağımız yer).
      let bestAsk = Number.POSITIVE_INFINITY;
      let bestAskSlot = -1;
      let bestBid = 0;
      let bestBidSlot = -1;
      let staleSkips = 0;
      let usable = 0;

      for (let v = 0; v < venueCount; v++) {
        const slot = base + v;
        const recv = this.store.recvTs(slot);
        if (recv === 0) continue;
        if (now - recv > this.venueMaxAge[v]!) {
          staleSkips++;
          continue;
        }
        usable++;

        const ask = this.store.ask(slot);
        if (ask > 0 && ask < bestAsk) {
          bestAsk = ask;
          bestAskSlot = slot;
        }
        const bid = this.store.bid(slot);
        if (bid > bestBid) {
          bestBid = bid;
          bestBidSlot = slot;
        }
      }

      // Bayatlık İKİ ayrı şey olarak ölçülüyor:
      //   staleVenueSkips  — bayat olduğu için atlanan okuma sayısı (ham hacim,
      //                      feed sağlığının göstergesi)
      //   rejectedByStale  — bayatlık yüzünden çift DEĞERLENDİRİLEMEDİ
      //
      // Eskiden tek sayaç vardı ve yalnızca hiç taze borsa kalmadığında
      // artıyordu. Bir borsa bayatlayıp diğeri tazeyken sayaç sıfır kalıyordu:
      // eleme doğru yapılıyor ama panelde hiç görünmüyordu.
      this.staleVenueSkips += staleSkips;
      // Arbitraj iki taraf ister; bayatlık bizi bunun altına düşürdüyse
      // fırsat üretimi gerçekten bayatlık yüzünden engellenmiş demektir.
      if (staleSkips > 0 && usable < 2) this.rejectedByStale++;

      if (bestAskSlot < 0 || bestBidSlot < 0) continue;
      // Aynı borsada al-sat arbitraj değil, sadece spread.
      if (bestAskSlot === bestBidSlot) continue;

      const rawPct = (bestBid - bestAsk) / bestAsk;
      if (rawPct < this.cfg.scan.prefilterPct) continue;

      // Kuyruk sırası ham farka göre; bozuk fiyat her zaman en büyük ham farkı
      // ürettiği için tepeyi o işgal eder. Önceliği dibe çekmek, aday hakkını
      // kaybetmeden diğerlerinin önünü açar (bkz. IMPLAUSIBLE_RAW_PCT).
      // İnce havuz HAFIZASI — aynı gerçeği tekrar tekrar öğrenmeyi bırakır.
      // Ölçüldü: 7 dakikada 440 eleme, ama sorunlu token sayısı ~56.
      // Eleme değil öncelik düşürme, `makulDegil` ile aynı gerekçe: TTL
      // dolduğunda ya da kapasite boşken aday yeniden denenmeli.
      const inceHavuz =
        now < this.inceHavuzSonu[bestAskSlot]! || now < this.inceHavuzSonu[bestBidSlot]!;

      const makulDegil = rawPct > IMPLAUSIBLE_RAW_PCT;
      const oncelik =
        makulDegil || inceHavuz ? rawPct - ONCELIK_CEZASI : rawPct;

      // Çift başına doğrulama soğuması.
      //
      // `verifying` yalnızca UÇUŞTAKİ aynı adayı engelliyordu; doğrulama biter
      // bitmez aynı çift yeniden kuyruğa giriyordu. Ölçüm: 59 saniyede 56.653
      // aday (~960/sn), kuyruk (40) sürekli dolu, sinyal sıfır.
      //
      // Bu tekrarların bilgi değeri yok: derinlik önbelleği 2 sn TTL'li, yani
      // 2 saniye içinde yeniden doğrulamak AYNI defteri okuyup AYNI sonuca
      // varır — sadece REST kotası ve kuyruk sırası harcar. Soğuma süresi bu
      // yüzden önbellek TTL'ine bağlanmalı.
      if (now - this.lastQueuedAt[pairIndex]! < this.cfg.scan.verifyCooldownMs) {
        this.skippedByCooldown++;
        continue;
      }

      // Quote ile doğrulanan DEX bacağı (jupiter, raydium) varsa ek şart:
      // DEX fiyatı son kuyruğa alınmadan beri YENİDEN YAZILMADIYSA atla.
      //
      // Ölçülen sebep: Jupiter `/swap/v1/quote` ~39 istek/dk ile 30/dk
      // limitini aşıyordu. Jupiter orta fiyatı 11–23 sn'de bir yazılıyor, ama
      // çift CEX tarafındaki HER tick'le dirty oluyor ve 2 sn'lik soğuma
      // dolar dolmaz aynı DEX fiyatıyla yeniden quote ediliyordu — kotayı
      // yakan, bilgi taşımayan tekrar.
      //
      // EVM DEX'ler kurala TABİ DEĞİL (bkz. `QUOTE_ILE_DOGRULANAN`): kota
      // baskısı yok, CEX defteri değişince hemen yeniden doğrulanmaları daha
      // değerli. Karışık bir DEX↔DEX adayında (ör. jupiter↔aerodrome) EVM
      // bacağının yeniden yazılması da yeni bilgi sayılır.
      //
      // ELEME DEĞİL ERTELEME: `makulDegil`/ince havuz "öncelik düşürme"
      // kuralıyla çelişmez. Aday hakkını kaybetmez; DEX slotu bir sonraki
      // yazımda (yeni bilgi) yeniden kuyruğa girer. Sayaç ayrı
      // (`skippedByDexUnchanged`), çünkü bu botta sessiz atlama olmaz.
      //
      // Yalnızca AYNI (alış, satış) slot kombinasyonu için: en iyi ask/bid
      // başka bir venue'ya geçtiyse o rota hiç doğrulanmamıştır ve DEX'in
      // yaşı onun için bir şey söylemez.
      //
      // DEX↔DEX: bacaklardan HERHANGİ BİRİ yeniden yazıldıysa kuyruğa alınır
      // ("ikisi de" değil). İki feed farklı periyotta çalışıyor (Jupiter
      // 11–23 sn, Raydium ayrı); "ikisi de" şartı, hızlı bacağın yeni
      // fiyatını yavaş bacak yazana kadar görmezden gelirdi. Yanılma yönü
      // muhafazakâr: fazladan bir quote, kapsam kaybından ucuz.
      //
      // `>=`: aynı milisaniyede yazılmış fiyatın kuyruğa alınmadan önce mi
      // sonra mı geldiği ayırt edilemez; belirsizlikte yeniden doğrula.
      const buyV = bestAskSlot % venueCount;
      const sellV = bestBidSlot % venueCount;
      const buyDex = this.venueIsDex[buyV] === 1;
      const sellDex = this.venueIsDex[sellV] === 1;
      if (
        (this.venueQuoteIle[buyV] === 1 || this.venueQuoteIle[sellV] === 1) &&
        this.lastQueuedBuySlot[pairIndex] === bestAskSlot &&
        this.lastQueuedSellSlot[pairIndex] === bestBidSlot
      ) {
        const sonKuyruk = this.lastQueuedAt[pairIndex]!;
        const yeniDexFiyati =
          (buyDex && this.store.recvTs(bestAskSlot) >= sonKuyruk) ||
          (sellDex && this.store.recvTs(bestBidSlot) >= sonKuyruk);
        if (!yeniDexFiyati) {
          this.skippedByDexUnchanged++;
          continue;
        }
      }

      const pair = this.store.pairAt(pairIndex);
      const buyVenue = this.store.slotVenue(bestAskSlot);
      const sellVenue = this.store.slotVenue(bestBidSlot);
      if (!pair || !buyVenue || !sellVenue) continue;

      const key = `${pair}|${buyVenue}|${sellVenue}`;
      if (this.verifying.has(key)) continue;
      this.verifying.add(key);

      this.candidateCount++;
      // Sayaç BURADA artıyor, ön filtrenin hemen sonrasında değil: orada
      // artırınca soğumaya takılan tekrarlar da sayılıyordu ve `makulDegil`
      // toplam aday sayısını AŞIYORDU (ölçüm: 80053 > 58068). Bir eleme
      // sayacı, ait olduğu kümenin alt kümesi olmalı — yoksa panel kendi
      // içinde çelişir ve okuyan kişi oranı yanlış hesaplar.
      if (makulDegil) this.makulDegilAday++;
      // Aynı sebeple burada: soğumaya takılan tekrarlar sayılmasın.
      if (inceHavuz) this.inceHavuzOnceliksiz++;
      this.lastQueuedAt[pairIndex] = now;
      this.lastQueuedBuySlot[pairIndex] = bestAskSlot;
      this.lastQueuedSellSlot[pairIndex] = bestBidSlot;
      this.queue.push({
        pair,
        pairIndex,
        buyVenue,
        sellVenue,
        buySlot: bestAskSlot,
        sellSlot: bestBidSlot,
        rawPct,
        oncelik,
      });

      // Kuyruk taştıysa en zayıf adayı düşür: doğrulanmayı bekleyen bir aday
      // beklerken fiyatı bayatlıyor, yani sırayı tutmasının değeri azalıyor.
      if (this.queue.length > this.maxQueue) {
        let worstIdx = 0;
        for (let i = 1; i < this.queue.length; i++) {
          if (this.queue[i]!.oncelik < this.queue[worstIdx]!.oncelik) worstIdx = i;
        }
        const dropped = this.queue.splice(worstIdx, 1)[0]!;
        this.verifying.delete(`${dropped.pair}|${dropped.buyVenue}|${dropped.sellVenue}`);
        this.droppedCount++;
        // Atılan aday hiç DOĞRULANMADI: "DEX değişmedi" kuralı onun için
        // geçerli olmamalı, yoksa bir sonraki DEX yazımına (11–23 sn) kadar
        // kuyruğa giremezdi. İşaret yalnızca hâlâ bu adayı gösteriyorsa silinir.
        if (
          this.lastQueuedBuySlot[dropped.pairIndex] === dropped.buySlot &&
          this.lastQueuedSellSlot[dropped.pairIndex] === dropped.sellSlot
        ) {
          this.lastQueuedBuySlot[dropped.pairIndex] = -1;
          this.lastQueuedSellSlot[dropped.pairIndex] = -1;
        }
      }
    }

    this.lastEvalDurationUs = Number(process.hrtime.bigint() - t0) / 1000;
    this.drain();
  }

  // -------------------------------------------------------------------------
  // Aşama 2 — derinlik + maliyet doğrulaması
  // -------------------------------------------------------------------------

  /** Kuyruğu sınırlı eşzamanlılıkla işler. */
  private drain(): void {
    while (this.inFlight < this.maxConcurrent && this.queue.length > 0) {
      // En kârlı görünen adayı önce doğrula: rate-limit'e takılırsak
      // kaybettiğimiz en değersiz aday olsun.
      let bestIdx = 0;
      for (let i = 1; i < this.queue.length; i++) {
        if (this.queue[i]!.oncelik > this.queue[bestIdx]!.oncelik) bestIdx = i;
      }
      const cand = this.queue.splice(bestIdx, 1)[0]!;

      this.inFlight++;
      void this.verify(cand)
        .catch((e) => {
          // İz bırakmadan yutmak, bir handler ya da quoter istisnasının
          // Telegram bildirimini sessizce atlaması demekti.
          this.verifyErrors++;
          this.lastVerifyError = (e as Error).message;
        })
        .finally(() => {
          this.inFlight--;
          this.verifying.delete(`${cand.pair}|${cand.buyVenue}|${cand.sellVenue}`);
          if (this.queue.length > 0) this.drain();
        });
    }
  }

  private async verify(c: Candidate): Promise<void> {
    const [coin, quote] = c.pair.split('/') as [string, string];
    const tradeSize = this.cfg.scan.tradeSizeQuote;
    const now = Date.now();

    const buyRecv = this.store.recvTs(c.buySlot);
    const sellRecv = this.store.recvTs(c.sellSlot);
    const buyAge = now - buyRecv;
    const sellAge = now - sellRecv;
    const worstAge = Math.max(buyAge, sellAge);

    // Bayatlık eşiği bacak BAŞINA, venue türüne göre uygulanır — Aşama 1'deki
    // kuralın aynısı (`venueMaxAge`).
    //
    // Burası uzun süre düz `maxPriceAgeMs` (CEX, 3 sn) kullanıyordu ve bu,
    // Aşama 1'de düzeltilmiş olan hatanın Aşama 2'de yaşamaya devam eden
    // hâliydi. Jupiter'in tarama periyodu kaynağın limitinden TÜRETİLİYOR:
    // 133 token / 40'lık chunk = 4 istek, anahtarsız 60/dk limitin %35'i
    // taramaya → ~11.4 sn (anahtarla bile taban 5 sn). Yani bir Solana çifti
    // CEX tick'iyle dirty olduğunda — dirty olayların ezici çoğunluğu — DEX
    // bacağının yaşı 3 sn'yi çoktan aşmış oluyor ve aday burada eleniyordu.
    // CEX↔DEX fırsatı yalnızca DEX yazımının ilk 3 saniyesinde
    // doğrulanabiliyordu: 11.4 sn'lik pencerenin ~%26'sı.
    //
    // Sessizliği ayrıca kötüydü: eleme `rejectedByStale`'e yazıldığı için
    // panelde gerçek CEX bayatlığından ayırt edilemiyordu.
    if (buyAge > this.maxAgeFor(c.buySlot) || sellAge > this.maxAgeFor(c.sellSlot)) {
      this.rejectedByStale++;
      return;
    }

    const bestAsk = this.store.ask(c.buySlot);
    const bestBid = this.store.bid(c.sellSlot);
    const askQty = this.store.askQty(c.buySlot);
    const bidQty = this.store.bidQty(c.sellSlot);
    if (!(bestAsk > 0) || !(bestBid > 0)) return;

    // İşlem büyüklüğü, DEX satış bacağının quote EDİLDİĞİ miktara kırpılır.
    //
    // EVM ve CoW feed'leri `bidQty`'ye orta fiyat değil, $tradeSize'lık
    // alışla elde edilen GERÇEK miktarı yazıyor (`bought = tradeSize / ask`).
    // Kârlı bir CEX→DEX adayında CEX'ten alınan miktar bundan HER ZAMAN
    // büyüktür (cexAsk < dexBid < dexAsk ⇒ tradeSize/cexAsk > tradeSize/dexAsk),
    // dolayısıyla satış bacağı `l1Fill`'den hiç tam dönmüyor ve
    // `quoteDexLeg`'e düşüyordu — orada EVM venue'ları için doğrulayıcı YOK
    // (`VenueLegQuoter` yalnızca Solana'yı tanır), yani her CEX→EVM DEX ve
    // EVM DEX↔DEX adayı `rejectedByDepth` ile eleniyordu. Ölçüldü: 265 kayıtta
    // EVM venue alış tarafında, yalnızca 2'sinde satış tarafında (o ikisi de
    // bozuk quote). Yön yapısal olarak kapalıydı.
    //
    // DEX quote'u tam `bidQty` kadar token için gerçek; işlemi o büyüklüğe
    // kırpmak muhafazakârdır (daha küçük alışın VWAP'ı daha iyi olurdu).
    // Solana bacakları `bidQty = 0` yazdığı için bu yola girmez, eskisi gibi
    // `quoteDexLeg` ile doğrulanır.
    let neededBase = tradeSize / bestAsk;
    let etkinTradeSize = tradeSize;
    if (isDex(c.sellVenue) && bidQty > 0 && bidQty < neededBase) {
      neededBase = bidQty;
      etkinTradeSize = bidQty * bestAsk;
    }

    // --- Alış tarafı ------------------------------------------------------
    // L1 derinliği talebi karşılıyorsa REST'e hiç gitmeyiz: hem hızlı hem
    // rate-limit dostu. Karşılamıyorsa gerçek defteri çekeriz.
    let buyFill = l1Fill(bestAsk, askQty, neededBase);
    // DEX'te "defter" yok: quoter zaten slippage dahil gerçekleşecek fiyatı
    // verdiği için L1 kaydı doğrudan kullanılabilir, REST derinliği çekilmez.
    if (!buyFill.complete && isCex(c.buyVenue)) {
      const symbol = this.registry.venuesFor(c.pair).get(c.buyVenue);
      if (!symbol) return;
      const book = await this.depth.get(c.buyVenue, c.pair, symbol);
      // `null` = defter ÇEKİLEMEDİ (429, timeout, bozuk cevap) — "defter
      // ince" ile aynı kovaya konunca altyapı bloğu likidite yokluğu gibi
      // görünüyordu ve "derinlikten düşenlerin %94'ü ince CEX defteri"
      // sonucu bu sayaçtan çıkarılamıyordu.
      if (!book) {
        this.rejectedByDepthFetch++;
        this.lastDepthFetchError = `${c.buyVenue} ${c.pair}`;
        return;
      }
      if (book.asks.length === 0) {
        this.rejectedByDepth++;
        return;
      }
      buyFill = buyWithQuote(book.asks, etkinTradeSize);
      if (!buyFill.complete) {
        // Defterin tamamı bile talebi karşılamıyor — bu boyutta işlem yapılamaz.
        this.rejectedByDepth++;
        return;
      }
    }

    if (!buyFill.complete && isDex(c.buyVenue)) {
      // Solana geniş taraması miktar yazmaz (orta fiyat verir); gerçek
      // gerçekleşecek miktarı ancak quote çağrısı söyler. EVM feed'leri miktarı
      // zaten yazdığı için buraya düşmez.
      const base = await this.quoteDexLeg('buy', c.buyVenue, c.pair, etkinTradeSize, c.buySlot);
      if (base === null) {
        this.rejectedByDepth++;
        return;
      }
      buyFill = dexFill(base, etkinTradeSize, bestAsk, 'buy');
    }

    let baseBought = buyFill.filledBase;
    let spentQuote = buyFill.filledQuote;
    if (!(baseBought > 0)) return;
    // REST defteri L1'den iyi fiyat verip kırpılan miktardan fazlasını
    // doldurmuş olabilir; DEX satış quote'u yalnızca `bidQty` için geçerli.
    // Alış VWAP'ı daha büyük miktar için ölçüldü, daha azına uygulamak
    // muhafazakâr.
    if (isDex(c.sellVenue) && bidQty > 0 && baseBought > bidQty) {
      spentQuote = buyFill.vwap * bidQty;
      baseBought = bidQty;
    }

    // --- Satış tarafı -----------------------------------------------------
    let sellFill = l1Fill(bestBid, bidQty, baseBought);
    if (!sellFill.complete && isCex(c.sellVenue)) {
      const symbol = this.registry.venuesFor(c.pair).get(c.sellVenue);
      if (!symbol) return;
      const book = await this.depth.get(c.sellVenue, c.pair, symbol);
      if (!book) {
        this.rejectedByDepthFetch++;
        this.lastDepthFetchError = `${c.sellVenue} ${c.pair}`;
        return;
      }
      if (book.bids.length === 0) {
        this.rejectedByDepth++;
        return;
      }
      sellFill = sellBase(book.bids, baseBought);
      if (!sellFill.complete) {
        this.rejectedByDepth++;
        return;
      }
    }

    if (!sellFill.complete && isDex(c.sellVenue)) {
      const quote = await this.quoteDexLeg('sell', c.sellVenue, c.pair, baseBought, c.sellSlot);
      if (quote === null) {
        this.rejectedByDepth++;
        return;
      }
      sellFill = dexFill(baseBought, quote, bestBid, 'sell');
    }

    // Bayatlık, `await`'lerden SONRA yeniden ölçülür. Derinlik çekimi rate
    // kovasında bekleyebilir (+4 sn timeout), DEX quote'u Jupiter kovasında
    // (1/sn) — başta taze olan bacak buraya gelene kadar eşiği aşmış olabilir
    // ve eski kod bunu ne eliyor ne "fiyat yaşı" uyarısına yazıyordu. Ölçü,
    // başta okunan `recvTs`'lerdir: slot sonradan tazelense bile kullandığımız
    // DEĞERLER o andakiler.
    const araNow = Date.now();
    if (
      araNow - buyRecv > this.maxAgeFor(c.buySlot) ||
      araNow - sellRecv > this.maxAgeFor(c.sellSlot)
    ) {
      this.rejectedByStale++;
      return;
    }

    // --- Transfer yolu ----------------------------------------------------
    // Coin'i alış mekanından satış mekanına taşıyabilmemiz gerekiyor.
    //
    // DEX tarafında ayrı komisyon yok: havuz ücreti quoter'ın döndürdüğü
    // fiyata zaten dahil. Onun yerine gas maliyeti var.
    const buyFeeRate = this.takerFee(c.buyVenue, coin);
    const sellFeeRate = this.takerFee(c.sellVenue, coin);

    // Komisyon base cinsinden kesilir; borsadan çekeceğimiz miktar budur.
    // Zincir seçiminden ÖNCE hesaplanıyor çünkü pickChain asgari çekim
    // tutarını buna göre eliyor.
    const baseAfterBuyFee = baseBought * (1 - buyFeeRate);

    const picked = this.pickChain(coin, c.buyVenue, c.sellVenue, bestAsk, baseAfterBuyFee);
    if (!picked.ok) {
      if (picked.reason === 'address') this.rejectedByAddress++;
      else this.rejectedByTransfer++;
      return;
    }
    const route = picked;

    // --- Maliyetler -------------------------------------------------------
    const gasQuote = this.gasCost(c.buyVenue) + this.gasCost(c.sellVenue);

    const baseAfterWithdraw = baseAfterBuyFee - route.withdrawFee;
    if (!(baseAfterWithdraw > 0)) {
      this.rejectedByTransfer++;
      return;
    }

    // Çekim ücreti düşünce satılacak miktar azaldı; geliri buna göre ölçekleriz.
    const grossSellQuote = sellFill.vwap * baseAfterWithdraw;
    const sellFee = grossSellQuote * sellFeeRate;
    const netReceived = grossSellQuote - sellFee;

    const withdrawFeeQuote = route.withdrawFee * sellFill.vwap;
    const netQuote = netReceived - spentQuote - gasQuote;
    const netPct = netQuote / spentQuote;

    /**
     * Alış komisyonunun quote cinsinden GERÇEK maliyeti.
     *
     * Komisyon base cinsinden kesiliyor (`baseBought * buyFeeRate` kadar coin)
     * ve o coin bize kalsaydı SATIŞ fiyatından elden çıkacaktı. Dolayısıyla
     * maliyeti satış VWAP'ıyla değerlenir.
     *
     * Eskiden `spentQuote * buyFeeRate` yazılıyordu, yani alış fiyatıyla. Kâr
     * hesabı (netQuote) doğruydu ama DÖKÜM denkleşmiyordu: `grossQuote - costs`
     * ile `netQuote` arasında tam olarak `kesilen coin × spread` kadar fark
     * kalıyordu ve Telegram mesajı kârı olduğundan yüksek gösteriyordu.
     * Bu haliyle döküm netQuote'a birebir oturuyor.
     */
    const buyFee = baseBought * buyFeeRate * sellFill.vwap;

    // Ölçüm noktası: buraya gelen aday tüm elemeleri geçmiş ve kârı
    // hesaplanmış demektir. Eşiğin altında kalsa bile SAYILIR — "eşiğe ne
    // kadar yaklaştık" sorusunun tek cevabı bu.
    this.netHesaplanan++;
    if (netPct > this.enIyiNetPct) this.enIyiNetPct = netPct;

    const kayitAnahtari = `${coin}|${c.buyVenue}->${c.sellVenue}`;
    const kayit = this.netKayit.get(kayitAnahtari);
    if (kayit) {
      kayit.adet++;
      if (netPct > kayit.enIyi) kayit.enIyi = netPct;
    } else if (this.netKayit.size < NET_KAYIT_MAX) {
      this.netKayit.set(kayitAnahtari, { adet: 1, enIyi: netPct });
    }

    if (netPct < this.cfg.scan.minNetPct) return;

    // Quote USDT dışıysa kimliğe girer: izleme listesinde `quotes:["USD"]`
    // ile BTC/USD ve BTC/USDT aynı kimliği paylaşıp tracker, recordGate,
    // Telegram dedup ve panel listesinde birbirine karışırdı. USDT'de eski
    // biçim korunuyor (data/ ve kalibrasyon geçmişi).
    const oppId = `${coin}${quote === 'USDT' ? '' : `/${quote}`}|${c.buyVenue}->${c.sellVenue}`;
    this.tracker.shouldEmit(oppId, netPct, now);
    const persist = this.tracker.persistence(oppId, now);

    const warnings: string[] = [];

    // Gerçek bir arbitraj bu büyüklükte olmaz: %20 net kâr, iki tarafın da
    // canlı ve transfer edilebilir olduğu bir piyasada saniyeler içinde
    // kapanırdı. Kalibrasyon raporu bunu 20 saatlik veride zaten ölçüyordu
    // ("neredeyse her zaman veri hatası") ama ölçüm YALNIZCA rapor zamanında
    // yapılıyordu — motor tarafında hiçbir karşılığı yoktu ve bot %77'lik
    // RWA sinyalini hiçbir şüphe işareti taşımadan Telegram'a gönderdi.
    //
    // Sebep genelde kimlik çakışması ya da ölü defterdir; ikisi de artık ayrıca
    // eleniyor. Bu yüzden bu kontrol bir ELEME değil son çare AĞIDIR: bilinmeyen
    // bir sebeple bu eşiği geçen sinyal yine yayınlanır ama uyarısıyla gider.
    if (netPct > IMPLAUSIBLE_NET_PCT) {
      warnings.push(
        `net %${(netPct * 100).toFixed(1)} — bu büyüklükte fark neredeyse her zaman ` +
          `veri hatası (ticker çakışması, ölü defter, yanlış ondalık)`,
      );
    }

    if (persist.ageMs > SUSPICIOUS_PERSISTENCE_MS) {
      this.persistentCount++;
      warnings.push(
        `bu fark ${Math.round(persist.ageMs / 1000)}sn'dir kapanmıyor — ` +
          `muhtemelen çekim kapalı veya piyasa ölü`,
      );
    }

    // Transfer tablosu bayatsa "çekim/yatırma açık" bilgisi ARTIK BİLGİ DEĞİL.
    //
    // Kontrolün kendisi doğru çalışıyor ama baktığı veri eskiyse sonuç aynı:
    // yatırması yeni kapanmış bir coin hâlâ açık görünür. `refreshIfStale`
    // hatayı yuttuğu için bu durumun tek görünür yeri burası.
    const tabloYasi = this.transfers.tableAgeMs;
    if (tabloYasi > TRANSFER_TABLE_STALE_MS) {
      warnings.push(
        `transfer tablosu ${Math.round(tabloYasi / 60000)} dk'dır tazelenemedi — ` +
          `çekim/yatırma durumu o kadar eski`,
      );
    }

    if (!route.verified) {
      warnings.push(
        // Sebep artık "public API yok" olmayabilir: anahtar girilmemiş de olabilir,
        // girilip başarısız da olmuş olabilir. Sebebi başlangıç logu söylüyor.
        `${route.unverifiedVenues.join('/')} çekim durumu doğrulanamadı (API anahtarı yok)`,
      );
    }
    // USD/USDT bazı: bu bacağın fiyatı USD çiftinden geliyor (o borsada USDT
    // çifti yok, bkz. usdVekiliUygula). USD ile USDT farklı varlıklar ve
    // aradaki baz doğrudan kâra karışır — ölçüm anında %-0.09, yani
    // MIN_NET_PCT'in dörtte biri; depeg anlarında %'lerce. Sessiz bırakmak,
    // sistematik bir kaymayı kâr diye raporlamak olurdu.
    const vekilBacaklar = ([c.buyVenue, c.sellVenue] as const).filter(
      (v) => isCex(v) && this.registry.usdVekiliMi(coin, v),
    );
    if (vekilBacaklar.length > 0) {
      warnings.push(
        `${vekilBacaklar.join('/')} fiyatı USD çiftinden (USDT çifti yok) — ` +
          `USDT/USD bazı kâra dahil değil`,
      );
    }
    // Ek kesinti UYGULANDIYSA görünür olmalı: bu, borsanın yayınladığı
    // komisyon tarifesinde OLMAYAN bir maliyet ve kullanıcı sinyale bakarken
    // rakamın neden düşük olduğunu görebilmeli. Sessiz bırakmak, modeli
    // doğrulanamaz yapardı.
    // Yalnızca CEX bacağı taşıyan sinyalde: DEX↔DEX (ör. jupiter↔raydium)
    // sinyalinde kesinti uygulanmıyor, uyarı da olmamalı.
    if (
      this.cfg.hisseTokenleri.has(coin.toUpperCase()) &&
      this.cfg.scan.hisseTokenEkPct > 0 &&
      (isCex(c.buyVenue) || isCex(c.sellVenue))
    ) {
      warnings.push(
        `hisse tokeni: CEX bacağı başına %${(this.cfg.scan.hisseTokenEkPct * 100).toFixed(2)} ` +
          `ek kesinti kâra dahil edildi (mekanizma belgelenmemiş, büyüklük ölçüldü)`,
      );
    }
    if (buyFill.slippage > 0.002) {
      warnings.push(`alışta %${(buyFill.slippage * 100).toFixed(2)} kayma`);
    }
    if (sellFill.slippage > 0.002) {
      warnings.push(`satışta %${(sellFill.slippage * 100).toFixed(2)} kayma`);
    }
    // Uyarı da bacağın KENDİ eşiğine göre ölçülür. Düz `maxPriceAgeMs / 2`
    // (1.5 sn) kullanmak, DEX bacağı 30 sn'ye kadar taze sayılırken her
    // CEX↔DEX fırsatına "fiyat yaşı" uyarısı iliştirirdi — her sinyalde çıkan
    // uyarı bilgi taşımaz, yalnızca gerçek uyarıları gürültüye boğar.
    if (buyAge > this.maxAgeFor(c.buySlot) / 2 || sellAge > this.maxAgeFor(c.sellSlot) / 2) {
      warnings.push(`fiyat yaşı ${worstAge}ms`);
    }

    if (!route.verified && !this.cfg.scan.allowUnverifiedTransfer) {
      this.rejectedByTransfer++;
      return;
    }

    // --- DEX bacağının ikinci görüşü --------------------------------------
    //
    // Burada, yani `MIN_NET_PCT` eşiği geçildikten SONRA yapılıyor: istek
    // sayısı tur başına değil SİNYAL başına oluyor. CoW'un dar kovası
    // (2/sn) geniş taramayı kaldırmıyor ama sinyal başına bir isteği rahat
    // kaldırır — bu, venue olarak kapatılmasının sebebi olan bütçe sorununu
    // ortadan kaldıran ayrım.
    const caprazSonuc = await this.caprazKontrolEt(
      c,
      spentQuote,
      baseBought,
      baseBought,
      sellFill.filledQuote,
    );
    if (caprazSonuc) {
      // Yalnızca BİZ İYİMSERKEN uyarı. Ters yön (ikinci kaynak daha çok
      // veriyor) sinyali güvenilmez yapmaz, yalnızca muhafazakâr yapar.
      //
      // Eşik `minNetPct`e bağlı, sabit değil: ikinci kaynak kârın TAMAMI
      // kadar ayrışıyorsa sinyalin dayanağı kalmamış demektir. Sabit bir
      // yüzde, eşik değiştiğinde ya her sinyale uyarı iliştirir ya da hiç
      // uyarmazdı.
      if (caprazSonuc.sonuc.sapmaPct > this.cfg.scan.minNetPct) {
        warnings.push(
          `${caprazSonuc.venue} bacağı ${caprazSonuc.sonuc.kaynak}'a göre ` +
            `%${(caprazSonuc.sonuc.sapmaPct * 100).toFixed(2)} iyimser — ` +
            `rotalardan biri yanlış`,
        );
      }
    }

    // Yaşlar YAYIN anında: `now` doğrulamanın başı, aradaki await'ler
    // (derinlik, quote, çapraz kontrol) saniyeler sürebilir.
    const yayinAni = Date.now();
    const buyLeg: Leg = {
      kind: isCex(c.buyVenue) ? 'cex-buy' : 'dex-buy',
      venue: c.buyVenue,
      pair: c.pair,
      vwap: buyFill.vwap,
      bestPrice: bestAsk,
      qty: baseBought,
      feeQuote: buyFee,
      ageMs: yayinAni - buyRecv,
    };

    const sellLeg: Leg = {
      kind: isCex(c.sellVenue) ? 'cex-sell' : 'dex-sell',
      venue: c.sellVenue,
      pair: c.pair,
      vwap: sellFill.vwap,
      bestPrice: bestBid,
      qty: baseAfterWithdraw,
      feeQuote: sellFee,
      ageMs: yayinAni - sellRecv,
    };

    const opp: Opportunity = {
      id: oppId,
      kind: classify(c.buyVenue, c.sellVenue),
      coin,
      quote,
      buy: buyLeg,
      sell: sellLeg,
      chain: route.chain,
      grossQuote: (sellFill.vwap - buyFill.vwap) * baseBought,
      netQuote,
      netPct,
      costs: {
        buyFee,
        sellFee,
        withdrawFee: withdrawFeeQuote,
        gas: gasQuote,
        bridge: 0,
      },
      warnings,
      transferVerified: route.verified,
      ...(caprazSonuc
        ? {
            capraz: {
              kaynak: caprazSonuc.sonuc.kaynak,
              venue: caprazSonuc.venue,
              sapmaPct: caprazSonuc.sonuc.sapmaPct,
            },
          }
        : {}),
      detectedAt: yayinAni,
      worstAgeMs: Math.max(buyLeg.ageMs, sellLeg.ageMs),
    };

    this.opportunityCount++;
    for (const h of this.handlers) h(opp);
  }

  /**
   * Fırsatın DEX bacağını bağımsız ikinci kaynağa sorar.
   *
   * İki DEX bacağı varsa (DEX↔DEX) İYİMSER olanı seçilir — uyarının amacı en
   * zayıf halkayı göstermek; ikisini birden sormak istek sayısını ikiye
   * katlar ve uyarı yine tek satır olurdu.
   *
   * Hata YUTULUYOR ama SESSİZ DEĞİL: sayaçlar `CaprazKontrol` içinde tutuluyor
   * ve panele basılıyor. Tek bir başarısız kontrol yüzünden gerçek bir sinyal
   * yayınlanmamalı.
   */
  private async caprazKontrolEt(
    c: Candidate,
    alisGirdi: number,
    alisCikti: number,
    satisGirdi: number,
    satisCikti: number,
  ): Promise<{ venue: DexId; sonuc: CaprazSonuc } | null> {
    if (!this.capraz) return null;
    const symbol = c.pair.split('/')[0];
    if (!symbol) return null;

    const adaylar: { venue: DexId; yon: 'buy' | 'sell'; girdi: number; cikti: number }[] = [];
    if (isDex(c.buyVenue) && this.capraz.destekler(c.buyVenue)) {
      adaylar.push({ venue: c.buyVenue, yon: 'buy', girdi: alisGirdi, cikti: alisCikti });
    }
    if (isDex(c.sellVenue) && this.capraz.destekler(c.sellVenue)) {
      adaylar.push({ venue: c.sellVenue, yon: 'sell', girdi: satisGirdi, cikti: satisCikti });
    }
    if (adaylar.length === 0) return null;

    let enIyimser: { venue: DexId; sonuc: CaprazSonuc } | null = null;
    for (const a of adaylar) {
      // Hata BURADA da yakalanıyor, uygulamanın kendi içinde yakalıyor olsa
      // bile: ikinci görüş bir EK'tir, onu üreten katmanın arızası gerçek bir
      // sinyali yok edemez. CoW'un önündeki CDN bloğu ölçülmüş bir gerçek ve
      // o anda tüm Base sinyallerinin susması, kontrolün faydasından büyük
      // bir zarar olurdu.
      const sonuc = await this.capraz
        .kontrol(a.venue, symbol, a.yon, a.girdi, a.cikti)
        .catch(() => null);
      if (!sonuc) continue;
      if (!enIyimser || sonuc.sapmaPct > enIyimser.sonuc.sapmaPct) {
        enIyimser = { venue: a.venue, sonuc };
      }
    }
    return enIyimser;
  }

  /** DEX'lerde havuz ücreti quote fiyatına dahil olduğu için ayrıca kesilmez. */
  /**
   * DEX bacağı için gerçek quote alır.
   *
   * Hata yutuluyor: tek bir aday yüzünden tarama durmamalı. `null` dönüşü
   * çağıran tarafta `rejectedByDepth` olarak sayılıyor — yani "rota yok"
   * ile "quote başarısız" aynı kovaya düşüyor; ikisi de o boyutta işlem
   * yapılamadığı anlamına geldiği için ayrım pratik değer taşımıyor.
   */
  private async quoteDexLeg(
    yon: 'buy' | 'sell',
    venue: VenueId,
    pair: PairKey,
    miktar: number,
    slot: number,
  ): Promise<number | null> {
    this.dexQuoteTried++;

    if (!this.legQuoter) {
      this.dexQuoteError++;
      this.lastDexQuoteError = 'doğrulayıcı bağlı değil';
      return null;
    }
    const symbol = pair.split('/')[0];
    if (!isDex(venue) || !symbol) {
      this.dexQuoteError++;
      this.lastDexQuoteError = `${venue}/${pair} çözümlenemedi`;
      return null;
    }

    try {
      const sonuc =
        yon === 'buy'
          ? await this.legQuoter.buy(venue, symbol, miktar)
          : await this.legQuoter.sell(venue, symbol, miktar);
      if (sonuc === null || !(sonuc.miktar > 0)) {
        this.dexQuoteEmpty++;
        return null;
      }

      // İNCE HAVUZ — "rota yok"tan AYRI bir teşhis.
      //
      // Ölçülen örnek ZEUS: orta fiyatı Jupiter'le %2.5 uyumlu (fiyat kaynağı
      // sağlam, referans filtresi haklı olarak geçiriyor) ama $500'lük quote
      // birim fiyatı 3.5 KATINA çıkıyor. Havuz doğru fiyatlı, sadece o
      // büyüklüğü taşımıyor. Kâr hesabı bunu zaten yakalıyordu (net %-99) ama
      // eleme "derinlik yok" kovasına düşüyor ve panelde rotasızlıkla aynı
      // görünüyordu — üstelik aynı bozuk havuz her turda yeniden sorulup
      // doğrulama bütçesini yakıyordu.
      //
      // Etki değeri zaten elimizdeydi: iki quoter da döndürüyor, Jupiter'inki
      // ayrıştırılıp atılıyordu.
      if (sonuc.etkiPct !== null && sonuc.etkiPct > MAX_FIYAT_ETKISI) {
        this.rejectedByImpact++;
        this.sonInceHavuz = `${symbol}/${venue} etki %${(sonuc.etkiPct * 100).toFixed(1)}`;
        if (slot >= 0) this.inceHavuzSonu[slot] = Date.now() + INCE_HAVUZ_TTL_MS;
        return null;
      }

      // Havuz taşıyorsa hafıza SİLİNİR: likidite geri gelmiş olabilir ve eski
      // kayıt tokeni haksızca kör bırakmamalı.
      if (slot >= 0) this.inceHavuzSonu[slot] = 0;

      this.dexQuoteOk++;
      return sonuc.miktar;
    } catch (e) {
      this.dexQuoteError++;
      this.lastDexQuoteError = (e as Error).message;
      return null;
    }
  }

  /**
   * Bir slotun bayatlık eşiği (ms) — venue TÜRÜNE göre.
   *
   * `venueMaxAge` kurulumda venue indeksine göre dolduruluyor ve slot düzeni
   * `pairIndex * venueCount + venueIndex` olduğu için venue indeksi kalandan
   * çıkar. İki aşamanın AYNI tablodan okuması kasıtlı: eşik iki yerde ayrı
   * hesaplansaydı biri güncellenip diğeri unutulduğunda Aşama 1'in kabul
   * ettiği adayı Aşama 2 sessizce elemeye devam ederdi — düzeltilen hata
   * tam olarak buydu.
   */
  private maxAgeFor(slot: number): number {
    return this.venueMaxAge[slot % this.store.venueCount]!;
  }

  /**
   * Bacağın komisyon oranı — venue VE coin'e göre.
   *
   * Tokenlaştırılmış hisseler (xStocks) CEX bacağında borsanın taker
   * oranının ÜSTÜNE bir kesinti daha taşıyor. Bunun taker'a katılmasının
   * sebebi ölçüm: Gate ve MEXC bu çiftlere normal çiftlerle birebir aynı
   * taker oranını uyguluyor (%0.2 / %0.05), yani kesinti işlem komisyonu
   * DEĞİL — ama kâr hesabına giren yer aynı, çünkü işlem büyüklüğüyle
   * orantılı.
   *
   * DEX bacağına uygulanmaz: orada quoter zaten gerçekleşecek miktarı
   * döndürüyor, havuz ücreti fiyatın içinde.
   */
  private takerFee(v: VenueId, coin: string): number {
    if (!isCex(v)) return 0;
    const taban = this.cfg.exchanges[v].fees.taker;
    return this.cfg.hisseTokenleri.has(coin.toUpperCase())
      ? taban + this.cfg.scan.hisseTokenEkPct
      : taban;
  }

  /** DEX bacağı başına tahmini gas maliyeti (quote cinsinden). */
  private gasCost(v: VenueId): number {
    if (!isDex(v)) return 0;
    return this.cfg.chains[DEX_CHAIN[v as DexId]]?.gasCostUsd ?? 0;
  }

  /**
   * Varlığı alış mekanından satış mekanına taşıyabileceğimiz en ucuz yolu seçer.
   *
   * Zincir seçimi arbitrajın gizli maliyet kalemidir: aynı coin bir ağda
   * 0.1 USD, başka bir ağda 15 USD çekim ücretine sahip olabilir ve yanlış
   * ağ seçimi kârı tamamen yer.
   *
   * Dört durum var:
   *   CEX→CEX  her iki borsada da ortak, çekimi/yatırması açık bir zincir
   *   CEX→DEX  DEX'in zinciri zorunlu; CEX'ten o zincirde çekim açık olmalı
   *   DEX→CEX  DEX'in zinciri zorunlu; CEX'e o zincirde yatırma açık olmalı
   *   DEX→DEX  aynı zincirdeyse transfer YOK (en temiz durum, sadece gas);
   *            farklı zincirlerse köprü gerekir — v1 bunu desteklemiyor.
   *
   * @param withdrawAmount Alış borsasından çekilecek base miktarı. Zincirin
   *   asgari çekim tutarını karşılamayan aday elenir.
   */
  private pickChain(
    coin: string,
    buyVenue: VenueId,
    sellVenue: VenueId,
    priceQuote: number,
    withdrawAmount: number,
  ): ChainPick {
    const buyChain = isDex(buyVenue) ? DEX_CHAIN[buyVenue as DexId] : null;
    const sellChain = isDex(sellVenue) ? DEX_CHAIN[sellVenue as DexId] : null;

    // DEX → DEX
    if (buyChain && sellChain) {
      if (buyChain !== sellChain) {
        // Köprü maliyeti ve gecikmesi modellenmeden bu fırsat güvenilir değil.
        return { ok: false, reason: 'transfer' };
      }
      return {
        ok: true,
        chain: buyChain,
        withdrawFee: 0,
        verified: true,
        unverifiedVenues: [],
      };
    }

    // DEX bacağı varsa zincir sabittir; yoksa ortak zincirler aranır.
    const candidates = buyChain
      ? [buyChain]
      : sellChain
        ? [sellChain]
        : this.transfers.chainsFor(coin);

    if (candidates.length === 0) return { ok: false, reason: 'transfer' };

    let best: Extract<ChainPick, { ok: true }> | null = null;

    // Kimlik çakışması yüzünden elenen zincir oldu mu? Sayaç yalnızca HİÇBİR
    // zincir kalmadığında artar: başka bir zincirde adresler uyuşuyorsa fırsat
    // reddedilmiş değildir, yalnızca rota değişmiştir.
    let addressConflict = false;

    for (const chain of candidates) {
      const unverified: VenueId[] = [];
      let withdrawFee = 0;

      // KİMLİK KONTROLÜ — her şeyden önce.
      //
      // İki borsanın aynı ticker'ı farklı token'a verdiği ölçülmüş bir
      // gerçektir (DEFAI/solana: kucoin `hwfh2kn2…`, gate `8zx6ecj3…`).
      // Böyle bir çiftte "fırsat" transfer edilemez: gönderilen token
      // karşı borsada hiçbir şeye karşılık gelmez.
      //
      // Yalnızca İKİ TARAF DA adres bildirdiğinde karar veriyoruz. Bilinmeyen
      // adres çakışma sayılmaz (Bybit bu alanı hiç vermiyor; öyle sayılsaydı
      // Bybit'in bütün rotaları elenirdi).
      const buyAddr = this.venueAddress(buyVenue, coin, chain, priceQuote);
      const sellAddr = this.venueAddress(sellVenue, coin, chain, priceQuote);
      if (buyAddr && sellAddr && buyAddr !== sellAddr) {
        addressConflict = true;
        continue;
      }

      if (isCex(buyVenue)) {
        // Varlığı bu borsadan çekebilmeliyiz.
        const from = this.transfers.lookup(buyVenue, coin, chain, priceQuote);
        if (!from.withdrawEnabled) continue;
        // Asgari çekim tutarı: borsa bu miktarın ALTINI göndermez. Kontrol
        // edilmezse hiç gerçekleştirilemeyecek bir transfer fırsat olarak
        // yayınlanır — "ulaşılamaz fırsat" hata sınıfının ta kendisi. Bilgi
        // zaten dört borsadan da çekiliyordu, yalnızca kullanılmıyordu.
        if (from.withdrawMin > 0 && withdrawAmount < from.withdrawMin) continue;
        withdrawFee = from.withdrawFee;
        if (!from.verified) unverified.push(buyVenue);
      }

      if (isCex(sellVenue)) {
        // Varlığı bu borsaya yatırabilmeliyiz.
        const to = this.transfers.lookup(sellVenue, coin, chain, priceQuote);
        if (!to.depositEnabled) continue;
        if (!to.verified) unverified.push(sellVenue);
      }

      if (!best || withdrawFee < best.withdrawFee) {
        best = {
          ok: true,
          chain,
          withdrawFee,
          verified: unverified.length === 0,
          unverifiedVenues: unverified,
        };
      }
    }

    if (best) return best;
    // Gerekçe dönüş değerinde taşınıyor, sayaç burada artırılmıyor: sayacı hem
    // burada hem çağıran tarafta artırmak aynı elemeyi iki kovaya birden
    // yazardı ve panelde toplam eleme sayısı gerçeğin iki katı görünürdü.
    return { ok: false, reason: addressConflict ? 'address' : 'transfer' };
  }

  /**
   * Bir mekanın bu coin/zincir için bildirdiği kontrat/mint adresi.
   *
   * CEX tarafında kaynak borsanın kendi transfer tablosudur; DEX tarafında
   * `config/tokens.json` (zaten adres üzerinden tanımlı). İkisini aynı
   * fonksiyonda birleştirmek kasıtlı: kimlik kuralı CEX↔CEX, CEX↔DEX ve
   * DEX↔DEX için AYNI kural olmalı — ayrı yollara bölünürse biri güncellenip
   * diğeri unutulur.
   *
   * `null` = bilinmiyor. Çakışma DEĞİL.
   */
  private venueAddress(
    venue: VenueId,
    coin: string,
    chain: ChainId,
    priceQuote: number,
  ): string | null {
    if (isDex(venue)) {
      return DEX_CHAIN[venue as DexId] === chain
        ? (this.tokenAddresses.get(`${coin.toUpperCase()}|${chain}`) ?? null)
        : null;
    }
    return this.transfers.lookup(venue as CexId, coin, chain, priceQuote).address;
  }
}
