/**
 * EVM DEX fiyat kaynağı — Base/Aerodrome ve Arbitrum/Camelot + Uniswap V3.
 *
 * Tasarım: her turda TEK multicall ile tüm tokenların hem alış hem satış
 * fiyatını çekiyoruz. Token başına ayrı RPC çağrısı yapmak hem yavaş hem de
 * public uç noktaları boğuyor (verify-contracts'ı yazarken tam olarak bunu
 * yaşadık) — multicall ile 14 token 28 quote'a rağmen tek istek.
 *
 * CEX'lerin aksine burada gerçek bir "defter" yok: quoter zaten belirli bir
 * girdi miktarı için gerçekleşecek çıktıyı, yani slippage dahil fiyatı
 * döndürüyor. Bu yüzden DEX tarafında ayrıca VWAP hesaplamıyoruz — quote'un
 * kendisi VWAP'ın karşılığı. Bunu doğru yapmak için quote'u taradığımız
 * İŞLEM BÜYÜKLÜĞÜYLE alıyoruz, 1 birimlik sembolik miktarla değil.
 *
 * Adresler config/dex.json'da ve scripts/verify-contracts.ts ile zincirden
 * doğrulanmış durumda.
 */

import {
  BaseError,
  HttpRequestError,
  InternalRpcError,
  LimitExceededRpcError,
  ResourceUnavailableRpcError,
  SocketClosedError,
  TimeoutError,
  WebSocketRequestError,
  createPublicClient,
  http,
  webSocket,
  parseAbi,
  type Address,
  type PublicClient,
} from 'viem';
import { base, arbitrum } from 'viem/chains';
import type { PriceStore } from '../../book/price-store.ts';
import type {
  ChainId,
  DexId,
  Feed,
  FeedHealth,
  FeedState,
  PairKey,
} from '../../core/types.ts';
import { RateCounter } from '../../core/metrics.ts';

export const AERODROME_ABI = parseAbi([
  'struct Route { address from; address to; bool stable; address factory; }',
  'function getAmountsOut(uint256 amountIn, Route[] routes) view returns (uint256[] amounts)',
]);

