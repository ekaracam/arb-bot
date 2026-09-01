/**
 * Zorunlu izleme listesi — "bu coin kesinlikle taransın" dediğin kayıtlar.
 *
 * Botun otomatik keşfi kasıtlı olarak muhafazakârdır: stablecoin'leri eler,
 * kaldıraçlı kalıba uyanı eler, yalnızca `config/exchanges.json`'daki quote
 * para birimlerine bakar ve bir çifti taramak için en az iki BORSA ister.
 * Bu kurallar toplu keşifte doğrudur ama tek tek coinlerde yanılırlar:
 *
 *   - kalıp yanlış eleyebilir (ölçüldü: JUP "UP" ile bittiği için aylarca
 *     hiç taranmadı — altı borsada listeliyken),
 *   - bir coin tek CEX + bir DEX'te olabilir; bu geçerli bir arbitrajdır ama
 *     "en az iki borsa" kuralı çifti daha oluşmadan siler,
 *   - Kraken'in USDT piyasası dar, USD piyasası geniş — quote listesi dışında
 *     kalan gerçek çiftler var.
 *
 * Bu dosya o kararları coin bazında GERİ ALMANI sağlar. Muafiyet sessiz
 * değildir: her girdinin gerçekten işe yarayıp yaramadığı `npm run izle` ve
 * `npm run kapsam` çıktısında satır satır raporlanır. Bir girdinin hiçbir şeye
 * yaramaması (coin hiçbir borsada yok) tam olarak bu botun en pahalı hata
 * sınıfıdır — kullanıcı izlendiğini sanır, oysa çift hiç oluşmamıştır.
 *
 * DEX bilgisi (`dex[]`) girersen token doğrudan `config/tokens.json`
 * tablosuna karışır; `npm run discover-tokens` çalıştırmana gerek kalmaz.
 * Adres elle yazıldığı için kimlik kuralı burada daha da kritik: aynı
 * zincirde aynı sembol için tokens.json başka bir adres diyorsa bot
 * BAŞLAMAZ (bkz. core/config.ts).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { CHAIN_IDS, type ChainId } from './types.ts';

/** Liste dosyasının repo köküne göre yolu — hata mesajlarında da kullanılır. */
export const IZLEME_DOSYASI = 'config/izleme-listesi.json';

/** Dosyanın başına yazılan kullanım notu; CLI yeniden yazarken korur. */
const ACIKLAMA = [
  'Botun otomatik keşfinin ELEDİĞİ ama senin kesinlikle taranmasını istediğin coinler.',
  'sembol  : ticker (zorunlu). Stablecoin/kaldıraçlı elemesi ve "en az iki borsa" kuralı bu coin için uygulanmaz.',
  'quotes  : USDT dışında kabul edilecek ek quote birimleri (ör. ["USD"]). Boş bırakılabilir.',
  'dex     : DEX bacağı için token bilgisi. tokens.json ile aynı zincirde çelişirse bot başlamaz.',
  'not     : neden eklediğin. Aylar sonra okuyacak olan sensin.',
  'Girdinin GERÇEKTEN işe yarayıp yaramadığını gör: npm run izle',
];

// ---------------------------------------------------------------------------
// Tipler
// ---------------------------------------------------------------------------

export interface IzlemeDexTokeni {
  readonly zincir: ChainId;
  readonly adres: string;
  readonly decimals: number;
}

export interface IzlemeGirdisi {
  /** Büyük harfe normalize edilmiş ticker. */
  readonly sembol: string;
  /** USDT dışında kabul edilecek ek quote birimleri (büyük harf). */
  readonly quotes: readonly string[];
  readonly dex: readonly IzlemeDexTokeni[];
  readonly not: string | null;
}

/**
 * Sembol keşfine verilen muafiyet tablosu.
 *
 * `SymbolRegistry` bu yapıyı alır ama izleme listesi dosyasını hiç bilmez:
 * kayıt defterinin tek ihtiyacı "şu base'ler muaf, şu quote'lar da kabul"
 * bilgisidir. Dar tutmak testleri dosyaya bağımlı olmaktan kurtarıyor.
 */
