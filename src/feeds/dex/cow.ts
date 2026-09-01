/**
 * CoW Protocol — EVM zincirlerinde TOPLAYICI fiyat kaynağı.
 *
 * Diğer DEX feed'lerinden yapısal olarak farklı ve fark ÖNEMLİ: CoW bir AMM
 * değil, niyet (intent) tabanlı toplu açık artırma protokolü. Zincirde
 * sorgulanacak bir quoter kontratı YOK — dolayısıyla `EvmDexFeed`'in multicall
 * yolu buraya hiç uymaz; fiyat HTTP quote uçtasından alınır.
 *
 * ASIL KAZANÇ BU DEĞİL, ROTA. `EvmDexFeed` yalnızca DOĞRUDAN token↔USDC
 * havuzunu soruyor ve Base'de likidite ağırlıklı olarak WETH ile eşleştiği
 * için tokenların çoğu ya "havuz yok" ya da "toz havuz" diye eleniyordu. CoW
 * solver'ı çok adımlı rotayı KENDİSİ kuruyor; yani uzun süredir "bilinen
 * boşluk" olarak duran 2 adımlı WETH rotasını biz yazmadan kapatıyor.
 *
 * ÖLÇÜM (base, $1000 gidiş-dönüş, aynı tokenlar — Aerodrome doğrudan-USDC
 * rakamları CLAUDE.md'den):
 *
 *   token   Aerodrome   CoW        token   Aerodrome   CoW
 *   AERO    %0.62       %0.25      DEGEN   %158        %1.12
 *   PLAY    %13.1       %0.62      ZEN     %455        %0.45
 *   OFC     %16.8       %1.91      BRETT   %3389       %0.76
 *
 * Ayrıca tabloya hiç girememiş 43 Base tokenı denendi: 27'si CoW ile
 * fiyatlanıp sapma+spread filtrelerinden geçti.
 *
 * İKİNCİ FARK: CoW quote'u GERÇEKLEŞECEK miktarı döndürür (ücret dahil), orta
 * fiyat değil. Bu yüzden Jupiter'in aksine ayrı bir Aşama 2 doğrulayıcısına
 * (`DexLegQuoter`) ihtiyaç duymaz — `EvmDexFeed` gibi store'a gerçek miktarlı
 * bid/ask yazar ve tarayıcı doğrudan VWAP hesaplayabilir.
 *
 * EKSİK KALAN: quote bir NİYET fiyatıdır; emir imzalanıp solver tarafından
 * toplu açık artırmada eşleştirilir, AMM'deki gibi anında ve atomik değildir.
 * v1 yalnızca tespit/bildirim yaptığı için bu fark bugün maliyetsiz, ama v2'de
 * emir gönderilecekse bacak modeli AMM'den farklı kurulmak zorunda.
 *
 * ÖLÇEK SINIRI — OKUMADAN TOKEN EKLEME. Bu feed geniş tarama (Aşama 1) yapıyor
 * ve maliyeti token başına 2 istek/tur. Ücretsiz uç nokta bunu 75 tokende
 * KALDIRMIYOR: ~8 istek/sn'lik sürekli yük birkaç dakikada CloudFront bloğu
 * (403 + HTML) getirdi. Kova bu yüzden 2/sn ve o hızda 75 tokenlık tur ~94 sn
 * sürüyor — `MAX_DEX_PRICE_AGE_MS`'in (30 sn) çok üstünde, yani bu ölçekte
 * CoW geniş tarama kaynağı olarak KULLANILAMAZ. `start()` bunu sessizce
 * geçmiyor, panele yapısal uyarı yazıyor.
 *
 * Doğru yer mimaride zaten tarif edilmiş: CoW'un ucuz olmayan ama KESİN olan
 * quote'u Aşama 2'ye aittir (Solana'da `DexQuoter`'ın yaptığı iş). O düzende
 * geniş taramayı zincirden okuyan ucuz bir kaynak yapar, CoW yalnızca aday
 * çıktığında çağrılır ve istek sayısı turla değil ADAY sayısıyla ölçeklenir.
 * Bugünkü kod bu ayrımı YAPMIYOR; yapılana kadar CoW'u küçük bir token
 * listesiyle kullan.
 */

