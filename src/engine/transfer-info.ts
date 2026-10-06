/**
 * Çekim/yatırma durumu ve ücretleri.
 *
 * Bu, botun public-only modda en zayıf halkasıdır ve bunu gizlemiyoruz.
 *
 * Bir arbitraj fırsatının gerçek olması için coin'in satın alınacağı borsadan
 * ÇEKİLEBİLİYOR ve satılacağı borsaya YATIRILABİLİYOR olması gerekir. Çekimi
 * kapalı bir coin'de görünen %5 fark fırsat değil, tuzaktır — piyasa zaten o
 * yüzden ayrışmıştır.
 *
 * Kaynak durumu:
 *   KuCoin, Gate.io  → public endpoint, GERÇEK veri (verified: true)
 *   Binance, Bybit, OKX, MEXC → yalnızca private endpoint'te. Bu borsalar için
 *     coin'in hangi zincirlerde var olduğunu KuCoin/Gate verisinden devralır,
 *     çekim ücretini config'teki varsayılandan tahmin eder ve sonucu
 *     verified: false olarak işaretleriz.
 *
 * verified:false olan her fırsat bildirimde açıkça uyarı bayrağı taşır.
 * Salt-okunur API anahtarı eklendiğinde yapılacak tek şey bu dosyaya bir
 * provider daha eklemektir; motor kodu değişmez.
 */

import { createHash, createHmac } from 'node:crypto';
import { httpJson } from '../core/http.ts';
import type { ApiCredentials } from '../core/config.ts';
import { CEX_IDS, type CexId, type ChainId, type TransferInfo } from '../core/types.ts';

/** Borsaların ağ isimlerini bizim kanonik zincir kimliklerimize eşler. */
const CHAIN_ALIASES: Record<string, ChainId> = {
  sol: 'solana',
  solana: 'solana',
  spl: 'solana',
  base: 'base',
  basemainnet: 'base',
  baseevm: 'base',
  arbitrum: 'arbitrum',
  arbitrumone: 'arbitrum',
  arb: 'arbitrum',
  // Bybit "ARBI", OKX "Arbitrum One" der.
  arbi: 'arbitrum',
  arbevm: 'arbitrum',
  arbitrumevm: 'arbitrum',
};

export function normalizeChain(raw: string | undefined | null): ChainId | null {
  if (!raw) return null;
  const dene = (s: string): ChainId | null =>
    CHAIN_ALIASES[s.toLowerCase().replace(/[\s_\-()]/g, '')] ?? null;
  const direkt = dene(raw);
  if (direkt) return direkt;
  // MEXC "Solana(SOL)" / "Arbitrum One(ARB)" biçimini kullanıyor: parantezler
  // silinince "solanasol" oluyor ve hiçbir takma ada uymuyordu. Önce
  // parantezin İÇİ (kısa kod), sonra ÖNÜ (uzun ad) denenir.
  const m = /^([^(]*)\(([^)]*)\)/.exec(raw);
  if (m) return dene(m[2]!) ?? dene(m[1]!);
  return null;
}

/**
 * Binance/MEXC ağ kaydından zincir kimliği.
 *
 * Sıra ÖNEMLİ ve bir kez yanlıştı: `network ?? netWork` yazılınca `network`
 * doluysa `netWork` hiç denenmiyordu. MEXC `network`'e "Solana(SOL)" (o
 * dönem tanınmıyordu), `netWork`'e "SOL" yazıyor; sonuç, MEXC'in TÜM
 * Solana/Arbitrum satırlarının tabloya girmemesiydi. "Suskunluk = kapalı"
 * kuralı yüzünden bu, MEXC'in o zincirlerdeki her rotasının sessizce
 * `rejectedByTransfer`'e düşmesi demekti — veride anahtar sonrası
 * `mexc|solana` = 0, `mexc|arbitrum` = 0 (anahtar öncesi 114/151).
 * Her alan AYRI AYRI denenir; ilk tanınan kazanır.
 */
export function binanceStyleChain(n: {
  network?: string;
  netWork?: string;
  name?: string;
}): ChainId | null {
  return normalizeChain(n.netWork) ?? normalizeChain(n.network) ?? normalizeChain(n.name);
}

interface ChainEntry {
  chain: ChainId;
  withdrawEnabled: boolean;
  depositEnabled: boolean;
  withdrawFee: number;
  withdrawMin: number;
  /** Borsanın bildirdiği kontrat/mint adresi (küçük harf) — yoksa null. */
  address: string | null;
}

/**
 * Adresleri karşılaştırılabilir hale getirir.
 *
 * EVM adresleri borsalar arasında farklı harf düzeniyle geliyor (checksum'lı
 * ya da düz); Solana mint'leri ise base58 olduğu için büyük/küçük harf
 * ANLAMLIDIR ve küçültülemez. Bu yüzden yalnızca `0x` ile başlayanları
 * küçültüyoruz — hepsini küçültmek iki farklı Solana mint'ini eşit gösterebilir.
 */
function normalizeAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const a = raw.trim();
  if (a.length < 8) return null;
  return a.startsWith('0x') || a.startsWith('0X') ? a.toLowerCase() : a;
}

/** coin → chain → bilgi */
type CoinTable = Map<string, Map<ChainId, ChainEntry>>;

// ---------------------------------------------------------------------------
// Public kaynaklar
// ---------------------------------------------------------------------------

interface KucoinCurrency {
  currency: string;
  chains?: {
    chainName?: string;
    chainId?: string;
    isWithdrawEnabled?: boolean;
    isDepositEnabled?: boolean;
    withdrawalMinFee?: string;
    withdrawalMinSize?: string;
    contractAddress?: string | null;
  }[];
}

async function fetchKucoin(): Promise<CoinTable> {
  const r = await httpJson<{ data: KucoinCurrency[] }>(
    'https://api.kucoin.com/api/v3/currencies',
  );
  const table: CoinTable = new Map();

  for (const c of r.data ?? []) {
    for (const ch of c.chains ?? []) {
      // chainId genelde "sol"/"base"/"arbitrum" gibi kısa kod, chainName ise
      // görünen ad. Önce kısa kodu deneriz.
      const chain = normalizeChain(ch.chainId) ?? normalizeChain(ch.chainName);
      if (!chain) continue;

      const coin = c.currency.toUpperCase();
      let byChain = table.get(coin);
      if (!byChain) {
        byChain = new Map();
        table.set(coin, byChain);
      }
      byChain.set(chain, {
        chain,
        withdrawEnabled: ch.isWithdrawEnabled === true,
        depositEnabled: ch.isDepositEnabled === true,
        withdrawFee: Number(ch.withdrawalMinFee ?? 0),
        withdrawMin: Number(ch.withdrawalMinSize ?? 0),
        address: normalizeAddress(ch.contractAddress),
      });
    }
  }
  return table;
}

interface GateCurrency {
  currency: string;
  /** Coin'in VARSAYILAN zinciri — tam liste değil, `chains` alanına bak. */
  chain?: string;
  withdraw_disabled?: boolean;
  deposit_disabled?: boolean;
  withdraw_delayed?: boolean;
  trade_disabled?: boolean;
  /** Coin'in bulunduğu TÜM zincirler, kontrat adresleriyle. */
  chains?: {
    name?: string;
    addr?: string | null;
    withdraw_disabled?: boolean;
    deposit_disabled?: boolean;
  }[];
}

export const GATE_OLU_KAYIT = /_(?:OLD\d*|\d+)$/i;

/**
 * Aynı coin/zincir için birden fazla Gate kaydı geldiğinde KÖTÜMSER birleştirme.
 *
 * `byChain.set` ile üstüne yazmak, hangi kaydın SONRA geldiğine bağlı bir
 * sonuç üretir — yani doğruluk liste sırasına emanet edilir. Kapalıyı açık
 * göstermenin bedeli (ulaşılamaz fırsat) açığı kapalı göstermenin bedelinden
 * (kaçan fırsat) ağır olduğu için birleşim AND'dir.
 *
 * Adresler çelişiyorsa sonuç `null` — yani "bilinmiyor". Rastgele birini
 * seçmek kimlik çapraz kontrolünü kendi kendini doğrular hale getirirdi;
 * `pickChain` için `null` çakışma DEĞİL, yalnızca kararsızlıktır.
 */
