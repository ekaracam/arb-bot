/**
 * Raydium — Solana'da İKİNCİ bir DEX venue'sü (Jupiter'in yedeği DEĞİL).
 *
 * Jupiter bir TOPLAYICI: rotayı o kuruyor ve fiyatı tüm havuzların en iyisinden
 * veriyor. Raydium ise gerçek bir AMM — kendi havuzlarında ne varsa onu
 * söylüyor. İkisi ayrı venue olduğu için tarayıcı `raydium↔jupiter` çiftini de
 * görüyor; bu aynı zincirde olduğu için `pickChain` transfer maliyeti çıkarmaz
 * (bkz. DEX→DEX dalı) ve gerçekten uygulanabilir bir rota olur.
 *
 * İKİ AYRI HOST kullanması mimari olarak asıl kazanç:
 *
 *   Aşama 1 (geniş tarama)  api-v3.raydium.io/mint/price
 *   Aşama 2 (doğrulama)     transaction-v1.raydium.io/compute/swap-base-in
 *
 * Jupiter'de ikisi de `lite-api.jup.ag` üzerinde ve ölçülen sonuç, taramanın
 * doğrulamayı aç bırakmasıydı (`JupiterPriceSource.taramaPayi = 0.35`).
 * Raydium'da böyle bir çekişme yok: iki kova ayrı.
 *
 * ÖLÇÜLEN SINIR — Aşama 1 fiyatı GÜVENİLMEZ, Aşama 2 quote'u güvenilir.
 * 138 mint'te `mint/price` kapsamı 108/138 ve Jupiter'e sapması medyan %0.24,
 * p90 %25, **max %2577**. Sebep basit: bu uç, toplayıcı rotası değil tek
 * havuzun orta fiyatı. Bu, mimarinin zaten kabul ettiği bir durum — Aşama 1
 * fiyatı kâr hesabına HİÇ girmez, yalnızca hangi çiftin doğrulanacağını
 * seçer — ama bedeli sıfır değil: bozuk fiyat kuyruk kapasitesi yakar.
 * Aşama 2 (`compute/swap-base-in`) gerçek çıktı miktarını ve fiyat etkisini
 * döndürdüğü için bozuk havuz orada elenir.
 */

import { httpJson, HttpError } from '../../core/http.ts';
import type { SolanaPriceSource } from './solana-price.ts';

const PRICE_HOST = 'https://api-v3.raydium.io';
const QUOTE_HOST = 'https://transaction-v1.raydium.io';

/** Aşama 1 — toplu orta fiyat. */
export class RaydiumPriceSource implements SolanaPriceSource {
  readonly ad = 'raydium';
  /** Ölçüldü: 138 mint 50'lik parçalarla 3 istekte, 1.2 sn, 0 hata. */
  readonly chunkSize = 50;
  /**
   * Belgelenmiş bir limit yok. Kova (`core/http.ts`) 2/sn, yani 120/dk; buraya
   * onun yarısı yazıldı. Geckoterminal dersi: limit belgede yazmıyorsa ve tek
   * atışlık ölçümde görünmüyorsa, yine de vardır.
   */
  readonly perMinute = 60;
  /** Aşama 2 AYRI host kullanıyor — limitin tamamı taramanın olabilir. */
  readonly taramaPayi = 0.8;

