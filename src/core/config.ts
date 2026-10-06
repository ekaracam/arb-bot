/**
 * Konfigürasyon yükleme ve doğrulama.
 *
 * Prensip: bot yanlış bir config'le sessizce çalışmaz. Eksik/hatalı alan
 * varsa başlangıçta net bir hatayla durur — yanlış fiyatla üretilen sinyal
 * hiç sinyal olmamasından kötüdür.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CEX_IDS, CHAIN_IDS, type CexId, type ChainId, type FeeSchedule } from './types.ts';
import {
  IZLEME_DOSYASI,
  loadIzlemeListesi,
  type IzlemeListesi,
} from './izleme-listesi.ts';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// ---------------------------------------------------------------------------
// .env
// ---------------------------------------------------------------------------

function loadEnv(): void {
  const envPath = resolve(ROOT, '.env');
  if (!existsSync(envPath)) return;
  // Node 21+ yerleşik parser — ek bağımlılık (dotenv) gerekmiyor.
  process.loadEnvFile(envPath);
}
loadEnv();

function env(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Eksik ortam değişkeni: ${key} (.env dosyanı kontrol et)`);
  }
  return v;
}

function envOptional(key: string): string | null {
  const v = process.env[key];
  return v === undefined || v === '' ? null : v;
}

/**
 * Virgülle ayrılmış liste. Boş parçalar (fazladan virgül/boşluk) SESSİZCE
 * atılır — kullanıcı `123, ,456` yazarsa ortadaki boşluk bir chat id
 * sanılmamalı, ama bunu da başlangıçta değil burada elemek yeterli çünkü
 * Telegram zaten geçersiz id'yi kendi hata mesajıyla reddedecek.
 */
