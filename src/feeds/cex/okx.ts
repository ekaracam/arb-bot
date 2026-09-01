/**
 * OKX v5 spot — bbo-tbt (tick-by-tick best bid/offer).
 *
 * `tickers` yerine `bbo-tbt` seçildi: ikincisi her defter değişiminde push
 * ederken tickers 100ms'de bir toplulaştırır. Arbitraj için o 100ms fark eder.
 *
 * OKX 30 saniye içinde veri gitmezse bağlantıyı kapatır; sessiz dönemlerde
 * canlı kalmak için düz "ping" metni göndeririz (JSON değil — protokol böyle).
 */

import type WebSocket from 'ws';
import { BaseCexFeed, type BaseFeedOptions, type FeedMarket } from './base-feed.ts';
import type { PriceStore } from '../../book/price-store.ts';
import type { CexId } from '../../core/types.ts';

type Level = [price: string, size: string, liquidated: string, orders: string];

interface OkxMsg {
  event?: 'subscribe' | 'error' | 'channel-conn-count';
  code?: string;
  msg?: string;
  arg?: { channel: string; instId: string };
  data?: { asks?: Level[]; bids?: Level[]; ts?: string }[];
}

/** Tek abonelik mesajını makul boyutta tutmak için parçalıyoruz (limit 64KB). */
const ARGS_PER_MSG = 100;

export class OkxFeed extends BaseCexFeed {
  readonly venue: CexId = 'okx';
  private readonly symbols: string[];

  constructor(store: PriceStore, markets: readonly FeedMarket[], opts: BaseFeedOptions = {}) {
    super(store, markets, { staleTimeoutMs: 30_000, pingIntervalMs: 20_000, ...opts });
    this.symbols = markets.map((m) => m.venueSymbol);
  }

  protected async endpoint(): Promise<string> {
    return 'wss://ws.okx.com:8443/ws/v5/public';
  }

  protected *subscribeMessages(): Iterable<string> {
    for (let i = 0; i < this.symbols.length; i += ARGS_PER_MSG) {
      const args = this.symbols
        .slice(i, i + ARGS_PER_MSG)
        .map((instId) => ({ channel: 'bbo-tbt', instId }));
      yield JSON.stringify({ op: 'subscribe', args });
    }
  }

  protected override pingMessage(): string {
    // OKX düz metin bekler; JSON gönderirsek hata döner.
    return 'ping';
  }

  protected handleMessage(data: WebSocket.RawData, recvTs: number): void {
    const raw = data.toString();
    if (raw === 'pong') return;

    const msg = JSON.parse(raw) as OkxMsg;

    if (msg.event === 'error') {
      throw new Error(`OKX hata ${msg.code}: ${msg.msg}`);
    }
    if (msg.event) return; // subscribe onayı vb.

    const instId = msg.arg?.instId;
    if (!instId || !msg.data) return;

    const slot = this.slots.get(instId);
    if (slot === undefined) return;

    for (let i = 0; i < msg.data.length; i++) {
      const d = msg.data[i]!;
      const bidLvl = d.bids?.[0];
      const askLvl = d.asks?.[0];
      // bbo-tbt her mesajda iki tarafı da yollar; biri boşsa o tarafta
      // gerçekten emir yok demektir.
      const exchangeTs = d.ts ? +d.ts : 0;
      if (exchangeTs > 0) this.recordLatency(exchangeTs, recvTs);

      this.store.write(
        slot,
        bidLvl ? +bidLvl[0] : 0,
        bidLvl ? +bidLvl[1] : 0,
        askLvl ? +askLvl[0] : 0,
        askLvl ? +askLvl[1] : 0,
        exchangeTs,
        recvTs,
      );
    }
  }
}
