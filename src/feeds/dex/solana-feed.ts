/**
 * Solana geniş tarama feed'i — venue BAŞINA bir örnek.
 *
 * DEX'lerde WebSocket push yok, o yüzden burası pull tabanlı. Sınıf tek bir
 * venue'ya bağlı DEĞİL: `jupiter` (toplayıcı) ve `raydium` (tek AMM) aynı
 * kodu, farklı `SolanaPriceSource` ile kullanıyor. Ayrı ayrı yazılsalardı
 * periyot türetme, bayatlık ve sağlık raporlaması iki yerde yaşar ve biri
 * güncellenip diğeri unutulurdu.
 *
 * Kaynak ne olursa olsun buradan çıkan fiyat bir ORTA fiyattır: bid=ask
 * yazılır ve MİKTARLAR 0 BIRAKILIR. Tarayıcı bunu "L1 derinliği yok, doğrula"
 * olarak okuyup Aşama 2'ye gider — yani geniş taramanın fiyatı hiçbir zaman
 * kâr hesabına girmez. Venue'ya göre doğrulayıcı seçimi
 * [leg-quoter.ts](leg-quoter.ts) içinde.
 */

import type { PriceStore } from '../../book/price-store.ts';
import type {
  ChainId,
  DexId,
  Feed,
  FeedHealth,
  FeedState,
  PairKey,
} from '../../core/types.ts';
import { RateCounter } from '../../core/metrics.ts';
import { guvenliAralik, type SolanaPriceSource } from './solana-price.ts';

export interface SolanaFeedOptions {
  readonly venue: DexId;
  /** Aşama 1'in fiyat kaynağı — venue'yu belirleyen şey budur. */
  readonly priceSource: SolanaPriceSource;
  /** Geniş tarama periyodu (ms). Kaynağın limiti gerektirirse uzatılır. */
  readonly pollIntervalMs?: number;
}

export interface SolanaToken {
  readonly symbol: string;
  readonly mint: string;
  readonly decimals: number;
  readonly pair: PairKey;
  /** PriceStore satırı. */
  readonly slot: number;
}

export interface JupiterOptions {
  readonly apiKey?: string | null;
  /** Geniş tarama periyodu (ms). Kaynağın limiti gerektirirse uzatılır. */
  readonly pollIntervalMs?: number;
  /**
   * Aşama 1'in fiyat kaynağı. Verilmezse Jupiter kullanılır.
   * Aşama 2 (DexQuoter) HER ZAMAN Jupiter'dir — bkz. solana-price.ts.
   */
  readonly priceSource?: SolanaPriceSource;
}

export class SolanaMidFeed implements Feed {
  readonly venue: DexId;
  readonly chain: ChainId = 'solana';

  private timer: NodeJS.Timeout | null = null;
  private state: FeedState = 'idle';
  private lastTickTs = 0;
  private lastError: string | null = null;
  private errorCount = 0;
  private readonly rate = new RateCounter();

  private readonly source: SolanaPriceSource;

  constructor(
    private readonly store: PriceStore,
    private readonly tokens: readonly SolanaToken[],
    private readonly opts: SolanaFeedOptions,
  ) {
    this.venue = opts.venue;
    this.source = opts.priceSource;
  }

  /** Aşama 1'i besleyen kaynağın adı — sağlık panelinde gösterilir. */
  get priceSourceName(): string {
    return this.source.ad;
  }

  async start(): Promise<void> {
    if (this.tokens.length === 0) {
      this.state = 'idle';
      this.lastError = 'taranacak Solana token yok (config/tokens.json)';
      return;
    }

    this.state = 'connecting';
    await this.poll();

    // Periyot kaynağın limitinden TÜRETİLİYOR, sabit değil: token listesi
    // büyüdükçe tur başına istek sayısı artıyor ve sabit periyot sessizce 429
    // yemeye başlıyor (feed açık kalır, fiyat bayatlar, panel "live" der).
    // DEX fiyatları blok hızında (~400 ms) değişse de daha sık çekmenin
    // pratik faydası sınırlı, o yüzden taban 5 sn.
    const chunks = Math.ceil(this.tokens.length / this.source.chunkSize);
    const interval = guvenliAralik(
      chunks,
      this.source.perMinute,
      this.opts.pollIntervalMs ?? 5000,
      this.source.taramaPayi,
    );
    this.timer = setInterval(() => void this.poll(), interval);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.state = 'idle';
  }

  private async poll(): Promise<void> {
    try {
      const fiyatlar = await this.source.fetchPrices(this.tokens.map((t) => t.mint));

      const now = Date.now();
      let written = 0;

      for (const t of this.tokens) {
        const price = fiyatlar.get(t.mint);
        if (!price || !(price > 0)) continue;

        // Geniş tarama tek fiyat verir: bid=ask. Gerçek alım/satım farkı
        // yalnızca quote çağrısıyla öğrenilir, bu yüzden buradaki miktarları
        // 0 bırakıyoruz — tarayıcı bunu "L1 derinliği yok, doğrula" olarak
        // okuyup DexQuoter'a gidiyor.
        this.store.write(t.slot, price, 0, price, 0, now, now);
        written++;
      }

      this.rate.tick(now);
      this.lastTickTs = now;
      this.state = written > 0 ? 'live' : 'failed';
      if (written === 0) {
        this.lastError = `${this.source.ad}: hiçbir token için fiyat döndürmedi`;
      } else {
        this.lastError = null;
      }
    } catch (e) {
      this.errorCount++;
      this.lastError = (e as Error).message;
      // Tek bir hatalı tur feed'i öldürmez; bir sonraki turda tekrar denenir.
      if (this.state !== 'live') this.state = 'failed';
    }
  }

  health(): FeedHealth {
    const now = Date.now();
    return {
      venue: this.venue,
      state: this.state,
      lastTickAgeMs: this.lastTickTs === 0 ? -1 : now - this.lastTickTs,
      msgsPerSec: this.rate.perSec(now),
      reconnects: this.errorCount,
      latencyP50: 0,
      latencyP99: 0,
      clockSkewMs: 0,
      subscribedCount: this.tokens.length,
      lastError: this.lastError,
    };
  }
}