function gateBirlestir(a: ChainEntry, b: ChainEntry): ChainEntry {
  return {
    chain: a.chain,
    withdrawEnabled: a.withdrawEnabled && b.withdrawEnabled,
    depositEnabled: a.depositEnabled && b.depositEnabled,
    withdrawFee: Number.isNaN(a.withdrawFee) ? b.withdrawFee : a.withdrawFee,
    withdrawMin: Math.max(a.withdrawMin, b.withdrawMin),
    address: a.address === b.address ? a.address : null,
  };
}

/**
 * Gate'in coin tablosu.
 *
 * ÖLÇÜLMÜŞ TUZAK: bir dönem yalnızca üst seviyedeki `chain` alanı okunuyordu.
 * O alan coin'in VARSAYILAN zinciridir, bulunduğu zincirlerin listesi değil —
 * `chains[]` dizisi asıl kaynaktır. Sonuç iki yönlü hataydı:
 *
 *   - Varsayılanı ETH olan ama Base'de de listeli bir coin tabloda hiç Base
 *     satırı taşımıyordu. "Suskunluk da bilgidir" kuralı devrede olduğu için
 *     bu, gerçek bir fırsatın SESSİZCE elenmesi demekti.
 *   - `chains[]` ayrıca `addr` (kontrat adresi) veriyor. Bu alanın var
 *     olmadığı sanıldığı için borsalar arası kimlik çapraz kontrolü
 *     "kapsanamaz" diye ölçüm dışı bırakılmıştı; oysa ölçüm Gate dahil
 *     tekrarlandığında 330 karşılaştırmada 4 çatışma çıktı (DEFAI/solana
 *     aynı zincirde iki farklı mint).
 *
 * Zincir başına durum bayrağı varsa o kullanılır; yoksa coin geneline düşülür
 * (Gate bazı satırlarda zincir bayraklarını boş bırakıyor).
 *
 * Ağdan ayrı bir fonksiyon: aşağıdaki hata sınıfları yalnızca gerçek cevap
 * biçimiyle görülebiliyor, testin de ağa çıkmadan aynı biçimi zorlaması
 * gerekiyor.
 */
export function gateTablosunuKur(list: readonly GateCurrency[]): CoinTable {
  const table: CoinTable = new Map();

  for (const c of list ?? []) {
    // ÖLÇÜLEN HATA — ölü listeleme kayıtları canlı kaydı EZİYORDU.
    //
    // Gate delisting'de kaydı silmiyor, `_OLD` / `_OLD2` / `_1` sonekiyle
    // saklıyor ve o kayıtların durum bayrakları eski (genelde "açık") kalıyor.
    // Taban coin adı ilk alt çizgiye kadar alındığı için `OX_OLD1` kaydı
    // `OX` satırının üstüne yazıyordu; ölçüm (2026-08-27, 5487 kayıt):
    // 624 coin|zincir satırının 6'sı iki kayıttan geliyordu ve **5'i
    // çelişiyordu** — hepsinde ölü kayıt "yatırma açık", canlı kayıt
    // "yatırma KAPALI" diyordu (OX/arbitrum, CATCH/arbitrum, GOB/arbitrum,
    // ROOST/base, RDNT/arbitrum). Yani yatırması kapalı bir coin tabloya
    // "açık" girip sinyal üretebiliyordu.
    //
    // Yalnızca ölü kayıttan gelen 10 satır da bu filtreyle düşüyor
    // (NEIRO/solana, CYS/solana, BABYSHARK/solana…) ve düşmesi DOĞRU: Gate'in
    // canlı kaydı o zinciri saymıyorsa orada iş yapamayız. Üstelik bunlar tam
    // olarak kimlik çakışması sınıfı — aynı ticker'ın eski token'ı.
    //
    // `_ETH` / `_BSC` gibi zincire özel kayıtlar ELENMEZ; onlar canlıdır ve
    // taban coin altında birleşmeleri gerekir (bkz. gateBirlestir).
    if (GATE_OLU_KAYIT.test(c.currency)) continue;

    // Gate'in currency kaydı "BTC_BSC" gibi zincire özel olabilir; taban
    // coin adını ilk alt çizgiye kadar alırız.
    const coin = (c.currency.split('_')[0] ?? c.currency).toUpperCase();

    // `chains` yoksa varsayılan zincire düşeriz — eski davranış, ama artık
    // yalnızca yedek yol.
    const rows = c.chains?.length
      ? c.chains
      : [{ name: c.chain, addr: null, withdraw_disabled: undefined, deposit_disabled: undefined }];

    for (const row of rows) {
      const chain = normalizeChain(row.name);
      if (!chain) continue;

      let byChain = table.get(coin);
      if (!byChain) {
        byChain = new Map();
        table.set(coin, byChain);
      }
      const entry: ChainEntry = {
        chain,
        withdrawEnabled: (row.withdraw_disabled ?? c.withdraw_disabled) !== true,
        depositEnabled: (row.deposit_disabled ?? c.deposit_disabled) !== true,
        // Gate bu endpoint'te çekim ücretini vermiyor; anahtar tanımlıysa
        // fetchGateFees dolduruyor, değilse tahmin katmanı devralıyor.
        withdrawFee: Number.NaN,
        withdrawMin: 0,
        address: normalizeAddress(row.addr),
      };
      const prev = byChain.get(chain);
      byChain.set(chain, prev ? gateBirlestir(prev, entry) : entry);
    }
  }
  return table;
}

async function fetchGate(): Promise<CoinTable> {
  const list = await httpJson<GateCurrency[]>(
    'https://api.gateio.ws/api/v4/spot/currencies',
  );
  return gateTablosunuKur(list ?? []);
}

// ---------------------------------------------------------------------------
// Private kaynaklar (salt-okunur API anahtarı gerektirir)
//
// Dört borsa da çekim/yatırma durumunu yalnızca imzalı endpoint'te veriyor.
// Anahtarların ÇEKİM YETKİSİ OLMAMALI — burada yalnızca okuma yapıyoruz.
//
// Ortak tuzak: imza zaman damgası içerir, bu yüzden her denemede yeniden
// imzalanmalıdır. httpJson'ın kendi retry'ı aynı URL'i tekrar gönderirdi ve
// ikinci deneme "timestamp geçersiz" ile ölürdü — bu yüzden retries:0 verip
// tekrar denemeyi withRetry ile dışarıda, yeni imzayla yapıyoruz.
// ---------------------------------------------------------------------------

/** Coin listesini borsanın kendi cevabından ortak tabloya çevirir. */
function addEntry(
  table: CoinTable,
  coin: string,
  chain: ChainId,
  entry: Omit<ChainEntry, 'chain'>,
): void {
  const c = coin.toUpperCase();
  let byChain = table.get(c);
  if (!byChain) {
    byChain = new Map();
    table.set(c, byChain);
  }
  byChain.set(chain, { chain, ...entry });
}

function hmacHex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

// --- Saat kayması ----------------------------------------------------------
//
// İmzalı isteklerde zaman damgası borsanın saatine göre doğrulanır ve borsalar
// GELECEKTEKİ zaman damgasını recvWindow'dan BAĞIMSIZ olarak ~1 sn toleransla
// reddeder (Binance -1021, Bybit 10002). Lokal saati doğru varsayamayız —
// canlı testte 2.1 sn ileri olduğunu ölçtük, bu tek başına dört borsanın
// tamamını çalışmaz hale getiriyordu.
//
// Feed katmanı da aynı sorunu çözüyor (bkz. base-feed.ts saat kayması
// düzeltmesi); burada bağımsız bir ölçüm tutuyoruz çünkü REST ve WebSocket
// uç noktaları farklı sunuculara düşebiliyor.

/** venue → (borsa saati − lokal saat) ms */
const clockOffsets = new Map<CexId, number>();

const CLOCK_ENDPOINTS: Partial<Record<CexId, { url: string; parse: (r: never) => number }>> = {
  binance: {
    url: 'https://api.binance.com/api/v3/time',
    parse: (r: { serverTime?: number }) => Number(r.serverTime),
  },
  mexc: {
    url: 'https://api.mexc.com/api/v3/time',
    parse: (r: { serverTime?: number }) => Number(r.serverTime),
  },
  bybit: {
    url: 'https://api.bybit.com/v5/market/time',
    parse: (r: { result?: { timeSecond?: string } }) => Number(r.result?.timeSecond) * 1000,
  },
  okx: {
    url: 'https://www.okx.com/api/v5/public/time',
    parse: (r: { data?: { ts?: string }[] }) => Number(r.data?.[0]?.ts),
  },
  gate: {
    url: 'https://api.gateio.ws/api/v4/spot/time',
    parse: (r: { server_time?: number }) => Number(r.server_time),
  },
};

