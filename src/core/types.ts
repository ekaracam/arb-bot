/**
 * Sistemin tüm katmanlarının paylaştığı çekirdek tipler.
 *
 * Tasarım notu: hot path'te (tick işleme) burada tanımlı hiçbir object
 * ALLOCATE EDİLMEZ. Tick verisi Float64Array tabanlı PriceStore'a yazılır.
 * Buradaki nesneler yalnızca kurulum ve fırsat raporlama yolunda kullanılır.
 */

// ---------------------------------------------------------------------------
// Mekan (venue) kimliği
// ---------------------------------------------------------------------------

export const CEX_IDS = ['binance', 'bybit', 'okx', 'gate', 'mexc', 'kucoin', 'kraken'] as const;
export type CexId = (typeof CEX_IDS)[number];

/**
 * DEX venue kimliği = (protokol, ZİNCİR) çifti.
 *
 * `DEX_CHAIN` birebir eşleme olduğu için aynı protokol iki zincirde ayrı ID
 * ister. `uniswap-v3` (arbitrum) tarihsel sebeple soneksiz kaldı: yeniden
 * adlandırmak `data/opportunities-*.ndjson` içindeki venue adlarını geçmişe
 * dönük tutarsız yapar ve `calibrate` eski koşuları okuyamaz hale gelirdi.
 * Yeni girdiler zincir sonekiyle yazılıyor.
 */
export const DEX_IDS = [
  'jupiter',
  'raydium',
  'aerodrome',
  'camelot',
  'uniswap-v3',
  'uniswap-v3-base',
  'cow-base',
] as const;
export type DexId = (typeof DEX_IDS)[number];

export type VenueId = CexId | DexId;

export const CHAIN_IDS = ['solana', 'base', 'arbitrum'] as const;
export type ChainId = (typeof CHAIN_IDS)[number];

/** DEX venue'ları hangi zincirde çalışıyor. */
export const DEX_CHAIN: Record<DexId, ChainId> = {
  jupiter: 'solana',
  raydium: 'solana',
  aerodrome: 'base',
  camelot: 'arbitrum',
  'uniswap-v3': 'arbitrum',
  'uniswap-v3-base': 'base',
  'cow-base': 'base',
};

/**
 * Arbitraj taramasının dışında tutulan base varlıklar.
 *
 * Stablecoin'ler arasındaki fark arbitraj değil kur farkıdır; taramaya
 * girdiklerinde sürekli düşük yüzdeli gürültü üretirler.
 *
 * Tek yerde duruyor çünkü iki bağımsız yerde uygulanıyor: main.ts sembol
 * keşfini bununla filtreliyor, scripts/discover-solana.ts ise bu listedeki
 * coinleri hiç tokens.json'a yazmıyor. Ayrı ayrı tanımlansalardı biri
 * güncellenip diğeri unutulduğunda tabloda hiç taranmayan ölü satırlar kalırdı.
 */
export const EXCLUDED_BASES = [
  'USDT',
  'USDC',
  'DAI',
  'FDUSD',
  'TUSD',
  'BUSD',
  'USDE',
  'PYUSD',
  'USD1',
] as const;

export function isCex(v: VenueId): v is CexId {
  return (CEX_IDS as readonly string[]).includes(v);
}