export const UNIV3_QUOTER_ABI = parseAbi([
  'struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }',
  'function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

export const ALGEBRA_QUOTER_ABI = parseAbi([
  'function quoteExactInputSingle(address tokenIn, address tokenOut, uint256 amountIn, uint160 limitSqrtPrice) returns (uint256 amountOut, uint16 fee)',
]);

/**
 * Çok adımlı (path) quote'lar. Tek atlamalı sürümden AYRI fonksiyonlar.
 *
 * Yol kodlaması venue'ya göre farklı:
 *   UniV3   tokenIn(20) + fee(3) + ara(20) + fee(3) + tokenOut(20)
 *   Algebra tokenIn(20) + ara(20) + tokenOut(20)   — fee havuzdan okunur
 */
export const UNIV3_PATH_ABI = parseAbi([
  'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
]);

export const ALGEBRA_PATH_ABI = parseAbi([
  'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint16[] fees)',
]);

/** EVM adresleri büyük/küçük harf duyarsızdır. */
const eq = (a: Address, b: Address): boolean => a.toLowerCase() === b.toLowerCase();

const hx = (a: Address): string => a.slice(2).toLowerCase();
const fee3 = (f: number): string => f.toString(16).padStart(6, '0');

/** UniV3 çok adımlı yol baytları. */
function univ3Path(a: Address, feeA: number, mid: Address, feeB: number, b: Address): `0x${string}` {
  return `0x${hx(a)}${fee3(feeA)}${hx(mid)}${fee3(feeB)}${hx(b)}`;
}

/** Algebra (Camelot) çok adımlı yol baytları — fee alanı yok. */
function algebraPath(a: Address, mid: Address, b: Address): `0x${string}` {
  return `0x${hx(a)}${hx(mid)}${hx(b)}`;
}

export interface EvmToken {
  readonly symbol: string;
  readonly address: Address;
  readonly decimals: number;
  readonly pair: PairKey;
  readonly slot: number;
}

/**
 * `poll()` döngüsünün RPC'den ihtiyaç duyduğu tek şey.
 *
 * Arayüz kasıtlı olarak dar: testler viem istemcisini kurmadan, ağa
 * çıkmadan tur sonuçlarını taklit edebiliyor. Durum makinesi (tolerans,
 * rotasız token eleme) ancak böyle deterministik doğrulanabilir.
 */
export interface MulticallClient {
  multicall(args: { contracts: unknown; allowFailure: boolean }): Promise<MulticallResult[]>;
}

export interface EvmDexConfig {
  readonly venue: DexId;
  readonly chain: ChainId;
  readonly rpcUrl: string;
  /** Test enjeksiyonu. Verilmezse `rpcUrl`'den gerçek viem istemcisi kurulur. */
  readonly client?: MulticallClient;
  /** Fiyatlamada referans alınan stablecoin (genelde USDC). */
  readonly quoteToken: { address: Address; decimals: number };
  readonly tokens: readonly EvmToken[];
  /** Quote'ların alınacağı işlem büyüklüğü (quote token cinsinden). */
  readonly tradeSize: number;
  readonly pollIntervalMs?: number;
  /**
   * DEX fiyatının bayat sayıldığı yaş (`MAX_DEX_PRICE_AGE_MS`).
   *
   * Feed bunu kullanmıyor, yalnızca ÖLÇÜLEN tur süresiyle karşılaştırıp
   * uyarıyor. Burada yapılandırılmış periyot değil gerçekleşen süre önemli:
   * `poll()` üst üste binmeyi engellediği için tur `pollIntervalMs`'ten uzun
   * sürerse periyot fiilen tur süresine eşitlenir ve bu HİÇBİR YERDE
   * görünmezdi.
   *
   * ÖLÇÜLDÜ (Base, token sayısı 11 → 75'e çıkınca): aerodrome turu 57 sn,
   * uniswap-v3-base 61 sn — ikisi de 30 sn'lik bütçenin üstünde, yani her
   * okuma bayat ve Base CEX↔DEX bacağı yapısal olarak sinyal üretemiyor.
   * Panel bu sırada üç venue için de "live" diyordu; kapsamı büyütmenin
   * sinyal üretimini öldürebildiği, ancak ölçülünce görülen bir etki.
   */
  readonly maxPriceAgeMs?: number;

  /**
   * Ara token (Base ve Arbitrum'da WETH) — 2 adımlı rota için.
   *
   * ÖLÇÜLDÜ ve bu botun en uzun süre açık kalan boşluğuydu: Base'de likidite
   * ağırlıklı olarak WETH ile eşleşiyor, doğrudan token↔USDC havuzu ya yok ya
   * toz. `KTA` örneği — doğrudan rota $1000 karşılığı **0.0109 KTA** veriyor
   * (fiilen bozuk), WETH üzerinden **10522 KTA**; ask $0.0950, bid $0.0938,
   * gidiş-dönüş spread %1.36 ve CEX referansı $0.0932–0.0940. Yani 2 adımlı
   * rota yalnızca kapsam açmıyor, DOĞRU fiyatı veren rota o.
   *
   * Verilmezse yalnızca doğrudan rota sorulur (eski davranış).
   */
  readonly hopToken?: Address;
  /**
   * Ara token ↔ quote token bacağının fee tier'ı (yalnızca UniV3).
   *
   * Sabit tutuluyor çünkü WETH/USDC her zincirde en likit havuzdur ve tier'ı
   * bilinir; onu da taramak quote sayısını tier² yapardı.
   */
  readonly hopQuoteFee?: number;
  /** Aerodrome (Base) */
  readonly aerodrome?: { router: Address; factory: Address };
  /** Uniswap V3 (Arbitrum) */
  readonly uniswapV3?: { quoterV2: Address; feeTiers: readonly number[] };
  /** Camelot / Algebra (Arbitrum) */
  readonly camelot?: { quoterV2: Address };
}

type MulticallResult = { status: 'success' | 'failure'; result?: unknown; error?: unknown };

/**
 * `failure` girdisi TAŞIMA arızası mı, yoksa veri mi?
 *
 * viem `allowFailure: true` ile HİÇBİR hatayı fırlatmaz: ağ, timeout, 429 da
 * dahil her şey `{status:'failure', error}` girdisine çevrilir
 * (viem/actions/public/multicall.js, "results.push({ error, status: 'failure' })").
 * Dolayısıyla `poll()`'un `catch` dalı gerçek RPC arızasında hiç çalışmıyordu:
 * bütün alışlar `null` geliyor, `alisOk === 0` oluyor, her token'ın
 * `failStreak`'i artıyor ve 20 tur sonra tablo "rotasız" ilan ediliyordu —
 * teşhis metni de "rota/kontrat sorunu, RPC değil" diyordu. Ölçüldü:
 * 127.0.0.1:9'a (connection refused) bağlı gerçek viem istemcisi 22 turda tüm
 * tokenları `idle`'a düşürdü. Test bunu göremiyordu çünkü sahte istemci
 * `Promise.reject` yapıyordu; gerçek viem bunu yapmıyor.
 *
 * Ayrım: taşıma katmanı (HTTP, timeout, soket, RPC kota/iç hata) ARIZADIR ve
 * fırlatılır — `catch` dalı `errorCount`'u artırıp "RPC: …" yazar ve
 * `failStreak`'e dokunmaz. Kontrat revert'i, boş dönüş, "execution reverted"
 * ise VERİDİR (havuz yok ya da multicall gas bütçesi) ve `failure` olarak
 * kalır. Hata taşımayan `failure` (test sahteleri) de veri sayılır.
 */
export function tasimaArizasiMi(e: unknown): boolean {
  if (e === undefined || e === null) return false;
  // viem dışı bir hata buraya ancak ağ katmanından gelir.
  if (!(e instanceof BaseError)) return true;
  return (
    e.walk(
      (c) =>
        c instanceof HttpRequestError ||
        c instanceof TimeoutError ||
        c instanceof WebSocketRequestError ||
        c instanceof SocketClosedError ||
        c instanceof LimitExceededRpcError ||
        c instanceof InternalRpcError ||
        c instanceof ResourceUnavailableRpcError,
    ) !== null
  );
}

/**
 * Art arda kaç kötü tur sonra durum `failed` olur.
 *
 * Tek bir kötü tur paneli kırmızıya boyamamalı: DEX fiyatı ancak blok
 * değişince değişir ve DEX bayatlık eşiği 30 sn (`MAX_DEX_PRICE_AGE_MS`).
 * 3 sn'lik periyotla üç tur = 9 sn, yani hâlâ bayatlık penceresi içindeyiz —
 * motor bu sürede zaten eski fiyatı kullanmaya devam ediyor. Daha yükseğe
 * çekmek gerçek kesintiyi gizler, 1'e indirmek her hıçkırığı arıza gösterir.
 */
const FAILURE_TOLERANCE = 3;

/**
 * Tur BAŞARILIYKEN bu kadar kez üst üste fiyatlanamayan token "rotasız"
 * sayılır ve sorgudan çıkarılır.
 *
 * Ölçüldü: Camelot'ta `MAGIC` için doğrudan USDC havuzu yok ve 10 turun
 * 10'unda da başarısız oldu. Böyle bir token her turda bir quote yuvası
 * yakar, başarı oranını kalıcı olarak aşağı çeker ve "failed" teşhisini
 * kirletir. Sayaç yalnızca turun kendisi başarılı olduğunda artar — aksi
 * halde RPC arızası token'ı haksızca rotasız ilan ederdi.
 */
const NO_ROUTE_ROUNDS = 20;

/**
 * Rotasız sayılan token bu tur aralığıyla yeniden denenir.
 *
 * Kalıcı eleme yanlış olurdu: havuz sonradan açılabilir ve o token bir daha
 * asla sorgulanmazsa bunu hiç öğrenemeyiz.
 */
const REPROBE_EVERY = 100;

/**
 * Gidiş-dönüş spread'i bunu aşan token, işlem büyüklüğümüzde fiyatlanamıyor
 * demektir.
 *
 * ÖLÇÜM (Base/Aerodrome, doğrudan USDC rotası, $1000): AERO %0.6 — sağlıklı;
 * PLAY %13, OFC %16.7, DEGEN %158, ZEN %455, BRETT %3389. Yani havuz VAR ve
 * `getAmountsOut` başarıyla dönüyor, ama $1000 havuzu deviriyor. Teknik
 * başarı ile ekonomik kullanılabilirlik aynı şey değil.
 *
 * Eşik kasıtlı olarak GENİŞ. Bu fiyatlar tarayıcı için zaten güvenli yönde
 * hatalı — şişmiş ask DEX'i asla en ucuz alış yeri yapmaz, çökük bid asla en
 * iyi satış yeri yapmaz — dolayısıyla sahte sinyal riski yok, tek maliyet
 * boşa giden RPC yuvası. O yüzden yalnızca tartışmasız bozuk olanları
 * eliyoruz: %13 ve %16.7 kalıyor, %158 ve üstü gidiyor. Daraltmak gerçek bir
 * fırsatı eleyebilir, çünkü bu değerler bizim işlem büyüklüğümüze özgüdür.
 */
const MAX_ROUNDTRIP_SPREAD = 0.25;

/**
 * Tek multicall'a konulacak azami quote sayısı.
 *
 * Multicall3'ün `aggregate3`'ü bütün çağrıları TEK bir `eth_call` içinde ve
 * TEK gas bütçesiyle çalıştırır. Havuzu olmayan bir token'ın quoter çağrısı
 * revert ederken bütçeyi tüketiyor ve kendisiyle alakasız çağrılar da
 * düşüyor — `allowFailure: true` buna çare DEĞİL, çünkü sorun tek tek
 * çağrıların revert etmesi değil, ortak bütçenin bitmesi.
 *
 * ÖLÇÜM (Arbitrum/Camelot, arb1 public RPC, aynı token listesi):
 *   n=4 → 4/4 başarılı
 *   n=5 → 4/5 (yalnızca havuzu olmayan MAGIC düştü — DOĞRU davranış)
 *   n=6 → 0/6, hepsi düştü
 *   n=8 → viem 7+1 böldü; 7'lik grup toptan düştü, tek kalan geçti
 * Yani sınır token sayısına değil, gruptaki toplam gas'a bağlı. 4 ölçülen
 * güvenli değer; artırmak bu hatayı sessizce geri getirir. Bölmenin maliyeti
 * ihmal edilebilir (ölçülen tur başına ~86 ms).
 *
 * Aynı ders `scripts/discover-tokens.ts`'te de var (`MC_CHUNK = 60`, orada
 * çağrılar çok daha ucuz `ERC20` okumaları) — burada uygulanmamıştı.
 */
const MAX_CALLS_PER_BATCH = 4;

/**
 * Tek bir RPC çağrısının azami süresi ve deneme sayısı.
 *
 * ÖLÇÜLDÜ ve bu, Base turunu bayatlık bütçesinin iki katına çıkaran şeydi.
 * `base-rpc.publicnode.com`, 300 istek sürekli yük: medyan **47–52 ms**,
 * sağlıklı penceredeki en yavaş istek **200 ms**, sıfır hata. Ama o 300
 * isteğin BİRİ **60185 ms** sürdü — uç nokta yavaş değil, arada bir bağlantı
 * takılıyor.
 *
 * Eski ayar (`timeout: 15_000` + viem'in varsayılan `retryCount: 3`) tek bir
 * takılmayı 4 × 15 sn ≈ 60 sn'ye çeviriyordu ve çağrı sonunda BAŞARILI olduğu
 * için hiçbir yere hata yazılmıyordu. `multicallChunked` grupları sırayla
 * beklediğinden bir takılma turun tamamını donduruyor; Base'de tur başına
 * ~400 grup olduğu için neredeyse her tur bir takılmaya denk geliyordu.
 * Ölçülen sonuç: aerodrome turu ilk dakikada 6.1 sn, sonrasında 59–64 sn
 * (bütçe 30 sn), uniswap-v3-base 74.4 sn.
 *
 * 3 sn, ölçülen medyanın ~60 katı: bu süreyi aşan bir çağrı yavaş değil
 * TAKILMIŞTIR ve yeni bir bağlantıyla tekrar sormak beklemekten her zaman
 * ucuzdur. Toplam en kötü hâl 3 × 3 sn ≈ 9 sn, yani tek takılma turu
 * bütçenin içinde bırakıyor.
 *
 * Düşürürken dikkat: sağlıklı kuyruk gecikmesi de gerçek. 1 sn'ye indirmek
 * geçici yavaşlamayı takılma sayıp gereksiz yük üretir.
 */
const RPC_TIMEOUT_MS = 3_000;
const RPC_RETRY_COUNT = 2;

/**
 * Tur süresi uyarısı için bakılacak SON tur sayısı.
 *
 * Ölçü neden "son N turun en iyisi": tek bir yavaş tur (RPC hıçkırığı) uyarı
 * üretmemeli, ama sürekli bozulma görünmeli. Eski kod minimumu koşunun
 * TAMAMI üzerinden alıyordu (`Math.min(enIyiTurMs, sureMs)`, hiç
 * sıfırlanmıyor) ve bunun bedeli ölçüldü: ilk dakikadaki 6.1 sn'lik tur,
 * sonraki 10 dakika boyunca her tur 60 sn sürerken uyarıyı KALICI olarak
 * susturdu. Yani bozulmayı gösterecek olan araç, bozulmaya karşı kördü.
 */
const TUR_PENCERESI = 5;

export class EvmDexFeed implements Feed {
  readonly venue: DexId;
  readonly chain: ChainId;

  /** Quote çağrıları buradan gider (testte sahte olabilir). */
  private readonly caller: MulticallClient;
  /** Yalnızca blok aboneliği için — enjekte edilmiş istemcide null. */
  private readonly client: PublicClient | null;
  private timer: NodeJS.Timeout | null = null;
  private unwatch: (() => void) | null = null;
  private state: FeedState = 'idle';
  private lastTickTs = 0;
  private lastError: string | null = null;
  private errorCount = 0;
  private readonly rate = new RateCounter();
  private polling = false;

  /**
   * Fiyatlanacak tokenlar (quote token'ın kendisi hariç). Kurulumda bir kez
   * süzülüyor: her turda yeniden filtrelemek gereksiz, ve sayaç dizilerinin
   * indeksleri bu listeye sabitlenmek zorunda.
   */
  private readonly priced: readonly EvmToken[];
  /** Token başına: kaç turda fiyatlanabildi / üst üste kaç turdur olamıyor. */
  private readonly okCount: Uint32Array;
  private readonly failStreak: Uint32Array;
  /**
   * Son ölçülen gidiş-dönüş spread'i (0 = hiç ölçülmedi). Elenen token'ın
   * sebebini ayırt etmek için: "havuz yok" ile "havuz çok ince" farklı
   * sorunlar ve farklı çözümleri var (kontrat düzelt vs. WETH üzerinden rota).
   */
  private readonly lastSpread: Float64Array;
  private rounds = 0;
  /** Art arda kötü tur sayısı — `FAILURE_TOLERANCE` ile karşılaştırılır. */
  private badStreak = 0;

  constructor(
    private readonly store: PriceStore,
    private readonly cfg: EvmDexConfig,
  ) {
    this.venue = cfg.venue;
    this.chain = cfg.chain;

    const q = cfg.quoteToken.address.toLowerCase();
    this.priced = cfg.tokens.filter((t) => t.address.toLowerCase() !== q);
    this.okCount = new Uint32Array(this.priced.length);
    this.failStreak = new Uint32Array(this.priced.length);
    this.lastSpread = new Float64Array(this.priced.length);

    if (cfg.client) {
      this.caller = cfg.client;
      this.client = null;
    } else {
      const chainDef = cfg.chain === 'base' ? base : arbitrum;
      const isWs = cfg.rpcUrl.startsWith('ws');
      const c = createPublicClient({
        chain: chainDef,
        transport: isWs
          ? webSocket(cfg.rpcUrl, { timeout: RPC_TIMEOUT_MS })
          : http(cfg.rpcUrl, {
              timeout: RPC_TIMEOUT_MS,
              retryCount: RPC_RETRY_COUNT,
              retryDelay: 100,
              batch: true,
            }),
      }) as PublicClient;
      this.client = c;
      this.caller = c as unknown as MulticallClient;
    }
  }

  async start(): Promise<void> {
    if (this.priced.length === 0) {
      this.state = 'idle';
      this.lastError = `${this.chain} için taranacak token yok`;
      return;
    }

    this.state = 'connecting';
    await this.poll();

    // WebSocket RPC varsa blok başına tetikleniyoruz: DEX fiyatları ancak
    // blok değişince değişir, bu yüzden bundan hızlı sorgulamanın anlamı yok
    // ve gereksiz RPC kotası yakar.
    if (this.cfg.rpcUrl.startsWith('ws')) {
      // `poll` belirtmiyoruz: viem WebSocket transport'ta otomatik olarak
      // abonelik (push) kullanıyor, HTTP'de yoklamaya düşüyor.
      this.unwatch =
        this.client?.watchBlockNumber({
          onBlockNumber: () => void this.poll(),
          emitOnBegin: false,
        }) ?? null;
    } else {
      const interval =
        this.cfg.pollIntervalMs ?? (this.cfg.chain === 'arbitrum' ? 2000 : 3000);
      this.timer = setInterval(() => void this.poll(), interval);
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unwatch?.();
    this.unwatch = null;
    this.state = 'idle';
  }

  /**
   * Bir tur: her token için "quoteToken → token" (alış) ve
   * "token → quoteToken" (satış) quote'u.
   *
   * İki yönü de almak şart: DEX'te alış ve satış fiyatı havuz eğrisi yüzünden
   * simetrik değildir ve aradaki fark CEX'teki bid/ask spread'inin karşılığıdır.
   */
  private async poll(): Promise<void> {
    // Önceki tur bitmediyse üst üste bindirme — yavaş RPC'de kuyruk büyür.
    if (this.polling) return;
    this.polling = true;
    this.rounds++;
    const turBasi = Date.now();

    try {
      const amountIn = BigInt(
        Math.floor(this.cfg.tradeSize * 10 ** this.cfg.quoteToken.decimals),
      );

      // Rotasız sayılan tokenlar sorgudan çıkarılır; `REPROBE_EVERY` turda bir
      // hepsi yeniden denenir.
      const aktif: number[] = [];
      const buyGroups: unknown[][] = [];
      for (let i = 0; i < this.priced.length; i++) {
        if (this.rotasiz(i)) continue;
        aktif.push(i);
        buyGroups.push(
          this.buildQuoteGroup(this.cfg.quoteToken.address, this.priced[i]!.address, amountIn),
        );
      }

      if (buyGroups.length === 0) {
        this.state = 'idle';
        this.lastError = 'fiyatlanacak token yok';
        return;
      }

      const buyRaw = await this.quoteGroupsRaw(buyGroups);

      // Satış bacağı, alışın yapıldığı TIER'IN KENDİSİNDE sorulur — aynı
      // havuzda al, aynı havuzda sat. Tier'ları karıştırmak (birinden al,
      // diğerine sat) gerçekleştirilemeyecek bir işlemi fiyatlamak olurdu.
      const sellCalls: unknown[] = [];
      const sellRef: { k: number; tier: number }[] = [];
      let alisOk = 0;

      for (let k = 0; k < aktif.length; k++) {
        const row = buyRaw[k]!;
        let tokenAlisVar = false;
        for (let tier = 0; tier < row.length; tier++) {
          const out = row[tier];
          if (out === null || out === undefined || out <= 0n) continue;
          tokenAlisVar = true;
          sellCalls.push(
            this.buildQuoteForRota(
              this.priced[aktif[k]!]!.address,
              this.cfg.quoteToken.address,
              out,
              tier,
            ),
          );
          sellRef.push({ k, tier });
        }
        if (tokenAlisVar) alisOk++;
      }

      const sellFlat = await this.multicallChunked(sellCalls);

      // Zaman damgası turun BAŞI: alış quote'u o anda alındı ve EVM bacağı
      // Aşama 2'de yeniden quote edilmiyor — store'daki değer doğrudan kâr
      // hesabına giriyor. Tur sonu yazılınca uniswap-v3-base'de 10–14 sn'lik
      // tur kadar genç görünüyor, "≤30 sn" sanılan fiyat ~44 sn'ye kadar eski
      // olabiliyordu. CoW feed'i zaten böyle yapıyor (muhafazakâr yön).
      const now = turBasi;
      const yazildi = new Uint8Array(this.priced.length);
      let written = 0;
      let satisOk = 0;
      let ince = 0;

      /**
       * Token başına en iyi ADAY: yalnızca gidiş-dönüş spread'i eşiği geçen
       * tier'lar aday olur, aralarından en ucuz ask seçilir.
       *
       * Sıralama önemli: önce elenir, sonra en iyisi seçilir. Ters sırada
       * (önce en iyi ask, sonra eleme) bozuk havuz her zaman kazanırdı —
       * çünkü bozuk havuzun ask'i her zaman en düşüktür.
       */
      const enIyi = new Map<number, { ask: number; bid: number; bought: number }>();
      // Token en az bir tier'da satış cevabı aldı mı / hepsi eşiği aştı mı?
      const satisGoruldu = new Set<number>();
      const inceGoruldu = new Set<number>();

      for (let s = 0; s < sellRef.length; s++) {
        const { k, tier } = sellRef[s]!;
        const i = aktif[k]!;
        const t = this.priced[i]!;

        const boughtRaw = buyRaw[k]![tier] ?? null;
        const soldRaw = this.extractAmount(sellFlat[s]);
        if (boughtRaw === null || soldRaw === null || boughtRaw <= 0n || soldRaw <= 0n) continue;

        const bought = Number(boughtRaw) / 10 ** t.decimals;
        const sold = Number(soldRaw) / 10 ** this.cfg.quoteToken.decimals;
        if (!(bought > 0) || !(sold > 0)) continue;
        satisGoruldu.add(i);

        // ask: bu token'ı almanın birim maliyeti
        // bid: bu token'ı satmanın birim getirisi
        const ask = this.cfg.tradeSize / bought;
        const bid = sold / bought;
        if (!(ask > 0) || !(bid > 0)) continue;

        // Havuz bu işlem büyüklüğünü taşıyamıyorsa fiyatı store'a HİÇ yazmayız.
        // Yazmak zararsız görünür (yön güvenli tarafta) ama anlamsız bir sayıyı
        // motora sokmak, sonradan başka bir yerde kullanılma riski taşır ve
        // token'ı sonsuza dek "başarılı" gösterip elenmesini engellerdi.
        const spread = (ask - bid) / bid;
        const oncekiSpread = this.lastSpread[i]!;
        // Panelde en İYİ tier'ın spread'i görünsün: token birden çok havuzda
        // olabilir ve en kötüsünü raporlamak yanıltıcı olur.
        if (!enIyi.has(i) || spread < oncekiSpread) this.lastSpread[i] = spread;

        if (spread > MAX_ROUNDTRIP_SPREAD) {
          inceGoruldu.add(i);
          continue;
        }

        const mevcut = enIyi.get(i);
        if (!mevcut || ask < mevcut.ask) enIyi.set(i, { ask, bid, bought });
      }

      satisOk = satisGoruldu.size;
      for (const i of inceGoruldu) if (!enIyi.has(i)) ince++;

      for (const [i, v] of enIyi) {
        const t = this.priced[i]!;
        // Miktar alanlarına gerçekten işlem yapılabilen büyüklüğü yazıyoruz;
        // tarayıcı bunu L1 derinliği gibi kullanıp ek doğrulamaya gerek
        // duymadan VWAP'ı hesaplayabiliyor.
        this.store.write(t.slot, v.bid, v.bought, v.ask, v.bought, now, now);
        yazildi[i] = 1;
        this.okCount[i]!++;
        this.failStreak[i] = 0;
        written++;
      }

      // Token başına başarısızlık serisi YALNIZCA burada artar: bu noktaya
      // gelmek multicall'ın döndüğü, yani RPC'nin çalıştığı anlamına gelir.
      // catch dalında artırsaydık bir RPC kesintisi tüm tokenları rotasız
      // ilan ederdi.
      for (const i of aktif) if (!yazildi[i]) this.failStreak[i]!++;

      this.rate.tick(now);
      this.lastTickTs = now;
      this.onRoundResult({ written, alisOk, satisOk, ince, denenen: aktif.length });
    } catch (e) {
      // Buraya düşmek RPC katmanının çalışmadığı anlamına gelir — havuz
      // yokluğuyla karıştırılmamalı, çünkü çözümü tamamen farklı (uç nokta
      // değiştir vs. rota/kontrat düzelt).
      this.errorCount++;
      this.noteFailure(`RPC: ${(e as Error).message.slice(0, 100)}`);
    } finally {
      this.polling = false;
      this.turSuresiniDegerlendir(Date.now() - turBasi);
    }
  }

  /**
   * Tur süresi bayatlık bütçesini aşıyorsa yapısal uyarı kur.
   *
   * Ölçü **son `TUR_PENCERESI` turun en iyisi**: tek bir yavaş tur (RPC
   * hıçkırığı) uyarı üretmemeli, ama bacak gerçekten bütçeye sığmıyorsa
   * penceredeki en iyi tur bile aşar.
   *
   * Pencerenin KAYMASI şart. Koşu boyunca minimum tutulduğunda tek bir erken
   * hızlı tur uyarıyı sonsuza kadar susturuyordu — ölçülen hâli: ilk dakikada
   * 6.1 sn, sonraki 10 dakika 59–64 sn, panel tertemiz. Uyarı hem kurulabilir
   * hem KALKABİLİR olmalı: bozulma geçiciyse (bkz. `RPC_TIMEOUT_MS`) pencere
   * dolduğunda kendiliğinden temizlenir.
   */
  private turSuresiniDegerlendir(sureMs: number): void {
    const butce = this.cfg.maxPriceAgeMs;
    if (butce === undefined) return;

    this.sonTurlar.push(sureMs);
    if (this.sonTurlar.length > TUR_PENCERESI) this.sonTurlar.shift();

    // İlk birkaç tur ısınma sayılır (bağlantı kurulumu, önbellek soğuk).
    if (this.rounds < 3) return;

    const enIyi = Math.min(...this.sonTurlar);
    this.periyotUyarisi =
      enIyi >= butce
        ? `tur ${(enIyi / 1000).toFixed(0)} sn sürüyor — bayatlık eşiği ` +
          `${(butce / 1000).toFixed(0)} sn'yi AŞIYOR, bu venue taranamaz. ` +
          `Token sayısını azalt ya da MAX_DEX_PRICE_AGE_MS'i yükselt.`
        : null;
  }

  /** Kurulumda değil ÇALIŞIRKEN saptanan yapısal sorun. */
  private periyotUyarisi: string | null = null;
  /** Son `TUR_PENCERESI` turun süresi (ms) — kayan pencere. */
  private readonly sonTurlar: number[] = [];

  /**
   * Quote'ları `MAX_CALLS_PER_BATCH`'lik gruplara bölerek çalıştırır ve
   * sonuçları GİRDİ SIRASINDA birleştirir — çağıran taraf indeks eşlemesine
   * güveniyor.
   *
   * Gruplar sıralı gönderiliyor: paralel göndermek public RPC'de rate-limit
   * riski yaratır ve kazanç ihmal edilebilir (grup başına ~86 ms).
   */
  private async multicallChunked(contracts: readonly unknown[]): Promise<MulticallResult[]> {
    const out: MulticallResult[] = [];
    for (let i = 0; i < contracts.length; i += MAX_CALLS_PER_BATCH) {
      const parca = contracts.slice(i, i + MAX_CALLS_PER_BATCH);
      const r = await this.caller.multicall({
        // viem tip sistemi heterojen ABI listesinde zorlanıyor; içerik
        // doğrulaması çağıran tarafta status kontrolüyle yapılıyor.
        contracts: parca as never,
        allowFailure: true,
      });
      for (const x of r) {
        // Taşıma arızası tek bir girdide bile görünse tur geçersiz: aynı
        // parçadaki diğer çağrılar da aynı sebeple düştü ve sonraki parçalar
        // da büyük ihtimalle düşecek. `catch` dalına taşıyoruz.
        if (x.status === 'failure' && tasimaArizasiMi(x.error)) {
          throw x.error instanceof Error ? x.error : new Error(String(x.error));
        }
        out.push(x);
      }
    }
    return out;
  }

  /** Bu token rotasız sayıldığı için bu turda atlanmalı mı? */
  private rotasiz(i: number): boolean {
    if (this.failStreak[i]! < NO_ROUTE_ROUNDS) return false;
    return this.rounds % REPROBE_EVERY !== 0;
  }

  /**
   * Turun sonucunu duruma çevirir.
   *
   * ÜÇ AYRI DURUM tek "failed" etiketine sıkıştırılmıştı ve teşhis
   * imkânsızdı — `written > 0 ? 'live' : 'failed'`. Oysa sıfır yazımın dört
   * sebebi var ve dördünün çözümü farklı:
   *   - RPC çağrısı patladı           → uç nokta sorunu (catch dalı)
   *   - multicall döndü, hepsi revert → havuz/rota yok, config sorunu
   *   - alış geçti, satış geçmedi     → tek yönlü likidite
   *   - ikisi de geçti, spread devasa → havuz var ama işlem büyüklüğümüzü
   *                                     taşımıyor; WETH üzerinden rota gerek
   * Ayrıca eski kod asimetrikti: `catch` içinde "live iken istisna" durumu
   * live bırakıyor, ama "live iken sıfır yazım" anında failed yapıyordu.
   */
  private onRoundResult(b: {
    written: number;
    alisOk: number;
    satisOk: number;
    ince: number;
    denenen: number;
  }): void {
    const { written, alisOk, satisOk, ince, denenen } = b;
    if (written > 0) {
      this.state = 'live';
      this.badStreak = 0;
      // Kısmi başarı gizlenmemeli: bir token sessizce hiç fiyatlanmıyorsa
      // panelde iz bırakmalı (`DexQuoter`'ın hiç çağrılmaması bu yüzden
      // aylarca fark edilmedi).
      const { yok, ince } = this.elenenler();
      const parcalar: string[] = [];
      if (yok.length > 0) parcalar.push(`havuz yok: ${yok.join(',')}`);
      // "İnce havuz" ayrı raporlanıyor çünkü çözümü farklı: kontrat/adres
      // sorunu değil, likidite WETH ile eşleşmiş demektir ve 2 adımlı rota
      // gerektirir.
      if (ince.length > 0) parcalar.push(`havuz ince: ${ince.join(',')}`);
      this.lastError =
        parcalar.length > 0
          ? `${parcalar.join(' · ')} (${written}/${denenen} fiyatlandı)`
          : null;
      return;
    }

    // Sıra önemli: quoter'ın cevap verdiği ama spread'in taşınamadığı durum,
    // "satış fiyatlanamadı" ile karıştırılmamalı — orada satış BAŞARILI, biz
    // sonucu reddediyoruz. Karıştırmak, likidite sorununu RPC/kontrat sorunu
    // gibi gösterip yanlış tarafta arattırır.
    let sebep: string;
    if (ince > 0 && ince >= satisOk) {
      sebep = `${ince}/${denenen} token'ın havuzu $${this.cfg.tradeSize} işlemi taşımıyor — WETH üzerinden rota gerek`;
    } else if (alisOk === 0) {
      sebep = `${denenen} token'ın hiçbirinde havuz yok — rota/kontrat sorunu, RPC değil`;
    } else {
      sebep = `alış ${alisOk}/${denenen} geçti ama satış tarafı fiyatlanamadı`;
    }
    this.noteFailure(sebep);
  }

  /** Kötü turu kaydeder; durumu ancak tolerans aşılınca `failed` yapar. */
  private noteFailure(sebep: string): void {
    this.badStreak++;
    this.lastError =
      this.badStreak < FAILURE_TOLERANCE
        ? `${sebep} (${this.badStreak}/${FAILURE_TOLERANCE} tur)`
        : sebep;
    if (this.badStreak >= FAILURE_TOLERANCE) this.state = 'failed';
  }

  /**
   * Tur başarılıyken üst üste fiyatlanamadığı için elenen tokenlar, sebebe
   * göre ayrılmış: quoter hiç cevap vermedi mi (havuz yok), yoksa cevap verdi
   * ama spread taşınamayacak kadar geniş mi (havuz ince).
   */
  private elenenler(): { yok: string[]; ince: string[] } {
    const yok: string[] = [];
    const ince: string[] = [];
    for (let i = 0; i < this.priced.length; i++) {
      if (this.failStreak[i]! < NO_ROUTE_ROUNDS) continue;
      (this.lastSpread[i]! > MAX_ROUNDTRIP_SPREAD ? ince : yok).push(this.priced[i]!.symbol);
    }
    return { yok, ince };
  }

  /**
   * Bir mantıksal quote'un RPC çağrıları.
   *
   * Aerodrome ve Camelot için tek çağrı; Uniswap V3 için **her fee tier'a bir
   * çağrı**. Sebep ölçülmüş: tek tier körlemesine seçmek YANLIŞ FİYAT üretiyor.
   * Arbitrum'da UNI için `fee=500` havuzu 0.2973 döndürürken `fee=3000` havuzu
   * 3.9384 döndürdü — gerçek fiyat ~4. Yani 500'lük havuz var (çağrı revert
   * etmiyor, "başarılı") ama içi boş. `feeTiers[1]`'i sabit seçen eski kod bu
   * tokenı sessizce dörtte bir fiyatla fiyatlardı.
   *
   * Tier'lar arasından EN İYİ çıktıyı seçmek gerçek bir router'ın yaptığı
   * şeydir ve yön güvenlidir: en iyi çıktı, gerçekte elde edilebilecek en
   * kötü değil en İYİ sonuçtur — hangi havuzun kullanılacağını biz seçiyoruz.
   */
  private buildQuoteGroup(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
  ): unknown[] {
    const out: unknown[] = [];
    for (let r = 0; r < this.rotaSayisi; r++) {
      out.push(this.buildQuoteForRota(tokenIn, tokenOut, amountIn, r));
    }
    return out;
  }

  /**
   * Bir token için sorulacak ADAY ROTA sayısı.
   *
   * Rota indeksi ikiye bölünür: ilk yarı doğrudan (tier başına bir), ikinci
   * yarı ara token üzerinden 2 adımlı. Ayrım indeksle yapıldığı için alış ve
   * satış bacağı AYNI rotadan sorulabiliyor — bu şart, çünkü bir rotadan alıp
   * başka bir rotadan satmak gerçekleştirilemeyecek bir işlemi fiyatlar.
   */
  private get rotaSayisi(): number {
    return this.dogrudanSayisi * (this.cfg.hopToken ? 2 : 1);
  }

  /** Doğrudan rota sayısı = fee tier sayısı (UniV3 dışında 1). */
  private get dogrudanSayisi(): number {
    return this.cfg.uniswapV3?.feeTiers.length ?? 1;
  }

  /**
   * Belirli bir aday rota için quoter çağrısı.
   *
   * Ara token'ın kendisi bacakta yer alıyorsa (WETH↔USDC gibi) 2 adımlı rota
   * anlamsızdır — `WETH→WETH→USDC` diye bir yol yok. O durumda doğrudan rotayı
   * tekrarlıyoruz: sonuç aynı çıkar ve `enIyi` seçimi zaten tekilleştirir.
   * Alternatif (çağrıyı atlamak) grup indekslerini kaydırıp alış/satış
   * eşlemesini bozardı.
   */
  private buildQuoteForRota(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
    rota: number,
  ): unknown {
    const n = this.dogrudanSayisi;
    const tier = rota % n;
    const ikiAdim = rota >= n;
    const hop = this.cfg.hopToken;

    if (!ikiAdim || !hop || eq(tokenIn, hop) || eq(tokenOut, hop)) {
      return this.buildDogrudan(tokenIn, tokenOut, amountIn, tier);
    }
    return this.buildIkiAdim(tokenIn, tokenOut, amountIn, tier, hop);
  }

  /** Tek havuz üzerinden quote. */
  private buildDogrudan(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
    tier: number,
  ): unknown {
    const u = this.cfg.uniswapV3;
    if (u) {
      return {
        address: u.quoterV2,
        abi: UNIV3_QUOTER_ABI,
        functionName: 'quoteExactInputSingle',
        args: [
          { tokenIn, tokenOut, amountIn, fee: u.feeTiers[tier] ?? 500, sqrtPriceLimitX96: 0n },
        ],
      };
    }
    return this.buildQuote(tokenIn, tokenOut, amountIn);
  }

  /** Ara token üzerinden iki havuz. */
  private buildIkiAdim(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
    tier: number,
    hop: Address,
  ): unknown {
    const a = this.cfg.aerodrome;
    if (a) {
      // Aerodrome `Route[]` aldığı için çok adımlı quote AYNI fonksiyonla
      // yapılıyor — çağrı tarafı bedava, tek maliyet ikinci rota girdisi.
      return {
        address: a.router,
        abi: AERODROME_ABI,
        functionName: 'getAmountsOut',
        args: [
          amountIn,
          [
            { from: tokenIn, to: hop, stable: false, factory: a.factory },
            { from: hop, to: tokenOut, stable: false, factory: a.factory },
          ],
        ],
      };
    }

    const u = this.cfg.uniswapV3;
    if (u) {
      const q = this.cfg.hopQuoteFee ?? 500;
      // Ara bacağın tier'ı taranıyor, ara↔quote bacağı sabit: WETH/USDC her
      // zincirde en likit havuz ve onu da taramak quote sayısını tier² yapardı.
      const [f1, f2] = eq(tokenIn, this.cfg.quoteToken.address)
        ? [q, u.feeTiers[tier] ?? 500]
        : [u.feeTiers[tier] ?? 500, q];
      return {
        address: u.quoterV2,
        abi: UNIV3_PATH_ABI,
        functionName: 'quoteExactInput',
        args: [univ3Path(tokenIn, f1, hop, f2, tokenOut), amountIn],
      };
    }

    const c = this.cfg.camelot;
    if (c) {
      return {
        address: c.quoterV2,
        abi: ALGEBRA_PATH_ABI,
        functionName: 'quoteExactInput',
        args: [algebraPath(tokenIn, hop, tokenOut), amountIn],
      };
    }

    throw new Error(`${this.venue}: quoter yapılandırması eksik`);
  }

  /**
   * Grupları düzleştirip sorar ve sonuçları GRUP YAPISINI KORUYARAK döndürür.
   *
   * Grubu tek "en iyi" değere indirgemek ÖLÇÜLEN BİR HATAYDI ve canlı testte
   * 8/8 token'ı fiyatlanamaz yaptı. Sebep ters yönlü: alış bacağında "en iyi
   * çıktı" = en çok token, ve boş/bozuk bir havuz tam olarak bunu verir
   * (1000 USDC karşılığı absürt miktarda token). Yani max seçmek, aramaya
   * çalıştığımız sağlıklı havuzu değil, en bozuk havuzu seçiyordu; sonra o
   * miktar geri satılınca gidiş-dönüş spread'i patlıyor ve token
   * "havuz taşımıyor" diye eleniyordu.
   *
   * Doğru kural: her tier KENDİ İÇİNDE gidiş-dönüş değerlendirilir (aynı
   * havuzda al, aynı havuzda sat) ve yalnızca spread'i makul olan tier'lar
   * aday olur. Bu yüzden ham sonuçlar burada korunuyor, seçim `poll()`
   * içinde iki bacak da bilindikten sonra yapılıyor.
   */
  private async quoteGroupsRaw(groups: readonly unknown[][]): Promise<(bigint | null)[][]> {
    const flat: unknown[] = [];
    for (const g of groups) for (const c of g) flat.push(c);

    const results = await this.multicallChunked(flat);

    const out: (bigint | null)[][] = [];
    let k = 0;
    for (const g of groups) {
      const row: (bigint | null)[] = [];
      for (let j = 0; j < g.length; j++) {
        const v = this.extractAmount(results[k++]);
        row.push(v !== null && v > 0n ? v : null);
      }
      out.push(row);
    }
    return out;
  }

  /** Venue'ya uygun quoter çağrısını üretir. */
  private buildQuote(tokenIn: Address, tokenOut: Address, amountIn: bigint): unknown {
    if (this.cfg.aerodrome) {
      return {
        address: this.cfg.aerodrome.router,
        abi: AERODROME_ABI,
        functionName: 'getAmountsOut',
        args: [
          amountIn,
          [
            {
              from: tokenIn,
              to: tokenOut,
              // Volatil havuz: stablecoin çiftleri dışında doğru olan bu.
              stable: false,
              factory: this.cfg.aerodrome.factory,
            },
          ],
        ],
      };
    }

    if (this.cfg.camelot) {
      return {
        address: this.cfg.camelot.quoterV2,
        abi: ALGEBRA_QUOTER_ABI,
        functionName: 'quoteExactInputSingle',
        args: [tokenIn, tokenOut, amountIn, 0n],
      };
    }

    if (this.cfg.uniswapV3) {
      // Tek fee tier kullanıyoruz; en likit olanı %0.05'tir. Tüm tier'ları
      // taramak quote sayısını dörde katlar, kazancı sınırlı.
      const fee = this.cfg.uniswapV3.feeTiers[1] ?? 500;
      return {
        address: this.cfg.uniswapV3.quoterV2,
        abi: UNIV3_QUOTER_ABI,
        functionName: 'quoteExactInputSingle',
        args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
      };
    }

    throw new Error(`${this.venue}: quoter yapılandırması eksik`);
  }

  /**
   * Quoter cevabından çıktı miktarını alır.
   *
   * Seçim VENUE'YA GÖRE yapılıyor, dönüş şekline BAKARAK değil. Eski sürüm
   * şekilden tahmin ediyordu ("dizinin son elemanı bigint ise odur") ve bu,
   * canlı testte Uniswap V3'ü tamamen bozdu:
   *
   *   - Aerodrome `getAmountsOut` → uint256[]; hedef miktar SON elemandır.
   *   - Algebra (Camelot) `(uint256 amountOut, uint16 fee)` → İLK eleman.
   *     `fee` uint16 olduğu için viem onu `number` döndürüyor, dolayısıyla
   *     "son eleman bigint mi" testi tesadüfen başarısız oluyor ve doğru dala
   *     düşüyordu — yani Camelot'un çalışması ŞANSTI.
   *   - UniV3 QuoterV2 `(uint256 amountOut, uint160 sqrtPriceX96After,
   *     uint32 initializedTicksCrossed, uint256 gasEstimate)` → İLK eleman.
   *     Son eleman `gasEstimate` ve o da bigint; heuristik bu yüzden
   *     miktar yerine GAS TAHMİNİNİ döndürüyordu. Hata sessizdi: quote
   *     "başarılı" görünüyor, sayı makul büyüklükte, sadece tamamen alakasız.
   *     Sonuç 8/8 token'ın "havuz $1000'ı taşımıyor" diye elenmesiydi.
   *
   * 2 adımlı (path) sürümler bu kuralı BOZMUYOR ve ek dal gerektirmiyor:
   *   - Aerodrome `getAmountsOut` çok adımlı rotada da `uint256[]` döndürüyor,
   *     yalnızca dizi uzuyor (3 eleman) — hedef yine SON eleman.
   *   - UniV3 `quoteExactInput` → `(amountOut, uint160[], uint32[], uint256)`,
   *     Algebra `quoteExactInput` → `(amountOut, uint16[])`; ikisinde de İLK.
   * Yani ayrım hâlâ "aerodrome mu, değil mi" ve venue'ya göre yapılıyor —
   * şekle bakarak değil.
   */
  private extractAmount(r: MulticallResult | undefined): bigint | null {
    if (!r || r.status !== 'success' || r.result === undefined) return null;
    const v = r.result;

    if (Array.isArray(v)) {
      const el = this.cfg.aerodrome ? v[v.length - 1] : v[0];
      return typeof el === 'bigint' ? el : null;
    }
    return typeof v === 'bigint' ? v : null;
  }

  health(): FeedHealth {
    const now = Date.now();
    return {
      venue: this.venue,
      state: this.state,
      lastTickAgeMs: this.lastTickTs === 0 ? -1 : now - this.lastTickTs,
      msgsPerSec: this.rate.perSec(now),
      reconnects: this.errorCount,
      latencyP50: 0,
      latencyP99: 0,
      clockSkewMs: 0,
      // Quote token'ın kendisi fiyatlanmıyor; sayıya dahil etmek paneli
      // gerçekte taranandan fazla gösterirdi.
      subscribedCount: this.priced.length,
      // Yapısal uyarı tur teşhisinin ÖNÜNE geçer: "havuz yok: X" gibi normal
      // bir mesaj, venue'nun tamamen taranamıyor olmasını gölgelememeli.
      lastError:
        this.periyotUyarisi !== null
          ? `${this.periyotUyarisi}${this.lastError ? ` · ${this.lastError}` : ''}`
          : this.lastError,
    };
  }
}
