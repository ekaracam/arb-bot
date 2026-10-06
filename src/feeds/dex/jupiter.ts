/**
 * Jupiter — Aşama 2 doğrulaması (`swap/v1/quote`).
 *
 * Planın "ucuz geniş tarama → pahalı hedefli doğrulama" deseninin Solana
 * karşılığı iki parçaya bölünmüş durumda:
 *
 *   GENİŞ TARAMA  fiyat kaynağı + [solana-feed.ts](solana-feed.ts) — venue
 *                 başına bir feed (jupiter, raydium).
 *   DOĞRULAMA     burası: gerçek rota, gerçek slippage, gerçek çıktı.
 *                 Yalnızca tarayıcı bir aday bulduğunda çağrılır.
 *
 * Geniş tarama bir ORTA fiyat verir; alım ve satım için ayrı ayrı quote
 * almadan gerçek kâr hesaplanamaz. Bu yüzden feed miktarları 0 bırakır ve DEX
 * bacağı taşıyan her fırsat buradan geçmek zorunda.
 */

import { httpJson, HttpError, hostKovasiniAyarla } from '../../core/http.ts';
import type { JupiterTier } from '../../core/config.ts';

// ---------------------------------------------------------------------------
// Kademe: kova ve dakikalık limit TEK tanımdan türer
// ---------------------------------------------------------------------------
//
// Belge (developers.jup.ag/docs/api-rate-limit): 60 sn kayan pencere.
//   anahtarsız `lite-api` 0.5 rps (30/dk) · Free anahtar 1 rps · Developer 10 rps
//
// ÖLÇÜLEN HATA: kod anahtarsız uçta 60/dk varsayıyordu (kova 1/sn, tarama
// `perMinute = 60`), yani limiti 2× aşıyordu; anahtarlı dal ise Developer
// rakamını (10 rps) her anahtara uyguluyordu — ücretsiz anahtar girilince 429
// daha da kötüleşirdi. Kova (`http.ts`) ile tarama periyodu (`perMinute`) bu
// tablodan türüyor; ikisi ayrı yazılırsa ayrışır (COW_PER_MINUTE dersi).

export type JupiterKademe = 'lite' | 'free' | 'developer';

/**
 * Belgelenen limitin kullanılan payı. Ölçüldü (2026-10-07, Free anahtar):
 * kova TAM 1 rps'teyken 244 quote'un 15'i yine 429 aldı — Jupiter 60 sn'lik
 * kayan pencereyle sayıyor ve ağ gecikmesindeki dalgalanma istekleri
 * pencerede sıkıştırıyor. Limitin tam üstünde koşmak, sınırda koşmaktır.
 */
const JUPITER_GUVENLIK_PAYI = 0.85;

export const JUPITER_KADEMELERI: Readonly<
  Record<JupiterKademe, { readonly host: string; readonly saniyeBasina: number }>
> = {
  lite: { host: 'lite-api.jup.ag', saniyeBasina: 0.5 * JUPITER_GUVENLIK_PAYI },
  free: { host: 'api.jup.ag', saniyeBasina: 1 * JUPITER_GUVENLIK_PAYI },
  developer: { host: 'api.jup.ag', saniyeBasina: 10 * JUPITER_GUVENLIK_PAYI },
};

/**
 * Anahtar yoksa `lite`; varsa config'teki anahtarlı kademe. `JUPITER_TIER`
 * burada OKUNMAZ ve doğrulanmaz — tek kaynak `loadConfig()`
 * (`jupiterTierCoz`). `tier` verilmezse `free` (config'siz araçlar için en dar
 * anahtarlı kademe).
 */
export function jupiterKademesi(
  apiKey: string | null | undefined,
  tier: JupiterTier = 'free',
): JupiterKademe {
  return apiKey ? tier : 'lite';
}

/** Kademenin dakikalık istek limiti — tarama periyodu (`guvenliAralik`) bunu kullanır. */
export function jupiterDakikaLimiti(kademe: JupiterKademe): number {
  return JUPITER_KADEMELERI[kademe].saniyeBasina * 60;
}

/**
 * Kademenin host kovasını kurar ve taban URL'yi döndürür. Patlama
 * `max(1, rps)`: kayan pencerede büyük patlama, pencerenin başında kotayı
 * yakıp sonunda 429 demek. Tarama ve doğrulama aynı host'u kullandığında
 * tek kovayı paylaşırlar (aynı değerle tekrar kurmak kovayı değiştirmez).
 */
export function jupiterKovasiniKur(kademe: JupiterKademe): string {
  const k = JUPITER_KADEMELERI[kademe];
  hostKovasiniAyarla(k.host, k.saniyeBasina, Math.max(1, k.saniyeBasina));
  return `https://${k.host}`;
}

export interface JupiterOptions {
  readonly apiKey?: string | null;
  /** Anahtarlı kademe — `cfg.jupiterTier`. Verilmezse `free`. */
  readonly tier?: JupiterTier;
}

// ---------------------------------------------------------------------------
// Doğrulama katmanı
// ---------------------------------------------------------------------------

interface QuoteResponse {
  inAmount?: string;
  outAmount?: string;
  priceImpactPct?: string;
  routePlan?: unknown[];
  error?: string;
}