/**
 * Borsanın saatiyle aramızdaki farkı ölçer.
 *
 * Gidiş-dönüş gecikmesinin yarısını hesaba katmak için sunucu saatini isteğin
 * ORTA noktasıyla karşılaştırıyoruz; aksi halde ölçtüğümüz kayma, gecikmenin
 * tamamı kadar yanlı çıkardı.
 */
async function syncClock(venue: CexId): Promise<void> {
  const ep = CLOCK_ENDPOINTS[venue];
  if (!ep) return;
  const t0 = Date.now();
  const body = await httpJson<never>(ep.url, { retries: 1, timeoutMs: 5000 });
  const t1 = Date.now();
  const serverMs = ep.parse(body);
  if (!Number.isFinite(serverMs) || serverMs <= 0) return;
  clockOffsets.set(venue, Math.round(serverMs - (t0 + t1) / 2));
}

/** İmzada kullanılacak, borsa saatine hizalanmış zaman damgası. */
function venueNow(venue: CexId): number {
  // 500 ms geri alıyoruz: kalan ölçüm hatası bizi İLERİ atarsa istek reddedilir,
  // geri atarsa recvWindow (20 sn) rahatlıkla soğuruyor. Asimetrik risk.
  return Date.now() + (clockOffsets.get(venue) ?? 0) - 500;
}

/** Ölçülen kaymalar — başlangıç logunda gösterilir. */
export function clockSkews(): ReadonlyMap<CexId, number> {
  return clockOffsets;
}

interface BinanceStyleCoin {
  coin: string;
  networkList?: {
    network?: string;
    /** MEXC bazı sürümlerde bu adı kullanıyor. */
    netWork?: string;
    name?: string;
    withdrawEnable?: boolean;
    depositEnable?: boolean;
    withdrawFee?: string | number;
    withdrawMin?: string | number;
    /** Binance bu adı kullanıyor. */
    contractAddress?: string | null;
    /** MEXC aynı bilgiyi bu adla veriyor. */
    contract?: string | null;
  }[];
}

/**
 * Binance ve MEXC aynı imza şemasını kullanıyor (MEXC API'sini Binance'ten
 * kopyaladı): query string'in HMAC-SHA256 hex'i `signature` parametresi olarak
 * eklenir, anahtar header'da gider.
 */
async function fetchBinanceStyle(
  venue: CexId,
  host: string,
  path: string,
  apiKeyHeader: string,
  cred: ApiCredentials,
): Promise<CoinTable> {
  const query = `timestamp=${venueNow(venue)}&recvWindow=20000`;
  const url = `https://${host}${path}?${query}&signature=${hmacHex(cred.secret, query)}`;

  const list = await httpJson<BinanceStyleCoin[]>(url, {
    headers: { [apiKeyHeader]: cred.key },
    retries: 0,
  });

  const table: CoinTable = new Map();
  for (const c of list ?? []) {
    for (const n of c.networkList ?? []) {
      const chain = binanceStyleChain(n);
      if (!chain) continue;
      addEntry(table, c.coin, chain, {
        withdrawEnabled: n.withdrawEnable === true,
        depositEnabled: n.depositEnable === true,
        withdrawFee: Number(n.withdrawFee ?? Number.NaN),
        withdrawMin: Number(n.withdrawMin ?? 0),
        address: normalizeAddress(n.contractAddress ?? n.contract),
      });
    }
  }
  return table;
}

const fetchBinance = (cred: ApiCredentials): Promise<CoinTable> =>
  fetchBinanceStyle(
    'binance',
    'api.binance.com',
    '/sapi/v1/capital/config/getall',
    'X-MBX-APIKEY',
    cred,
  );

const fetchMexc = (cred: ApiCredentials): Promise<CoinTable> =>
  fetchBinanceStyle(
    'mexc',
    'api.mexc.com',
    '/api/v3/capital/config/getall',
    'X-MEXC-APIKEY',
    cred,
  );

interface BybitCoinRow {
  coin: string;
  chains?: {
    chain?: string;
    chainType?: string;
    withdrawFee?: string;
    withdrawMin?: string;
    /** "0" | "1" */
    chainDeposit?: string;
    chainWithdraw?: string;
  }[];
}

/** Bybit imzası: HMAC(timestamp + apiKey + recvWindow + queryString). */
async function fetchBybit(cred: ApiCredentials): Promise<CoinTable> {
  const ts = String(venueNow('bybit'));
  const recvWindow = '20000';
  const query = '';
  const sign = hmacHex(cred.secret, ts + cred.key + recvWindow + query);

  const r = await httpJson<{ retCode?: number; retMsg?: string; result?: { rows?: BybitCoinRow[] } }>(
    'https://api.bybit.com/v5/asset/coin/query-info',
    {
      headers: {
        'X-BAPI-API-KEY': cred.key,
        'X-BAPI-TIMESTAMP': ts,
        'X-BAPI-RECV-WINDOW': recvWindow,
        'X-BAPI-SIGN': sign,
      },
      retries: 0,
    },
  );

  // Bybit hatayı HTTP 200 + retCode ile bildirir; sessizce boş tablo dönmemeliyiz.
  if (r.retCode !== undefined && r.retCode !== 0) {
    throw new Error(`bybit retCode ${r.retCode}: ${r.retMsg ?? ''}`);
  }

  const table: CoinTable = new Map();
  for (const row of r.result?.rows ?? []) {
    for (const ch of row.chains ?? []) {
      const chain = normalizeChain(ch.chain) ?? normalizeChain(ch.chainType);
      if (!chain) continue;
      addEntry(table, row.coin, chain, {
        withdrawEnabled: ch.chainWithdraw === '1',
        depositEnabled: ch.chainDeposit === '1',
        withdrawFee: Number(ch.withdrawFee ?? Number.NaN),
        withdrawMin: Number(ch.withdrawMin ?? 0),
        // Bybit `query-info` kontrat adresi vermiyor — kimlik çapraz kontrolü
        // bu borsa için yapılamaz (null = bilinmiyor, çakışma değil).
        address: null,
      });
    }
  }
  return table;
}

interface OkxCurrency {
  ccy: string;
  /** "SOL-Solana", "USDT-Arbitrum One" biçiminde. */
  chain?: string;
  canWd?: boolean;
  canDep?: boolean;
  minFee?: string;
  minWd?: string;
  /** Kontrat adresi. */
  ctAddr?: string | null;
}

/** OKX imzası: base64(HMAC(timestamp + method + requestPath)), ISO zaman damgası. */
async function fetchOkx(cred: ApiCredentials): Promise<CoinTable> {
  const path = '/api/v5/asset/currencies';
  const ts = new Date(venueNow('okx')).toISOString();
  const sign = createHmac('sha256', cred.secret).update(`${ts}GET${path}`).digest('base64');

  const r = await httpJson<{ code?: string; msg?: string; data?: OkxCurrency[] }>(
    `https://www.okx.com${path}`,
    {
      headers: {
        'OK-ACCESS-KEY': cred.key,
        'OK-ACCESS-SIGN': sign,
        'OK-ACCESS-TIMESTAMP': ts,
        'OK-ACCESS-PASSPHRASE': cred.passphrase ?? '',
      },
      retries: 0,
    },
  );

  if (r.code !== undefined && r.code !== '0') {
    throw new Error(`okx code ${r.code}: ${r.msg ?? ''}`);
  }

  const table: CoinTable = new Map();
  for (const c of r.data ?? []) {
    // "USDT-Arbitrum One" → zincir adı ilk tireden SONRAKİ kısımdır; coin
    // adının kendisi tire içerebileceği için sondan değil baştan ayırıyoruz.
    const dash = c.chain?.indexOf('-') ?? -1;
    const chainPart = dash >= 0 ? c.chain!.slice(dash + 1) : c.chain;
    const chain = normalizeChain(chainPart);
    if (!chain) continue;
    addEntry(table, c.ccy, chain, {
      withdrawEnabled: c.canWd === true,
      depositEnabled: c.canDep === true,
      withdrawFee: Number(c.minFee ?? Number.NaN),
      withdrawMin: Number(c.minWd ?? 0),
      address: normalizeAddress(c.ctAddr),
    });
  }
  return table;
}

