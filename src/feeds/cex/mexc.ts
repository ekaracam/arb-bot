/**
 * MEXC spot — protobuf book ticker.
 *
 * MEXC bu botun en zahmetli adapter'ı, iki sebepten:
 *
 * 1. AKIŞ PROTOBUF. MEXC WebSocket'i JSON'dan protobuf'a taşıdı
 *    (`wbs-api.mexc.com`). Şemayı çalışma anında derliyoruz; harici .proto
 *    dosyası yok ki bundle edilince kaybolmasın.
 *
 * 2. BAĞLANTI BAŞINA 30 ABONELİK. Diğer borsalarda tek bağlantı yüzlerce
 *    sembolü taşırken burada her 30 sembol için ayrı bağlantı açmak gerekiyor.
 *    Bu yüzden MexcFeed tek bir WebSocket değil, bir bağlantı HAVUZUDUR:
 *    içindeki her MexcConnection normal bir BaseCexFeed'dir, MexcFeed ise
 *    hepsinin sağlığını tek bir görünümde birleştirir.
 *
 * Şema alan numaraları MEXC'in yayınladığı .proto tanımlarından alındı. Yanlış
 * numara sessizce çöp fiyat üretir; bu yüzden decode sonrası akla yatkınlık
 * kontrolü yapıyoruz (pozitif, sonlu, ask >= bid).
 */

import protobuf from 'protobufjs';
import type WebSocket from 'ws';
import { BaseCexFeed, type BaseFeedOptions, type FeedMarket } from './base-feed.ts';
import { FeedPool, chunk } from './pool.ts';
import type { PriceStore } from '../../book/price-store.ts';
import type { CexId } from '../../core/types.ts';

/**
 * Kullandığımız alt küme. Tam şemayı taşımaya gerek yok: protobuf bilinmeyen
 * alanları atlayabildiği için yalnızca okuduğumuz mesajları tanımlıyoruz.
 */
const PROTO_SOURCE = `
syntax = "proto3";
package mexc;

message PublicBookTickerV3Api {
  string bidPrice = 1;
  string bidQuantity = 2;
  string askPrice = 3;
  string askQuantity = 4;
}

message PushDataV3ApiWrapper {
  string channel = 1;
  string symbol = 3;
  string symbolId = 4;
  int64 createTime = 5;
  int64 sendTime = 6;
  PublicBookTickerV3Api publicBookTicker = 305;
  PublicBookTickerV3Api publicAggreBookTicker = 315;
}
`;

const root = protobuf.parse(PROTO_SOURCE).root;
const Wrapper = root.lookupType('mexc.PushDataV3ApiWrapper');

interface DecodedWrapper {
  channel?: string;
  symbol?: string;
  sendTime?: protobuf.Long | number;
  publicBookTicker?: {
    bidPrice?: string;
    bidQuantity?: string;
    askPrice?: string;
    askQuantity?: string;
  };
  publicAggreBookTicker?: {
    bidPrice?: string;
    bidQuantity?: string;
    askPrice?: string;
    askQuantity?: string;
  };
}

/** MEXC bağlantı başına en fazla 30 abonelik kabul eder. */
const SUBS_PER_CONNECTION = 30;

// ---------------------------------------------------------------------------
// Tek bağlantı
// ---------------------------------------------------------------------------

class MexcConnection extends BaseCexFeed {
  readonly venue: CexId = 'mexc';
  private readonly symbols: string[];

  constructor(store: PriceStore, markets: readonly FeedMarket[], opts: BaseFeedOptions = {}) {
    super(store, markets, {
      staleTimeoutMs: 40_000,
      // MEXC geçerli abonelik yoksa 30sn'de kapatır; 20sn'de ping atıyoruz.
      pingIntervalMs: 20_000,
      ...opts,
    });
    this.symbols = markets.map((m) => m.venueSymbol);
  }

  protected async endpoint(): Promise<string> {
    return 'wss://wbs-api.mexc.com/ws';
  }

  protected *subscribeMessages(): Iterable<string> {
    // Tek mesajda tüm parametreler gönderilebilir (zaten <= 30 tane).
    yield JSON.stringify({
      method: 'SUBSCRIPTION',
      params: this.symbols.map(
        (s) => `spot@public.aggre.bookTicker.v3.api.pb@100ms@${s}`,
      ),
    });
  }

  protected override pingMessage(): string {
    return JSON.stringify({ method: 'PING' });
  }

  protected handleMessage(data: WebSocket.RawData, recvTs: number): void {
    // Abonelik onayı ve PONG hâlâ JSON olarak geliyor; veri mesajları binary.
    if (typeof data === 'string' || !Buffer.isBuffer(data)) {
      return;
    }

    // JSON kontrol mesajları da Buffer olarak gelebilir: '{' ile başlıyorsa JSON.
    if (data.length > 0 && data[0] === 0x7b) {
      const msg = JSON.parse(data.toString()) as { code?: number; msg?: string };
      if (msg.code !== undefined && msg.code !== 0) {
        throw new Error(`MEXC abonelik hatası ${msg.code}: ${msg.msg ?? ''}`);
      }
      return;
    }

    const w = Wrapper.decode(data) as unknown as DecodedWrapper;
    const t = w.publicAggreBookTicker ?? w.publicBookTicker;
    if (!t || !w.symbol) return;

    const slot = this.slots.get(w.symbol);
    if (slot === undefined) return;

    const bid = Number(t.bidPrice);
    const bidQty = Number(t.bidQuantity);
    const ask = Number(t.askPrice);
    const askQty = Number(t.askQuantity);

    // Şema alan numaraları yanlış olsaydı burada saçma değerler görürdük.
    // Sessizce çöp fiyat yazmaktansa mesajı düşürmek çok daha güvenli.
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return;
    if (ask < bid) return;

    const sendTime = w.sendTime == null ? 0 : Number(w.sendTime);
    if (sendTime > 0) this.recordLatency(sendTime, recvTs);

    this.store.write(slot, bid, bidQty, ask, askQty, sendTime, recvTs);
  }
}

// ---------------------------------------------------------------------------
// Havuz
// ---------------------------------------------------------------------------

export class MexcFeed extends FeedPool {
  constructor(store: PriceStore, markets: readonly FeedMarket[], opts: BaseFeedOptions = {}) {
    super(
      'mexc',
      chunk(markets, SUBS_PER_CONNECTION).map((part) => new MexcConnection(store, part, opts)),
      120,
    );
  }
}