export interface DexQuote {
  /** Birim başına gerçekleşen fiyat (quote para birimi cinsinden). */
  readonly price: number;
  /** Girdi miktarı (ham birim). */
  readonly inAmount: number;
  readonly outAmount: number;
  /** Jupiter'in bildirdiği fiyat etkisi (0.01 = %1). */
  readonly priceImpact: number;
  readonly hops: number;
}

/**
 * Gerçek swap fiyatı — tarayıcı yalnızca aday bulduğunda çağırır.
 *
 * Buradaki fiyat, geniş taramanın verdiği orta fiyattan farklıdır ve GERÇEK
 * olan budur: rota, havuz derinliği ve fiyat etkisi dahil. CEX tarafındaki
 * VWAP hesabının DEX karşılığı.
 */
/**
 * Gövde Jupiter'in kendi hata biçiminde mi? (`{"error":…,"errorCode":…}`)
 * Gövde kırpılmış olabileceği için JSON.parse yerine alan adına bakılır;
 * CDN/proxy'nin HTML'i bu kalıba uymaz.
 */
export function jupiterHatasiMi(govde: string): boolean {
  return /"errorCode"\s*:|"error"\s*:/.test(govde);
}

/** Önbellek bu boyutu aşınca süresi dolmuşlar atılır. */
const ONBELLEK_BUDAMA_ESIGI = 2000;

export class DexQuoter {
  private cache = new Map<string, { at: number; quote: DexQuote | null }>();
  private calls = 0;
  private failures = 0;

  private readonly base: string;

  constructor(
    private readonly opts: JupiterOptions = {},
    private readonly ttlMs = 3000,
  ) {
    this.base = jupiterKovasiniKur(jupiterKademesi(opts.apiKey, opts.tier));
  }

  get stats(): { calls: number; failures: number } {
    return { calls: this.calls, failures: this.failures };
  }

  /**
   * @param inputMint  satılan token
   * @param outputMint alınan token
   * @param amount     girdi miktarı, ham birimde (decimals uygulanmış)
   */
  /**
   * Süresi dolmuş girdileri atar. Anahtar `in:out:amount` ve satış miktarı
   * her adayda farklı, yani her doğrulama YENİ girdi ekliyor; budanmazsa
   * uzun koşuda on binlerce girdi birikir (ölçülen tahmin ~86k/gün).
   */
  private budaOnbellek(): void {
    if (this.cache.size < ONBELLEK_BUDAMA_ESIGI) return;
    const simdi = Date.now();
    for (const [k, v] of this.cache) if (simdi - v.at >= this.ttlMs) this.cache.delete(k);
  }

  async quote(
    inputMint: string,
    outputMint: string,
    amount: bigint,
    inDecimals: number,
    outDecimals: number,
  ): Promise<DexQuote | null> {
    this.budaOnbellek();
    const key = `${inputMint}:${outputMint}:${amount}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < this.ttlMs) return cached.quote;

    this.calls++;
    try {
      const url =
        `${this.base}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
        `&amount=${amount}&slippageBps=50&restrictIntermediateTokens=true`;

      const res = await httpJson<QuoteResponse>(url, {
        headers: this.opts.apiKey ? { 'x-api-key': this.opts.apiKey } : {},
        timeoutMs: 6000,
        // Fiyat zamana duyarlı: geç gelen cevapla hesaplanan kâr gerçek değil.
        retries: 0,
      });

      if (res.error || !res.outAmount || !res.inAmount) {
        this.failures++;
        this.cache.set(key, { at: Date.now(), quote: null });
        return null;
      }

      const inHuman = Number(res.inAmount) / 10 ** inDecimals;
      const outHuman = Number(res.outAmount) / 10 ** outDecimals;
      if (!(inHuman > 0) || !(outHuman > 0)) {
        this.failures++;
        return null;
      }

      const quote: DexQuote = {
        price: outHuman / inHuman,
        inAmount: inHuman,
        outAmount: outHuman,
        priceImpact: Number(res.priceImpactPct ?? 0),
        hops: res.routePlan?.length ?? 0,
      };
      this.cache.set(key, { at: Date.now(), quote });
      return quote;
    } catch (e) {
      this.failures++;
      // "Rota yok" Jupiter'in KENDİ cevabıdır: HTTP 400 + `errorCode` alanlı
      // JSON. 429, 5xx ve timeout ise ARIZA — likidite yokluğu gibi
      // raporlanamaz ve önbelleğe de yazılmaz (kota tükenmesi yüzünden tokenı
      // 3 sn kör bırakmanın sebebi yok). Ölçüldü: panel "665 denendi │ 643
      // rota yok" derken o 643'ün neredeyse tamamı HTTP 429'du ve bakan kişi
      // tokenları silmeye yönelirdi. Fırlatılan hata tarayıcıda
      // `dexQuoteError` + `lastDexQuoteError` olarak görünür.
      if (e instanceof HttpError && e.status === 400 && jupiterHatasiMi(e.bodySnippet)) {
        this.cache.set(key, { at: Date.now(), quote: null });
        return null;
      }
      throw e;
    }
  }
}