interface KrakenWithdrawMethod {
  asset?: string;
  method?: string;
  /** "Solana", "Arbitrum One", "Base" gibi görünen ad. */
  network?: string;
  minimum?: string;
}

/**
 * Kraken çekim ağları — yalnızca imzalı endpoint'te.
 *
 * Kraken'in public tarafı bu bilgiyi HİÇ vermiyor (ölçüldü: `/0/public/Assets`
 * yalnızca `status`, `decimals`, `altname` döndürüyor; zincir listesi yok,
 * çekim durumu yok, kontrat adresi yok). Anahtar olmadan Kraken bacakları
 * zincir varlığını başka borsalardan devralıp iyimser davranmak zorunda —
 * yani "ortak zincir yok" durumunu tespit edemiyoruz, ki RWA hatasının
 * sınıfı tam olarak budur.
 *
 * Bu tablonun KAPSAMADIĞI iki şey var ve ikisi de bilinçli:
 *   - **Çekim ücreti**: Kraken genel bir ücret tablosu vermiyor.
 *     `/0/private/WithdrawInfo` önceden kaydedilmiş bir çekim adresi anahtarı
 *     istiyor, dolayısıyla tablo kurmak için kullanılamaz. Ücret
 *     `assumedFee()`'ye düşmeye devam eder.
 *   - **Kontrat adresi**: Kraken vermiyor → Kraken kimlik çapraz kontrolüne
 *     giremez (Bybit ile aynı durumda, `address: null`).
 *
 * Yatırma durumu ayrı bir uçtan (`/0/private/DepositMethods`) ve VARLIK BAŞINA
 * geliyor. Buradaki `depositEnabled: true` bu yüzden bir VARSAYIM DEĞİL,
 * yalnızca yer tutucudur: gerçek değer `TransferInfoProvider.lookup()` içinde
 * `krakenDepositFor()` ile ezilir (aşağıya bak). Bu satıra bakıp "yatırma
 * açık" sonucu çıkarma.
 *
 * Eskiden gerçekten varsayımdı ve ÖLÇÜLEN bir sahte sinyal üretti: BONK
 * `WithdrawMethods`'ta Solana ağıyla listeli (çekim açık) ama
 * `DepositMethods` BONK için BOŞ dizi döndürüyor — yani Kraken'e BONK
 * yatırılamıyor. Bot 5 dakikalık bir koşuda 9 BONK sinyali üretti ve
 * DOKUZUNDA DA satış tarafı kraken'di; hepsi gerçekleştirilemez.
 * "Ağ bazlı tek yönlü kapatma nadir" gerekçesi yanlıştı.
 *
 * İmza: `HMAC-SHA512(base64decode(secret), path + SHA256(nonce + postdata))`,
 * sonuç base64. Nonce artan olmak zorunda; ms zaman damgası kullanıyoruz.
 */
