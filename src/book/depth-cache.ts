/**
 * L2 derinlik snapshot'ları (REST).
 *
 * İki aşamalı taramanın pahalı yarısı. Yalnızca L1 ön-filtresini geçen çiftler
 * için çağrılır — her tick'te derinlik çekmek hem rate-limit yer hem de
 * gereksiz gecikme ekler.
 *
 * Snapshot'lar kısa süreli önbelleğe alınır: aynı fırsat art arda birkaç kez
 * tetiklendiğinde borsayı tekrar tekrar sorgulamayız.
 */

import { httpJson } from '../core/http.ts';
import type { CexId, DepthLevel, DepthSnapshot, PairKey } from '../core/types.ts';

type RawLevels = [string, string][];

interface DepthFetcher {
  url(symbol: string, limit: number): string;
  parse(body: unknown): { bids: RawLevels; asks: RawLevels } | null;
}

const FETCHERS: Record<CexId, DepthFetcher> = {
  binance: {
    url: (s, n) => `https://api.binance.com/api/v3/depth?symbol=${s}&limit=${n}`,
    parse: (b) => b as { bids: RawLevels; asks: RawLevels },
  },
  bybit: {
    url: (s, n) =>
      `https://api.bybit.com/v5/market/orderbook?category=spot&symbol=${s}&limit=${n}`,
    parse: (b) => {
      const r = (b as { result?: { b?: RawLevels; a?: RawLevels } }).result;
      return r?.b && r.a ? { bids: r.b, asks: r.a } : null;
    },
  },
  okx: {
    url: (s, n) => `https://www.okx.com/api/v5/market/books?instId=${s}&sz=${n}`,
    parse: (b) => {
      const d = (b as { data?: { bids?: RawLevels; asks?: RawLevels }[] }).data?.[0];
      return d?.bids && d.asks ? { bids: d.bids, asks: d.asks } : null;
    },
  },
  gate: {
    url: (s, n) =>
      `https://api.gateio.ws/api/v4/spot/order_book?currency_pair=${s}&limit=${n}`,
    parse: (b) => b as { bids: RawLevels; asks: RawLevels },
  },
  mexc: {
    url: (s, n) => `https://api.mexc.com/api/v3/depth?symbol=${s}&limit=${n}`,
    parse: (b) => b as { bids: RawLevels; asks: RawLevels },
  },
  kraken: {
    // Sembol "BTC/USDT" biçiminde ve eğik çizgi URL'de kodlanmalı. Kraken
    // cevabı çift adıyla anahtarlanmış bir nesne olarak döndürüyor; anahtarın
    // gönderdiğimizle birebir aynı olduğuna GÜVENMİYORUZ (v1 döneminden kalma
    // ad normalizasyonu var), ilk değeri alıyoruz — istek tek çift içeriyor.
    url: (s, n) => `https://api.kraken.com/0/public/Depth?pair=${encodeURIComponent(s)}&count=${n}`,
    parse: (b) => {
      const r = (b as { result?: Record<string, { bids?: RawLevels; asks?: RawLevels }> }).result;
      const first = r ? Object.values(r)[0] : undefined;
      // Kraken seviyeleri [fiyat, miktar, zaman] üçlüsü — üçüncü alan
      // toLevels tarafından zaten yok sayılıyor.
      return first?.bids && first.asks ? { bids: first.bids, asks: first.asks } : null;
    },
  },
  kucoin: {
    url: (s) => `https://api.kucoin.com/api/v1/market/orderbook/level2_20?symbol=${s}`,
    parse: (b) => {
      const d = (b as { data?: { bids?: RawLevels; asks?: RawLevels } }).data;
      return d?.bids && d.asks ? { bids: d.bids, asks: d.asks } : null;
    },
  },
};

function toLevels(raw: RawLevels): DepthLevel[] {
  const out: DepthLevel[] = [];
  for (let i = 0; i < raw.length; i++) {
    const p = Number(raw[i]![0]);
    const q = Number(raw[i]![1]);
    if (p > 0 && q > 0) out.push([p, q]);
  }
  return out;
}

interface CacheEntry {
  snapshot: DepthSnapshot;
  /** Aynı anda birden fazla istek gitmesin diye uçuşta olan çağrı. */
  inflight: Promise<DepthSnapshot | null> | null;
}

export interface DepthCacheOptions {
  /** Snapshot bu süreden eskiyse yeniden çekilir (ms). */
  readonly ttlMs?: number;
  readonly levels?: number;
}

export class DepthCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly levels: number;
  private hits = 0;
  private misses = 0;
  private errors = 0;

  constructor(opts: DepthCacheOptions = {}) {
    // Derinlik hızla değişir; 2 saniyeden eski snapshot'a güvenmeyiz.
    this.ttlMs = opts.ttlMs ?? 2000;
    this.levels = opts.levels ?? 20;
  }

  get stats(): { hits: number; misses: number; errors: number } {
    return { hits: this.hits, misses: this.misses, errors: this.errors };
  }

  async get(
    venue: CexId,
    pair: PairKey,
    venueSymbol: string,
  ): Promise<DepthSnapshot | null> {
    const key = `${venue}:${venueSymbol}`;
    const now = Date.now();
    const entry = this.cache.get(key);

    if (entry && now - entry.snapshot.ts < this.ttlMs) {
      this.hits++;
      return entry.snapshot;
    }
    // Aynı sembol için zaten bir istek uçuyorsa ona bağlan.
    if (entry?.inflight) {
      this.hits++;
      return entry.inflight;
    }

    this.misses++;
    const promise = this.fetch(venue, pair, venueSymbol);

    this.cache.set(key, {
      snapshot: entry?.snapshot ?? { venue, pair, bids: [], asks: [], ts: 0 },
      inflight: promise,
    });

    const result = await promise;
    const current = this.cache.get(key);
    if (current) {
      current.inflight = null;
      if (result) current.snapshot = result;
    }
    return result;
  }

  private async fetch(
    venue: CexId,
    pair: PairKey,
    venueSymbol: string,
  ): Promise<DepthSnapshot | null> {
    const f = FETCHERS[venue];
    try {
      const body = await httpJson<unknown>(f.url(venueSymbol, this.levels), {
        timeoutMs: 4000,
        // Derinlik zamana duyarlı: yeniden denemek yerine fırsatı atlamak
        // daha doğru, çünkü geç gelen cevapla hesaplanan kâr gerçek değil.
        retries: 0,
      });
      const parsed = f.parse(body);
      if (!parsed) return null;

      return {
        venue,
        pair,
        bids: toLevels(parsed.bids),
        asks: toLevels(parsed.asks),
        ts: Date.now(),
      };
    } catch {
      this.errors++;
      return null;
    }
  }
}