import { httpJson, HttpError } from '../../core/http.ts';
import type { PriceStore } from '../../book/price-store.ts';
import type { ChainId, DexId, Feed, FeedHealth, FeedState, PairKey } from '../../core/types.ts';
import { RateCounter } from '../../core/metrics.ts';
import { guvenliAralik } from './solana-price.ts';

/** CoW'un zincir başına API yolu. */
const CHAIN_PATH: Partial<Record<ChainId, string>> = {
  base: 'base',
  arbitrum: 'arbitrum_one',
};

/**
 * CoW'un konuşabildiği zincirler — `CHAIN_PATH`'ten TÜRETİLİR.
 *
 * Elle yazılmış kopya bir dizi, yeni bir zincir eklendiğinde çapraz kontrolün
 * sessizce kapalı kalması demekti; bu botta aynı hata `dexVenues` ile bir kez
 * yaşandı (venue eklendi, kopya liste güncellenmedi, rapor yanlış söyledi).
 */
export const COW_CHAINS: readonly ChainId[] = Object.keys(CHAIN_PATH) as ChainId[];

/**
 * Quote isteğinde zorunlu olan `from` alanı.
 *
 * İmzalanmayacak, gönderilmeyecek bir fiyat sorgusu yapıyoruz; CoW yine de
 * geçerli bir adres istiyor. Sabit ve bakiyesi olmayan bir adres kullanmak
 * kasıtlı: gerçek bir cüzdan adresi yazmak, fiyat sorgularımızı o adresle
 * ilişkilendirir ve hiçbir karşılığı yoktur.
 */
const QUOTE_FROM = '0x2222222222222222222222222222222222222222';

/**
 * Gidiş-dönüş spread'i bunu aşan token, işlem büyüklüğümüzde fiyatlanamıyor
 * demektir. `EvmDexFeed`'deki eşikle AYNI tutuldu — iki feed farklı eşik
 * kullanırsa aynı token bir venue'da "geçerli" diğerinde "bozuk" olur ve
 * tarayıcı ikisini karşılaştırıp sahte sinyal üretir.
 */
const MAX_ROUNDTRIP_SPREAD = 0.25;

/** Art arda kaç kötü tur sonra durum `failed` olur (bkz. evm.ts). */
const FAILURE_TOLERANCE = 3;

/**
 * Tur BAŞARILIYKEN bu kadar kez üst üste fiyatlanamayan token sorgudan
 * çıkarılır. CoW'da bu tasarrufun değeri EvmDexFeed'dekinden yüksek: orada
 * elenen token bir multicall yuvası yakıyordu, burada iki ayrı HTTP isteği
 * yakıyor ve tur süresini doğrudan uzatıyor.
 */
const NO_ROUTE_ROUNDS = 20;

/** Rotasız sayılan token bu tur aralığıyla yeniden denenir. */
const REPROBE_EVERY = 100;

/** Tolerans aşıldıktan sonraki ilk geri çekilme süresi. */
const GERI_CEKILME_TABAN_MS = 30_000;
/** Geri çekilme tavanı — blok geçici, feed kendi kendine toparlayabilmeli. */
const GERI_CEKILME_TAVAN_MS = 15 * 60_000;

/**
 * Kova (5/sn) zaten hız sınırını uyguluyor; buradaki eşzamanlılık yalnızca
 * istek gecikmesinin (p50 ~150 ms) kovanın boşta beklemesine yol açmasını
 * engelliyor. Sıralı beklemede tur süresi gereksiz yere ikiye katlanırdı.
 */
const MAX_INFLIGHT = 8;