function envList(key: string): readonly string[] {
  const v = process.env[key];
  if (v === undefined || v === '') return [];
  return v
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

function envNum(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${key} sayı olmalı, alınan: ${v}`);
  return n;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return v === '1' || v.toLowerCase() === 'true';
}

// ---------------------------------------------------------------------------
// JSON config dosyaları
// ---------------------------------------------------------------------------

function readJson<T>(relPath: string): T {
  const p = resolve(ROOT, relPath);
  if (!existsSync(p)) throw new Error(`Config dosyası bulunamadı: ${relPath}`);
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch (e) {
    throw new Error(`${relPath} geçerli JSON değil: ${(e as Error).message}`);
  }
}

export interface ExchangeConfig {
  readonly enabled: boolean;
  readonly fees: FeeSchedule;
  /** Bu borsada taranacak quote para birimleri. */
  readonly quotes: string[];
  /** Çekim/yatırma bilgisi public API'den alınabiliyor mu? */
  readonly transferInfoPublic: boolean;
}

/** Zincir başına RPC adresini ezen ortam değişkeni. */
const RPC_ENV: Record<ChainId, string> = {
  solana: 'SOLANA_RPC_URL',
  base: 'BASE_RPC_URL',
  arbitrum: 'ARBITRUM_RPC_URL',
};

export interface ChainConfig {
  readonly enabled: boolean;
  /** wss:// tercih edilir — blok event'iyle tetiklenmek için gerekli. */
  readonly rpcUrl: string | null;
  /** Bir swap işleminin tahmini gas maliyeti (USD). */
  readonly gasCostUsd: number;
}

/**
 * Bir borsanın SALT-OKUNUR API kimliği.
 *
 * Tek kullanım yeri transfer durumu sorgulamaktır (çekim/yatırma açık mı,
 * ücret ne). Bot v1'de emir göndermiyor; bu anahtarlara çekim veya işlem
 * yetkisi verilmemelidir.
 */
export interface ApiCredentials {
  readonly key: string;
  readonly secret: string;
  /** OKX zorunlu kılar; diğer borsalarda kullanılmaz. */
  readonly passphrase: string | null;
}

export interface TokenEntry {
  readonly symbol: string;
  readonly chain: ChainId;
  readonly address: string;
  readonly decimals: number;
  /** Bu token'ın hangi CEX'lerde hangi sembolle listelendiği (opsiyonel override). */
  readonly cexSymbols?: Partial<Record<CexId, string>>;
  /**
   * Kayıt nereden geldi. Tanımsız = `config/tokens.json` (keşifle doğrulanmış).
   *
   * Elle girilen adres, `discover-tokens`'ın çoğunluk kuralından ve sapma
   * filtresinden geçmemiş demektir; raporlar bu ikisini ayırt edebilmeli.
   */
  readonly kaynak?: 'izleme-listesi';
}

export interface AppConfig {
  readonly exchanges: Record<CexId, ExchangeConfig>;
  readonly chains: Record<ChainId, ChainConfig>;
  readonly tokens: readonly TokenEntry[];
  /** Yalnızca anahtarı tanımlanmış borsalar için dolu. */
  readonly apiKeys: Partial<Record<CexId, ApiCredentials>>;
  /**
   * Kullanıcının "kesinlikle taransın" dediği coinler.
   *
   * `tokens` alanı bu listenin DEX girdilerini zaten içerir (birleştirilmiş);
   * liste ayrıca burada duruyor çünkü sembol keşfine verilecek muafiyetler
   * (`kapsam`) ve raporlama için girdinin kendisi gerekiyor.
   */
  readonly izleme: IzlemeListesi;

  readonly scan: {
    /** Bildirim için gereken minimum net kâr oranı (0.004 = %0.4). */
    readonly minNetPct: number;
    /** Fırsat hesabında varsayılan işlem büyüklüğü (quote cinsinden, örn. USDT). */
    readonly tradeSizeQuote: number;
    /** Bu yaştan eski fiyatlar fırsat üretmez (ms). */
    readonly maxPriceAgeMs: number;
    /**
     * DEX venue'ları için bayatlık eşiği. CEX'inkinden ayrı: DEX fiyatı
     * push edilmez, çekilir — periyodu kaynağın limiti belirler.
     */
    readonly maxDexPriceAgeMs: number;
    /**
     * Aynı çift bu süre içinde yeniden doğrulanmaz.
     *
     * Derinlik önbelleği 2 sn TTL'li: daha sık doğrulamak aynı defteri okuyup
     * aynı sonuca varır, yalnızca kota ve kuyruk harcar.
     */
    readonly verifyCooldownMs: number;
    /** Dirty pair'lerin değerlendirilme periyodu (ms). */
    readonly evalIntervalMs: number;
    /** L2 derinlik doğrulaması tetikleyen ön-eşik — minNetPct'in altında olmalı. */
    readonly prefilterPct: number;
    /** Doğrulanmamış transfer bilgisiyle bildirim gönderilsin mi? */
    readonly allowUnverifiedTransfer: boolean;
    /**
     * Tokenlaştırılmış hisse senetlerinin CEX bacağında taşıdığı EK kesinti
     * (0.015 = %1.5). Borsanın taker komisyonuna EKLENİR.
     *
     * Neden ayrı bir kalem: ölçüldü ki Gate ve MEXC bu çiftlere normal
     * çiftlerle birebir aynı taker oranını uyguluyor (%0.2 / %0.05), yani
     * kesinti işlem komisyonu DEĞİL. Bybit'e Solana üzerinden yapılan
     * transferde ~%1.5'lik bir kayıp ölçüldü; Bybit'in public belgelerinde
     * yatırma ücreti olarak belgelenmiş bir karşılığı yok, ama üçüncü taraf
     * analizler xStocks tarafında ~%1 spread + %0.5 işlem ücreti bildiriyor —
     * ikisi ölçülen değere oturuyor.
     *
     * Mekanizma belirsiz, BÜYÜKLÜK ölçülü. Bu botta doğru davranış, mekanizmayı
     * doğru modelleyemediğimizde maliyeti YÜKSEK yazmaktır: olduğundan düşük
     * komisyon doğrudan sahte sinyal üretir, yüksek komisyon yalnızca fırsat
     * kaçırır (aynı gerekçe `config/exchanges.json` taker oranlarında da var).
     */
    readonly hisseTokenEkPct: number;
  };

  /** Ek kesinti uygulanacak tokenlaştırılmış hisse sembolleri (büyük harf). */
  readonly hisseTokenleri: ReadonlySet<string>;

  readonly telegram: {
    readonly enabled: boolean;
    readonly token: string | null;
    /**
     * Bildirim gönderilecek chat id'leri. BİRDEN FAZLA olabilir — `.env`'de
     * `TELEGRAM_CHAT_ID` virgülle ayrılmış liste kabul eder
     * (`123456,-100987654`). Her fırsat listedeki HERKESE ayrı ayrı
     * gönderilir; biri başarısız olsa diğerleri etkilenmez (`send()` chat
     * başına dener, hatasını kendi başına taşır).
     */
    readonly chatIds: readonly string[];
    /** Aynı fırsat için tekrar bildirim arası minimum süre (ms). */
    readonly cooldownMs: number;
    /** Cooldown içinde tekrar göndermek için gereken net% değişimi. */
    readonly resendDeltaPct: number;
  };

  /**
   * Solana Aşama 1 fiyat kaynağı. Aşama 2 doğrulaması her zaman Jupiter'dir
   * (bkz. feeds/dex/solana-price.ts).
   */
  readonly solanaPriceSource: 'jupiter' | 'geckoterminal';

  readonly sound: {
    readonly enabled: boolean;
    /** İki uyarı sesi arası asgari süre (ms). */
    readonly cooldownMs: number;
  };

  readonly ui: {
    readonly enabled: boolean;
    readonly refreshHz: number;
    readonly maxRows: number;
  };

  readonly persist: {
    readonly enabled: boolean;
    readonly dir: string;
  };
}

/**
 * `tokens.json` + izleme listesinin DEX girdilerini tek tabloda birleştirir.
 *
 * Elle girilen adres keşfin çoğunluk kuralından ve ±%25 sapma filtresinden
 * geçmemiştir; buradaki tek koruma tabloyla ÇELİŞMEMESİDİR. Çelişki iki
 * biçimde olur ve ikisi de sessizce çözülemez:
 *
 *   - aynı zincirde aynı sembol, FARKLI adres → biri yanlış token. Hangisi
 *     olduğunu söyleyecek dayanak yok; bot başlamaz.
 *   - aynı adres, farklı sembol → aynı token iki adla tabloda; hangi ticker'la
 *     CEX'e eşleneceği belirsiz kalırdı.
 *
 * Adresin ZATEN tabloda olması hata değil: girdi yalnızca gereksizdir ve
 * `npm run izle` bunu "zaten tokens.json'da" diye raporlar.
 */
function tokenTablosu(
  dosya: readonly TokenEntry[],
  izleme: IzlemeListesi,
): TokenEntry[] {
  const tokens = [...dosya];

  for (const g of izleme.girdiler) {
    for (const d of g.dex) {
      const ayniAdres = tokens.find(
        (t) => t.chain === d.zincir && t.address.toLowerCase() === d.adres.toLowerCase(),
      );
      if (ayniAdres) {
        if (ayniAdres.symbol.toUpperCase() !== g.sembol) {
          throw new Error(
            `${IZLEME_DOSYASI}: ${g.sembol} (${d.zincir}) için verilen adres ` +
              `config/tokens.json'da "${ayniAdres.symbol}" olarak kayıtlı — ` +
              `aynı adres iki farklı ticker'a ait olamaz`,
          );
        }
        continue;
      }

      const ayniSembol = tokens.find(
        (t) => t.chain === d.zincir && t.symbol.toUpperCase() === g.sembol,
      );
      if (ayniSembol) {
        throw new Error(
          `${IZLEME_DOSYASI}: ${g.sembol} (${d.zincir}) için ADRES ÇELİŞKİSİ — ` +
            `izleme listesi "${d.adres}", config/tokens.json "${ayniSembol.address}" diyor. ` +
            `İkisi aynı token olamaz; hangisinin doğru olduğunu doğrula ` +
            `(npm run verify-contracts / npm run dex) ve birini düzelt.`,
        );
      }

      tokens.push({
        symbol: g.sembol,
        chain: d.zincir,
        address: d.adres,
        decimals: d.decimals,
        kaynak: 'izleme-listesi',
      });
    }
  }

  return tokens;
}

