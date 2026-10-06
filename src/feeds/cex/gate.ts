/**
 * Gate.io v4 spot — spot.book_ticker.
 *
 * Gate en iyi bid/ask'i doğrudan tek kanalda verir (delta birleştirme derdi yok).
 * Fiyatlar string, miktarlar bazen number gelir — ikisini de sayıya zorluyoruz.
 */

import type WebSocket from 'ws';
import { BaseCexFeed, type BaseFeedOptions, type FeedMarket } from './base-feed.ts';
import type { PriceStore } from '../../book/price-store.ts';
import type { CexId } from '../../core/types.ts';

interface GateMsg {
  channel?: string;
  event?: 'update' | 'subscribe' | 'unsubscribe';
  error?: { code: number; message: string } | null;
  result?: {
    t?: number;
    s?: string;
    b?: string | number;
    B?: string | number;
    a?: string | number;
    A?: string | number;
    status?: string;
  };
}

/** Gate tek payload'da çok sembol kabul eder ama mesajı makul tutuyoruz. */
const SYMS_PER_MSG = 100;

export class GateFeed extends BaseCexFeed {
  readonly venue: CexId = 'gate';
  private readonly symbols: string[];

  constructor(store: PriceStore, markets: readonly FeedMarket[], opts: BaseFeedOptions = {}) {
    super(store, markets, { staleTimeoutMs: 30_000, pingIntervalMs: 20_000, ...opts });
    this.symbols = markets.map((m) => m.venueSymbol);
  }

  protected async endpoint(): Promise<string> {
    return 'wss://api.gateio.ws/ws/v4/';
  }

  protected *subscribeMessages(): Iterable<string> {
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < this.symbols.length; i += SYMS_PER_MSG) {
      yield JSON.stringify({
        time: now,
        channel: 'spot.book_ticker',
        event: 'subscribe',
        payload: this.symbols.slice(i, i + SYMS_PER_MSG),
      });
    }
  }

  protected override pingMessage(): string {
    return JSON.stringify({
      time: Math.floor(Date.now() / 1000),
      channel: 'spot.ping',
    });
  }

  protected handleMessage(data: WebSocket.RawData, recvTs: number): void {
    const msg = JSON.parse(data.toString()) as GateMsg;

    if (msg.error) {
      throw new Error(`Gate hata ${msg.error.code}: ${msg.error.message}`);
    }
    if (msg.event !== 'update' || msg.channel !== 'spot.book_ticker') return;

    const r = msg.result;
    if (!r?.s) return;

    const slot = this.slots.get(r.s);
    if (slot === undefined) return;

    const exchangeTs = r.t ?? 0;
    if (exchangeTs > 0) this.recordLatency(exchangeTs, recvTs);

    this.store.write(slot, +(r.b ?? 0), +(r.B ?? 0), +(r.a ?? 0), +(r.A ?? 0), exchangeTs, recvTs);
    this.markData(recvTs);
  }
}
