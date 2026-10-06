/**
 * DEX token tablosunu borsalarla eşitler: Solana, Base ve Arbitrum'da
 * taranabilecek tüm token'ları bulup config/tokens.json'a yazar.
 *
 * KAYNAK SEÇİMİ, kimlik kuralının doğrudan sonucudur. Bir varlığın kimliği
 * ticker değil kontrat/mint adresidir; bir coin'in adresini bilen otoriter yer
 * ise o coin'i o zincirde gerçekten gönderip alan borsadır. Dört kaynak
 * kullanıyoruz:
 *
 *   kucoin   public /api/v3/currencies              — anahtar gerekmez
 *   gate     public /api/v4/spot/currencies         — anahtar gerekmez, en geniş
 *   binance  private /sapi/v1/capital/config/getall
 *   okx      private /api/v5/asset/currencies
 *
 * Gate uzun süre kaynak DEĞİLDİ ve bunun sebebi bir okuma hatasıydı: adres
 * üst seviyedeki `chain` alanında değil `chains[].addr` içinde duruyor, o alan
 * hiç okunmuyordu ve Gate "adres vermiyor" sanılıyordu. Gate spot piyasası en
 * geniş olan borsa (~2200 çift), yani bu tek satırlık okuma hatasının bedeli
 * doğrudan DEX kapsamıydı.
 *
 * Birden fazla kaynak kullanmanın asıl değeri kapsam değil ÇAPRAZ KONTROL:
 * iki borsa aynı ticker için farklı adres veriyorsa bu, tam da kaçındığımız
 * ticker çakışmasıdır (birden fazla "MOON", "APE", "SUN" vardır). Çelişkili
 * girdiler yazılmaz, raporda listelenir.
 *
 * Doğrulama zincire göre değişir ama amaç aynı: adresin VAR olması doğru adres
 * olduğunu göstermez.
 *
 *   solana  Jupiter price/v3 → decimals + USD fiyat (rota yoksa fiyat da yok)
 *   evm     zincirden ERC20 symbol()/decimals() + DEX quoter'dan gerçek fiyat
 *
 * EVM doğrulaması BOTUN YETENEĞİYLE AYNI olmak zorunda: tabloya, botun
 * fiyatlayamayacağı token yazmak boşuna RPC harcar; tersine, botun
 * fiyatlayabildiği bir venue'yu burada denememek tabloyu haksız yere daraltır.
 * Arbitrum'da bot artık hem Camelot hem Uniswap V3 soruyor (GRT/UNI yalnızca
 * UniV3'te), keşif de öyle: Camelot sıfır dönerse tüm UniV3 fee tier'ları
 * denenir ve EN İYİ çıktı alınır. İlk çalışanı seçmek ince bir havuza düşüp
 * fiyatı düşük gösterir ve token sapma filtresine takılıp haksızca elenirdi.
 *
 * Base'de aynı kural üç venue'ya uygulanıyor: Aerodrome, Uniswap V3 ve CoW.
 * Sonuncusu belirleyici — CoW bir AMM değil toplayıcı olduğu için çok adımlı
 * (WETH üzerinden) rotayı solver kuruyor. ÖLÇÜM: yalnızca doğrudan-USDC soran
 * eski sürümde Base'de 78 aday elendi ve tabloya 0 token girdi; elenenlerin
 * 43'ü CoW'a sorulduğunda 27'si fiyatlandı ve sapma+spread filtrelerini geçti.
 * Yani Base'deki darboğaz adres kaynağı değil ROTA'ydı.
 *
 * Her iki yolda da son kontrol aynı: DEX fiyatı CEX fiyatından %25'ten fazla
 * sapıyorsa girdi yazılmaz. Gerçek CEX↔DEX farkı likit coinlerde %0.5'in
 * altındadır; bu büyüklükte bir sapma fiyat hareketi değil yanlış eşleşmedir.
 *
 * Kullanım:
 *   npm run discover-tokens                  # rapor (dosyaya dokunmaz)
 *   npm run discover-tokens -- --yaz         # config/tokens.json'u güncelle
 *   npm run discover-tokens -- solana --yaz  # tek zincir
 */

import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, http, parseAbi, type Address } from 'viem';
import { base as baseChain, arbitrum as arbChain } from 'viem/chains';
import { loadConfig, tokenTablosunuDogrula, ROOT, type AppConfig } from '../src/core/config.ts';
import { httpJson } from '../src/core/http.ts';
import { SymbolRegistry, isLeveragedTicker } from '../src/normalize/symbol-registry.ts';
import { GATE_OLU_KAYIT, normalizeChain } from '../src/engine/transfer-info.ts';
import { tasimaArizasiMi } from '../src/feeds/dex/evm.ts';
import { DEVRE_DISI } from '../src/feeds/dex/index.ts';
// ABI'ler feed'den geliyor: kopyalanırsa keşif ile bot zamanla farklı şeyi
// sorar ve tablo "botun fiyatlayamadığı" tokenlarla dolar.
import {
  AERODROME_ABI,
  ALGEBRA_QUOTER_ABI,
  UNIV3_QUOTER_ABI,
  UNIV3_PATH_ABI,
  ALGEBRA_PATH_ABI,
} from '../src/feeds/dex/evm.ts';
import type { DexContracts } from '../src/feeds/dex/index.ts';
import { HttpCowQuoter } from '../src/feeds/dex/cow.ts';
import { CEX_IDS, EXCLUDED_BASES, pairKey, type ChainId } from '../src/core/types.ts';

/**
 * UniV3 çok adımlı yol baytları — feed'dekiyle AYNI kodlama.
 *
 * `evm.ts`'teki sürüm private; burada tekrar yazmak yerine ihraç etmek daha
 * doğru olurdu ama kodlama üç satır ve kuralı sabit (tokenIn+fee+ara+fee+
 * tokenOut). Değişirse ikisi de değişmeli.
 */
const univ3Yol = (
  a: string,
  f1: number,
  mid: string,
  f2: number,
  b: string,
): `0x${string}` =>
  `0x${a.slice(2).toLowerCase()}${f1.toString(16).padStart(6, '0')}${mid
    .slice(2)
    .toLowerCase()}${f2.toString(16).padStart(6, '0')}${b.slice(2).toLowerCase()}`;

/** Algebra (Camelot) çok adımlı yol — fee alanı yok, havuzdan okunur. */
const algebraYol = (a: string, mid: string, b: string): `0x${string}` =>
  `0x${a.slice(2).toLowerCase()}${mid.slice(2).toLowerCase()}${b.slice(2).toLowerCase()}`;


const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Jupiter price/v3'e tek istekte sorulacak azami mint (bkz. feeds/dex/jupiter.ts). */
const PRICE_CHUNK = 40;

/** DEX ↔ CEX fiyatı arasında kabul edilen azami sapma. */
const MAX_PRICE_DEVIATION = 0.25;

/** EVM quoter probu için kullanılacak nominal büyüklük (USD). */
// `main()` bunu `cfg.scan.tradeSizeQuote` ile ezer: keşif botla AYNI büyüklüğü
// sormalı, yoksa $100'da geçen token $1000'da taşınmayabilir ve tabloya girer.
let PROBE_USD = 1000;

const ERC20_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);