export interface ZorunluKapsam {
  readonly bases: ReadonlySet<string>;
  /** base → o base için ek kabul edilen quote'lar. */
  readonly ekQuotes: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface IzlemeListesi {
  readonly girdiler: readonly IzlemeGirdisi[];
  readonly kapsam: ZorunluKapsam;
  girdi(sembol: string): IzlemeGirdisi | null;
}

// ---------------------------------------------------------------------------
// Doğrulama
// ---------------------------------------------------------------------------

/**
 * Bilinmeyen alan HATA sayılır.
 *
 * `"symbol"` yazıp `"sembol"` sanmak, girdinin sessizce yok sayılması demek.
 * Bu listenin var olma sebebi tam olarak sessiz kapsam kaybını önlemek
 * olduğuna göre, kendi dosyasında sessiz kalmak en kötüsü olurdu.
 */
const ALANLAR = new Set(['sembol', 'quotes', 'dex', 'not']);
const DEX_ALANLARI = new Set(['zincir', 'adres', 'decimals']);

const SEMBOL_KALIBI = /^[A-Z0-9]{1,20}$/;

function hata(mesaj: string): never {
  throw new Error(`${IZLEME_DOSYASI}: ${mesaj}`);
}

function metin(v: unknown, alan: string, ctx: string): string {
  if (typeof v !== 'string') hata(`${ctx} → "${alan}" metin olmalı`);
  return v.trim();
}

function fazlaAlan(obj: Record<string, unknown>, izinli: ReadonlySet<string>, ctx: string): void {
  for (const k of Object.keys(obj)) {
    if (!izinli.has(k)) {
      hata(`${ctx} → bilinmeyen alan "${k}" (beklenen: ${[...izinli].join(', ')})`);
    }
  }
}

function dexTokeniOku(raw: unknown, sembol: string, i: number): IzlemeDexTokeni {
  const ctx = `${sembol} → dex[${i}]`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    hata(`${ctx} bir nesne olmalı: { "zincir": "...", "adres": "...", "decimals": 0 }`);
  }
  const o = raw as Record<string, unknown>;
  fazlaAlan(o, DEX_ALANLARI, ctx);

  const zincirHam = metin(o['zincir'], 'zincir', ctx).toLowerCase();
  if (!(CHAIN_IDS as readonly string[]).includes(zincirHam)) {
    hata(`${ctx} → geçersiz zincir "${zincirHam}" (beklenen: ${CHAIN_IDS.join(', ')})`);
  }
  const zincir = zincirHam as ChainId;

  // Adres formatı burada da kontrol ediliyor (config.ts token tablosunu ayrıca
  // doğruluyor) çünkü hata mesajının HANGİ dosyadan geldiğini söylemesi
  // gerekiyor: elle yazılmış bir adresin nerede olduğunu bilmeden düzeltemezsin.
  const adres = metin(o['adres'], 'adres', ctx);
  if (zincir === 'solana') {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(adres)) {
      hata(`${ctx} → geçersiz Solana mint adresi "${adres}"`);
    }
  } else if (!/^0x[0-9a-fA-F]{40}$/.test(adres)) {
    hata(`${ctx} → geçersiz EVM adresi "${adres}"`);
  }

  const decimals = o['decimals'];
  if (!Number.isInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 18) {
    hata(`${ctx} → decimals 0-18 arası tam sayı olmalı, alınan: ${String(decimals)}`);
  }

  return { zincir, adres, decimals: decimals as number };
}

function girdiOku(raw: unknown, i: number): IzlemeGirdisi {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    hata(`coinler[${i}] bir nesne olmalı: { "sembol": "PEPE" }`);
  }
  const o = raw as Record<string, unknown>;
  fazlaAlan(o, ALANLAR, `coinler[${i}]`);

  const sembol = metin(o['sembol'], 'sembol', `coinler[${i}]`).toUpperCase();
  if (!SEMBOL_KALIBI.test(sembol)) {
    hata(`coinler[${i}] → geçersiz sembol "${sembol}" (yalnızca harf ve rakam, en fazla 20)`);
  }

  const quotesHam = o['quotes'] ?? [];
  if (!Array.isArray(quotesHam)) hata(`${sembol} → "quotes" dizi olmalı`);
  const quotes = quotesHam.map((q, qi) => metin(q, `quotes[${qi}]`, sembol).toUpperCase());

  const dexHam = o['dex'] ?? [];
  if (!Array.isArray(dexHam)) hata(`${sembol} → "dex" dizi olmalı`);
  const dex = dexHam.map((d, di) => dexTokeniOku(d, sembol, di));

  // Aynı zincirde iki adres = hangisinin doğru olduğunu söyleyecek dayanak yok.
  const zincirler = new Set<ChainId>();
  for (const d of dex) {
    if (zincirler.has(d.zincir)) hata(`${sembol} → "${d.zincir}" zinciri iki kez tanımlanmış`);
    zincirler.add(d.zincir);
  }

  const notHam = o['not'];
  const not = notHam === undefined || notHam === null ? null : metin(notHam, 'not', sembol);

  return { sembol, quotes, dex, not: not === '' ? null : not };
}