/**
 * Bir izleme listesi tokens.json ile çelişiyor mu — DİSKE YAZMADAN dene.
 *
 * `npm run izle -- ekle` bunu kullanıyor: çelişkiyi ancak bir sonraki
 * başlangıçta görmek, kullanıcıyı botu başlatamaz halde bırakırdı.
 */
export function tokenCakismasiniDene(izleme: IzlemeListesi): void {
  tokenTablosu(readJson<TokenEntry[]>('config/tokens.json'), izleme);
}

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;

  const exchanges = readJson<Record<string, ExchangeConfig>>('config/exchanges.json');
  const chains = readJson<Record<string, ChainConfig>>('config/chains.json');
  const izleme = loadIzlemeListesi(ROOT);
  const tokens = tokenTablosu(readJson<TokenEntry[]>('config/tokens.json'), izleme);

  // Liste ELLE tutulur, kalıpla türetilmez: sondaki "X" harfine bakan bir kural
  // SPX, ARX, MPLX, NATIX ve GMX'i de hisse sanardı. Kimlik kuralının aynısı —
  // bir varlığın kimliği ticker'ın ŞEKLİ değildir.
  const hisseTokenleri = new Set(
    readJson<{ semboller?: string[] }>('config/hisse-tokenlari.json').semboller?.map((x) =>
      x.toUpperCase(),
    ) ?? [],
  );

  for (const id of CEX_IDS) {
    const ex = exchanges[id];
    if (!ex) throw new Error(`config/exchanges.json içinde "${id}" tanımlı değil`);
    if (!(ex.fees?.taker >= 0)) throw new Error(`${id}: fees.taker geçersiz`);
    if (!Array.isArray(ex.quotes) || ex.quotes.length === 0) {
      throw new Error(`${id}: en az bir quote para birimi tanımlanmalı`);
    }
  }

  // Zincir RPC adresleri: .env dosyadakini EZER.
  //
  // Eskiden değer yalnızca config/chains.json'dan okunuyordu; oysa
  // .env.example, `npm run dex` çıktısı ve DEX kurulum hatası üçü birden
  // kullanıcıya "BASE_RPC_URL / ARBITRUM_RPC_URL tanımla" diyordu. Yazılan
  // değişken sessizce yok sayılıyor, kullanıcı kendi RPC'sini kullandığını
  // sanarken public uç noktada rate-limit yiyordu.
  for (const id of CHAIN_IDS) {
    const c = chains[id];
    if (!c) throw new Error(`config/chains.json içinde "${id}" tanımlı değil`);

    const override = envOptional(RPC_ENV[id]);
    const rpcUrl = override ?? c.rpcUrl;
    if (rpcUrl && !/^(https?|wss?):\/\//.test(rpcUrl)) {
      throw new Error(
        `${id}: rpcUrl http(s):// veya ws(s):// ile başlamalı — alınan "${rpcUrl}"` +
          (override ? ` (${RPC_ENV[id]} içinden)` : ' (config/chains.json içinden)'),
      );
    }
    if (override) chains[id] = { ...c, rpcUrl: override };
  }

  // Token tablosu doğrulaması: aynı (chain, address) iki kez girilmemeli ve
  // adresler zincire uygun formatta olmalı. Bu tablo yanlışsa yanlış token'ı
  // arbitraja sokarız — en pahalı hata sınıfı.
  const seen = new Set<string>();
  for (const t of tokens) {
    // Hata mesajı kaynağı SÖYLEMELİ: aynı doğrulama iki dosyadan beslenirken
    // "geçersiz adres" demek, kullanıcıyı yanlış dosyada arattırır.
    const nereden = t.kaynak === 'izleme-listesi' ? IZLEME_DOSYASI : 'config/tokens.json';
    const key = `${t.chain}:${t.address.toLowerCase()}`;
    if (seen.has(key)) throw new Error(`${nereden}: yinelenen token ${key}`);
    seen.add(key);

    if (t.chain === 'solana') {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t.address)) {
        throw new Error(`${nereden} → ${t.symbol}: geçersiz Solana mint adresi "${t.address}"`);
      }
    } else if (!/^0x[0-9a-fA-F]{40}$/.test(t.address)) {
      throw new Error(`${nereden} → ${t.symbol}: geçersiz EVM adresi "${t.address}"`);
    }

    if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 18) {
      throw new Error(`${nereden} → ${t.symbol}: geçersiz decimals ${t.decimals}`);
    }
  }

  // API anahtarları: yarım girilmiş kimlik sessizce yok sayılmaz. Anahtarı olup
  // secret'ı olmayan bir borsa, kullanıcının doldurduğunu sandığı ama aslında
  // doğrulanmamış kalan bir borsadır — tam olarak kaçındığımız durum.
  const apiKeys: Partial<Record<CexId, ApiCredentials>> = {};
  for (const id of CEX_IDS) {
    const prefix = id.toUpperCase();
    const key = envOptional(`${prefix}_API_KEY`);
    const secret = envOptional(`${prefix}_API_SECRET`);
    const passphrase = envOptional(`${prefix}_API_PASSPHRASE`);

    if (!key && !secret) continue;
    if (!key || !secret) {
      throw new Error(
        `${prefix}_API_KEY ve ${prefix}_API_SECRET birlikte tanımlanmalı (biri eksik)`,
      );
    }
    if (id === 'okx' && !passphrase) {
      throw new Error('OKX_API_PASSPHRASE zorunlu — OKX imzası passphrase olmadan geçersiz');
    }
    apiKeys[id] = { key, secret, passphrase };
  }

  const minNetPct = envNum('MIN_NET_PCT', 0.4) / 100;
  const prefilterPct = envNum('PREFILTER_PCT', 0.15) / 100;
  if (prefilterPct > minNetPct) {
    throw new Error(
      `PREFILTER_PCT (${prefilterPct * 100}%) MIN_NET_PCT'ten (${minNetPct * 100}%) büyük olamaz — ` +
        `ön-filtre daha gevşek olmalı, aksi halde gerçek fırsatları eleriz`,
    );
  }

  // DEX fiyatları HTTP ile ÇEKİLİR; periyodu kaynağın dakikalık limiti
  // belirler (109 mint GeckoTerminal'de 10 sn). CEX eşiğini (3 sn) DEX'e de
  // uygulamak, her DEX okumasını bayat sayıp CEX↔DEX fırsatını yapısal olarak
  // imkânsız kılıyordu.
  const cexAge = envNum('MAX_PRICE_AGE_MS', 3000);
  const dexAge = envNum('MAX_DEX_PRICE_AGE_MS', 30_000);
  if (dexAge < cexAge) {
    throw new Error(
      `MAX_DEX_PRICE_AGE_MS (${dexAge}) MAX_PRICE_AGE_MS'ten (${cexAge}) küçük olamaz — ` +
        `DEX fiyatı çekmeli olduğu için her zaman daha yavaş tazelenir`,
    );
  }

  // Yanlış yazılmış bir kaynak adı sessizce Jupiter'e düşmemeli: kullanıcı
  // ücretsiz kaynağa geçtiğini sanırken lite-api kovasını doldurmaya devam
  // ederdi ve sebebini hiçbir yerde göremezdi.
  const solanaKaynakHam = env('SOLANA_PRICE_SOURCE', 'jupiter').toLowerCase();
  if (solanaKaynakHam !== 'jupiter' && solanaKaynakHam !== 'geckoterminal') {
    throw new Error(
      `SOLANA_PRICE_SOURCE geçersiz: "${solanaKaynakHam}" — 'jupiter' veya 'geckoterminal' olmalı`,
    );
  }
  const solanaKaynak = solanaKaynakHam;

  cached = {
    exchanges: exchanges as Record<CexId, ExchangeConfig>,
    chains: chains as Record<ChainId, ChainConfig>,
    tokens,
    apiKeys,
    izleme,
    scan: {
      minNetPct,
      prefilterPct,
      tradeSizeQuote: envNum('TRADE_SIZE_QUOTE', 1000),
      maxPriceAgeMs: envNum('MAX_PRICE_AGE_MS', 3000),
      maxDexPriceAgeMs: dexAge,
      verifyCooldownMs: envNum('VERIFY_COOLDOWN_MS', 2000),
      evalIntervalMs: envNum('EVAL_INTERVAL_MS', 50),
      allowUnverifiedTransfer: envBool('ALLOW_UNVERIFIED_TRANSFER', true),
      hisseTokenEkPct: envNum('HISSE_TOKEN_EK_PCT', 1.5) / 100,
    },
    hisseTokenleri,
    telegram: {
      enabled: envBool('TELEGRAM_ENABLED', false),
      token: envOptional('TELEGRAM_BOT_TOKEN'),
      chatIds: envList('TELEGRAM_CHAT_ID'),
      cooldownMs: envNum('TELEGRAM_COOLDOWN_MS', 300_000),
      resendDeltaPct: envNum('TELEGRAM_RESEND_DELTA_PCT', 0.5) / 100,
    },
    solanaPriceSource: solanaKaynak,
    sound: {
      enabled: envBool('SOUND_ENABLED', true),
      cooldownMs: envNum('SOUND_COOLDOWN_MS', 15_000),
    },
    ui: {
      enabled: envBool('UI_ENABLED', true),
      refreshHz: envNum('UI_REFRESH_HZ', 4),
      maxRows: envNum('UI_MAX_ROWS', 15),
    },
    persist: {
      enabled: envBool('PERSIST_ENABLED', true),
      dir: env('PERSIST_DIR', resolve(ROOT, 'data')),
    },
  };

  if (cached.telegram.enabled && (!cached.telegram.token || cached.telegram.chatIds.length === 0)) {
    throw new Error(
      'TELEGRAM_ENABLED=1 ama TELEGRAM_BOT_TOKEN veya TELEGRAM_CHAT_ID eksik',
    );
  }

  return cached;
}