/**
 * Kovanın (`core/http.ts` → `api.cow.fi`, 2/sn) dakikalık karşılığı.
 * `guvenliAralik` periyodu bundan türetiyor; kova ile bu sayı BİRLİKTE
 * değişmeli, yoksa periyot limitin üstünde istek üretir, istekler kovada
 * kuyruğa girer ve tur süresi sessizce şişer.
 */
const COW_PER_MINUTE = 120;

export interface CowToken {
  readonly symbol: string;
  readonly address: string;
  readonly decimals: number;
  readonly pair: PairKey;
  /** PriceStore satırı. */
  readonly slot: number;
}

export interface CowFeedConfig {
  readonly venue: DexId;
  readonly chain: ChainId;
  readonly quoteToken: { address: string; decimals: number };
  readonly tokens: readonly CowToken[];
  /** Quote'ların alınacağı işlem büyüklüğü (quote token cinsinden). */
  readonly tradeSize: number;
  readonly pollIntervalMs?: number;
  /**
   * DEX fiyatının bayat sayıldığı yaş (`MAX_DEX_PRICE_AGE_MS`).
   *
   * Feed bunu KULLANMIYOR, yalnızca kendi periyoduyla karşılaştırıp uyarıyor.
   * Sebep: periyot token sayısıyla birlikte büyüyor (tur başına 2 istek/token,
   * kova sabit), bayatlık eşiği ise sabit. Liste yeterince büyüdüğünde periyot
   * eşiği geçer ve her okuma bayat sayılır — yani Base CEX↔DEX fırsatı
   * YAPISAL olarak üretilemez hale gelir. Bu tam olarak tek bayatlık eşiği
   * kullanılırken bir kez yaşanmış hata sınıfı: hiçbir yerde hata görünmüyor,
   * DEX bacağı sessizce ölü ağırlığa dönüşüyor.
   */
  readonly maxPriceAgeMs?: number;
  /** Test enjeksiyonu — verilmezse gerçek HTTP kullanılır. */
  readonly quoter?: CowQuoter;
}

/**
 * Tek bir quote çağrısı. Arayüz kasıtlı olarak dar tutuldu (`EvmDexFeed`'in
 * `MulticallClient`'ı gibi): testler ağa çıkmadan tur sonuçlarını taklit
 * edebilsin, durum makinesi deterministik doğrulanabilsin.
 *
 * @returns alınan ham miktar, ya da rota yoksa `null`
 */
export interface CowQuoter {
  quote(sellToken: string, buyToken: string, sellAmount: bigint): Promise<bigint | null>;
}

/**
 * Cevap gövdesi CoW'un KENDİ hata biçimi mi (yani "rota yok" anlamına gelen
 * gerçek bir API cevabı), yoksa araya giren bir katmanın HTML'i mi?
 */
export function cowHatasiMi(govde: string): boolean {
  try {
    const j = JSON.parse(govde) as { errorType?: unknown };
    return typeof j.errorType === 'string';
  } catch {
    return false;
  }
}

/** Gerçek HTTP quoter'ı. */
export class HttpCowQuoter implements CowQuoter {
  constructor(private readonly chain: ChainId) {}