// ---------------------------------------------------------------------------
// Yükleme / yazma
// ---------------------------------------------------------------------------

function listeKur(girdiler: readonly IzlemeGirdisi[]): IzlemeListesi {
  const bases = new Set(girdiler.map((g) => g.sembol));
  const ekQuotes = new Map<string, ReadonlySet<string>>();
  for (const g of girdiler) {
    if (g.quotes.length > 0) ekQuotes.set(g.sembol, new Set(g.quotes));
  }
  const index = new Map(girdiler.map((g) => [g.sembol, g]));

  return {
    girdiler,
    kapsam: { bases, ekQuotes },
    girdi: (s) => index.get(s.toUpperCase()) ?? null,
  };
}

/** Girdisi olmayan liste — testler ve dosya yokluğu için. */
export function bosIzlemeListesi(): IzlemeListesi {
  return listeKur([]);
}

/**
 * Listeyi diskten oku. Dosya yoksa boş liste döner (özellik opsiyonel), ama
 * dosya VARSA ve bozuksa hata verilir — yarısı okunmuş bir liste, kullanıcının
 * eklediğini sandığı coinin taranmaması demektir.
 */
export function loadIzlemeListesi(root: string): IzlemeListesi {
  const p = resolve(root, IZLEME_DOSYASI);
  if (!existsSync(p)) return bosIzlemeListesi();

  let ham: unknown;
  try {
    ham = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    hata(`geçerli JSON değil — ${(e as Error).message}`);
  }
  return izlemeListesiOku(ham);
}

/**
 * Ham JSON gövdesini doğrulayıp listeye çevirir.
 *
 * Dosyadan okuma ve CLI'nın yazacağı gövde AYNI fonksiyondan geçer. Ayrı
 * yollar olsaydı `ekle` komutu dosyayı bozup çıkabilirdi: ölçüldü — geçersiz
 * bir adres önce diske yazıldı, hata ancak sonraki adımda göründü ve bot o
 * andan itibaren başlamıyordu. Doğrulama yazma yolunun İÇİNDE olmalı.
 */
export function izlemeListesiOku(ham: unknown): IzlemeListesi {
  if (typeof ham !== 'object' || ham === null || Array.isArray(ham)) {
    hata('kök nesne olmalı: { "coinler": [...] }');
  }
  const kok = ham as Record<string, unknown>;
  const coinlerHam = kok['coinler'];
  if (coinlerHam === undefined) hata('"coinler" alanı yok');
  if (!Array.isArray(coinlerHam)) hata('"coinler" dizi olmalı');

  const girdiler = coinlerHam.map((g, i) => girdiOku(g, i));

  const gorulen = new Set<string>();
  for (const g of girdiler) {
    if (gorulen.has(g.sembol)) hata(`"${g.sembol}" iki kez tanımlanmış`);
    gorulen.add(g.sembol);
  }

  return listeKur(girdiler);
}

/**
 * Listeyi diske yaz (CLI kullanır).
 *
 * Sembole göre sıralı yazılır: elle düzenlenen bir dosyada satır sırasının
 * kararlı olması, iki eklemenin diff'te yan yana görünmesi demek.
 *
 * Gövde yazılmadan önce okuma yolundan geçirilir — geçersiz bir girdi diske
 * ULAŞMAZ. Aksi halde `ekle` komutu botu başlatılamaz halde bırakabilirdi.
 */
export function yazIzlemeListesi(root: string, girdiler: readonly IzlemeGirdisi[]): string {
  const sirali = [...girdiler].sort((a, b) => a.sembol.localeCompare(b.sembol, 'en'));
  const govde = {
    $aciklama: ACIKLAMA,
    coinler: sirali.map((g) => ({
      sembol: g.sembol,
      ...(g.not ? { not: g.not } : {}),
      ...(g.quotes.length > 0 ? { quotes: g.quotes } : {}),
      ...(g.dex.length > 0
        ? {
            dex: g.dex.map((d) => ({
              zincir: d.zincir,
              adres: d.adres,
              decimals: d.decimals,
            })),
          }
        : {}),
    })),
  };
  izlemeListesiOku(govde);

  const p = resolve(root, IZLEME_DOSYASI);
  writeFileSync(p, `${JSON.stringify(govde, null, 2)}\n`, 'utf8');
  return p;
}