interface TokenEntry {
  symbol: string;
  chain: string;
  address: string;
  decimals: number;
}

/** Bir (zincir, sembol) için kaynakların verdiği adresler. */
type Adaylar = Map<string, Map<string, string>>;

// ---------------------------------------------------------------------------
// Kaynaklar
// ---------------------------------------------------------------------------

/**
 * Zincir adı eşlemesi tek yerden: `normalizeChain` (transfer-info.ts).
 *
 * Burada üç ayrı `AG_*` tablosu vardı ve her biri yalnızca üç ad tanıyordu.
 * İkinci bir eşleme tablosu tutmak, borsa ad yazımını değiştirdiğinde iki
 * yerden birinin güncellenmemesi demek — ve o hata SESSİZ: zincir eşleşmez,
 * token adayı hiç görünmez. Motor tarafı zaten `normalizeChain` kullanıyor.
 */

function kaydet(
  adaylar: Adaylar,
  kaynak: string,
  chain: ChainId,
  sembol: string,
  adres: string,
): void {
  const gecerli = chain === 'solana' ? SOL_ADDR.test(adres) : EVM_ADDR.test(adres);
  if (!gecerli) return;
  const anahtar = `${chain}|${sembol.toUpperCase()}`;
  let e = adaylar.get(anahtar);
  if (!e) adaylar.set(anahtar, (e = new Map()));
  // EVM adresleri büyük/küçük harf duyarsızdır; karşılaştırma için normalize.
  e.set(kaynak, chain === 'solana' ? adres : adres.toLowerCase());
}

async function kucoinAdresleri(adaylar: Adaylar): Promise<number> {
  const r = await httpJson<{
    data: { currency: string; chains?: { chainId?: string; contractAddress?: string }[] }[];
  }>('https://api.kucoin.com/api/v3/currencies', { timeoutMs: 20_000, retries: 1 });

  let n = 0;
  for (const c of r.data ?? []) {
    for (const ch of c.chains ?? []) {
      const chain = normalizeChain(ch.chainId);
      if (!chain || !ch.contractAddress) continue;
      kaydet(adaylar, 'kucoin', chain, c.currency, ch.contractAddress);
      n++;
    }
  }
  return n;
}

/**
 * Gate public currency listesi.
 *
 * Adres `chains[].addr` içindedir; üst seviyedeki `chain` alanı coin'in yalnızca
 * VARSAYILAN zinciridir ve adres taşımaz. Zincir adı eşlemesi için kendi
 * tablosunu değil `normalizeChain` kullanıyoruz — Gate'in ad yazımı zaten orada
 * karşılanıyor (transfer tablosu bu borsadan besleniyor), ikinci bir tablo
 * tutmak ikisinin ayrışması demekti.
 */
async function gateAdresleri(adaylar: Adaylar): Promise<number> {
  const list = await httpJson<
    { currency: string; chains?: { name?: string; addr?: string | null }[] }[]
  >('https://api.gateio.ws/api/v4/spot/currencies', { timeoutMs: 20_000, retries: 1 });

  let n = 0;
  for (const c of list ?? []) {
    // Delist edilmiş `_OLD` / `_1` kayıtları ESKİ kontratı taşır; taban ad
    // ilk alt çizgiye kadar alındığı için `NEIRO_OLD`, `NEIRO`'nun oyu olarak
    // sayılıyor ve ya sahte 2-2 beraberlik üretiyor ya da Gate tek kaynaksa
    // ölü adres tabloya giriyordu. Transfer tablosu bunları zaten eliyor
    // (`gateTablosunuKur`); keşif aynı kalıbı kullanır.
    if (GATE_OLU_KAYIT.test(c.currency)) continue;
    // Gate'in currency kaydı "BTC_BSC" gibi zincire özel olabilir.
    const coin = (c.currency.split('_')[0] ?? c.currency).toUpperCase();
    for (const row of c.chains ?? []) {
      const chain = normalizeChain(row.name);
      if (!chain || !row.addr) continue;
      kaydet(adaylar, 'gate', chain, coin, row.addr);
      n++;
    }
  }
  return n;
}

/**
 * Binance tarzı `capital/config/getall` — Binance ve MEXC aynı şemayı kullanır
 * (imza HMAC-SHA256, yalnızca host/yol/başlık farklı).
 *
 * MEXC ağ adını üç ayrı alanda verebiliyor (`network`, `netWork`, `name`);
 * üçünü de deniyoruz — transfer tablosu tarafında da aynısı yapılıyor.
 */
async function binanceTarziAdresler(
  adaylar: Adaylar,
  kaynak: string,
  host: string,
  yol: string,
  baslik: string,
  saatYolu: string,
  cred: { key: string; secret: string },
): Promise<number> {
  // Saat kayması: borsalar gelecekteki zaman damgasını reddeder (bkz.
  // engine/transfer-info.ts). 500 ms geri alıyoruz — asimetrik risk.
  const t0 = Date.now();
  const t = await httpJson<{ serverTime?: number }>(`https://${host}${saatYolu}`, {
    timeoutMs: 8000,
  });
  const server = Number(t.serverTime);
  const ts = Number.isFinite(server)
    ? Math.round(Date.now() + (server - (t0 + Date.now()) / 2) - 500)
    : Date.now() - 500;

  const query = `timestamp=${ts}&recvWindow=20000`;
  const signature = createHmac('sha256', cred.secret).update(query).digest('hex');
  const list = await httpJson<
    {
      coin: string;
      networkList?: {
        network?: string;
        netWork?: string;
        name?: string;
        contractAddress?: string;
        contract?: string;
      }[];
    }[]
  >(`https://${host}${yol}?${query}&signature=${signature}`, {
    headers: { [baslik]: cred.key },
    timeoutMs: 20_000,
    retries: 0,
  });

  let n = 0;
  for (const c of list) {
    for (const net of c.networkList ?? []) {
      const chain =
        normalizeChain(net.network) ?? normalizeChain(net.netWork) ?? normalizeChain(net.name);
      const adres = net.contractAddress ?? net.contract;
      if (!chain || !adres) continue;
      kaydet(adaylar, kaynak, chain, c.coin, adres);
      n++;
    }
  }
  return n;
}

const binanceAdresleri = (adaylar: Adaylar, cred: { key: string; secret: string }) =>
  binanceTarziAdresler(
    adaylar,
    'binance',
    'api.binance.com',
    '/sapi/v1/capital/config/getall',
    'X-MBX-APIKEY',
    '/api/v3/time',
    cred,
  );

const mexcAdresleri = (adaylar: Adaylar, cred: { key: string; secret: string }) =>
  binanceTarziAdresler(
    adaylar,
    'mexc',
    'api.mexc.com',
    '/api/v3/capital/config/getall',
    'X-MEXC-APIKEY',
    '/api/v3/time',
    cred,
  );