  async quote(sellToken: string, buyToken: string, sellAmount: bigint): Promise<bigint | null> {
    const path = CHAIN_PATH[this.chain];
    if (!path) throw new Error(`cow: ${this.chain} desteklenmiyor`);

    try {
      const res = await httpJson<{ quote?: { buyAmount?: string } }>(
        `https://api.cow.fi/${path}/api/v1/quote`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sellToken,
            buyToken,
            from: QUOTE_FROM,
            receiver: QUOTE_FROM,
            sellAmountBeforeFee: sellAmount.toString(),
            kind: 'sell',
            partiallyFillable: false,
            sellTokenBalance: 'erc20',
            buyTokenBalance: 'erc20',
            signingScheme: 'eip712',
            onchainOrder: false,
            // `optimal` solver'ları tam simülasyona sokuyor ve belirgin şekilde
            // yavaş; geniş taramada gereken hassasiyet bu değil.
            priceQuality: 'fast',
            validFor: 600,
          }),
          timeoutMs: 8000,
          // Fiyat zamana duyarlı — geç gelen cevapla hesaplanan kâr gerçek
          // değil. Tur zaten periyodik, bir sonraki turda yeniden denenir.
          retries: 0,
        },
      );

      const raw = res.quote?.buyAmount;
      if (!raw) return null;
      const v = BigInt(raw);
      return v > 0n ? v : null;
    } catch (e) {
      // "Rota yok" ile "engellendik" AYRI şeyler ve ayırt edici işaret HTTP
      // kodu DEĞİL, gövdenin JSON olması.
      //
      // ÖLÇÜLEN HATA: her 4xx `null` (= rota yok) sayılıyordu. CoW'un önünde
      // CloudFront var ve sürekli yükte IP'yi **403 + HTML** ile blokluyor
      // (429 değil — "0×429 ölçtüm" bu yüzden yanıltıcıydı). Feed o anda 75
      // tokenın 75'i için `null` alıp "hiçbirine rota yok" diyordu: yani
      // altyapı bloğunu likidite yokluğu gibi raporluyordu. Kullanıcı tokenları
      // silmeye çalışırdı; sorun tokenlarda değildi.
      //
      // CoW gerçek "rota yok" cevabını JSON gövdeyle ve `errorType` alanıyla
      // verir (NoLiquidity, SellAmountDoesNotCoverFee, …). Gövde JSON değilse
      // konuştuğumuz şey CoW değil, önündeki CDN'dir → arıza olarak fırlat.
      if (e instanceof HttpError && e.status >= 400 && e.status < 500) {
        if (cowHatasiMi(e.bodySnippet)) return null;
        throw new Error(`CoW erişimi engellendi (HTTP ${e.status}, JSON olmayan cevap)`);
      }
      throw e;
    }
  }
}

export class CowFeed implements Feed {
  readonly venue: DexId;
  readonly chain: ChainId;

  private timer: NodeJS.Timeout | null = null;
  private state: FeedState = 'idle';
  private lastTickTs = 0;
  private lastError: string | null = null;
  private errorCount = 0;
  private readonly rate = new RateCounter();
  private polling = false;

  private readonly quoter: CowQuoter;
  private readonly priced: readonly CowToken[];
  private readonly failStreak: Uint32Array;
  /** Son ölçülen gidiş-dönüş spread'i — "havuz yok" ile "ince" ayrımı için. */
  private readonly lastSpread: Float64Array;
  private rounds = 0;
  private badStreak = 0;

  constructor(
    private readonly store: PriceStore,
    private readonly cfg: CowFeedConfig,
  ) {
    this.venue = cfg.venue;
    this.chain = cfg.chain;
    this.quoter = cfg.quoter ?? new HttpCowQuoter(cfg.chain);

    const q = cfg.quoteToken.address.toLowerCase();
    this.priced = cfg.tokens.filter((t) => t.address.toLowerCase() !== q);
    this.failStreak = new Uint32Array(this.priced.length);
    this.lastSpread = new Float64Array(this.priced.length);
  }