async function fetchKraken(cred: ApiCredentials): Promise<CoinTable> {
  const path = '/0/private/WithdrawMethods';
  // Nonce `venueNow()` ile ÜRETİLMEZ. Diğer borsalarda zaman damgası sunucu
  // saatine göre doğrulanır, bu yüzden kaymayı düzeltiyoruz; Kraken'de ise
  // nonce'un sunucu saatiyle ilgisi yok, tek şartı HER İSTEKTE ARTMASI.
  // Saat düzeltmesi uygulamak tam ters etki yapardı: iki tazeleme arasında
  // ölçülen offset küçülürse nonce geriye giderdi ve Kraken o andan sonra
  // TÜM istekleri "Invalid nonce" ile reddederdi — anahtar geçerliyken.
  const nonce = krakenNonce();
  const postData = `nonce=${nonce}`;

  const sha = createHash('sha256').update(nonce + postData).digest();
  const sign = createHmac('sha512', Buffer.from(cred.secret, 'base64'))
    .update(Buffer.concat([Buffer.from(path, 'utf8'), sha]))
    .digest('base64');

  const r = await httpJson<{ error?: string[]; result?: KrakenWithdrawMethod[] }>(
    `https://api.kraken.com${path}`,
    {
      method: 'POST',
      headers: {
        'API-Key': cred.key,
        'API-Sign': sign,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: postData,
      retries: 0,
    },
  );

  // Kraken hatayı HTTP 200 + `error` dizisiyle bildiriyor; sessizce boş tablo
  // dönmek "anahtar çalışıyor ama coin yok" gibi görünürdü.
  if (r.error && r.error.length > 0) {
    throw new Error(`kraken: ${r.error.join(', ')}`);
  }

  const table: CoinTable = new Map();
  for (const m of r.result ?? []) {
    if (!m.asset) continue;
    const chain = normalizeChain(m.network);
    if (!chain) continue;
    // Kraken varlık kodları eski biçimde olabilir (XXBT, XETH); ticker
    // eşleşmesi için WebSocket v2 adlarıyla aynı takma adları uyguluyoruz.
    const coin = krakenAssetToTicker(m.asset);
    addEntry(table, coin, chain, {
      // Listede görünmek çekilebilir olmak demektir; Kraken kapalı ağları
      // bu cevaba hiç koymuyor. "Suskunluk da bilgidir" kuralı burada
      // doğrudan uygulanıyor.
      withdrawEnabled: true,
      depositEnabled: true,
      withdrawFee: Number.NaN,
      withdrawMin: Number(m.minimum ?? 0),
      address: null,
    });
  }
  return table;
}

/**
 * Kraken varlık kodunu kanonik ticker'a çevirir.
 *
 * Eski kodlar X/Z önekli (XXBT, XETH, ZUSD) ve XBT→BTC, XDG→DOGE eşlemesi
 * gerekiyor — symbol-registry.ts'teki `KRAKEN_V2_ALIASES` ile AYNI mantık.
 * Burada tekrar ediyor çünkü orası WebSocket sembolü, burası varlık kodu
 * üretiyor; ikisi Kraken tarafında farklı alanlar.
 */
/**
 * Kraken nonce üreteci — MONOTONİK.
 *
 * Kraken'in tek şartı nonce'un her istekte ARTMASI. Düz `Date.now()` tek
 * istekte yeterliydi, ama yatırma sorgusu geldiğinden beri aynı milisaniyede
 * iki private istek çıkabiliyor; ikisi de aynı nonce'u alırsa Kraken o andan
 * SONRAKİ tüm istekleri "Invalid nonce" ile reddeder — anahtar geçerliyken.
 * Sayaç saatten geri gitmez ve çakışmada bir artar.
 */
let sonKrakenNonce = 0;
function krakenNonce(): string {
  const now = Date.now();
  sonKrakenNonce = now > sonKrakenNonce ? now : sonKrakenNonce + 1;
  return String(sonKrakenNonce);
}

/** Yatırma durumu bu süre sonra tazelenir (arka planda, eski değer servis edilir). */
const KRAKEN_DEPOSIT_TTL_MS = 30 * 60_000;
/** Düşen bir coin bu süre dolmadan yeniden sorulmaz. */
const KRAKEN_DEPOSIT_RETRY_MS = 5 * 60_000;
/** Bekleyen sorgu tavanı — Kraken'in dar kovasını tıkamamak için. */
const KRAKEN_DEPOSIT_QUEUE_MAX = 64;

interface KrakenDepositMethod {
  /** "Solana", "USDC - Base (Unified)", "kBTC - Ink (Unified)" gibi. */
  method?: string;
}

/**
 * Kraken yatırma yöntemi adından zincir çıkarır.
 *
 * Biçim iki türlü: ya düz ağ adı (`"Solana"`), ya `"<VARYANT> - <AĞ> (...)"`.
 * İkinci biçimde varyant kontrolü ŞART — ölçülen örnekler:
 *
 *   "USDC - Base (Unified)"      → USDC, base       ✓
 *   "USDC.e - Optimism (Unified)" → USDC.e, farklı token
 *   "kBTC - Ink (Unified)"        → kBTC, farklı token
 *
 * `USDC.e` ve `kBTC` sarmalanmış/köprülenmiş varyantlar; onları "USDC şu
 * ağda yatırılabilir" diye saymak, kimlik kuralının tam olarak yasakladığı
 * şey olurdu (ticker aynı, varlık değil). Bu yüzden ayraçtan önceki kısım
 * ticker'la birebir eşleşmezse kayıt yok sayılır.
 *
 * Parantezli sonek (`(Unified)`) zincir adından atılır; `normalizeChain`
 * onu tanımaz ve tanısaydı bile bilgi taşımıyor.
 */
export function krakenDepositChain(
  method: string | undefined,
  ticker: string,
): ChainId | null {
  if (!method) return null;
  const ayirac = method.indexOf(' - ');
  if (ayirac < 0) return normalizeChain(method);

  const varyant = method.slice(0, ayirac).trim();
  if (varyant.toUpperCase() !== ticker.toUpperCase()) return null;

  return normalizeChain(method.slice(ayirac + 3).replace(/\(.*?\)/g, '').trim());
}

/**
 * Bir varlığın Kraken'de YATIRMAYA açık olduğu zincirler.
 *
 * Boş küme geçerli bir cevaptır ve "hiçbir ağda yatırılamaz" demektir —
 * hata DEĞİL. Ayrım kritik: hatayı boş kümeye çevirmek, geçici bir arızayı
 * kalıcı "yatırma kapalı" gibi gösterirdi (ve tersi, boş kümeyi hata saymak
 * BONK'u sonsuza kadar yeniden sorgulatırdı).
 */
async function fetchKrakenDepositChains(
  cred: ApiCredentials,
  ticker: string,
): Promise<Set<ChainId>> {
  const path = '/0/private/DepositMethods';
  const nonce = krakenNonce();
  const postData = `nonce=${nonce}&asset=${encodeURIComponent(ticker)}`;

  const sha = createHash('sha256').update(nonce + postData).digest();
  const sign = createHmac('sha512', Buffer.from(cred.secret, 'base64'))
    .update(Buffer.concat([Buffer.from(path, 'utf8'), sha]))
    .digest('base64');

  const r = await httpJson<{ error?: string[]; result?: KrakenDepositMethod[] }>(
    `https://api.kraken.com${path}`,
    {
      method: 'POST',
      headers: {
        'API-Key': cred.key,
        'API-Sign': sign,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: postData,
      retries: 0,
    },
  );

  // Kraken hatayı HTTP 200 + `error` dizisiyle bildiriyor.
  if (r.error && r.error.length > 0) throw new Error(`kraken: ${r.error.join(', ')}`);

  const out = new Set<ChainId>();
  for (const m of r.result ?? []) {
    const chain = krakenDepositChain(m.method, ticker);
    if (chain) out.add(chain);
  }
  return out;
}

/**
 * Kraken'in v1 döneminden kalma önekli varlık kodları.
 *
 * Eskiden "4 harfli ve X/Z ile başlıyorsa ilk harfi at" KALIBI kullanılıyordu
 * ve bu, öneksiz her 4 harfli coini bozuyordu: ZEUS→EUS, ZORA→ORA, ZETA→ETA,
 * ZBCN→BCN, XAUT→AUT, XTER→TER. Sembol kaydı `wsname`'den "ZEUS" okuduğu için
 * `lookup('kraken','ZEUS')` tabloda hiçbir şey bulamıyor, çekim/yatırma
 * `false` dönüyor ve o coinlerin tüm Kraken rotaları sessizce eleniyordu
 * (anahtar sonrası veride Kraken bacaklı bu sınıftan 0 sinyal). Önek yalnızca
 * bu sonlu listede var; kalıp yerine liste.
 */
const KRAKEN_ESKI_KODLAR: Readonly<Record<string, string>> = {
  XXBT: 'BTC',
  XBT: 'BTC',
  XETH: 'ETH',
  XXDG: 'DOGE',
  XDG: 'DOGE',
  XLTC: 'LTC',
  XXMR: 'XMR',
  XXRP: 'XRP',
  XXLM: 'XLM',
  XZEC: 'ZEC',
  XETC: 'ETC',
  XMLN: 'MLN',
  XREP: 'REP',
  XICN: 'ICN',
  XNMC: 'NMC',
  XXVN: 'XVN',
  XDAO: 'DAO',
  ZUSD: 'USD',
  ZEUR: 'EUR',
  ZGBP: 'GBP',
  ZJPY: 'JPY',
  ZCAD: 'CAD',
  ZAUD: 'AUD',
  ZKRW: 'KRW',
};

export function krakenAssetToTicker(asset: string): string {
  let a = asset.toUpperCase();
  // ".S" / ".M" gibi staking varyantları ayrı varlıklar — taban kodu al.
  const dot = a.indexOf('.');
  if (dot > 0) a = a.slice(0, dot);
  return KRAKEN_ESKI_KODLAR[a] ?? a;
}

const PRIVATE_FETCHERS: Partial<Record<CexId, (c: ApiCredentials) => Promise<CoinTable>>> = {
  binance: fetchBinance,
  bybit: fetchBybit,
  okx: fetchOkx,
  mexc: fetchMexc,
  kraken: fetchKraken,
};

interface GateWithdrawStatus {
  currency: string;
  /** Zincir adı → coin cinsinden sabit çekim ücreti. */
  withdraw_fix_on_chains?: Record<string, string>;
  /** Asgari çekim tutarı (coin cinsinden). */
  withdraw_amount_mini?: string;
  /** Zincirden bağımsız sabit ücret — zincir kırılımı yoksa yedek. */
  withdraw_fix?: string;
}

/** coin → chain → { ücret, asgari } */
type GateFeeTable = Map<string, Map<ChainId, { fee: number; min: number }>>;

/**
 * Gate'in çekim ÜCRETLERİ — yalnızca imzalı endpoint'te.
 *
 * Gate diğer dört borsadan farklı bir yerde duruyor: çekim durumu (açık/kapalı)
 * ve kontrat adresi zaten public uçtan geliyor ve doğrulanmış sayılıyor.
 * Anahtarın eklediği TEK şey ücrettir — ama bu önemsiz değil: ücretsiz halde
 * `assumedFee()` devreye giriyor ve o tahmin işlem büyüklüğünün sabit bir
 * yüzdesi. Ucuz coinlerde tahmin gülünç şekilde sapıyor (ölçüm: RWA için
 * 769 coin tahmin edilirken KuCoin'in gerçek ücreti 450).
 *
 * Bu yüzden gate PRIVATE_FETCHERS'a KONULMADI: oradaki sözleşme "tablo
 * gelirse borsa doğrulanır" — gate zaten doğrulanmış durumda ve ücret çekimi
 * başarısız olsa bile doğrulanmış KALMALI. Tablo ayrı gelir, mevcut satırların
 * üstüne yalnızca ücret yazılır.
 *
 * Gate imzası diğerlerinden ayrı: HMAC-SHA512 ve imzalanan metin gövdenin
 * SHA512 özetini içeriyor; zaman damgası SANİYE (ms verilirse imza reddedilir).
 */
async function fetchGateFees(cred: ApiCredentials): Promise<GateFeeTable> {
  const path = '/api/v4/wallet/withdraw_status';
  const ts = Math.floor(venueNow('gate') / 1000);
  const bodyHash = createHash('sha512').update('').digest('hex');
  const sign = createHmac('sha512', cred.secret)
    .update(`GET\n${path}\n\n${bodyHash}\n${ts}`)
    .digest('hex');

  const list = await httpJson<GateWithdrawStatus[]>(`https://api.gateio.ws${path}`, {
    headers: { KEY: cred.key, SIGN: sign, Timestamp: String(ts) },
    retries: 0,
  });

  const table: GateFeeTable = new Map();
  for (const c of list ?? []) {
    const coin = c.currency.toUpperCase();
    const min = Number(c.withdraw_amount_mini ?? 0);
    for (const [rawChain, rawFee] of Object.entries(c.withdraw_fix_on_chains ?? {})) {
      const chain = normalizeChain(rawChain);
      if (!chain) continue;
      const fee = Number(rawFee);
      if (!Number.isFinite(fee)) continue;
      let byChain = table.get(coin);
      if (!byChain) {
        byChain = new Map();
        table.set(coin, byChain);
      }
      byChain.set(chain, { fee, min: Number.isFinite(min) ? min : 0 });
    }
  }
  return table;
}

/** İmzayı her denemede tazeleyerek tekrar dener. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: Error | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e as Error;
      // Kalıcı hatada (geçersiz anahtar, IP kısıtı) tekrar denemek anlamsız.
      if ((e as { permanent?: boolean }).permanent) break;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 400 * 2 ** i));
    }
  }
  throw last ?? new Error('bilinmeyen hata');
}

// ---------------------------------------------------------------------------
// Sağlayıcı
// ---------------------------------------------------------------------------

/**
 * Transfer tablosunun tazelenme aralığı.
 *
 * ÖLÇÜLEN HATA — eskiden 6 SAAT'ti ve bu, "yatırması kapalı coinin alarmı
 * saatlerce çaldı" şikâyetinin doğrudan sebebidir. Çekim/yatırma durumu
 * yapısal değil OPERASYONEL bir bilgidir: borsa ağ bakımına girdiğinde
 * dakikalar içinde kapanır. Kontrol kodu doğru çalışıyordu (`pickChain`
 * `depositEnabled`'a bakıyor), yalnızca baktığı veri 6 saate kadar eskiydi.
 *
 * Üstelik bu hata sınıfı kendini BESLİYOR: yatırması kapanan coinin fiyatı
 * tam da o yüzden ayrışır, yani tablo bayatken üretilen sinyal hem yanlış hem
 * de ısrarcı olur — 45 sn'lik "kapanmayan fark" uyarısı bile onu yakalayamaz,
 * çünkü uyarı sinyali engellemez.
 *
 * Maliyeti önemsiz: tam bir tazeleme kucoin + gate + gate ücret + anahtarlı
 * borsa başına 1 istek ≈ 7 istek. 15 dakikada bir bu, saatte 28 istek.
 */
const DEFAULT_REFRESH_MS = 15 * 60 * 1000;

/**
 * Tablo bu yaştan büyükse sinyaller uyarı taşır.
 *
 * `refreshIfStale` hatayı YUTUYOR (eski tabloyla devam etmek doğru olan), yani
 * arka arkaya başarısız tazeleme hiçbir iz bırakmadan tabloyu bayatlatabilir.
 * Üç tazeleme penceresi üst üste kaçırıldıysa artık "biliyoruz" diyemeyiz.
 */
export const TRANSFER_TABLE_STALE_MS = 3 * DEFAULT_REFRESH_MS;

export interface TransferInfoOptions {
  /** Ücreti bilinmeyen coinler için işlem büyüklüğüne oranla varsayılan maliyet. */
  readonly assumedFeePctOfTrade?: number;
  /**
   * Tahminin oranlandığı işlem büyüklüğü (quote cinsinden).
   *
   * Verilmezse 1000 varsayılır. `main.ts` bunu `cfg.scan.tradeSizeQuote`'tan
   * geçirir — aksi halde TRADE_SIZE_QUOTE değiştirildiğinde varsayılan çekim
   * ücreti oransal olarak yanlış ölçekte kalırdı.
   */
  readonly tradeSizeQuote?: number;
  /**
   * Tablo bu süreden eskiyse yenilenir (ms). Varsayılan `DEFAULT_REFRESH_MS`.
   */
  readonly refreshMs?: number;
  /** Salt-okunur API kimlikleri. Verilen her borsa doğrulanmış kaynağa terfi eder. */
  readonly credentials?: Partial<Record<CexId, ApiCredentials>>;
}

export class TransferInfoProvider {
  private kucoin: CoinTable = new Map();
  private gate: CoinTable = new Map();
  /**
   * Private endpoint'ten BAŞARIYLA çekilmiş tablolar. Anahtar tanımlı olsa bile
   * istek başarısız olduysa borsa buraya girmez — yarım veriyle "doğrulandı"
   * demek, hiç doğrulamamaktan daha tehlikelidir.
   */
  private readonly privateTables = new Map<CexId, CoinTable>();
  /** Anahtarı tanımlı ama çekimi başarısız olan borsalar → sebep. */
  private readonly privateErrors = new Map<CexId, string>();
  /** Coin'in hangi zincirlerde var olduğuna dair birleşik görünüm. */
  private known: CoinTable = new Map();
  /**
   * Kaynak BAŞINA son başarılı çekim anı.
   *
   * Tek bir `fetchedAt`, `refresh()`'in sonunda KOŞULSUZ yazılıyordu: KuCoin,
   * Gate ve imzalı uçların hepsi düşse bile tablo "taze" sayılıyor,
   * `tableAgeMs` "son başarılı tazeleme" değil "son deneme" ölçüyor ve
   * `TRANSFER_TABLE_STALE_MS` uyarısı ilk başarılı açılıştan sonra HİÇ
   * tetiklenemiyordu. Kısmi arıza (yalnızca KuCoin düşmüş) da görünmüyordu.
   * Artık her kaynak kendi zamanını taşır; tablo yaşı, bir kez de olsa
   * başarılı olmuş kaynakların EN ESKİSİDİR — hiç çalışmamış bir anahtar
   * tabloyu bayat göstermez (o zaten `credentialErrors`'ta).
   */
  private kucoinAt = 0;
  private gateAt = 0;
  private readonly privateAt = new Map<CexId, number>();
  private lastError: string | null = null;

  /** Bir kez de olsa başarılı olmuş kaynakların en eski çekim anı; hiç yoksa 0. */
  private get fetchedAt(): number {
    let enEski = Number.POSITIVE_INFINITY;
    for (const t of [this.kucoinAt, this.gateAt, ...this.privateAt.values()]) {
      if (t > 0 && t < enEski) enEski = t;
    }
    return Number.isFinite(enEski) ? enEski : 0;
  }

  /** Bu borsanın kendi tablosunun çekim anı; kendi tablosu yoksa genel yaş. */
  private fetchedAtFor(venue: CexId): number {
    if (venue === 'kucoin') return this.kucoinAt;
    if (venue === 'gate') return this.gateAt;
    return this.privateAt.get(venue) ?? this.fetchedAt;
  }

  // --- Kraken yatırma durumu (TALEP ÜZERİNE, coin bazında) -----------------
  //
  // Kraken'in toplu ucu (`WithdrawMethods`) yatırma bilgisi vermiyor; o bilgi
  // yalnızca VARLIK BAŞINA `DepositMethods`'tan geliyor. Tam tabloyu önden
  // kurmak 557 taranan sembol × 1 istek/sn ≈ 9 dakika sürerdi, bu yüzden
  // başlangıçta hiç çekilmiyordu ve yatırma çekimden VARSAYILIYORDU — ölçülen
  // sonucu BONK sahte sinyalleriydi.
  //
  // Çözüm mimarinin kendi fikri: bu bir AŞAMA 2 bilgisi. `pickChain` bir
  // coini sorduğunda o coin sıraya girer; 557 coinin tamamı değil, gerçekten
  // aday olan avuç dolusu coin sorulur. Derinlik önbelleğiyle aynı desen.
  /** ticker → yatırmaya açık zincirler + ne zaman çekildiği. */
  private readonly krakenDeposit = new Map<string, { chains: Set<ChainId>; at: number }>();
  private readonly krakenDepositPending = new Set<string>();
  /** ticker → son başarısızlık anı; yakın geçmişte düşen coin hemen tekrar denenmez. */
  private readonly krakenDepositFailedAt = new Map<string, number>();
  private readonly krakenDepositQueue: string[] = [];
  private krakenDepositBusy = false;
  /**
   * Uç nokta hiç kullanılamıyorsa (izin yok, kalıcı hata) sebebi.
   *
   * Bu durumda ESKİ iyimser davranışa dönülür — ama `verified: false` ile.
   * Alternatif (tüm Kraken satış rotalarını kapatmak) botu sessizce yarı
   * felç ederdi; kullanıcı sebebini göremeden Kraken fırsatlarının yok
   * olduğunu sanırdı. Sebep başlangıç logunda görünüyor.
   */
  private krakenDepositUnavailable: string | null = null;

  constructor(private readonly opts: TransferInfoOptions = {}) {}

  get lastRefreshError(): string | null {
    return this.lastError;
  }

  get coinsKnown(): number {
    return this.known.size;
  }

  async refresh(): Promise<void> {
    const creds = this.opts.credentials ?? {};
    const keyedVenues = (Object.keys(PRIVATE_FETCHERS) as CexId[]).filter((v) => creds[v]);
    const gateCred = creds.gate ?? null;

    // Anahtarı girilmiş ama transfer sağlayıcısı OLMAYAN borsa.
    //
    // `loadConfig()` `<BORSA>_API_KEY`'i CEX_IDS üzerinden geziyor, yani yeni bir
    // borsa eklendiği anda anahtarı kabul edilmeye başlıyor — ama o borsanın
    // burada bir fetcher'ı yoksa anahtar hiçbir işe yaramadan yok sayılırdı.
    // Kullanıcı anahtarı girmiş olmanın verdiği güvenle borsayı "doğrulanmış"
    // sanardı; oysa sinyalleri hâlâ uyarı taşıyor. Sessiz kalmak yerine
    // credentialErrors'a yazıyoruz ki başlangıç logunda görünsün.
    for (const v of CEX_IDS) {
      if (!creds[v] || v === 'gate' || PRIVATE_FETCHERS[v]) continue;
      this.privateErrors.set(
        v,
        'anahtar tanımlı ama bu borsa için transfer sağlayıcısı yok — anahtar KULLANILMIYOR',
      );
    }

    // İmzalamadan ÖNCE saatleri hizala — kayma ölçülmezse imza doğru olsa bile
    // istek zaman damgası yüzünden reddedilir.
    await Promise.allSettled(
      [...keyedVenues, ...(gateCred ? (['gate'] as const) : [])].map((v) => syncClock(v)),
    );

    const [k, g, gf, ...privates] = await Promise.allSettled([
      fetchKucoin(),
      fetchGate(),
      gateCred ? withRetry(() => fetchGateFees(gateCred)) : Promise.resolve(null),
      ...keyedVenues.map((v) => withRetry(() => PRIVATE_FETCHERS[v]!(creds[v]!))),
    ]);

    const simdi = Date.now();
    if (k.status === 'fulfilled') {
      this.kucoin = k.value;
      this.kucoinAt = simdi;
    }
    if (g.status === 'fulfilled') {
      this.gate = g.value;
      this.gateAt = simdi;
    }

    const errs: string[] = [];
    if (k.status === 'rejected') errs.push(`kucoin: ${(k.reason as Error).message}`);
    if (g.status === 'rejected') errs.push(`gate: ${(g.reason as Error).message}`);

    // Gate ücretleri mevcut satırların ÜSTÜNE yazılır: durum ve adres public
    // uçtan gelmeye devam eder, anahtar yalnızca tahmini gerçek ücretle
    // değiştirir. Başarısızlık gate'i doğrulanmamış YAPMAZ — yalnızca ücret
    // tahmine geri düşer ve sebep credentialErrors'ta görünür.
    if (gateCred) {
      if (gf.status === 'fulfilled' && gf.value && gf.value.size > 0) {
        for (const [coin, byChain] of gf.value) {
          const own = this.gate.get(coin);
          if (!own) continue;
          for (const [chain, { fee, min }] of byChain) {
            const entry = own.get(chain);
            if (entry) {
              entry.withdrawFee = fee;
              if (entry.withdrawMin === 0) entry.withdrawMin = min;
            }
          }
        }
        this.privateErrors.delete('gate');
      } else {
        const msg =
          gf.status === 'rejected'
            ? (gf.reason as Error).message
            : 'boş ücret tablosu döndü (anahtar yetkisi?)';
        this.privateErrors.set('gate', `çekim ücretleri alınamadı — ${msg}`);
        errs.push(`gate ücret: ${msg}`);
      }
    }

    for (let i = 0; i < keyedVenues.length; i++) {
      const venue = keyedVenues[i]!;
      const res = privates[i]!;
      if (res.status === 'fulfilled' && res.value.size > 0) {
        this.privateTables.set(venue, res.value);
        this.privateAt.set(venue, simdi);
        this.privateErrors.delete(venue);
      } else {
        // Eski tablo varsa onu korur, yoksa borsa doğrulanmamış kalır.
        const msg =
          res.status === 'rejected'
            ? (res.reason as Error).message
            : 'boş tablo döndü (anahtar yetkisi?)';
        this.privateErrors.set(venue, msg);
        errs.push(`${venue}: ${msg}`);
      }
    }

    this.lastError = errs.length > 0 ? errs.join(' | ') : null;

    // Kraken yatırma ucu KULLANILABİLİR Mİ — bir kez, başlangıçta yoklanır.
    //
    // Tembel sorgu "bilinmiyor = kapalı" diye davranıyor; uç nokta hiç
    // çalışmıyorsa (anahtarda izin yok, Kraken kapatmış) bu kural TÜM Kraken
    // satış rotalarını sessizce yok ederdi ve kullanıcı sebebini hiçbir yerde
    // göremezdi. Yoklama, arızayı BAŞLANGIÇTA görünür kılıyor: başarısızsa
    // eski iyimser davranışa dönülür ama kayıtlar `verified:false` taşır.
    await this.probeKrakenDeposit();

    // Birleşik görünüm: bir coin herhangi bir kaynakta bir zincirde görünüyorsa,
    // o zincirde var kabul ederiz. Doğrulanmamış borsalar için tek dayanağımız.
    const merged: CoinTable = new Map();
    for (const src of [this.kucoin, this.gate, ...this.privateTables.values()]) {
      for (const [coin, byChain] of src) {
        let dst = merged.get(coin);
        if (!dst) {
          dst = new Map();
          merged.set(coin, dst);
        }
        for (const [chain, entry] of byChain) {
          const prev = dst.get(chain);
          // Ücret bilgisi olan kaydı tercih et.
          if (!prev || (Number.isNaN(prev.withdrawFee) && !Number.isNaN(entry.withdrawFee))) {
            dst.set(chain, entry);
          }
        }
        // NOT: birleşik tabloya adres YAZILMIYOR. `known` "bu coin şu zincirde
        // var mı" sorusunu cevaplar ve kaynakları bilerek karıştırır; adres ise
        // borsaya ÖZGÜ olmak zorundadır. Birleşik adres, çakışan iki token'dan
        // rastgele birini "doğru" ilan edip çapraz kontrolü anlamsızlaştırırdı.
      }
    }
    this.known = merged;
  }

  async refreshIfStale(): Promise<void> {
    const maxAge = this.opts.refreshMs ?? DEFAULT_REFRESH_MS;
    if (Date.now() - this.fetchedAt > maxAge) {
      await this.refresh().catch(() => {
        /* lastError zaten dolduruldu; eski tabloyla devam ederiz */
      });
    }
  }

  /** Tablonun son başarılı tazelemeden bu yana geçen süresi (ms). */
  get tableAgeMs(): number {
    return this.fetchedAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - this.fetchedAt;
  }

  /** Bu coin'in transfer edilebileceği zincirler (herhangi bir kaynağa göre). */
  chainsFor(coin: string): ChainId[] {
    return [...(this.known.get(coin.toUpperCase())?.keys() ?? [])];
  }

  /**
   * Belirli bir borsa + coin + zincir için transfer bilgisi.
   * Bilgi kaynağı yoksa `verified: false` ile tahmin döner.
   */
  lookup(venue: CexId, coin: string, chain: ChainId, priceQuote: number): TransferInfo {
    const c = coin.toUpperCase();
    const now = Date.now();

    // Bu borsanın KENDİ tablosu yüklendiyse SUSKUNLUK da bilgidir: coin/zincir
    // listede yoksa o borsa o zincirde transferi desteklemiyor demektir.
    //
    // Bu kural public (gate/kucoin) ve private kaynaklar için AYNI olmak
    // zorunda. Bir dönem yalnızca private'a uygulanıyordu; sonuç, gate/kucoin'in
    // desteklemediği zincirlerde iyimser "bilinmiyor" kaydı üretmek ve
    // ulaşılamaz fırsatları sinyale çevirmekti. Birleşik tablo büyüdükçe
    // (anahtar eklendiğinde 643→1037 coin) bu hata katlanarak arttı.
    const own = this.tableFor(venue);
    if (own) {
      const e = own.get(c)?.get(chain);
      return {
        venue,
        coin: c,
        chain,
        withdrawEnabled: e?.withdrawEnabled ?? false,
        // Kraken'de yatırma AYRI uçtan gelir; tablodaki değer yer tutucudur.
        depositEnabled:
          venue === 'kraken'
            ? this.krakenDepositFor(c, chain, e)
            : (e?.depositEnabled ?? false),
        // Gate çekim ücretini vermiyor (NaN); durum bilgisi gerçek olduğu için
        // kayıt yine doğrulanmış sayılır, yalnızca ücret tahminle doldurulur.
        withdrawFee:
          e && !Number.isNaN(e.withdrawFee) ? e.withdrawFee : this.assumedFee(priceQuote),
        withdrawMin: e?.withdrawMin ?? 0,
        // Kraken'in yatırma ucu çalışmıyorsa durumu ÇEKİMDEN varsaymış
        // oluyoruz — bu doğrulanmış bir kayıt değildir ve öyle görünmemeli.
        verified: !(venue === 'kraken' && this.krakenDepositUnavailable !== null),
        fetchedAt: this.fetchedAtFor(venue) || now,
        address: e?.address ?? null,
      };
    }

    // Private endpoint'i olan borsalar: zincir varlığını biliyoruz, durumu değil.
    const exists = this.known.get(c)?.has(chain) ?? false;
    return {
      venue,
      coin: c,
      chain,
      // İyimser varsayım: açık kabul ediyoruz ama verified:false ile
      // işaretliyoruz. Kötümser varsayım (kapalı) tüm bu borsaları taramadan
      // çıkarır ve bot işe yaramaz hale gelir; doğru denge, sinyali üretip
      // belirsizliği kullanıcıya AÇIKÇA göstermek.
      withdrawEnabled: exists,
      depositEnabled: exists,
      withdrawFee: this.assumedFee(priceQuote),
      withdrawMin: 0,
      verified: false,
      fetchedAt: this.fetchedAt || now,
      // Tablosu olmayan borsanın adresini BİLMİYORUZ. Birleşik tablodan
      // devralmak cazip ama yanlış olurdu: devralınan adres başka bir
      // borsanın adresidir ve çapraz kontrol kendi kendini doğrular hale gelir.
      address: null,
    };
  }

  /**
   * Kraken'de bu coin/zincir yatırmaya açık mı.
   *
   * BİLİNMİYOR = KAPALI. Bu, projenin "suskunluk da bilgidir" kuralının aynısı
   * değil — burada henüz sormadık — ama yön aynı sebeple seçildi: bilinmeyeni
   * açık saymak tam olarak BONK hatasını üretir. Bilmediğimiz coin birkaç
   * saniye boyunca sinyal üretmez, sonra gerçek cevapla üretir; tersi yönde
   * hata gerçekleştirilemez bir fırsat yayınlamaktır.
   *
   * TTL dolduğunda ESKİ değer döndürülüp tazeleme arkaya atılır: yenileme
   * anında sinyalin kesilip kesilmemesi gereksiz bir dalgalanma olurdu.
   */
  private krakenDepositFor(
    coin: string,
    chain: ChainId,
    e: ChainEntry | undefined,
  ): boolean {
    // Çekim listesinde hiç yoksa zaten bu zincirde iş yapamayız.
    if (!e) return false;
    // Uç nokta kullanılamıyorsa eski iyimser davranış (verified:false ile).
    if (this.krakenDepositUnavailable !== null) return e.depositEnabled;

    const kayit = this.krakenDeposit.get(coin);
    if (kayit) {
      if (Date.now() - kayit.at > KRAKEN_DEPOSIT_TTL_MS) this.queueKrakenDeposit(coin);
      return kayit.chains.has(chain);
    }

    this.queueKrakenDeposit(coin);
    return false;
  }

  /**
   * Yatırma ucunun çalıştığını bir kez doğrular.
   *
   * Sonda olarak Kraken'in KENDİ tablosundan bir varlık seçiliyor: uydurma bir
   * ticker (ör. sabit 'SOL') Kraken'de listeli değilse hata döner ve çalışan
   * bir ucu bozuk sanardık.
   */
  private async probeKrakenDeposit(): Promise<void> {
    const cred = this.opts.credentials?.kraken;
    const table = this.privateTables.get('kraken');
    if (!cred || !table || table.size === 0) return;

    const ornek = table.keys().next().value;
    if (ornek === undefined) return;

    try {
      const chains = await fetchKrakenDepositChains(cred, ornek);
      // Yoklamanın sonucu da geçerli veri — atmıyoruz.
      this.krakenDeposit.set(ornek, { chains, at: Date.now() });
      this.krakenDepositUnavailable = null;
      this.privateErrors.delete('kraken');
    } catch (e) {
      const msg = (e as Error).message;
      this.krakenDepositUnavailable = msg;
      this.privateErrors.set(
        'kraken',
        `yatırma durumu sorgulanamıyor (${msg}) — yatırma ÇEKİMDEN VARSAYILIYOR, ` +
          `Kraken bacaklı sinyaller doğrulanmamış işaretlenir`,
      );
    }
  }

  private queueKrakenDeposit(coin: string): void {
    if (this.krakenDepositPending.has(coin)) return;
    if (!this.opts.credentials?.kraken) return;
    const failedAt = this.krakenDepositFailedAt.get(coin);
    if (failedAt !== undefined && Date.now() - failedAt < KRAKEN_DEPOSIT_RETRY_MS) return;
    // Kuyruk sınırlı: bir anda çok sayıda coin ıskalarsa Kraken'in dar kovasını
    // (1 istek/sn) dakikalarca meşgul edip derinlik çekimlerini aç bırakırdı.
    // Sığmayan coin bir sonraki görülüşünde yeniden sıraya girer.
    if (this.krakenDepositQueue.length >= KRAKEN_DEPOSIT_QUEUE_MAX) return;

    this.krakenDepositPending.add(coin);
    this.krakenDepositQueue.push(coin);
    void this.drainKrakenDeposit();
  }

  /** Kuyruğu TEK akışta işler — Kraken'in private limiti dar. */
  private async drainKrakenDeposit(): Promise<void> {
    if (this.krakenDepositBusy) return;
    const cred = this.opts.credentials?.kraken;
    if (!cred) return;

    this.krakenDepositBusy = true;
    try {
      for (;;) {
        const coin = this.krakenDepositQueue.shift();
        if (coin === undefined) break;
        try {
          const chains = await fetchKrakenDepositChains(cred, coin);
          this.krakenDeposit.set(coin, { chains, at: Date.now() });
          this.krakenDepositFailedAt.delete(coin);
        } catch (e) {
          // Tek coinin düşmesi uç noktayı kullanılamaz yapmaz — sebep coine
          // özel olabilir (bilinmeyen varlık kodu). Genel arıza teşhisi
          // refresh()'teki yoklamanın işi.
          this.krakenDepositFailedAt.set(coin, Date.now());
          this.lastError = `kraken yatırma (${coin}): ${(e as Error).message}`;
        } finally {
          this.krakenDepositPending.delete(coin);
        }
      }
    } finally {
      this.krakenDepositBusy = false;
    }
  }

  /** Coin cinsinden tahmini çekim ücreti. */
  private assumedFee(priceQuote: number): number {
    const pct = this.opts.assumedFeePctOfTrade ?? 0.001;
    const tradeSize = this.opts.tradeSizeQuote ?? 1000;
    if (!(priceQuote > 0)) return 0;
    // Tipik çekim ücretlerini kabaca yakalayan yaklaşım: işlem büyüklüğünün
    // sabit bir yüzdesi, coin fiyatına bölünerek coin adedine çevrilir.
    // İşlem büyüklüğü eskiden 1000 olarak koda gömülüydü; seçeneğin adı
    // "...PctOfTrade" olmasına rağmen TRADE_SIZE_QUOTE hesaba hiç girmiyordu.
    return (pct * tradeSize) / priceQuote;
  }

  /**
   * Hangi borsaların verisi gerçekten doğrulanmış.
   *
   * Artık statik değil: gate/kucoin her zaman public API'den doğrulanır, diğer
   * borsalar ancak anahtarları tanımlıysa VE çekim başarılıysa listeye girer.
   */
  /**
   * Bu borsanın kendi transfer tablosu — public ya da private, fark etmez.
   * Boş tablo "yüklenmedi" sayılır: yarım veriyle karar vermeyiz.
   */
  private tableFor(venue: CexId): CoinTable | null {
    const t =
      venue === 'kucoin' ? this.kucoin : venue === 'gate' ? this.gate : this.privateTables.get(venue);
    return t && t.size > 0 ? t : null;
  }

  get verifiedVenues(): CexId[] {
    return CEX_IDS.filter((v) => this.tableFor(v) !== null);
  }

  get unverifiedVenues(): CexId[] {
    return CEX_IDS.filter((v) => !this.verifiedVenues.includes(v));
  }

  /** Anahtarı tanımlı olduğu halde doğrulanamayan borsalar → sebep. */
  get credentialErrors(): ReadonlyMap<CexId, string> {
    return this.privateErrors;
  }
}
