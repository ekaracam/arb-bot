/**
 * Solana geniş tarama fiyat kaynakları.
 *
 * NEDEN SEÇENEK VAR: Jupiter'in ücretsiz uç noktası (lite-api) saniyede 1 istek
 * kabul ediyor. 113 mint 3 isteğe bölününce her tarama turu bu kovanın ~3
 * saniyesini yiyor ve Aşama 2'nin `swap/v1/quote` doğrulamalarına yer kalmıyor.
 * Doğrulama, kârı belirleyen aşamadır — onu aç bırakmak kabul edilemez.
 *
 * Çözüm, iki aşamayı FARKLI kaynaklara vermek:
 *   Aşama 1 (geniş tarama)  → GeckoTerminal (ücretsiz, anahtarsız, tam kapsam)
 *   Aşama 2 (doğrulama)     → Jupiter swap/v1/quote (DEĞİŞMEDİ)
 *
 * Bu ayrımın güvenli olmasının sebebi mimaridir: geniş taramadan gelen fiyat
 * hiçbir zaman kâr hesabına girmez, yalnızca hangi çiftin DOĞRULANACAĞINI
 * seçer. Ölçüm — GeckoTerminal fiyatları Jupiter'inkinden medyan %0.10, p90
 * %0.57 sapıyor; `PREFILTER_PCT` (%0.15) eşiğinde bu sapma aday sayısını biraz
 * artırır, Aşama 2 fazlalıkları eler. Ters yön (kaçırma) riski düşüktür.
 *
 * Aynı sapmayla Aşama 2'yi beslemek ise doğrudan yanlış kâr demek olurdu; bu
 * yüzden DexQuoter'a dokunulmadı.
 */

import { httpJson } from '../../core/http.ts';

export interface SolanaPriceSource {
  readonly ad: string;
  /** Tek istekte sorulabilecek azami mint sayısı. */
  readonly chunkSize: number;
  /** Kaynağın dakikada kabul ettiği istek sayısı (ücretsiz kademe). */
  readonly perMinute: number;
  /**
   * Bu limitin ne kadarını geniş tarama kullanabilir (0–1).
   *
   * Kaynak Aşama 2 doğrulamasıyla AYNI host kovasını paylaşıyorsa düşük
   * olmalı: doğrulama kârı belirleyen aşamadır, tarama uğruna aç bırakılamaz.
   * Ayrı host kullanan kaynakta pay yüksek tutulabilir.
   */
  readonly taramaPayi: number;
  /** @returns mint → USD fiyat (yalnızca fiyatı olanlar) */
  fetchPrices(mints: readonly string[]): Promise<Map<string, number>>;
}

/**
 * Tarama periyodu, kaynağın dakikalık limitini aşmayacak biçimde hesaplanır.
 *
 * Sabit bir periyot yazmak kaynak değiştiğinde sessizce 429 yemek demektir:
 * feed açık kalır, fiyatlar bayatlar, panel "live" gösterir. Periyodu limitten
 * TÜRETMEK bu hata sınıfını baştan imkânsız kılıyor.
 *
 * @param chunkCount tur başına istek sayısı
 * @param perMinute  kaynağın dakikalık istek limiti
 * @param tabanMs    istenen periyot (limit izin veriyorsa bu kullanılır)
 */
export function guvenliAralik(
  chunkCount: number,
  perMinute: number,
  tabanMs: number,
  pay = 0.8,
): number {
  if (chunkCount <= 0 || perMinute <= 0 || pay <= 0) return tabanMs;
  const gerekenMs = Math.ceil((chunkCount * 60_000) / (perMinute * pay));
  return Math.max(tabanMs, gerekenMs);
}

// ---------------------------------------------------------------------------

/** Jupiter price/v3 — varsayılan. Anahtar varsa pro uç noktası kullanılır. */
export class JupiterPriceSource implements SolanaPriceSource {
  readonly ad = 'jupiter';
  readonly chunkSize = 40;

  constructor(private readonly apiKey: string | null = null) {}

  get perMinute(): number {
    // lite-api: 1/sn. Anahtarlı uç nokta belirgin biçimde yüksek.
    return this.apiKey ? 600 : 60;
  }