async function okxAdresleri(
  adaylar: Adaylar,
  cred: { key: string; secret: string; passphrase?: string | null },
): Promise<number> {
  const yol = '/api/v5/asset/currencies';
  const ts = new Date(Date.now() - 500).toISOString();
  const sign = createHmac('sha256', cred.secret).update(`${ts}GET${yol}`).digest('base64');

  const r = await httpJson<{ data?: { ccy: string; chain?: string; ctAddr?: string }[] }>(
    `https://www.okx.com${yol}`,
    {
      headers: {
        'OK-ACCESS-KEY': cred.key,
        'OK-ACCESS-SIGN': sign,
        'OK-ACCESS-TIMESTAMP': ts,
        'OK-ACCESS-PASSPHRASE': cred.passphrase ?? '',
      },
      timeoutMs: 20_000,
      retries: 0,
    },
  );

  let n = 0;
  for (const d of r.data ?? []) {
    // OKX zinciri "TOKEN-Solana" biçiminde verir.
    const chain = normalizeChain((d.chain ?? '').split('-').slice(1).join('-'));
    if (!chain) continue;
    let adres = d.ctAddr ?? '';
    if (!adres) continue;
    // OKX EVM adreslerini bazen 0x öneki olmadan döndürüyor.
    if (chain !== 'solana' && !adres.startsWith('0x')) adres = `0x${adres}`;
    kaydet(adaylar, 'okx', chain, d.ccy, adres);
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// CEX referans fiyatı
// ---------------------------------------------------------------------------

/**
 * Sembol → USDT orta fiyatı. Tek istekte tüm piyasa çekiliyor; token başına
 * ayrı çağrı yüzlerce istek demek olurdu.
 */
async function cexFiyatlari(): Promise<Map<string, number>> {
  const out = new Map<string, number>();

  try {
    const t = await httpJson<{ symbol: string; bidPrice: string; askPrice: string }[]>(
      'https://api.binance.com/api/v3/ticker/bookTicker',
      { timeoutMs: 20_000, retries: 1 },
    );
    for (const s of t) {
      if (!s.symbol.endsWith('USDT')) continue;
      const bid = Number(s.bidPrice);
      const ask = Number(s.askPrice);
      if (!(bid > 0) || !(ask > 0)) continue;
      out.set(s.symbol.slice(0, -4), (bid + ask) / 2);
    }
  } catch {
    /* KuCoin'e düşülür */
  }

  try {
    const k = await httpJson<{ data?: { ticker?: { symbol: string; last?: string }[] } }>(
      'https://api.kucoin.com/api/v1/market/allTickers',
      { timeoutMs: 20_000, retries: 1 },
    );
    for (const t of k.data?.ticker ?? []) {
      if (!t.symbol.endsWith('-USDT')) continue;
      const sembol = t.symbol.slice(0, -5);
      if (out.has(sembol)) continue; // Binance önceliklidir
      const p = Number(t.last);
      if (p > 0) out.set(sembol, p);
    }
  } catch {
    /* Binance verisiyle devam */
  }

  // Referans fiyat kapsamı, ADRES kaynaklarının kapsamıyla aynı genişlikte
  // olmalı. Fiyatı yalnızca Binance/KuCoin'de aramak, Gate/MEXC/OKX'e özgü
  // tokenları "CEX fiyatı yok" diye sapma kontrolü YAPILMADAN tabloya
  // sokuyordu — ölçüldü: SUPERFORM böyle geçiyordu, Gate fiyatı eklenince
  // %89 sapmayla elendi. Hepsi tek istek, hepsi public.
  const digerKaynaklar: { url: string; oku: (b: unknown) => [string, number][] }[] = [
    {
      url: 'https://api.gateio.ws/api/v4/spot/tickers',
      oku: (b) =>
        (b as { currency_pair: string; last?: string }[]).flatMap((t) =>
          t.currency_pair.endsWith('_USDT')
            ? [[t.currency_pair.slice(0, -5), Number(t.last)] as [string, number]]
            : [],
        ),
    },
    {
      url: 'https://api.mexc.com/api/v3/ticker/price',
      oku: (b) =>
        (b as { symbol: string; price?: string }[]).flatMap((t) =>
          t.symbol.endsWith('USDT')
            ? [[t.symbol.slice(0, -4), Number(t.price)] as [string, number]]
            : [],
        ),
    },
    {
      url: 'https://www.okx.com/api/v5/market/tickers?instType=SPOT',
      oku: (b) =>
        ((b as { data?: { instId: string; last?: string }[] }).data ?? []).flatMap((t) =>
          t.instId.endsWith('-USDT')
            ? [[t.instId.slice(0, -5), Number(t.last)] as [string, number]]
            : [],
        ),
    },
    {
      url: 'https://api.bybit.com/v5/market/tickers?category=spot',
      oku: (b) =>
        ((b as { result?: { list?: { symbol: string; lastPrice?: string }[] } }).result?.list ??
          []).flatMap((t) =>
          t.symbol.endsWith('USDT')
            ? [[t.symbol.slice(0, -4), Number(t.lastPrice)] as [string, number]]
            : [],
        ),
    },
  ];

  for (const k of digerKaynaklar) {
    try {
      const body = await httpJson<unknown>(k.url, { timeoutMs: 20_000, retries: 1 });
      for (const [sembol, p] of k.oku(body)) {
        // İlk yazan kazanır: sıra likidite sırasıdır (Binance → … → Bybit).
        if (!out.has(sembol) && p > 0) out.set(sembol, p);
      }
    } catch {
      /* mevcut verilerle devam */
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Doğrulama — Solana
// ---------------------------------------------------------------------------

interface Dogrulama {
  decimals: number;
  dexFiyat: number;
  /** Fiyatı hangi venue verdi — EVM'de rapora yazılır (Solana'da tek yol var). */
  rota?: string;
}

async function solanaDogrula(
  mintler: string[],
): Promise<Map<string, Dogrulama>> {
  const out = new Map<string, Dogrulama>();
  for (let i = 0; i < mintler.length; i += PRICE_CHUNK) {
    const chunk = mintler.slice(i, i + PRICE_CHUNK);
    const res = await httpJson<
      Record<string, { usdPrice?: number; decimals?: number } | undefined>
    >(`https://lite-api.jup.ag/price/v3?ids=${chunk.join(',')}`, {
      timeoutMs: 15_000,
      retries: 1,
    });
    for (const mint of chunk) {
      const e = res[mint];
      const fiyat = e?.usdPrice ?? 0;
      const dec = e?.decimals;
      if (fiyat > 0 && typeof dec === 'number' && Number.isInteger(dec) && dec >= 0) {
        out.set(mint, { decimals: dec, dexFiyat: fiyat });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Doğrulama — EVM
// ---------------------------------------------------------------------------

const norm = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Doğrulama sonucunun anahtarı: (SEMBOL, adres) — yalnızca adres DEĞİL.
 *
 * ÖLÇÜLEN HATA: harita yalnızca adrese göre anahtarlıydı ve iki ticker aynı
 * kontratı gösterdiğinde biri diğerinin doğrulamasını devralıyordu. Base'de
 * `0x5b2193fd…` kontratının zincirdeki sembolü `UP` (adı "Superform"); KuCoin
 * onu `UP`, Gate/MEXC `SUPERFORM` olarak listeliyor. `UP` sembol kontrolünü
 * geçip haritaya yazıyor, `SUPERFORM` kontrolde DÜŞÜYOR ama `sonuc.get(adres)`
 * dolu geldiği için doğrulanmış sayılıp tabloya giriyordu.
 *
 * İki bedeli vardı: (a) aynı token iki ayrı ticker'la tabloya girer ve hangi
 * CEX çiftine eşleneceği belirsizleşir, (b) `loadConfig()` yinelenen adresi
 * gördüğü an bot HİÇ BAŞLAMAZ. Hata sınıfı tam olarak kimlik kuralının
 * korumaya çalıştığı şey: bir varlığın kimliği ticker değildir.
 */
const dogrulamaAnahtari = (sembol: string, adres: string): string =>
  `${sembol.toUpperCase()}|${adres.toLowerCase()}`;

interface EvmAday {
  sembol: string;
  adres: Address;
  cexFiyat: number | null;
}

/**
 * Zincirden ERC20 kimliği + DEX quoter'dan gerçek fiyat.
 *
 * symbol/decimals TEK multicall ile okunuyor: token başına ayrı RPC çağrısı
 * public uç noktaları boğuyor (verify-contracts.ts'te ölçülmüş).
 */
async function evmDogrula(
  chain: 'base' | 'arbitrum',
  cfg: AppConfig,
  dex: DexContracts,
  adaylar: EvmAday[],
): Promise<{ sonuc: Map<string, Dogrulama>; hatalar: Map<string, string> }> {
  const sonuc = new Map<string, Dogrulama>();
  const hatalar = new Map<string, string>();
  if (adaylar.length === 0) return { sonuc, hatalar };

  // Feed'in kendi quoter'ı kullanılıyor, kopyası değil: keşif ile bot aynı
  // soruyu sormazsa tablo botun fiyatlayamadığı tokenları içerir (ya da tersi)
  // ve iki taraf zamanla sessizce ayrışır.
  const cowQuoter = new HttpCowQuoter(chain);

  const kendiRpc = cfg.chains[chain].rpcUrl !== null;
  const rpc = cfg.chains[chain].rpcUrl ?? dex.publicRpc[chain];
  const client = createPublicClient({
    chain: chain === 'base' ? baseChain : arbChain,
    transport: http(rpc, { timeout: 20_000 }),
  });
  if (!kendiRpc) {
    console.log(
      `${C.yellow}  ⚠ ${chain}: public RPC (${new URL(rpc).host}) — ölçüldü ki bu uç nokta` +
        ` istek düşürüyor ve aynı token için koşudan koşuya farklı cevap veriyor.${C.reset}\n` +
        `${C.dim}    Elenen token'ların bir kısmı YANLIŞ NEGATİF olacaktır. .env → ` +
        `${chain === 'base' ? 'BASE_RPC_URL' : 'ARBITRUM_RPC_URL'} tanımlayıp tekrar çalıştır.${C.reset}`,
    );
  }

  // --- 1. ERC20 kimliği ---------------------------------------------------
  const calls = adaylar.flatMap((a) => [
    { address: a.adres, abi: ERC20_ABI, functionName: 'symbol' } as const,
    { address: a.adres, abi: ERC20_ABI, functionName: 'decimals' } as const,
  ]);

  // Multicall PARÇALANIYOR: tek istekte 130 çağrı gönderdiğimizde Base'in
  // public RPC'si hepsini birden reddetti ve sonuç "65 tokenın hiçbiri
  // okunamadı" oldu — adresler doğruyken. Sessiz ve yanıltıcı bir hata:
  // RPC sınırı, yanlış adres gibi görünüyor.
  const MC_CHUNK = 60;
  const okunan: { status: 'success' | 'failure'; result?: unknown }[] = [];
  for (let i = 0; i < calls.length; i += MC_CHUNK) {
    const dilim = calls.slice(i, i + MC_CHUNK);
    try {
      okunan.push(
        ...((await client.multicall({ contracts: dilim, allowFailure: true })) as typeof okunan),
      );
    } catch (e) {
      // Parça tamamen başarısızsa sıra bozulmasın diye yerine failure koy.
      hatalar.set('_rpc', `multicall parçası başarısız: ${(e as Error).message.slice(0, 60)}`);
      okunan.push(...dilim.map(() => ({ status: 'failure' as const })));
    }
  }

  const gecerli: { aday: EvmAday; decimals: number }[] = [];
  for (let i = 0; i < adaylar.length; i++) {
    const a = adaylar[i]!;
    const s = okunan[i * 2];
    const d = okunan[i * 2 + 1];
    if (s?.status !== 'success' || d?.status !== 'success') {
      hatalar.set(
        a.sembol,
        `ERC20 okunamadı${kendiRpc ? ' — adreste token yok' : ' (public RPC şüpheli, kesin değil)'}`,
      );
      continue;
    }
    const zincirSembol = String(s.result);
    const decimals = Number(d.result);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
      hatalar.set(a.sembol, `decimals anlamsız (${decimals})`);
      continue;
    }
    // Sembol farkı kozmetik olabilir ("$DEGEN" vs "DEGEN") ama tamamen farklı
    // bir sembol yanlış adres demektir.
    if (norm(zincirSembol) !== norm(a.sembol)) {
      hatalar.set(a.sembol, `zincirdeki sembol "${zincirSembol}" — yanlış adres şüphesi`);
      continue;
    }
    gecerli.push({ aday: a, decimals });
  }

  // --- 2. Gerçek quote ----------------------------------------------------
  const usdc = cfgUsdc(cfg, chain);
  if (!usdc) return { sonuc, hatalar };
  // 2 adımlı rotanın ara tokeni. Botun `EvmDexFeed`'i de bunu kullanıyor;
  // burada sormamak, botun fiyatlayabildiği tokenı tabloya sokmamak demekti.
  const weth = cfg.tokens.find((t) => t.chain === chain && t.symbol.toUpperCase() === 'WETH');

  for (const { aday, decimals } of gecerli) {
    if (!aday.cexFiyat) {
      hatalar.set(aday.sembol, 'CEX fiyatı yok — quote doğrulanamaz');
      continue;
    }
    // Nominal ~100 USD: 1 birim sormak ucuz token'larda sıfıra yuvarlanır.
    const miktar = BigInt(Math.max(1, Math.round((PROBE_USD / aday.cexFiyat) * 10 ** decimals)));

    // Tekrar deneme: public RPC tek seferlik hatalar veriyor ve tek denemede
    // "havuz yok" demek yanlış negatif üretiyor (ölçüldü: VIRTUAL ilk denemede
    // başarısız, ikincisinde $0.559).
    let cikti = 0n;
    let hataliBitti = false;
    let rota = '';
    for (let deneme = 0; deneme < 3 && cikti === 0n; deneme++) {
      if (deneme > 0) await new Promise((r) => setTimeout(r, 400 * deneme));
      hataliBitti = false;

      if (chain === 'base') {
        // Base'de bot ÜÇ venue soruyor (aerodrome, uniswap-v3, cow) ve keşif
        // aynısını sormak ZORUNDA: yalnızca Aerodrome soran eski sürüm, botun
        // fiyatlayabildiği tokenları tabloya hiç sokmuyordu. Aynı ders
        // Arbitrum'da UniV3 açılırken ölçülmüştü.
        try {
          const amounts = (await client.readContract({
            address: dex.base.aerodrome.router as Address,
            abi: AERODROME_ABI,
            functionName: 'getAmountsOut',
            args: [
              miktar,
              [
                {
                  from: aday.adres,
                  to: usdc.address as Address,
                  stable: false,
                  factory: dex.base.aerodrome.factory as Address,
                },
              ],
            ],
          })) as readonly bigint[];
          cikti = amounts[amounts.length - 1] ?? 0n;
          if (cikti > 0n) rota = 'aerodrome';
        } catch {
          hataliBitti = true;
        }

        // Aerodrome, WETH üzerinden 2 adım. `getAmountsOut` çok adımlı
        // `Route[]` aldığı için ek çağrı maliyeti yok.
        if (weth) {
          try {
            const amounts = (await client.readContract({
              address: dex.base.aerodrome.router as Address,
              abi: AERODROME_ABI,
              functionName: 'getAmountsOut',
              args: [
                miktar,
                [
                  { from: aday.adres, to: weth.address as Address, stable: false,
                    factory: dex.base.aerodrome.factory as Address },
                  { from: weth.address as Address, to: usdc.address as Address, stable: false,
                    factory: dex.base.aerodrome.factory as Address },
                ],
              ],
            })) as readonly bigint[];
            const out = amounts[amounts.length - 1] ?? 0n;
            if (out > cikti) {
              cikti = out;
              rota = 'aerodrome:weth';
              hataliBitti = false;
            }
          } catch {
            /* WETH havuzu yok — diğer venue'lar denenir */
          }
        }

        // Uniswap V3: tüm tier'lar sorulup EN İYİ çıktı alınır (Arbitrum'daki
        // ile aynı gerekçe — ilk çalışanı seçmek ince havuza düşürür).
        for (const fee of dex.base.uniswapV3.feeTiers) {
          try {
            const { result } = await client.simulateContract({
              address: dex.base.uniswapV3.quoterV2 as Address,
              abi: UNIV3_QUOTER_ABI,
              functionName: 'quoteExactInputSingle',
              args: [
                {
                  tokenIn: aday.adres,
                  tokenOut: usdc.address as Address,
                  amountIn: miktar,
                  fee,
                  sqrtPriceLimitX96: 0n,
                },
              ],
            });
            const out = (result as readonly [bigint, bigint, number, bigint])[0];
            if (out > cikti) {
              cikti = out;
              rota = `univ3:${fee}`;
              hataliBitti = false;
            }
          } catch {
            /* bu tier'da havuz yok — diğerleri denenir */
          }
        }

        // UniV3, WETH üzerinden 2 adım. Ara bacağın tier'ı taranır,
        // WETH↔USDC sabit 500 (zincirden doğrulandı: en likit havuz).
        if (weth) {
          for (const fee of dex.base.uniswapV3.feeTiers) {
            try {
              const { result } = await client.simulateContract({
                address: dex.base.uniswapV3.quoterV2 as Address,
                abi: UNIV3_PATH_ABI,
                functionName: 'quoteExactInput',
                args: [univ3Yol(aday.adres, fee, weth.address as Address, 500, usdc.address as Address), miktar],
              });
              const out = (result as readonly [bigint, ...unknown[]])[0];
              if (out > cikti) {
                cikti = out;
                rota = `univ3:${fee}+weth`;
                hataliBitti = false;
              }
            } catch {
              /* bu tier'da WETH havuzu yok */
            }
          }
        }

        // CoW: zincire hiç bağlanmıyor, çok adımlı rotayı solver kuruyor.
        // YALNIZCA venue olarak açıksa keşfe girer: `cow-base` bugün
        // `DEVRE_DISI` (çapraz kontrol olarak çalışıyor, geniş tarama olarak
        // değil). Kapalıyken CoW'un bulduğu rota tabloya token sokuyordu ama
        // bot o tokenı FİYATLAYAMIYORDU — her tur RPC yakıp `rotasiz()`'a
        // düşüyordu. Keşif, botun yeteneğiyle aynı rotayı sormak zorunda.
        if (!DEVRE_DISI.includes('cow-base')) {
          try {
            const out = await cowQuoter.quote(aday.adres, usdc.address, miktar);
            if (out !== null && out > cikti) {
              cikti = out;
              rota = 'cow';
              hataliBitti = false;
            }
          } catch {
            // API arızası "havuz yok" ile karıştırılmamalı; zincir bacakları
            // zaten denendi, sonuç onlardan gelir.
            hataliBitti = true;
          }
        }
        continue;
      }

      // --- Arbitrum: Camelot, olmazsa Uniswap V3 ---------------------------
      try {
        const { result } = await client.simulateContract({
          address: dex.arbitrum.camelot.quoterV2 as Address,
          abi: ALGEBRA_QUOTER_ABI,
          functionName: 'quoteExactInputSingle',
          args: [aday.adres, usdc.address as Address, miktar, 0n],
        });
        cikti = (result as readonly [bigint, number])[0];
        if (cikti > 0n) rota = 'camelot';
      } catch (e) {
        // Revert = havuz yok (VERİ); yalnızca taşıma hatası RPC arızasıdır.
        // Eskiden ikisi de "quote 3 denemede de hata verdi — public RPC
        // şüpheli" diye raporlanıyordu; üç bağımsız uç birebir aynı sonucu
        // verince anlaşıldı ki sonuç deterministik ve gerçek.
        if (tasimaArizasiMi(e)) hataliBitti = true;
      }
      // `continue` YOK: Camelot'ta toz bir doğrudan havuz sıfırdan büyük ama
      // düşük fiyat döndürür, token sapma filtresine takılır. Bot zaten
      // UniV3 tier'larını ve WETH rotasını da soruyor; en iyi çıktı seçilir
      // (Base dalıyla aynı kural).

      // Tüm tier'lar sorulup EN İYİ çıktı alınır. İlk çalışanı seçmek ince bir
      // havuza düşüp fiyatı düşük gösterir; token o zaman sapma filtresine
      // takılıp "yanlış eşleşme" damgasıyla haksızca elenirdi.
      for (const fee of dex.arbitrum.uniswapV3.feeTiers) {
        try {
          const { result } = await client.simulateContract({
            address: dex.arbitrum.uniswapV3.quoterV2 as Address,
            abi: UNIV3_QUOTER_ABI,
            functionName: 'quoteExactInputSingle',
            args: [
              {
                tokenIn: aday.adres,
                tokenOut: usdc.address as Address,
                amountIn: miktar,
                fee,
                sqrtPriceLimitX96: 0n,
              },
            ],
          });
          const out = (result as readonly [bigint, bigint, number, bigint])[0];
          if (out > cikti) {
            cikti = out;
            rota = `univ3:${fee}`;
            hataliBitti = false;
          }
        } catch {
          /* bu tier'da havuz yok — diğerleri denenir */
        }
      }

      // --- Arbitrum, WETH üzerinden 2 adım ---------------------------------
      // Bot burada da 2 adım soruyor; keşif sormazsa tablo botun
      // fiyatlayabildiği tokenları içermez. `LINK` sınıfı (doğrudan USDC
      // sıfır, WETH ilk adımı çalışıyor) ve `GRT/ZRO/STG/LPT/JOE` sınıfı
      // (doğrudan havuz toz) tam olarak burada kurtulur.
      if (weth) {
        try {
          const { result } = await client.simulateContract({
            address: dex.arbitrum.camelot.quoterV2 as Address,
            abi: ALGEBRA_PATH_ABI,
            functionName: 'quoteExactInput',
            args: [algebraYol(aday.adres, weth.address, usdc.address), miktar],
          });
          const out = (result as readonly [bigint, ...unknown[]])[0];
          if (out > cikti) {
            cikti = out;
            rota = 'camelot:weth';
            hataliBitti = false;
          }
        } catch {
          /* Camelot'ta WETH rotası yok */
        }

        for (const fee of dex.arbitrum.uniswapV3.feeTiers) {
          try {
            const { result } = await client.simulateContract({
              address: dex.arbitrum.uniswapV3.quoterV2 as Address,
              abi: UNIV3_PATH_ABI,
              functionName: 'quoteExactInput',
              args: [univ3Yol(aday.adres, fee, weth.address, 500, usdc.address), miktar],
            });
            const out = (result as readonly [bigint, ...unknown[]])[0];
            if (out > cikti) {
              cikti = out;
              rota = `univ3:${fee}+weth`;
              hataliBitti = false;
            }
          } catch {
            /* bu tier'da WETH havuzu yok */
          }
        }
      }
    }

    if (cikti <= 0n) {
      // İki durumu ayırıyoruz: quote ÇALIŞIP sıfır dönmesi gerçekten havuz
      // yok demektir; istek hata verip bitmesi ise RPC sorunu olabilir ve
      // "havuz yok" demek yanlış negatif üretir.
      hatalar.set(
        aday.sembol,
        hataliBitti
          ? `quote isteği 3 denemede de hata verdi${kendiRpc ? '' : ' — public RPC şüpheli'}`
          : 'DEX havuzu yok (quote sıfır döndü)',
      );
      continue;
    }

    const girdiAdet = Number(miktar) / 10 ** decimals;
    const ciktiUsd = Number(cikti) / 10 ** usdc.decimals;
    sonuc.set(dogrulamaAnahtari(aday.sembol, aday.adres), {
      decimals,
      dexFiyat: ciktiUsd / girdiAdet,
      rota,
    });
  }

  return { sonuc, hatalar };
}

function cfgUsdc(cfg: AppConfig, chain: ChainId): TokenEntry | undefined {
  return cfg.tokens.find((t) => t.chain === chain && t.symbol.toUpperCase() === 'USDC') as
    | TokenEntry
    | undefined;
}

// ---------------------------------------------------------------------------

type Karar =
  | {
      tur: 'eklendi';
      entry: TokenEntry;
      sapma: number | null;
      kaynaklar: string[];
      rota: string | null;
    }
  | { tur: 'elendi'; chain: ChainId; sembol: string; sebep: string }
  /** Çoğunlukla yazıldı ama bazı borsalar farklı adres bildiriyor. */
  | { tur: 'catisma'; chain: ChainId; sembol: string; ayriklar: string[]; tabloda: boolean };

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const yaz = argv.includes('--yaz');
  const secilen = (['solana', 'base', 'arbitrum'] as ChainId[]).filter((z) => argv.includes(z));
  const zincirler: ChainId[] = secilen.length > 0 ? secilen : ['solana', 'base', 'arbitrum'];

  const cfg = loadConfig();
  PROBE_USD = cfg.scan.tradeSizeQuote;
  const dex = JSON.parse(readFileSync(resolve(ROOT, 'config/dex.json'), 'utf8')) as DexContracts;

  console.log(`\n${C.bold}${C.cyan}TOKEN KEŞFİ${C.reset} ${C.dim}(${zincirler.join(', ')})${C.reset}`);
  console.log(C.dim + '─'.repeat(80) + C.reset);

  // --- Kaynaklar ----------------------------------------------------------
  const adaylar: Adaylar = new Map();
  const kaynakDurum: string[] = [];

  try {
    kaynakDurum.push(`kucoin ${await kucoinAdresleri(adaylar)} (public)`);
  } catch (e) {
    kaynakDurum.push(`${C.yellow}kucoin başarısız: ${(e as Error).message.slice(0, 40)}${C.reset}`);
  }
  try {
    kaynakDurum.push(`gate ${await gateAdresleri(adaylar)} (public)`);
  } catch (e) {
    kaynakDurum.push(`${C.yellow}gate başarısız: ${(e as Error).message.slice(0, 40)}${C.reset}`);
  }
  if (cfg.apiKeys.binance) {
    try {
      kaynakDurum.push(`binance ${await binanceAdresleri(adaylar, cfg.apiKeys.binance)}`);
    } catch (e) {
      kaynakDurum.push(`${C.yellow}binance başarısız: ${(e as Error).message.slice(0, 40)}${C.reset}`);
    }
  } else {
    kaynakDurum.push(`${C.dim}binance atlandı (anahtar yok)${C.reset}`);
  }
  if (cfg.apiKeys.okx) {
    try {
      kaynakDurum.push(`okx ${await okxAdresleri(adaylar, cfg.apiKeys.okx)}`);
    } catch (e) {
      kaynakDurum.push(`${C.yellow}okx başarısız: ${(e as Error).message.slice(0, 40)}${C.reset}`);
    }
  } else {
    kaynakDurum.push(`${C.dim}okx atlandı (anahtar yok)${C.reset}`);
  }
  if (cfg.apiKeys.mexc) {
    try {
      kaynakDurum.push(`mexc ${await mexcAdresleri(adaylar, cfg.apiKeys.mexc)}`);
    } catch (e) {
      kaynakDurum.push(`${C.yellow}mexc başarısız: ${(e as Error).message.slice(0, 40)}${C.reset}`);
    }
  } else {
    kaynakDurum.push(`${C.dim}mexc atlandı (anahtar yok)${C.reset}`);
  }
  // Bybit ve Kraken bilinçli olarak YOK: ikisi de kontrat adresi hiç vermiyor
  // (ölçüldü, bkz. transfer-info.ts). Kaynak listesine koymak "başarısız" gibi
  // görünen boş bir satır üretirdi.
  console.log(`kaynaklar: ${kaynakDurum.join(' · ')}`);

  // --- CEX çiftleri -------------------------------------------------------
  const venues = CEX_IDS.filter((v) => cfg.exchanges[v].enabled);
  const registry = await SymbolRegistry.build({
    venues,
    quotesByVenue: Object.fromEntries(venues.map((v) => [v, cfg.exchanges[v].quotes])),
    minVenues: 2,
    excludeBases: [...EXCLUDED_BASES],
  });
  const known = new Set(registry.pairs);
  const cexFiyat = await cexFiyatlari();
  console.log(
    `CEX: ${registry.pairCount} çift (≥2 borsa) · ${cexFiyat.size} sembol için referans fiyat`,
  );

  // --- Eleme --------------------------------------------------------------
  const mevcut = JSON.parse(
    readFileSync(resolve(ROOT, 'config/tokens.json'), 'utf8'),
  ) as TokenEntry[];
  const mevcutAdres = new Set(
    mevcut.map((t) => `${t.chain}|${t.address.toLowerCase()}`),
  );
  const mevcutSembol = new Set(mevcut.map((t) => `${t.chain}|${t.symbol.toUpperCase()}`));

  const kararlar: Karar[] = [];
  const gecenler = new Map<ChainId, { sembol: string; adres: string; kaynaklar: string[] }[]>();
  for (const z of zincirler) gecenler.set(z, []);

  for (const [anahtar, kaynaklar] of adaylar) {
    const [chainRaw, sembol] = anahtar.split('|') as [ChainId, string];
    if (!zincirler.includes(chainRaw)) continue;

    // --- Çakışma çözümü: ÇOĞUNLUK -----------------------------------------
    //
    // Eski kural "herhangi bir kaynak farklı adres veriyorsa hiç yazma" idi.
    // Beş kaynakla bu kural fazla kesiyor: ölçüldü, `ARB`'ı dört kaynak aynı
    // adresle veriyor, MEXC ise Arbitrum satırına Ethereum kontratını yazıyor
    // (bilinen veri kusuru) — tek bozuk kaynak gerçek bir tokeni bloke ediyordu.
    //
    // Çoğunluğu yazmak GÜVENLİ, çünkü asıl koruma çalışma anında: `pickChain`
    // her borsanın kendi bildirdiği adresi tokens.json'dakiyle karşılaştırır ve
    // uyuşmayan borsanın o rotasını eler. Yani ayrık kalan kaynağın bacakları
    // zaten kapanır; tabloyu boş bırakmanın tek etkisi DİĞER borsaları da
    // kaybetmekti. Beraberlikte (2-2 gibi) hâlâ yazmıyoruz — orada hangi
    // tarafın doğru olduğunu söyleyecek bir dayanak yok.
    const sayim = new Map<string, string[]>();
    for (const [k, a] of kaynaklar) {
      const g = sayim.get(a) ?? [];
      g.push(k);
      sayim.set(a, g);
    }
    const sirali = [...sayim.entries()].sort((a, b) => b[1].length - a[1].length);
    const cakisma = sirali.length > 1;
    if (cakisma && sirali[0]![1].length === sirali[1]![1].length) {
      kararlar.push({
        tur: 'elendi',
        chain: chainRaw,
        sembol,
        sebep: `kaynaklar farklı adres veriyor, çoğunluk YOK (${sirali
          .map((s) => s[1].join('+'))
          .join(' ↔ ')}) — ticker çakışması`,
      });
      continue;
    }
    const adres = sirali[0]![0];
    const ayriklar = cakisma ? sirali.slice(1).flatMap((s) => s[1]) : [];

    if ((EXCLUDED_BASES as readonly string[]).includes(sembol)) {
      kararlar.push({ tur: 'elendi', chain: chainRaw, sembol, sebep: 'stablecoin — tarama dışı' });
      continue;
    }
    if (/^(\d{3,}|\d+[KMB])[A-Z]{2,}/.test(sembol)) {
      kararlar.push({ tur: 'elendi', chain: chainRaw, sembol, sebep: 'ölçekli ticker (birim uyuşmazlığı)' });
      continue;
    }
    if (isLeveragedTicker(sembol)) {
      kararlar.push({ tur: 'elendi', chain: chainRaw, sembol, sebep: 'kaldıraçlı token' });
      continue;
    }
    if (!known.has(pairKey(sembol, 'USDT'))) {
      // Sessizce atlıyoruz: raporu 200 satır uzatır, bilgi vermez.
      continue;
    }
    if (mevcutAdres.has(`${chainRaw}|${adres.toLowerCase()}`)) {
      // Tabloda ZATEN var. Çakışma varsa bunu bilmek gerekiyor: girdi doğru
      // (çoğunluk onu diyor) ama ayrık kalan borsanın bacakları çalışma anında
      // eleniyor. "elendi" demek yanlış olurdu — token izleniyor.
      if (cakisma) {
        kararlar.push({
          tur: 'catisma',
          chain: chainRaw,
          sembol,
          ayriklar,
          tabloda: true,
        });
      }
      continue;
    }
    if (mevcutSembol.has(`${chainRaw}|${sembol}`)) {
      kararlar.push({
        tur: 'elendi',
        chain: chainRaw,
        sembol,
        sebep: 'tabloda aynı sembol farklı adresle var — elle girilene dokunulmuyor',
      });
      continue;
    }

    if (cakisma) {
      kararlar.push({ tur: 'catisma', chain: chainRaw, sembol, ayriklar, tabloda: false });
    }
    gecenler.get(chainRaw)!.push({ sembol, adres, kaynaklar: sirali[0]![1] });
  }

  // --- Doğrulama ----------------------------------------------------------
  const yeniler: TokenEntry[] = [];

  for (const chain of zincirler) {
    const liste = gecenler.get(chain)!;
    if (liste.length === 0) continue;
    console.log(`\n${C.dim}${chain}: ${liste.length} aday doğrulanıyor...${C.reset}`);

    if (chain === 'solana') {
      const dogrulanan = await solanaDogrula(liste.map((l) => l.adres));
      for (const l of liste) {
        const d = dogrulanan.get(l.adres);
        if (!d) {
          kararlar.push({ tur: 'elendi', chain, sembol: l.sembol, sebep: 'Jupiter fiyat/decimals vermiyor (rota yok)' });
          continue;
        }
        kararVer(kararlar, yeniler, chain, l, d, cexFiyat.get(l.sembol) ?? null);
      }
    } else {
      const { sonuc, hatalar } = await evmDogrula(
        chain as 'base' | 'arbitrum',
        cfg,
        dex,
        liste.map((l) => ({
          sembol: l.sembol,
          adres: l.adres as Address,
          cexFiyat: cexFiyat.get(l.sembol) ?? null,
        })),
      );
      for (const l of liste) {
        const d = sonuc.get(dogrulamaAnahtari(l.sembol, l.adres));
        if (!d) {
          kararlar.push({
            tur: 'elendi',
            chain,
            sembol: l.sembol,
            sebep: hatalar.get(l.sembol) ?? 'doğrulanamadı',
          });
          continue;
        }
        kararVer(kararlar, yeniler, chain, l, d, cexFiyat.get(l.sembol) ?? null);
      }
    }
  }

  raporla(kararlar, zincirler);

  // --- Yazma --------------------------------------------------------------
  console.log(`\n${C.dim}${'─'.repeat(80)}${C.reset}`);
  if (yeniler.length === 0) {
    console.log(`${C.green}Tablo güncel — eklenecek yeni token yok.${C.reset}\n`);
    return;
  }
  if (!yaz) {
    console.log(
      `${C.yellow}Önizleme.${C.reset} ${C.bold}${yeniler.length}${C.reset} token eklemek için:` +
        `\n  ${C.cyan}npm run discover-tokens -- --yaz${C.reset}\n`,
    );
    return;
  }

  // Zincir zincir grupla: dosya böyle okunuyor, sırayı bozmak diff'i şişirir.
  const birlesik = [...mevcut];
  for (const chain of ['solana', 'base', 'arbitrum'] as ChainId[]) {
    const ek = yeniler.filter((t) => t.chain === chain);
    if (ek.length === 0) continue;
    const son = birlesik.map((t) => t.chain).lastIndexOf(chain);
    if (son < 0) birlesik.push(...ek);
    else birlesik.splice(son + 1, 0, ...ek);
  }

  // Yazmadan ÖNCE son kontrol: aynı (zincir, adres) iki kez giremez.
  //
  // Doğrulama katmanı bunu zaten engelliyor olmalı (bkz. `dogrulamaAnahtari`),
  // ama kontrol burada da duruyor çünkü Solana tarafında zincirden sembol
  // okunmuyor — Jupiter mint'e göre fiyat veriyor ve iki ticker aynı mint'i
  // gösterirse ikisi de "doğrulanmış" görünür. Kontrol edilmezse hata
  // BAŞLANGIÇTA patlar (`loadConfig` → "yinelenen token") ve bot o andan
  // itibaren hiç açılmaz; dosya yazılmış, iş işten geçmiş olur. Aynı ders
  // izleme listesinde ölçülmüştü: doğrulama yazma yolunun İÇİNDE olmalı.
  const gorulen = new Map<string, string>();
  for (const t of birlesik) {
    const anahtar = `${t.chain}:${t.address.toLowerCase()}`;
    const oncekiSembol = gorulen.get(anahtar);
    if (oncekiSembol !== undefined) {
      console.error(
        `${C.red}${C.bold}✗ YAZILMADI${C.reset} — aynı adres iki ticker'a ait: ` +
          `${t.chain} ${anahtar} → "${oncekiSembol}" ve "${t.symbol}".\n` +
          `${C.dim}  Bir varlığın kimliği ticker değil adrestir; hangisinin doğru ` +
          `olduğunu söyleyecek dayanak yok. Kaynak borsaların listelemesini kontrol et.${C.reset}`,
      );
      process.exitCode = 1;
      return;
    }
    gorulen.set(anahtar, t.symbol);
  }

  // `loadConfig`'in kendi doğrulaması — format, decimals (≤18), yinelenen
  // adres VE izleme listesinin `dex[]` girdileriyle çakışma. Yukarıdaki yerel
  // kontrol bunların yalnızca birini kapsıyordu; eksik kopya "dosya yazıldı,
  // bot açılmıyor" üretiyordu.
  try {
    tokenTablosunuDogrula([
      ...birlesik,
      ...cfg.tokens.filter((t) => t.kaynak === 'izleme-listesi'),
    ]);
  } catch (e) {
    console.error(`${C.red}${C.bold}✗ YAZILMADI${C.reset} — ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }

  writeFileSync(
    resolve(ROOT, 'config/tokens.json'),
    JSON.stringify(birlesik, null, 2) + '\n',
    'utf8',
  );

  console.log(`${C.green}${C.bold}✓ config/tokens.json güncellendi${C.reset} — ${yeniler.length} yeni token`);
  for (const chain of ['solana', 'base', 'arbitrum'] as ChainId[]) {
    const n = birlesik.filter((t) => t.chain === chain).length;
    console.log(`  ${chain.padEnd(10)} ${String(n).padStart(3)} girdi`);
  }
  console.log(
    `${C.dim}Sırada: npm run dex (solana) ve npm run verify-contracts (evm) ile bağımsız doğrula.${C.reset}\n`,
  );
}

function kararVer(
  kararlar: Karar[],
  yeniler: TokenEntry[],
  chain: ChainId,
  l: { sembol: string; adres: string; kaynaklar: string[] },
  d: Dogrulama,
  cex: number | null,
): void {
  const sapma = cex ? Math.abs(d.dexFiyat - cex) / cex : null;
  if (sapma !== null && sapma > MAX_PRICE_DEVIATION) {
    kararlar.push({
      tur: 'elendi',
      chain,
      sembol: l.sembol,
      sebep: `DEX/CEX fiyat sapması %${(sapma * 100).toFixed(0)} — yanlış eşleşme şüphesi`,
    });
    return;
  }
  const entry: TokenEntry = {
    symbol: l.sembol,
    chain,
    address: l.adres,
    decimals: d.decimals,
  };
  yeniler.push(entry);
  kararlar.push({ tur: 'eklendi', entry, sapma, kaynaklar: l.kaynaklar, rota: d.rota ?? null });
}

function raporla(kararlar: Karar[], zincirler: ChainId[]): void {
  for (const chain of zincirler) {
    const eklendi = kararlar.filter((k) => k.tur === 'eklendi' && k.entry.chain === chain);
    const elendi = kararlar.filter((k) => k.tur === 'elendi' && k.chain === chain);
    if (eklendi.length === 0 && elendi.length === 0) continue;

    console.log(`\n${C.bold}${chain.toUpperCase()} — eklenecek ${eklendi.length}${C.reset}`);
    console.log(C.dim + '─'.repeat(80) + C.reset);
    for (const k of eklendi) {
      if (k.tur !== 'eklendi') continue;
      const sapma =
        k.sapma === null ? 'CEX fiyatı yok' : `CEX farkı %${(k.sapma * 100).toFixed(2)}`;
      console.log(
        `  ${C.green}${k.entry.symbol.padEnd(12)}${C.reset}` +
          `${C.dim}${k.entry.address.padEnd(46)}${C.reset}dec=${String(k.entry.decimals).padEnd(3)}` +
          ` ${C.dim}${sapma}  [${k.kaynaklar.join(',')}]${k.rota ? ` ${k.rota}` : ''}${C.reset}`,
      );
    }

    // Çakışmalar AYRI raporlanır: bunlar "elendi" değil, "yazıldı ama bir
    // borsanın bacakları çalışma anında kapanacak" demek. Aynı kovaya
    // konsalardı kimlik çakışmasının varlığı raporda hiç görünmezdi.
    const catisan = kararlar.filter((k) => k.tur === 'catisma' && k.chain === chain);
    if (catisan.length > 0) {
      console.log(
        `  ${C.cyan}kimlik çakışması ${catisan.length}${C.reset} ${C.dim}(çoğunluk yazıldı;` +
          ` ayrık borsanın rotaları çalışma anında elenir)${C.reset}`,
      );
      for (const k of catisan) {
        if (k.tur !== 'catisma') continue;
        console.log(
          `    ${C.dim}${k.sembol.padEnd(12)} ayrık: ${k.ayriklar.join(',')}` +
            `${k.tabloda ? ' · tabloda zaten var' : ''}${C.reset}`,
        );
      }
    }

    if (elendi.length > 0) {
      // Sebepleri grupluyoruz: 60 satır tek tek sebep okunmaz, dağılım okunur.
      const gruplar = new Map<string, string[]>();
      for (const k of elendi) {
        if (k.tur !== 'elendi') continue;
        const g = gruplar.get(k.sebep) ?? [];
        g.push(k.sembol);
        gruplar.set(k.sebep, g);
      }
      console.log(`  ${C.yellow}elenen ${elendi.length}:${C.reset}`);
      for (const [sebep, semboller] of [...gruplar].sort((a, b) => b[1].length - a[1].length)) {
        console.log(
          `    ${C.dim}${String(semboller.length).padStart(3)} × ${sebep}${C.reset}\n` +
            `        ${C.dim}${semboller.slice(0, 14).join(', ')}${semboller.length > 14 ? ', …' : ''}${C.reset}`,
        );
      }
    }
  }
}

main().catch((e: Error) => {
  console.error(`\n${C.red}HATA: ${e.message}${C.reset}`);
  process.exit(1);
});