  async start(): Promise<void> {
    if (this.priced.length === 0) {
      this.state = 'idle';
      this.lastError = `${this.chain} için taranacak token yok`;
      return;
    }

    this.state = 'connecting';
    await this.poll();

    // Periyot SABİT DEĞİL, limitten türetiliyor — token listesi büyüdükçe tur
    // başına istek sayısı artıyor ve sabit periyot sessizce 429 yemek demek
    // olurdu (feed açık kalır, panel "live" der, fiyatlar bayatlar).
    // Tur başına 2 istek/token: alış ve satış bacağı.
    const interval = guvenliAralik(
      this.priced.length * 2,
      COW_PER_MINUTE,
      this.cfg.pollIntervalMs ?? 5000,
    );
    this.timer = setInterval(() => void this.poll(), interval);

    // Periyot bayatlık bütçesini aşarsa fiyatlar yazıldıkları anda eskimiş
    // sayılır ve tarayıcı bu venue'yu hiç değerlendiremez. Sessiz kalmak
    // yasak: feed "live" görünürken bacağın ölü olması, panelin yalan
    // söylediği durumdur.
    const butce = this.cfg.maxPriceAgeMs;
    if (butce !== undefined && interval >= butce) {
      this.periyotUyarisi =
        `tarama periyodu ${(interval / 1000).toFixed(0)} sn — ` +
        `bayatlık eşiği ${(butce / 1000).toFixed(0)} sn'yi AŞIYOR, bu venue taranamaz. ` +
        `Token sayısını azalt ya da MAX_DEX_PRICE_AGE_MS'i yükselt.`;
    }
  }

