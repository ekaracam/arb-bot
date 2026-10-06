/**
 * Bybit v5 spot — orderbook.1 (en iyi seviye, tick-by-tick).
 *
 * Dikkat: v5'te spot `tickers` kanalı bid/ask İÇERMEZ (yalnızca son fiyat ve
 * 24s istatistikleri). Best bid/ask için `orderbook.1` kullanmak zorundayız.
 *
 * Bu kanal "snapshot" ve "delta" mesajları karıştırır ve delta'da yalnızca
 * DEĞİŞEN taraf gelir — bid güncellenmişse `a` boş dizi olarak gelir. Eksik
 * tarafı "sıfır" sanıp yazarsak fiyat anında bozulur ve sahte %100'lük
 * fırsatlar üretiriz. Bu yüzden delta'da eksik tarafı store'daki son değerden
 * koruyoruz.
 */

import type WebSocket from 'ws';
import { BaseCexFeed, type BaseFeedOptions, type FeedMarket } from './base-feed.ts';
import type { PriceStore } from '../../book/price-store.ts';
import type { CexId } from '../../core/types.ts';

type Level = [price: string, size: string];

interface OrderbookMsg {
  topic?: string;
  type?: 'snapshot' | 'delta';
  ts?: number;
  data?: { s: string; b?: Level[]; a?: Level[] };
  op?: string;
  success?: boolean;
  ret_msg?: string;
}

/** Bybit tek abonelik mesajında en fazla 10 argüman kabul eder. */
const ARGS_PER_MSG = 10;

export class BybitFeed extends BaseCexFeed {
  readonly venue: CexId = 'bybit';
  private readonly symbols: string[];

  constructor(store: PriceStore, markets: readonly FeedMarket[], opts: BaseFeedOptions = {}) {
    super(store, markets, { staleTimeoutMs: 30_000, pingIntervalMs: 20_000, ...opts });
    this.symbols = markets.map((m) => m.venueSymbol);
  }

  protected async endpoint(): Promise<string> {
    return 'wss://stream.bybit.com/v5/public/spot';
  }

  protected *subscribeMessages(): Iterable<string> {
    for (let i = 0; i < this.symbols.length; i += ARGS_PER_MSG) {
      const args = this.symbols.slice(i, i + ARGS_PER_MSG).map((s) => `orderbook.1.${s}`);
      yield JSON.stringify({ op: 'subscribe', args });
    }
  }

  protected override pingMessage(): string {
    return JSON.stringify({ op: 'ping' });
  }

  protected handleMessage(data: WebSocket.RawData, recvTs: number): void {
    const msg = JSON.parse(data.toString()) as OrderbookMsg;

    // Abonelik/ping yanıtları — başarısız abonelik sessizce geçilmemeli.
    if (msg.op) {
      if (msg.success === false) {
        throw new Error(`abonelik reddedildi: ${msg.ret_msg ?? 'bilinmeyen'}`);
      }
      return;
    }

    const d = msg.data;
    if (!d) return;

    const slot = this.slots.get(d.s);
    if (slot === undefined) return;

    const exchangeTs = msg.ts ?? 0;
    if (exchangeTs > 0) this.recordLatency(exchangeTs, recvTs);

    const bidLvl = d.b?.[0];
    const askLvl = d.a?.[0];

    let bid: number;
    let bidQty: number;
    let ask: number;
    let askQty: number;

    if (msg.type === 'snapshot') {
      bid = bidLvl ? +bidLvl[0] : 0;
      bidQty = bidLvl ? +bidLvl[1] : 0;
      ask = askLvl ? +askLvl[0] : 0;
      askQty = askLvl ? +askLvl[1] : 0;
    } else {
      // delta: yalnızca gelen tarafı güncelle, diğerini koru.
      if (bidLvl) {
        bid = +bidLvl[0];
        bidQty = +bidLvl[1];
        // size=0 → bu seviye silindi. Elimizde yeni best yok, eskisini de
        // güvenle kullanamayız: fiyatı sıfırlayıp bu tarafı devre dışı bırakırız.
        if (bidQty === 0) bid = 0;
      } else {
        bid = this.store.bid(slot);
        bidQty = this.store.bidQty(slot);
      }

      if (askLvl) {
        ask = +askLvl[0];
        askQty = +askLvl[1];
        if (askQty === 0) ask = 0;
      } else {
        ask = this.store.ask(slot);
        askQty = this.store.askQty(slot);
      }
    }

    this.store.write(slot, bid, bidQty, ask, askQty, exchangeTs, recvTs);
    this.markData(recvTs);
  }
}