  /**
   * Aşama 2 doğrulaması (`swap/v1/quote`) AYNI host kovasını kullanıyor.
   * Ölçülen sorun buydu: 113 mint 5 sn'de bir taranınca kovanın ~60'ı taramaya
   * gidiyor, doğrulama kuyruğu 40'ta sabitleniyor ve 28 binden fazla aday
   * doğrulanamadan atılıyordu. Taramaya küçük bir pay verip kalanı doğrulamaya
   * bırakmak, ücretsiz kademede tek doğru bölüşüm.
   */
  readonly taramaPayi = 0.35;

  async fetchPrices(mints: readonly string[]): Promise<Map<string, number>> {
    const base = this.apiKey ? 'https://api.jup.ag' : 'https://lite-api.jup.ag';
    const out = new Map<string, number>();

    for (let i = 0; i < mints.length; i += this.chunkSize) {
      const ids = mints.slice(i, i + this.chunkSize).join(',');
      const res = await httpJson<Record<string, { usdPrice?: number } | undefined>>(
        `${base}/price/v3?ids=${ids}`,
        {
          headers: this.apiKey ? { 'x-api-key': this.apiKey } : {},
          timeoutMs: 8000,
          retries: 1,
        },
      );
      for (const [mint, v] of Object.entries(res)) {
        const p = v?.usdPrice ?? 0;
        if (p > 0) out.set(mint, p);
      }
    }
    return out;
  }
}

/**
 * GeckoTerminal — ücretsiz ve anahtarsız.
 *
 * Kapsam iyi: 113 mint için 4 istek, Jupiter'in fiyatladığı her mint burada da
 * fiyatlı. (DexScreener elendi: toplu uç noktası istek başına 30 HAVUZ
 * döndürdüğü için aynı mint sayısında yarı kapsam veriyor — 62/113.)
 *
 * AMA SÜREKLİ KULLANIMDA DAYANMIYOR. Ölçüldü: dakikada ~24 istekle 6 turun
 * altısı da HTTP 429 aldı. Belgelenen 30/dk sınırı soğuk bir seri için geçerli;
 * sürekli yükte gerçek sınır belirgin biçimde daha düşük. Bu yüzden `perMinute`
 * belgeye değil ÖLÇÜME göre 10 yazıldı — 113 mint'te bu ~30 sn'lik tarama
 * periyodu demek.
 *
 * Sonuç: varsayılan Jupiter'dir. Bu kaynak, Jupiter kovasını tamamen
 * doğrulamaya bırakmak istendiğinde ve token sayısı düşükken anlamlıdır.
 */
export class GeckoTerminalPriceSource implements SolanaPriceSource {
  readonly ad = 'geckoterminal';
  /** Uç noktanın adres sınırı. */
  readonly chunkSize = 30;
  /** Belgelenen değil ÖLÇÜLEN sınır (belge 30 diyor, 24'te 429 alındı). */
  readonly perMinute = 10;
  /** Aşama 2 ile host paylaşmıyor: limitin tamamı taramanın. */
  readonly taramaPayi = 0.8;

  async fetchPrices(mints: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();

    for (let i = 0; i < mints.length; i += this.chunkSize) {
      const ids = mints.slice(i, i + this.chunkSize).join(',');
      const res = await httpJson<{
        data?: { attributes?: { token_prices?: Record<string, string> } };
      }>(`https://api.geckoterminal.com/api/v2/simple/networks/solana/token_price/${ids}`, {
        headers: { accept: 'application/json' },
        timeoutMs: 10_000,
        retries: 1,
      });

      for (const [mint, ham] of Object.entries(res.data?.attributes?.token_prices ?? {})) {
        const p = Number(ham);
        if (p > 0) out.set(mint, p);
      }
    }
    return out;
  }
}

export type SolanaPriceSourceId = 'jupiter' | 'geckoterminal';

export function createSolanaPriceSource(
  id: SolanaPriceSourceId,
  apiKey: string | null,
): SolanaPriceSource {
  return id === 'geckoterminal'
    ? new GeckoTerminalPriceSource()
    : new JupiterPriceSource(apiKey);
}
