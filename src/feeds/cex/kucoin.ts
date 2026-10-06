/**
 * KuCoin spot — /spotMarket/level1 (best bid/ask).
 *
 * KuCoin diğerlerinden üç noktada ayrılır:
 *  1. WebSocket URL'i sabit değil. Önce REST ile `bullet-public` çağrılıp
 *     geçici bir token ve sunucu adresi alınır. Token süreli olduğu için her
 *     yeniden bağlanmada bu adım tekrarlanır — endpoint() async olmasının
 *     sebebi tam olarak budur.
 *  2. Uygulama seviyesi ping ZORUNLUDUR. Sunucunun bildirdiği pingInterval
 *     içinde ping gelmezse bağlantı kapatılır.
 *  3. BAĞLANTI BAŞINA ABONELİK SINIRI VAR. Canlı testte 844 sembole abone
 *     olmaya çalışınca ~280'de tıkandı ve gerisi için 509 döndü. Paket
 *     boyutunu düşürmek işe yaramadı, çünkü sorun mesaj hızı değil bağlantı
 *     başına toplam abonelik. Bu yüzden MEXC gibi bağlantı havuzu kullanıyoruz.
 */

import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import { BaseCexFeed, type BaseFeedOptions, type FeedMarket } from './base-feed.ts';
import { FeedPool, chunk } from './pool.ts';
import { httpJson } from '../../core/http.ts';
import type { PriceStore } from '../../book/price-store.ts';
import type { CexId } from '../../core/types.ts';

interface BulletResponse {
  code: string;
  data: {
    token: string;
    instanceServers: {
      endpoint: string;
      pingInterval: number;
      pingTimeout: number;
    }[];
  };
}

interface KucoinMsg {
  type: 'welcome' | 'ack' | 'message' | 'pong' | 'error';
  topic?: string;
  subject?: string;
  code?: number;
  data?: {
    bids?: [string, string];
    asks?: [string, string];
    timestamp?: number;
  };
}

/** Tek abonelik mesajındaki sembol sayısı (doküman: topic başına en fazla 100). */
const SYMS_PER_TOPIC = 50;

/**
 * Bağlantı başına sembol sayısı.
 *
 * Ölçülen tıkanma noktası ~280 civarıydı; 200 ile belirgin pay bırakıyoruz.
 * Fazladan bağlantı açmanın maliyeti düşük, eksik abonelik ise sessizce
 * kör nokta yaratıyor.
 */
const SYMS_PER_CONNECTION = 200;

class KucoinConnection extends BaseCexFeed {
  readonly venue: CexId = 'kucoin';
  private readonly symbols: string[];

  constructor(store: PriceStore, markets: readonly FeedMarket[], opts: BaseFeedOptions = {}) {
    super(store, markets, {
      staleTimeoutMs: 40_000,
      // Sunucu tipik olarak 18s bildirir; güvenli tarafta kalmak için 15s.
      pingIntervalMs: 15_000,
      // KuCoin abonelik hızına duyarlı: hızlı gönderince 509 döndürüp
      // abonelikleri sessizce düşürüyor. Kurulumun birkaç saniye uzaması,
      // sembollerin yarısının hiç fiyat almamasından çok daha iyi.
      subscribeDelayMs: 400,
      ...opts,
    });
    this.symbols = markets.map((m) => m.venueSymbol);
  }

  protected async endpoint(): Promise<string> {
    const r = await httpJson<BulletResponse>('https://api.kucoin.com/api/v1/bullet-public', {
      method: 'POST',
      // KuCoin boş gövde bekliyor ama Content-Type olmadan bazen 411 dönüyor.
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    const server = r.data?.instanceServers?.[0];
    if (!server?.endpoint || !r.data?.token) {
      throw new Error('bullet-public geçerli bir sunucu/token döndürmedi');
    }

    return `${server.endpoint}?token=${encodeURIComponent(r.data.token)}&connectId=${randomUUID()}`;
  }

  protected *subscribeMessages(): Iterable<string> {
    for (let i = 0; i < this.symbols.length; i += SYMS_PER_TOPIC) {
      const batch = this.symbols.slice(i, i + SYMS_PER_TOPIC);
      yield JSON.stringify({
        id: randomUUID(),
        type: 'subscribe',
        topic: `/spotMarket/level1:${batch.join(',')}`,
        privateChannel: false,
        response: true,
      });
    }
  }

  protected override pingMessage(): string {
    return JSON.stringify({ id: randomUUID(), type: 'ping' });
  }

  protected handleMessage(data: WebSocket.RawData, recvTs: number): void {
    const msg = JSON.parse(data.toString()) as KucoinMsg;

    if (msg.type === 'error') {
      // Sebep `data` alanında (string) gelir; `topic` hata mesajında yok.
      const sebep = (msg as { data?: unknown }).data;
      throw new Error(
        `KuCoin hata ${msg.code}: ${typeof sebep === 'string' ? sebep : (msg.topic ?? '')}`,
      );
    }
    if (msg.type !== 'message' || !msg.topic || !msg.data) return;

    // topic: "/spotMarket/level1:BTC-USDT"
    const colon = msg.topic.lastIndexOf(':');
    if (colon < 0) return;
    const symbol = msg.topic.slice(colon + 1);

    const slot = this.slots.get(symbol);
    if (slot === undefined) return;

    const d = msg.data;
    const exchangeTs = d.timestamp ?? 0;
    if (exchangeTs > 0) this.recordLatency(exchangeTs, recvTs);

    // level1 formatı: bids/asks = [fiyat, miktar]
    const bid = d.bids?.[0] ? +d.bids[0] : 0;
    const bidQty = d.bids?.[1] ? +d.bids[1] : 0;
    const ask = d.asks?.[0] ? +d.asks[0] : 0;
    const askQty = d.asks?.[1] ? +d.asks[1] : 0;

    this.store.write(slot, bid, bidQty, ask, askQty, exchangeTs, recvTs);
    this.markData(recvTs);
  }
}

export class KucoinFeed extends FeedPool {
  constructor(store: PriceStore, markets: readonly FeedMarket[], opts: BaseFeedOptions = {}) {
    super(
      'kucoin',
      chunk(markets, SYMS_PER_CONNECTION).map(
        (part) => new KucoinConnection(store, part, opts),
      ),
      // Her bağlantı ayrı bir bullet-public çağrısı yapıyor; REST tarafını
      // da yormamak için aralarında biraz bekliyoruz.
      300,
    );
  }
}
