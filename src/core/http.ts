/**
 * REST çağrıları için ince bir katman: timeout, retry ve host başına
 * token-bucket rate limit.
 *
 * Neden limiter şart: borsalar IP bazlı sert limitler uygular ve limiti aşmak
 * geçici ban demektir. Ban yediğin an feed'in de bozulur (KuCoin token yenileme,
 * Gate currencies vb. REST'e bağlı). Limiti kod seviyesinde garanti altına
 * almak, "dikkatli çağırırız" temennisinden güvenlidir.
 *
 * Node'un yerleşik fetch'i (undici) zaten bağlantı havuzu ve keep-alive
 * kullanıyor; havuzu ayrıca ayarlamak için `undici` paketini bağımlılık olarak
 * eklemeye değmez — REST burada yalnızca kurulum ve meta veri yolunda, fiyat
 * akışı tamamen WebSocket üzerinden geliyor.
 */

class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(
    readonly capacity: number,
    readonly refillPerSec: number,
  ) {
    this.tokens = capacity;
  }

  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      const elapsed = (now - this.lastRefill) / 1000;
      if (elapsed > 0) {
        this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
        this.lastRefill = now;
      } else if (elapsed < 0) {
        // Saat geri gitti (NTP düzeltmesi, testte sahte saat): referansı
        // çekmezsek kova o fark kapanana kadar hiç dolmaz.
        this.lastRefill = now;
      }
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil(((1 - this.tokens) / this.refillPerSec) * 1000);
      await new Promise((r) => setTimeout(r, Math.max(10, waitMs)));
    }
  }
}

/**
 * Host başına limitler. Değerler borsaların yayınladığı limitlerin belirgin
 * biçimde altında tutuldu — burada agresif olmanın hiçbir kazancı yok, çünkü
 * fiyat verisi WebSocket'ten geliyor; REST yalnızca kurulum ve meta veri için.
 */
