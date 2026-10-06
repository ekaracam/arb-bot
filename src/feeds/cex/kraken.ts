/**
 * Kraken WebSocket v2 — ticker kanalı, `bbo` tetikleyicisiyle.
 *
 * ÖLÇÜLMÜŞ İKİ TUZAK (ikisi de sessiz başarısızlık üretirdi):
 *
 * 1. **`event_trigger` varsayılanı `trades`.** Yani ticker yalnızca bir işlem
 *    GERÇEKLEŞTİĞİNDE güncelleniyor. Arbitraj için gereken şey en iyi bid/ask'in
 *    kendisi değiştiğinde haber almaktır; varsayılanla bırakılsaydı işlem hacmi
 *    düşük çiftlerde fiyat dakikalarca güncellenmez, bayatlık kontrolü de
 *    devreye girmediği için (mesaj akıyor, sadece seyrek) motor eski fiyatla
 *    hesap yapardı. Ölçüm: `bbo` ile 3 sembolde 2.9 sn'de 10 güncelleme geldi,
 *    varsayılanla aynı sürede yalnızca snapshot vardı.
 *
 * 2. **Sembol adı v1'den farklı.** `AssetPairs`'in verdiği `wsname` (`XBT/USDT`,
 *    `XDG/USDT`) v2 tarafından REDDEDİLİYOR ("Currency pair not supported").
 *    v2 yaygın adları istiyor: `BTC/USDT`, `DOGE/USDT`. Eşleme
 *    symbol-registry.ts'te yapılıyor; buraya gelen sembol zaten v2 biçimindedir.
 *
 * Kraken'in snapshot mesajındaki `timestamp` SON İŞLEM anıdır ve saniyeler
 * eski olabilir; `update` mesajlarında ise defter anıdır ve tazedir (ölçüm:
 * ~70 ms). Gecikme ölçümüne yalnızca update'ler giriyor, aksi halde snapshot
 * tek başına gecikme ortalamasını saniyelere çıkarırdı.
 */

import type WebSocket from 'ws';
import { BaseCexFeed, type BaseFeedOptions, type FeedMarket } from './base-feed.ts';
import type { PriceStore } from '../../book/price-store.ts';
import type { CexId } from '../../core/types.ts';

interface KrakenTickerRow {
  symbol?: string;
  bid?: number;
  bid_qty?: number;
  ask?: number;
  ask_qty?: number;
  timestamp?: string;
}

interface KrakenMsg {
  channel?: string;
  type?: 'snapshot' | 'update';
  data?: KrakenTickerRow[];
  /** Abonelik cevabı / hata. */
  method?: string;
  success?: boolean;
  error?: string;
  symbol?: string;
}

/** Tek abonelik mesajında gönderilen sembol sayısı. */
const SYMS_PER_MSG = 100;

export class KrakenFeed extends BaseCexFeed {
  readonly venue: CexId = 'kraken';
  private readonly symbols: string[];

  constructor(store: PriceStore, markets: readonly FeedMarket[], opts: BaseFeedOptions = {}) {
    super(store, markets, { staleTimeoutMs: 30_000, pingIntervalMs: 20_000, ...opts });
    this.symbols = markets.map((m) => m.venueSymbol);
  }

  protected async endpoint(): Promise<string> {
    return 'wss://ws.kraken.com/v2';
  }

  protected *subscribeMessages(): Iterable<string> {
    for (let i = 0; i < this.symbols.length; i += SYMS_PER_MSG) {
      yield JSON.stringify({
        method: 'subscribe',
        params: {
          channel: 'ticker',
          symbol: this.symbols.slice(i, i + SYMS_PER_MSG),
          // Bkz. dosya başındaki 1. tuzak — bunu kaldırmak feed'i sessizce
          // işlem-tetiklemeli hale getirir.
          event_trigger: 'bbo',
        },
      });
    }
  }

  protected override pingMessage(): string {
    return JSON.stringify({ method: 'ping' });
  }

  protected handleMessage(data: WebSocket.RawData, recvTs: number): void {
    const msg = JSON.parse(data.toString()) as KrakenMsg;

    // Abonelik cevabı. Tek bir sembolün reddedilmesi bağlantıyı öldürmemeli:
    // Kraken sembol listesini kendi tempoçsunda değiştiriyor ve listeden düşen
    // tek bir çift yüzünden 40+ sembolün akışını kesmek orantısız olurdu.
    // Bağlantının tamamen kurulamaması watchdog tarafından zaten yakalanır.
    if (msg.method === 'subscribe') {
      if (msg.success === false) {
        this.noteWarning(`abonelik reddedildi (${msg.symbol ?? '?'}): ${msg.error ?? ''}`);
      }
      return;
    }
    if (msg.channel !== 'ticker' || !msg.data) return;

    const snapshot = msg.type === 'snapshot';

    for (const r of msg.data) {
      if (!r.symbol) continue;
      const slot = this.slots.get(r.symbol);
      if (slot === undefined) continue;

      // Snapshot'ın zaman damgası son İŞLEM anı — defter anı değil. Store'a
      // 0 yazıyoruz ki bayatlık hesabı `recvTs`'e düşsün; gerçek bir değer
      // gibi yazmak snapshot'ı doğduğu anda bayat gösterirdi.
      const exchangeTs = snapshot ? 0 : Date.parse(r.timestamp ?? '') || 0;
      if (exchangeTs > 0) this.recordLatency(exchangeTs, recvTs);

      this.store.write(
        slot,
        r.bid ?? 0,
        r.bid_qty ?? 0,
        r.ask ?? 0,
        r.ask_qty ?? 0,
        exchangeTs,
        recvTs,
      );
      this.markData(recvTs);
    }
  }
}
