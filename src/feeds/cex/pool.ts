/**
 * Çok bağlantılı feed havuzu.
 *
 * Bazı borsalar bağlantı başına abonelik sayısını sınırlar ve bu sınırı aşınca
 * SESSİZCE davranır: bağlantı açık kalır, fazla semboller hiç veri almaz.
 * Canlı testte ikisini de gördük —
 *   MEXC   : bağlantı başına 30 abonelik (dokümante)
 *   KuCoin : ~300 sembolde tıkanıyor, fazlası için 509 dönüyor
 *
 * Havuz, sembolleri parçalara bölüp her parça için ayrı bir bağlantı açar ve
 * hepsinin sağlığını tek bir görünümde toplar. Dışarıdan bakınca sıradan bir
 * Feed'dir.
 */

import type { BaseCexFeed } from './base-feed.ts';
import type { CexId, Feed, FeedHealth, FeedState } from '../../core/types.ts';

/** Sağlık durumlarını birleştirirken "en kötüsü" kazanır. */
const STATE_SEVERITY: Record<FeedState, number> = {
  live: 0,
  connecting: 1,
  reconnecting: 2,
  idle: 3,
  failed: 4,
};

export class FeedPool implements Feed {
  constructor(
    readonly venue: CexId,
    private readonly connections: readonly BaseCexFeed[],
    /** Bağlantıları açarken aralarındaki bekleme (ms). */
    private readonly startDelayMs = 150,
  ) {}

  get connectionCount(): number {
    return this.connections.length;
  }

  async start(): Promise<void> {
    // Hepsini aynı anda açmak el sıkışma fırtınası yaratır ve borsalar bunu
    // rate-limit sayabilir.
    for (const c of this.connections) {
      await c.start();
      if (this.startDelayMs > 0) {
        await new Promise((r) => setTimeout(r, this.startDelayMs));
      }
    }
  }

  async stop(): Promise<void> {
    await Promise.all(this.connections.map((c) => c.stop()));
  }

  health(): FeedHealth {
    if (this.connections.length === 0) {
      return {
        venue: this.venue,
        state: 'idle',
        lastTickAgeMs: -1,
        msgsPerSec: 0,
        reconnects: 0,
        latencyP50: 0,
        latencyP99: 0,
        clockSkewMs: 0,
        subscribedCount: 0,
        lastError: null,
      };
    }

    const parts = this.connections.map((c) => c.health());

    let worst = parts[0]!.state;
    let msgsPerSec = 0;
    let reconnects = 0;
    let subscribedCount = 0;
    let p50Sum = 0;
    let p99Max = 0;
    let lastError: string | null = null;
    // Havuzun tazeliği en BAYAT bağlantı kadardır: biri susmuşsa o sembollerin
    // fiyatları eskiyor demektir ve bunu ortalamayla gizlemek istemiyoruz.
    let worstAge = -1;

    for (const h of parts) {
      if (STATE_SEVERITY[h.state] > STATE_SEVERITY[worst]) worst = h.state;
      msgsPerSec += h.msgsPerSec;
      reconnects += h.reconnects;
      subscribedCount += h.subscribedCount;
      p50Sum += h.latencyP50;
      if (h.latencyP99 > p99Max) p99Max = h.latencyP99;
      if (h.lastError) lastError = h.lastError;
      if (h.lastTickAgeMs > worstAge) worstAge = h.lastTickAgeMs;
    }

    return {
      venue: this.venue,
      state: worst,
      lastTickAgeMs: worstAge,
      msgsPerSec,
      reconnects,
      latencyP50: p50Sum / parts.length,
      latencyP99: p99Max,
      clockSkewMs: this.connections[0]!.clockSkewMs,
      subscribedCount,
      lastError,
    };
  }
}

/** Diziyi sabit boyutlu parçalara böler. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