  async fetchPrices(mints: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();

    for (let i = 0; i < mints.length; i += this.chunkSize) {
      const ids = mints.slice(i, i + this.chunkSize).join(',');
      const res = await httpJson<{
        success?: boolean;
        data?: Record<string, string | number | null>;
      }>(`${PRICE_HOST}/mint/price?mints=${ids}`, { timeoutMs: 8000, retries: 1 });

      for (const [mint, ham] of Object.entries(res.data ?? {})) {
        // `null` = "bu mint için fiyat yok" — hata değil, veri. Ayırt etmemek
        // rotasız tokenı arıza gibi gösterirdi.
        if (ham === null) continue;
        const p = Number(ham);
        if (p > 0) out.set(mint, p);
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Aşama 2 — gerçek quote
// ---------------------------------------------------------------------------

/**
 * `compute/swap-base-in` — gerçekleşecek çıktı miktarı.
 *
 * CoW gibi, Jupiter'in `swap/v1/quote`'u gibi: dönen sayı ORTA FİYAT DEĞİL,
 * havuz ücreti ve fiyat etkisi dahil gerçekten alınacak miktar. Bu yüzden
 * tarayıcı bunu doğrudan VWAP yerine koyabiliyor.
 */
/**
 * Cevap gövdesi Raydium'un KENDİ hata biçimi mi, yoksa önündeki katmanın
 * HTML'i mi? (`cowHatasiMi` ile aynı ders, farklı sağlayıcıda.)
 *
 * Raydium gerçek cevabı JSON verir ve `success` alanı taşır. Gövde HTML ise
 * konuştuğumuz şey Raydium değil önündeki WAF'tır ve bu bir ARIZADIR — "rota
 * yok" ile aynı kovaya konursa altyapı bloğu likidite yokluğu gibi
 * raporlanır.
 */
export function raydiumHatasiMi(govde: string): boolean {
  try {
    const j = JSON.parse(govde) as { success?: unknown };
    return typeof j.success === 'boolean';
  } catch {
    return false;
  }
}

/** Blok sonrası ilk bekleme ve tavan. */
const GERI_CEKILME_MS = 30_000;
const GERI_CEKILME_TAVAN_MS = 15 * 60_000;
/** Bu kadar ARDIŞIK arıza sonrası geri çekilme başlar. */
const ARIZA_TOLERANSI = 3;

export interface RaydiumQuote {
  /** Çıktı miktarı, ham birimde. */
  readonly out: number;
  /** Fiyat etkisi oran olarak (0.01 = %1); uç nokta vermezse null. */
  readonly etkiPct: number | null;
}

export class RaydiumQuoter {
  private readonly cache = new Map<string, { at: number; sonuc: RaydiumQuote | null }>();
  private calls = 0;
  private failures = 0;

  // --- Üstel geri çekilme -------------------------------------------------
  //
  // ÖLÇÜLEN HATA: bloklu uca yüklenmeye devam etmek bloğu UZATIYOR. Bu, CoW'da
  // ölçülmüş kendi kendini besleyen tuzağın aynısı — WAF kararını SÜREGELEN
  // yüke göre veriyor. Aşama 2 kuyruğu doymuş olduğu için hiçbir doğal fren
  // yok: quoter'ın kendisi frenlemezse bot dakikada 120 istekle bloklu uca
  // yüklenmeye devam eder (canlı koşuda tam olarak bu oldu).
  //
  // Tavan SONLU olmak zorunda: blok geçici ve quoter'ın insan müdahalesi
  // olmadan geri dönebilmesi gerekiyor.
  private ardisikAriza = 0;
  private bloklandiUntil = 0;
  private bekleme = GERI_CEKILME_MS;
  private sonHata: string | null = null;

  constructor(private readonly ttlMs = 3000) {}

  get stats(): {
    calls: number;
    failures: number;
    /** Geri çekilme bitene kadar kalan süre (ms); 0 = açık. */
    bloklu: number;
    sonHata: string | null;
  } {
    return {
      calls: this.calls,
      failures: this.failures,
      bloklu: Math.max(0, this.bloklandiUntil - Date.now()),
      sonHata: this.sonHata,
    };
  }

  /**
   * @param amount girdi miktarı, ham birimde
   * @returns çıktı miktarı ve fiyat etkisi, rota yoksa null
   */
  async quote(
    inputMint: string,
    outputMint: string,
    amount: bigint,
  ): Promise<RaydiumQuote | null> {
    const key = `${inputMint}:${outputMint}:${amount}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < this.ttlMs) return cached.sonuc;

    // Geri çekilme penceresindeyken istek ATILMAZ. Bloklu uca yüklenmek bloğu
    // uzatıyor; ayrıca sonuç önbelleğe de yazılmaz (arıza geçici, tokenı
    // kalıcı olarak kör bırakmamalı).
    if (Date.now() < this.bloklandiUntil) return null;

    this.calls++;
    let res: {
      success?: boolean;
      msg?: string;
      data?: { outputAmount?: string; priceImpactPct?: number | string } | null;
    };
    try {
      res = await httpJson(
        `${QUOTE_HOST}/compute/swap-base-in?inputMint=${inputMint}&outputMint=${outputMint}` +
          `&amount=${amount}&slippageBps=50&txVersion=V0`,
        {
          timeoutMs: 8000,
          // Fiyat zamana duyarlı: geç gelen cevapla hesaplanan kâr gerçek değil.
          retries: 0,
        },
      );
    } catch (e) {
      this.failures++;
      // Gövde Raydium'un kendi JSON'u ise bu bir VERİ cevabıdır (rota yok);
      // HTML ise önündeki WAF konuşuyor ve bu ARIZADIR.
      const arizaMi = !(e instanceof HttpError) || !raydiumHatasiMi(e.bodySnippet);
      this.sonHata = (e as Error).message.slice(0, 120);
      if (arizaMi) {
        this.ardisikAriza++;
        if (this.ardisikAriza >= ARIZA_TOLERANSI) {
          this.bloklandiUntil = Date.now() + this.bekleme;
          this.bekleme = Math.min(this.bekleme * 2, GERI_CEKILME_TAVAN_MS);
        }
        throw e;
      }
      this.cache.set(key, { at: Date.now(), sonuc: null });
      return null;
    }

    // Buraya gelindiyse uç nokta konuşuyor: geri çekilme sıfırlanır.
    this.ardisikAriza = 0;
    this.bekleme = GERI_CEKILME_MS;
    this.bloklandiUntil = 0;

    // `success:false` Raydium'un KENDİ "rota yok" cevabı — arıza değil veri.
    const ham = res.success === false ? null : (res.data?.outputAmount ?? null);
    const v = ham === null ? null : Number(ham);
    // `priceImpactPct` YÜZDE olarak geliyor (2.47 = %2.47), oran olarak değil.
    const etkiHam = Number(res.data?.priceImpactPct ?? Number.NaN);
    const sonuc: RaydiumQuote | null =
      v !== null && Number.isFinite(v) && v > 0
        ? { out: v, etkiPct: Number.isFinite(etkiHam) ? etkiHam / 100 : null }
        : null;
    if (sonuc === null) this.failures++;
    this.cache.set(key, { at: Date.now(), sonuc });
    return sonuc;
  }
}