const LIMITS: Record<string, TokenBucket> = {
  'api.binance.com': new TokenBucket(10, 5),
  'api.bybit.com': new TokenBucket(10, 5),
  'www.okx.com': new TokenBucket(10, 5),
  'api.gateio.ws': new TokenBucket(10, 5),
  'api.mexc.com': new TokenBucket(10, 5),
  'api.kucoin.com': new TokenBucket(10, 5),
  // Kraken public REST'i diğerlerinden belirgin şekilde SIKI: sayaç tabanlı
  // bir sistemle çalışıyor ve doğrulanmamış kullanıcıda saniyede ~1 istek
  // civarında tutmak gerekiyor. Diğer borsalarla aynı kovayı (10/sn) vermek
  // derinlik çekimlerinde hızla 429 üretirdi.
  'api.kraken.com': new TokenBucket(3, 1),
  // Jupiter (`lite-api.jup.ag`, `api.jup.ag`) burada YOK: kovası kademeye
  // (anahtarsız / free / developer) bağlı ve `perMinute` ile aynı tanımdan
  // türemek zorunda — `jupiterKovasiniKur()` (feeds/dex/jupiter.ts) kurar.
  // İki ayrı yerde yazılan sayılar ayrışır: kova 60/dk varsayarken gerçek
  // limit 30/dk'ydı ve uç sürekli 429 veriyordu (COW_PER_MINUTE dersi).
  // Ücretsiz ve anahtarsız: dakikada 30 istek. Kovayı buna göre daraltmak
  // şart — DEFAULT_LIMIT (10/sn) bu uç noktayı saniyeler içinde 429'a sokar.
  'api.geckoterminal.com': new TokenBucket(2, 0.5),
  // CoW Protocol quote uçtası — DAR, ve sebebi geckoterminal'inkinden farklı.
  //
  // Kısa ölçüm YANILTTI: 20 sn sürekli yükte 2/sn, 5/sn ve 10/sn kademelerinin
  // ÜÇÜ de 0×429 verdi ("limit yok" gibi göründü). Gerçek sınır 429 değil:
  // CoW'un önünde CloudFront var ve sürekli yükten bir süre SONRA IP'yi
  // **403 + HTML** ile blokluyor. Yani limit aşımı anlık olarak görünmüyor,
  // gecikmeli ve farklı bir kodla geliyor — tek atışlık ölçümün göremeyeceği
  // bir davranış (geckoterminal dersinin başka bir biçimi).
  //
  // Ölçülen sonuç: ~8 istek/sn'lik sürekli yük (75 token × 2 bacak / 19 sn)
  // birkaç dakikada blok yedi. Kova bu yüzden 2/sn; bu hızda 75 token bir
  // turu ~94 sn'de tamamlar, yani CoW bu ÖLÇEKTE geniş tarama kaynağı
  // OLAMAZ (bkz. CowFeed başlığı — doğru yer Aşama 2 doğrulaması).
  'api.cow.fi': new TokenBucket(4, 2),
  // Raydium — anahtarsız, ve İKİ AYRI HOST kullanıyor. Ayrılık mimari olarak
  // değerli: Aşama 1 geniş taraması (`api-v3`) ile Aşama 2 doğrulaması
  // (`transaction-v1`) birbirinin kotasını YEMİYOR. Jupiter'de ikisi de
  // `lite-api.jup.ag` üzerinde ve ölçülen sonuç, taramanın doğrulamayı aç
  // bırakmasıydı (`taramaPayi` bu yüzden 0.35).
  //
  // Ölçüm (2026-08-27): mint/price 138 mint = 3 istek, 1.2 sn, 0 hata;
  // compute/swap-base-in 40 istek 2/sn → 39 ok, 0×429. Belgelenmiş bir limit
  // yok, bu yüzden kova ölçülen hızın altında tutuldu — geckoterminal dersi:
  // limit belgede yazmıyorsa ve tek atışta görünmüyorsa, yine de vardır.
  'api-v3.raydium.io': new TokenBucket(4, 2),
  // Aşama 2 quote ucu — ÖLÇÜLDÜ VE DARALTILDI (2/sn → 0.5/sn).
  //
  // İlk değer (2/sn) 40 isteklik bir seride 0×429 görülerek konmuştu. Canlı
  // koşuda 12 dakika sonra uç nokta bloklandı: 20/20 istek **429 + HTML
  // gövde**, 7 ms'de — yani istek Raydium'a hiç ulaşmıyor, önündeki WAF
  // cevaplıyor. Bot tarafındaki iz dakikada ~120 hataydı.
  //
  // Bu, geckoterminal ve CoW derslerinin ÜÇÜNCÜ tekrarı: limit belgede
  // yazmıyorsa, tek atışlık ölçümde görünmüyorsa ve 429 ile ifade edilmiyorsa
  // bile vardır. Aşama 2 kuyruğu doymuş durumda olduğu için kendisine verilen
  // kovanın tamamını HER ZAMAN kullanır — dolayısıyla tek koruma kovanın
  // kendisi ve `RaydiumQuoter`'daki geri çekilmedir.
  'transaction-v1.raydium.io': new TokenBucket(2, 0.5),
};

