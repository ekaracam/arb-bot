/**
 * Binance spot — sembol bazlı book ticker.
 *
 * Başta all-market `!bookTicker` stream'i kullanılmıştı; canlı testte bağlantı
 * kuruluyor ama HİÇ mesaj gelmiyordu. Binance bu toplu stream'i kaldırmış.
 * Sessiz başarısızlık olduğu için (bağlantı "live" görünüyor, veri yok)
 * check-feeds'in "abone: 408, dolu: 0" satırı olmasa fark edilmezdi.
 *
 * Şimdi her sembole ayrı abone oluyoruz. Binance gelen mesajlara ~5 msg/sn
 * sınırı uyguladığı için abonelikler parça parça ve aralıklı gönderilir
 * (base-feed bunu subscribeDelayMs ile hallediyor).
 *
 * Payload: {"u":400900217,"s":"BNBUSDT","b":"25.35","B":"31.21","a":"25.36","A":"40.66"}
 * Bazı dağıtımlarda ayrıca "E" (event time) gelir; varsa gecikme ölçümünde kullanılır.
 */

import type WebSocket from 'ws';
import { BaseCexFeed, type BaseFeedOptions, type FeedMarket } from './base-feed.ts';
import type { PriceStore } from '../../book/price-store.ts';
import type { CexId } from '../../core/types.ts';

interface BookTicker {
  s: string;
  b: string;
  B: string;
  a: string;
  A: string;
  E?: number;
}

interface ControlMsg {
  result?: unknown;
  id?: number;
  error?: { code: number; msg: string };
}

/** Tek SUBSCRIBE mesajındaki stream sayısı. Bağlantı başına toplam sınır 1024. */
const STREAMS_PER_MSG = 150;

export class BinanceFeed extends BaseCexFeed {
  readonly venue: CexId = 'binance';
  private readonly symbols: string[];

  constructor(store: PriceStore, markets: readonly FeedMarket[], opts: BaseFeedOptions = {}) {
    super(store, markets, {
      // Binance sunucu ping'i gönderir, ws kütüphanesi otomatik pong döner.
      // Bizim ayrıca ping atmamıza gerek yok.
      staleTimeoutMs: 20_000,
      // Gelen mesaj limiti ~5/sn; güvenli tarafta kalıyoruz.
      subscribeDelayMs: 300,
      ...opts,
    });
    this.symbols = markets.map((m) => m.venueSymbol);
  }

  protected async endpoint(): Promise<string> {
    return 'wss://stream.binance.com:9443/ws';
  }

  protected *subscribeMessages(): Iterable<string> {
    for (let i = 0; i < this.symbols.length; i += STREAMS_PER_MSG) {
      yield JSON.stringify({
        method: 'SUBSCRIBE',
        // Stream adları küçük harf olmalı; payload'daki "s" alanı büyük harf
        // döndüğü için slot tablosu (venueSymbol = BTCUSDT) uyumlu kalıyor.
        params: this.symbols
          .slice(i, i + STREAMS_PER_MSG)
          .map((s) => `${s.toLowerCase()}@bookTicker`),
        id: i + 1,
      });
    }
  }

  protected handleMessage(data: WebSocket.RawData, recvTs: number): void {
    const parsed = JSON.parse(data.toString()) as BookTicker | BookTicker[] | ControlMsg;

    if (Array.isArray(parsed)) {
      for (let i = 0; i < parsed.length; i++) this.apply(parsed[i]!, recvTs);
      return;
    }

    // Abonelik yanıtı: hata sessizce geçilmemeli, yoksa yine "bağlı ama veri yok"
    // durumuna düşeriz.
    if ('result' in parsed || 'error' in parsed) {
      const err = (parsed as ControlMsg).error;
      if (err) throw new Error(`Binance abonelik hatası ${err.code}: ${err.msg}`);
      return;
    }

    this.apply(parsed as BookTicker, recvTs);
  }

  private apply(t: BookTicker, recvTs: number): void {
    const slot = this.slots.get(t.s);
    if (slot === undefined) return; // taramadığımız sembol

    const exchangeTs = t.E ?? 0;
    if (exchangeTs > 0) this.recordLatency(exchangeTs, recvTs);

    this.store.write(slot, +t.b, +t.B, +t.a, +t.A, exchangeTs, recvTs);
    this.markData(recvTs);
  }
}
