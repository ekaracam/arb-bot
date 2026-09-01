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

import { httpJson } from '../../core/http.ts';

/** API anahtarı yoksa ücretsiz uç nokta (daha sıkı rate limit). */
const LITE = 'https://lite-api.jup.ag';
const PRO = 'https://api.jup.ag';

export interface JupiterOptions {
  readonly apiKey?: string | null;
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
export class DexQuoter {
  private cache = new Map<string, { at: number; quote: DexQuote | null }>();
  private calls = 0;
  private failures = 0;

  constructor(
    private readonly opts: JupiterOptions = {},
    private readonly ttlMs = 3000,
  ) {}

  get stats(): { calls: number; failures: number } {
    return { calls: this.calls, failures: this.failures };
  }

  private get base(): string {
    return this.opts.apiKey ? PRO : LITE;
  }

  /**
   * @param inputMint  satılan token
   * @param outputMint alınan token
   * @param amount     girdi miktarı, ham birimde (decimals uygulanmış)
   */
  async quote(
    inputMint: string,
    outputMint: string,
    amount: bigint,
    inDecimals: number,
    outDecimals: number,
  ): Promise<DexQuote | null> {
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
    } catch {
      this.failures++;
      this.cache.set(key, { at: Date.now(), quote: null });
      return null;
    }
  }
}
