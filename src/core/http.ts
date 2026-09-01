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
    private readonly capacity: number,
    private readonly refillPerSec: number,
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
  'lite-api.jup.ag': new TokenBucket(2, 1),
  'api.jup.ag': new TokenBucket(10, 5),
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

function bucketFor(url: string): TokenBucket {
  try {
    return LIMITS[new URL(url).host] ?? DEFAULT_LIMIT;
  } catch {
    return DEFAULT_LIMIT;
  }
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

export async function httpJson<T>(url: string, opts: HttpOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const retries = opts.retries ?? 2;

  let lastErr: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    await bucketFor(url).take();

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
        // 429/5xx geçici sayılır ve tekrar denenir; 4xx kalıcıdır, hemen patlat.
        if (res.status === 429 || res.status >= 500) {
          throw new HttpError(res.status, url, snippet);
        }
        throw Object.assign(new HttpError(res.status, url, snippet), { permanent: true });
      }

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