export function isDex(v: VenueId): v is DexId {
  return (DEX_IDS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Sembol / token kimliği
//
// KRİTİK: Bir varlığın kimliği ticker DEĞİLDİR. Aynı ticker'a sahip farklı
// token'lar vardır (birden fazla "MOON", "SUN", "APE" mevcuttur). Bir CEX
// listesini bir DEX token'ıyla yalnızca kontrat adresi üzerinden eşleştiririz.
// Bkz. normalize/symbol-registry.ts
// ---------------------------------------------------------------------------

/** Kanonik çift anahtarı, örn. "BTC/USDT". Yalnızca CEX↔CEX eşleşmesi için yeterlidir. */
export type PairKey = string & { readonly __brand: 'PairKey' };

export function pairKey(base: string, quote: string): PairKey {
  return `${base.toUpperCase()}/${quote.toUpperCase()}` as PairKey;
}

/** Bir zincir üzerindeki somut token: kimliği kontrat/mint adresidir. */
export interface TokenRef {
  readonly chain: ChainId;
  /** EVM için checksum'suz lowercase adres, Solana için mint (base58, case-sensitive). */
  readonly address: string;
  readonly symbol: string;
  readonly decimals: number;
}

/** Bir venue'da işlem gören çift. */
export interface Market {
  readonly venue: VenueId;
  readonly pair: PairKey;
  /** Venue'nun kendi sembol gösterimi: BTCUSDT | BTC-USDT | BTC_USDT | mint adresi */
  readonly venueSymbol: string;
  readonly base: string;
  readonly quote: string;
  /** DEX'lerde her zaman dolu; CEX'lerde ancak çekim ağı bilgisi doğrulanabildiyse dolu. */
  readonly baseToken?: TokenRef;
}

// ---------------------------------------------------------------------------
// Fiyat verisi
// ---------------------------------------------------------------------------

/**
 * L1 (best bid/ask) tick. Feed adapter'ları bunu üretir.
 * Not: bu nesne feed→store sınırında kullanılır ve store'a yazıldıktan sonra
 * referansı tutulmaz; adapter'lar tek bir mutable instance'ı yeniden kullanır.
 */
export interface L1Tick {
  venue: VenueId;
  /** PriceStore'daki satır indeksi; -1 ise henüz çözülmemiş (bilinmeyen sembol). */
  slot: number;
  bid: number;
  bidQty: number;
  ask: number;
  askQty: number;
  /** Venue'nun bildirdiği zaman damgası (ms). Yoksa 0. */
  exchangeTs: number;
  /** Mesajın lokalde alındığı an (ms, Date.now tabanlı). */
  recvTs: number;
}

/** L2 derinlik seviyesi: [fiyat, miktar] */
export type DepthLevel = readonly [price: number, qty: number];

export interface DepthSnapshot {
  readonly venue: VenueId;
  readonly pair: PairKey;
  /** Azalan fiyat sırası */
  readonly bids: readonly DepthLevel[];
  /** Artan fiyat sırası */
  readonly asks: readonly DepthLevel[];
  readonly ts: number;
}

// ---------------------------------------------------------------------------
// Ücret ve transfer bilgisi
// ---------------------------------------------------------------------------

export interface FeeSchedule {
  /** Oran olarak, örn. 0.001 = %0.1 */
  readonly taker: number;
  readonly maker: number;
}

/**
 * Bir coin'in belirli bir zincirdeki çekim/yatırma durumu.
 *
 * `verified: false` ise bu bilgi statik config'ten geliyor demektir (public API'si
 * olmayan borsalar için) ve güncel olmayabilir — bildirimde uyarı bayrağı basılır.
 */
export interface TransferInfo {
  readonly venue: CexId;
  readonly coin: string;
  readonly chain: ChainId;
  readonly withdrawEnabled: boolean;
  readonly depositEnabled: boolean;
  /** Coin cinsinden sabit çekim ücreti. */
  readonly withdrawFee: number;
  readonly withdrawMin: number;
  /** Borsanın canlı API'sinden mi geldi, yoksa statik tablodan mı? */
  readonly verified: boolean;
  readonly fetchedAt: number;
  /**
   * Borsanın bu zincir için bildirdiği kontrat/mint adresi (küçük harf), yoksa null.
   *
   * Kimlik kuralının tek uygulanabilir dayanağı budur: ticker çakışmasını
   * başka hiçbir alan ayırt edemez. `null` "adres BİLİNMİYOR" demektir,
   * "adres uyuşmuyor" DEĞİL — Bybit bu alanı hiç vermiyor, dolayısıyla
   * null'ı çakışma sayan bir kontrol Bybit'in tüm rotalarını elerdi.
   */
  readonly address: string | null;
  /**
   * `true`: `depositEnabled = false` bir CEVAP değil, cevabın henüz
   * gelmediğini söylüyor (Kraken yatırma durumu talep üzerine çekiliyor,
   * bilinmeyen = kapalı). Tarayıcı imkânsız rotayı tablo tazelenene kadar
   * hatırlıyor; bu işaret olmadan sorulmamış bir coin 15 dk kör kalırdı.
   */
  readonly depositBilinmiyor?: boolean;
}

// ---------------------------------------------------------------------------
// Fırsat
// ---------------------------------------------------------------------------

export type LegKind = 'cex-buy' | 'cex-sell' | 'dex-buy' | 'dex-sell';

export interface Leg {
  readonly kind: LegKind;
  readonly venue: VenueId;
  readonly pair: PairKey;
  /** Derinlik üzerinden hesaplanan gerçekleşebilir ortalama fiyat (L1 değil). */
  readonly vwap: number;
  /** Referans olarak L1 en iyi fiyat — VWAP ile farkı slippage'i gösterir. */
  readonly bestPrice: number;
  /** Base coin cinsinden miktar. */
  readonly qty: number;
  /** Quote cinsinden komisyon. */
  readonly feeQuote: number;
  /** Fiyatın yaşı (ms) — tazelik kontrolü. */
  readonly ageMs: number;
}

export type OpportunityKind = 'cex-cex' | 'cex-dex' | 'dex-dex';

export interface Opportunity {
  readonly id: string;
  readonly kind: OpportunityKind;
  readonly coin: string;
  readonly quote: string;
  readonly buy: Leg;
  readonly sell: Leg;
  /** Transferin gerçekleşeceği zincir. */
  readonly chain: ChainId | null;

  /** Quote para birimi cinsinden brüt fark (komisyonlar öncesi). */
  readonly grossQuote: number;
  /** Tüm maliyetler düşülmüş net kâr (quote cinsinden). */
  readonly netQuote: number;
  /** netQuote / harcanan sermaye. 0.01 = %1 */
  readonly netPct: number;

  readonly costs: {
    readonly buyFee: number;
    readonly sellFee: number;
    readonly withdrawFee: number;
    readonly gas: number;
    readonly bridge: number;
  };

  /** Bu fırsatın güvenilirliğini düşüren durumlar. */
  readonly warnings: readonly string[];
  /**
   * DEX bacağının BAĞIMSIZ ikinci bir kaynakla karşılaştırılması.
   *
   * Base'de rotayı biz seçiyoruz (hangi havuz, hangi tier, kaç adım) —
   * dolayısıyla hata da bizim olabilir. CoW rotayı solver'a kurdurduğu için
   * bizim seçimimizden bağımsız bir görüş verir. `undefined` = kontrol
   * yapılmadı (venue desteklenmiyor ya da uç nokta ulaşılamadı); bu bir
   * onay DEĞİLDİR.
   */
  readonly capraz?: {
    readonly kaynak: string;
    readonly venue: VenueId;
    /** Pozitif = bizim rotamız ikinci kaynaktan İYİMSER. 0.01 = %1. */
    readonly sapmaPct: number;
  };
  /** Transfer bilgisi canlı API'den doğrulandı mı? */
  readonly transferVerified: boolean;

  readonly detectedAt: number;
  /** Sinyali üreten en eski fiyatın yaşı — fırsatın ne kadar "bayat" olduğunu gösterir. */
  readonly worstAgeMs: number;
}

// ---------------------------------------------------------------------------
// Feed arayüzü — tüm CEX ve DEX kaynakları bunu uygular
// ---------------------------------------------------------------------------

export type FeedState = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'failed';

export interface FeedHealth {
  readonly venue: VenueId;
  readonly state: FeedState;
  /** Son tick'in üzerinden geçen süre (ms). Hiç tick gelmediyse -1. */
  readonly lastTickAgeMs: number;
  readonly msgsPerSec: number;
  readonly reconnects: number;
  /**
   * Saat kayması düşülmüş GÖRELİ gecikme (ms). Mutlak gecikmeyi ölçmek için
   * lokal saatin borsa saatiyle senkron olması gerekir; bunu varsayamayız.
   */
  readonly latencyP50: number;
  readonly latencyP99: number;
  /** Tahmini lokal saat kayması (ms) — gözlenen en küçük fark. */
  readonly clockSkewMs: number;
  readonly subscribedCount: number;
  readonly lastError: string | null;
}

export interface Feed {
  readonly venue: VenueId;
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): FeedHealth;
}