const DEFAULT_LIMIT = new TokenBucket(20, 10);

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * Bir host'un kovasını kurar/değiştirir. Limiti çağıran modülün BİLDİĞİ
 * durumlar için (ör. Jupiter kademesi `.env`'e bağlı): kova ile periyot
 * hesabı aynı sayıdan türesin diye.
 *
 * Aynı değerlerle tekrar çağrılırsa mevcut kova KORUNUR — aynı host'u
 * kullanan iki istemci (Jupiter tarama + doğrulama) tek kovayı paylaşmalı,
 * yoksa toplam hız iki katına çıkar.
 */
export function hostKovasiniAyarla(host: string, saniyeBasina: number, patlama: number): void {
  const mevcut = LIMITS[host];
  if (mevcut && mevcut.refillPerSec === saniyeBasina && mevcut.capacity === patlama) return;
  LIMITS[host] = new TokenBucket(patlama, saniyeBasina);
}

/** Host'un kovası (test ve teşhis için). Tanımsızsa `null` — varsayılan kova kullanılır. */
export function hostKovasi(host: string): { patlama: number; saniyeBasina: number } | null {
  const k = LIMITS[host];
  return k ? { patlama: k.capacity, saniyeBasina: k.refillPerSec } : null;
}

// ---------------------------------------------------------------------------
// Host bazlı 429 geri çekilmesi
// ---------------------------------------------------------------------------
//
// ÖLÇÜLEN HATA: Jupiter `lite-api` 30 istek/dk (60 sn kayan pencere) verirken
// kova 60/dk varsayıyordu ve 429'dan sonra HİÇBİR fren yoktu — Aşama 2 kuyruğu
// doymuş olduğu için bot kovayı her zaman tüketip kayan pencereyi sürekli
// dolu tutuyordu (panel: `133 hata (HTTP 429 …/swap/v1…)`). Üstüne tarama
// `retries: 1` ile her 429'u ikinci bir istekle ödüllendiriyordu.
//
// Kural: 429 gelince host üstel sürelerle KAPANIR; kapalıyken istek ağa
// ÇIKMAZ, hemen `GeriCekilmeHatasi` fırlatılır (doğrulama yuvası kovada
// beklemeden boşalır). `retry-after` gelirse ona uyulur. Başarılı cevap
// sıfırlar. Tavan SONLU: limit geçicidir ve insan müdahalesi olmadan geri
// dönülebilmeli (Raydium `bloklandiUntil` ve CoW geri çekilmesiyle aynı ders).

export const GERI_CEKILME_ILK_MS = 15_000;
export const GERI_CEKILME_TAVAN_MS = 5 * 60_000;

interface GeriCekilmeKaydi {
  bloklandiUntil: number;
  /** Ardışık 429 sayısı (aynı patlamanın uçuştaki istekleri sayılmaz). */
  ardisik: number;
  /** Bir sonraki kapanmanın süresi (ms). */
  bekleme: number;
  /**
   * Son kapanma kurulduğunda verilmiş son gönderim numarası — numarası bundan
   * küçük/eşit isteğin cevabı kapanmadan ÖNCE yola çıkmıştır. Zaman damgası
   * yerine sayaç: aynı milisaniyede gönderilen istekler de doğru ayrılır.
   */
  kapanmaNo: number;
}

const geriCekilmeler = new Map<string, GeriCekilmeKaydi>();
/** Ağa çıkan her isteğin sıra numarası (tüm host'lar için tek sayaç). */
let gonderimSayaci = 0;

export interface GeriCekilmeDurumu {
  readonly host: string;
  /** Kapanmanın bittiği an (epoch ms); geçmişteyse host açık. */
  readonly bloklandiUntil: number;
  readonly ardisik: number;
}

/** Panel/sağlık için: host'un geri çekilme durumu (kaydı yoksa açık, ardisik 0). */
export function geriCekilmeDurumu(host: string): GeriCekilmeDurumu {
  const k = geriCekilmeler.get(host);
  return { host, bloklandiUntil: k?.bloklandiUntil ?? 0, ardisik: k?.ardisik ?? 0 };
}

/** Panel/sağlık için: şu anda KAPALI olan tüm host'lar. */
export function kapaliHostlar(simdi = Date.now()): GeriCekilmeDurumu[] {
  const out: GeriCekilmeDurumu[] = [];
  for (const [host, k] of geriCekilmeler) {
    if (simdi < k.bloklandiUntil) {
      out.push({ host, bloklandiUntil: k.bloklandiUntil, ardisik: k.ardisik });
    }
  }
  return out;
}

/** Yalnızca testler için: tüm geri çekilme durumunu temizler. */
export function geriCekilmeleriSifirla(): void {
  geriCekilmeler.clear();
}

/**
 * `retry-after` başlığını ms'ye çevirir: saniye sayısı ya da HTTP tarihi.
 * Anlaşılamayan değer `null` — sessizce 0 saymak hemen yeniden yüklenmek olurdu.
 */
export function retryAfterMs(deger: string | null, simdi = Date.now()): number | null {
  if (deger === null) return null;
  const v = deger.trim();
  if (v === '') return null;
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v) * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.max(0, t - simdi);
}

function kaydet429(host: string, retryAfter: string | null, gonderimNo: number): void {
  const simdi = Date.now();
  let k = geriCekilmeler.get(host);
  if (!k) {
    k = { bloklandiUntil: 0, ardisik: 0, bekleme: GERI_CEKILME_ILK_MS, kapanmaNo: 0 };
    geriCekilmeler.set(host, k);
  }
  const ra = retryAfterMs(retryAfter, simdi);
  const raSure = ra === null ? null : Math.min(Math.max(ra, 1000), GERI_CEKILME_TAVAN_MS);

  // Kapanma kurulduktan SONRA gelen ama ondan ÖNCE gönderilmiş isteğin 429'u
  // aynı patlamanın parçasıdır: süreyi katlamak, uçuştaki N istek yüzünden
  // tek seferde tavana fırlamak olurdu. Yalnızca `retry-after` daha uzun
  // diyorsa uzatılır.
  if (gonderimNo <= k.kapanmaNo) {
    if (raSure !== null) k.bloklandiUntil = Math.max(k.bloklandiUntil, simdi + raSure);
    return;
  }
  k.ardisik++;
  k.bloklandiUntil = simdi + (raSure ?? k.bekleme);
  k.kapanmaNo = gonderimSayaci;
  k.bekleme = Math.min(k.bekleme * 2, GERI_CEKILME_TAVAN_MS);
}