  /** Kurulumda saptanan yapısal sorun — her turda teşhisin başına eklenir. */
  private periyotUyarisi: string | null = null;

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.state = 'idle';
  }

  /**
   * Bir tur: her token için "USDC → token" (alış) ve ardından alınan miktarla
   * "token → USDC" (satış).
   *
   * Satış bacağının girdisi alış bacağının ÇIKTISI olmak zorunda — sabit bir
   * miktarla sormak farklı bir işlem büyüklüğünü fiyatlar ve gidiş-dönüş
   * spread'i anlamsızlaşır.
   */
  private async poll(): Promise<void> {
    if (this.polling) return;
    // Geri çekilme penceresi: art arda patlayan turlardan sonra ZAMANLAYICI
    // aynı hızda tetiklenmeye devam ediyor, o yüzden frenlemek burada olmalı.
    //
    // Sebebi ölçüldü: engellenmiş bir uca sabit hızla istek atmak yalnızca
    // boşa gitmiyor, BLOĞU UZATIYOR — CloudFront kararını süregelen yüke göre
    // veriyor. Yani "nasılsa hata alıyoruz, denemeye devam" davranışı kendi
    // kendini besleyen bir tuzak. Diğer feed'lerde bu sorun yok çünkü onların
    // karşısındaki RPC bizi bloklamıyor, yalnızca hata döndürüyor.
    if (Date.now() < this.geriCekilmeSonu) return;
    this.polling = true;
    this.rounds++;

    try {
      const amountIn = BigInt(
        Math.floor(this.cfg.tradeSize * 10 ** this.cfg.quoteToken.decimals),
      );

      const aktif: number[] = [];
      for (let i = 0; i < this.priced.length; i++) {
        if (this.rotasiz(i)) continue;
        aktif.push(i);
      }

      if (aktif.length === 0) {
        this.state = 'idle';
        this.lastError = 'fiyatlanacak token yok';
        return;
      }

      const now = Date.now();
      let written = 0;
      let alisOk = 0;
      let satisOk = 0;
      let ince = 0;
      let apiHatasi = 0;
      let sonHata: string | null = null;
      const yazildi = new Uint8Array(this.priced.length);

      await this.esZamanli(aktif, async (i) => {
        const t = this.priced[i]!;

        // Hata TOKEN BAŞINA yakalanır, tur başına değil.
        //
        // ÖLÇÜLEN HATA: istisna `Promise.all`'dan yukarı sızıyordu ve tek bir
        // tokenın 5xx'i bütün turu düşürüyordu. 75 tokenda tur başına 150
        // istek var; birinin patlaması neredeyse kesin, dolayısıyla feed
        // kalıcı olarak `failed` kalıyordu — canlı koşuda tam olarak bu oldu.
        // Bir tokenın arızası diğer 74'ünün fiyatını çöpe atmamalı.
        try {
          const boughtRaw = await this.quoter.quote(
            this.cfg.quoteToken.address,
            t.address,
            amountIn,
          );
          if (boughtRaw === null || boughtRaw <= 0n) return;
          alisOk++;

          const soldRaw = await this.quoter.quote(
            t.address,
            this.cfg.quoteToken.address,
            boughtRaw,
          );
          if (soldRaw === null || soldRaw <= 0n) return;
          satisOk++;

          const bought = Number(boughtRaw) / 10 ** t.decimals;
          const sold = Number(soldRaw) / 10 ** this.cfg.quoteToken.decimals;
          if (!(bought > 0) || !(sold > 0)) return;

          // ask: bu tokenı almanın birim maliyeti
          // bid: bu tokenı satmanın birim getirisi
          const ask = this.cfg.tradeSize / bought;
          const bid = sold / bought;
          if (!(ask > 0) || !(bid > 0)) return;

          const spread = (ask - bid) / bid;
          this.lastSpread[i] = spread;

          // Rota bu büyüklüğü taşımıyorsa store'a HİÇ yazmayız: anlamsız bir
          // sayıyı motora sokmak, tokenı sonsuza dek "başarılı" gösterip
          // elenmesini de engellerdi.
          if (spread > MAX_ROUNDTRIP_SPREAD) {
            ince++;
            return;
          }

          this.store.write(t.slot, bid, bought, ask, bought, now, now);
          yazildi[i] = 1;
          this.failStreak[i] = 0;
          written++;
        } catch (e) {
          apiHatasi++;
          sonHata = (e as Error).message.slice(0, 100);
        }
      });

      // Tur ancak çoğunluk patladığında "API arızası" sayılır: azınlık hata
      // tek tek tokenların sorunudur ve zaten `failStreak` ile eleniyor.
      if (apiHatasi > aktif.length / 2) {
        this.errorCount++;
        this.noteFailure(`CoW API: ${apiHatasi}/${aktif.length} istek patladı — ${sonHata}`);
        return;
      }

      for (const i of aktif) if (!yazildi[i]) this.failStreak[i]!++;

      this.rate.tick(now);
      this.lastTickTs = now;
      this.onRoundResult({
        written,
        alisOk,
        satisOk,
        ince,
        denenen: aktif.length,
        apiHatasi,
      });
    } catch (e) {
      this.errorCount++;
      this.noteFailure(`CoW API: ${(e as Error).message.slice(0, 100)}`);
    } finally {
      this.polling = false;
    }
  }

  /** Sabit sayıda eşzamanlı işçiyle listeyi tüketir. */
  private async esZamanli(
    idx: readonly number[],
    is: (i: number) => Promise<void>,
  ): Promise<void> {
    let next = 0;
    const isci = async (): Promise<void> => {
      for (;;) {
        const k = next++;
        if (k >= idx.length) return;
        await is(idx[k]!);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(MAX_INFLIGHT, idx.length) }, () => isci()),
    );
  }

  /** Bu token rotasız sayıldığı için bu turda atlanmalı mı? */
  private rotasiz(i: number): boolean {
    if (this.failStreak[i]! < NO_ROUTE_ROUNDS) return false;
    return this.rounds % REPROBE_EVERY !== 0;
  }

  /**
   * Turun sonucunu duruma çevirir — `EvmDexFeed` ile aynı dört teşhis.
   * Sıfır yazımın sebebi panelde görünmeli, yoksa "failed" tek etiketi
   * "API bozuk" ile "likidite yok"u aynı kovaya koyar.
   */
  private onRoundResult(b: {
    written: number;
    alisOk: number;
    satisOk: number;
    ince: number;
    denenen: number;
    apiHatasi: number;
  }): void {
    const { written, alisOk, satisOk, ince, denenen, apiHatasi } = b;
    if (written > 0) {
      this.state = 'live';
      this.badStreak = 0;
      const { yok, ince: inceler } = this.elenenler();
      const parcalar: string[] = [];
      // Azınlık API hatası turu düşürmüyor ama gizlenmemeli: kalıcı hale
      // gelirse tek işaret bu satır olur.
      if (apiHatasi > 0) parcalar.push(`${apiHatasi} istek patladı`);
      if (yok.length > 0) parcalar.push(`rota yok: ${yok.join(',')}`);
      if (inceler.length > 0) parcalar.push(`rota ince: ${inceler.join(',')}`);
      this.lastError =
        parcalar.length > 0
          ? `${parcalar.join(' · ')} (${written}/${denenen} fiyatlandı)`
          : null;
      return;
    }

    let sebep: string;
    if (ince > 0 && ince >= satisOk) {
      sebep = `${ince}/${denenen} token $${this.cfg.tradeSize} işlemini taşımıyor`;
    } else if (alisOk === 0) {
      // CoW toplayıcı olduğu için burası ANLAMLI bir sinyal: doğrudan havuz
      // yokluğu değil, hiçbir rota bulunamaması demek.
      sebep = `${denenen} token'ın hiçbirine rota yok — CoW API'si sağlıklı ama likidite yok`;
    } else {
      sebep = `alış ${alisOk}/${denenen} geçti ama satış tarafı fiyatlanamadı`;
    }
    this.noteFailure(sebep);
  }

  private noteFailure(sebep: string): void {
    this.badStreak++;
    if (this.badStreak >= FAILURE_TOLERANCE) this.state = 'failed';

    // Tolerans aşıldıktan sonra üstel geri çekilme (30 sn → 15 dk tavan).
    // Tavan var çünkü blok geçici: sonsuza kadar uzayan bir bekleme, uç nokta
    // düzeldiğinde feed'in kendi kendine toparlanmasını engellerdi.
    let bekleme = 0;
    if (this.badStreak >= FAILURE_TOLERANCE) {
      const us = Math.min(this.badStreak - FAILURE_TOLERANCE, 5);
      bekleme = Math.min(GERI_CEKILME_TABAN_MS * 2 ** us, GERI_CEKILME_TAVAN_MS);
      this.geriCekilmeSonu = Date.now() + bekleme;
    }

    this.lastError =
      this.badStreak < FAILURE_TOLERANCE
        ? `${sebep} (${this.badStreak}/${FAILURE_TOLERANCE} tur)`
        : `${sebep} · ${(bekleme / 1000).toFixed(0)} sn bekleniyor (${this.badStreak}. hata)`;
  }

  /** Bu ana kadar yeni tur başlatılmaz. */
  private geriCekilmeSonu = 0;

  private elenenler(): { yok: string[]; ince: string[] } {
    const yok: string[] = [];
    const ince: string[] = [];
    for (let i = 0; i < this.priced.length; i++) {
      if (this.failStreak[i]! < NO_ROUTE_ROUNDS) continue;
      (this.lastSpread[i]! > MAX_ROUNDTRIP_SPREAD ? ince : yok).push(this.priced[i]!.symbol);
    }
    return { yok, ince };
  }

  health(): FeedHealth {
    const now = Date.now();
    // Yapısal uyarı tur teşhisinin ÖNÜNE geçer: "rota yok: X" gibi normal bir
    // mesaj, venue'nun tamamen taranamıyor olmasını gölgelememeli.
    const hata =
      this.periyotUyarisi !== null
        ? `${this.periyotUyarisi}${this.lastError ? ` · ${this.lastError}` : ''}`
        : this.lastError;
    return {
      venue: this.venue,
      state: this.state,
      lastTickAgeMs: this.lastTickTs === 0 ? -1 : now - this.lastTickTs,
      msgsPerSec: this.rate.perSec(now),
      reconnects: this.errorCount,
      latencyP50: 0,
      latencyP99: 0,
      clockSkewMs: 0,
      subscribedCount: this.priced.length,
      lastError: hata,
    };
  }
}