function kaydetBasari(host: string, gonderimNo: number): void {
  const k = geriCekilmeler.get(host);
  // Kapanmadan önce yola çıkmış isteğin başarısı yeni kapanmayı AÇMAZ.
  if (!k || gonderimNo <= k.kapanmaNo) return;
  geriCekilmeler.delete(host);
}

function kapaliysaFirlat(host: string, url: string): void {
  const k = geriCekilmeler.get(host);
  if (!k) return;
  const kalan = k.bloklandiUntil - Date.now();
  if (kalan > 0) throw new GeriCekilmeHatasi(host, url, kalan, k.ardisik);
}

export interface HttpOptions {
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly headers?: Record<string, string>;
  readonly method?: 'GET' | 'POST';
  readonly body?: string;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly bodySnippet: string,
  ) {
    super(`HTTP ${status} ${url} — ${bodySnippet.slice(0, 200)}`);
    this.name = 'HttpError';
  }
}

/**
 * Host 429 geri çekilmesindeyken istek ATILMADAN fırlatılır. `HttpError(429)`
 * alt sınıfı: çağıranın mevcut "429 = arıza, rota yok değil" ayrımı aynen
 * işler (gövde sağlayıcının JSON'u değil). Mesaj panelde okunur kalsın diye
 * kısa: `lite-api.jup.ag geri çekilmede (12 sn, ardışık 429: 1)`.
 */
export class GeriCekilmeHatasi extends HttpError {
  constructor(
    readonly host: string,
    url: string,
    readonly kalanMs: number,
    readonly ardisik: number,
  ) {
    const metin =
      `${host} geri çekilmede (${Math.ceil(kalanMs / 1000)} sn, ardışık 429: ${ardisik})` +
      ' — istek atılmadı';
    super(429, url, metin);
    this.name = 'GeriCekilmeHatasi';
    this.message = metin;
  }
}

export async function httpJson<T>(url: string, opts: HttpOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const retries = opts.retries ?? 2;

  const host = hostOf(url);
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // İki kontrol: kovada beklemeden ÖNCE (yuva hemen boşalsın) ve SONRA
    // (beklerken başka bir isteğin 429'u host'u kapatmış olabilir).
    kapaliysaFirlat(host, url);
    await (LIMITS[host] ?? DEFAULT_LIMIT).take();
    kapaliysaFirlat(host, url);

    const gonderimNo = ++gonderimSayaci;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers: { accept: 'application/json', ...opts.headers },
        body: opts.body,
        signal: ac.signal,
      });

      if (!res.ok) {
        const snippet = await res.text().catch(() => '');
        // 429: host'u kapat ve TEKRAR DENEME — aynı pencerede yeniden yüklenmek
        // limiti uzatır; sonraki deneme zaten kapanma yüzünden atılmazdı.
        if (res.status === 429) {
          if (host) kaydet429(host, res.headers.get('retry-after'), gonderimNo);
          throw Object.assign(new HttpError(429, url, snippet), { permanent: true });
        }
        // 5xx geçici sayılır ve tekrar denenir; 4xx kalıcıdır, hemen patlat.
        if (res.status >= 500) throw new HttpError(res.status, url, snippet);
        throw Object.assign(new HttpError(res.status, url, snippet), { permanent: true });
      }

      if (host) kaydetBasari(host, gonderimNo);
      return (await res.json()) as T;
    } catch (e) {
      lastErr = e as Error;
      if ((e as { permanent?: boolean }).permanent) throw e;
      if (attempt < retries) {
        const delay = 300 * 2 ** attempt + Math.random() * 200;
        await new Promise((r) => setTimeout(r, delay));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr ?? new Error(`istek başarısız: ${url}`);
}
