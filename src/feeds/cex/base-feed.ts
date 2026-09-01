/**
 * Tüm CEX WebSocket adapter'larının ortak temeli.
 *
 * Buradaki tek amaç: bağlantı yaşam döngüsünü bir kez doğru yazıp altı borsada
 * tekrar etmemek. Alt sınıflar yalnızca protokole özgü üç şeyi doldurur:
 * URL üretimi, abonelik mesajları ve mesaj çözümleme.
 *
 * Kritik davranışlar:
 *  - Exponential backoff + JITTER. Jitter olmadan altı borsa aynı anda kopup
 *    aynı anda yeniden bağlanır (thundering herd) ve rate-limit yersin.
 *  - Heartbeat watchdog. TCP bağlantısı "açık" görünürken veri akışının durması
 *    en sinsi hata modudur: fiyatlar sessizce bayatlar ve bot hayalet fırsatlar
 *    üretir. Belirlenen süre tick gelmezse bağlantıyı biz öldürürüz.
 *  - Kapanış sırasında yeniden bağlanma yok (stop() çağrıldıysa gerçekten dur).
 */

import WebSocket from 'ws';
import type { CexId, Feed, FeedHealth, FeedState, PairKey, VenueId } from '../../core/types.ts';
import { LatencyTracker, RateCounter } from '../../core/metrics.ts';
import type { PriceStore } from '../../book/price-store.ts';

export interface FeedMarket {
  readonly pair: PairKey;
  readonly venueSymbol: string;
}

export interface BaseFeedOptions {
  /** Bu süre boyunca hiç mesaj gelmezse bağlantı ölü sayılır (ms). */
  readonly staleTimeoutMs?: number;
  /** Uygulama seviyesi ping periyodu (ms). 0 ise gönderilmez. */
  readonly pingIntervalMs?: number;
  readonly maxBackoffMs?: number;
  /** Abonelik mesajları arasındaki bekleme (ms) — gelen mesaj hız sınırı için. */
  readonly subscribeDelayMs?: number;
}

export abstract class BaseCexFeed implements Feed {
  abstract readonly venue: CexId;

  /**
   * venueSymbol → PriceStore slot indeksi.
   *
   * Kurulumda bir kez doldurulur. Hot path'te tek yaptığımız bu Map'ten
   * okumaktır: string→slot çözümlemesi O(1) ve sonrasında tüm yazma işlemi
   * düz sayı indeksleriyle yapılır.
   */
  protected readonly slots = new Map<string, number>();

  protected ws: WebSocket | null = null;
  protected state: FeedState = 'idle';

  private stopped = false;
  private reconnects = 0;
  private attempt = 0;
  private lastTickTs = 0;
  private lastError: string | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;

  protected readonly rate = new RateCounter();
  protected readonly latency = new LatencyTracker();

  private readonly staleTimeoutMs: number;
  private readonly pingIntervalMs: number;
  private readonly maxBackoffMs: number;
  private readonly subscribeDelayMs: number;

  /**
   * Gözlenen en küçük (recvTs - exchangeTs) farkı.
   *
   * Lokal saat borsa saatiyle senkron değilse bu fark sabit bir ofset içerir;
   * ham değeri "gecikme" diye raporlamak yanıltıcı olur (saati 3sn geri olan
   * bir makinede her borsa 3000ms gecikmeli görünür). Gözlenen minimumu
   * saat kayması tahmini kabul edip raporlanan gecikmeden düşüyoruz. Geriye
   * kalan, borsalar arasında karşılaştırılabilir GÖRELİ gecikmedir.
   */
  private minDelta = Number.POSITIVE_INFINITY;

  constructor(
    protected readonly store: PriceStore,
    markets: readonly FeedMarket[],
    opts: BaseFeedOptions = {},
  ) {
    this.staleTimeoutMs = opts.staleTimeoutMs ?? 30_000;
    this.pingIntervalMs = opts.pingIntervalMs ?? 0;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this.subscribeDelayMs = opts.subscribeDelayMs ?? 250;
    this.pendingMarkets = markets;
  }

  private readonly pendingMarkets: readonly FeedMarket[];

  /**
   * Slot tablosunu kurar. `venue` alanı alt sınıfta tanımlandığı için
   * constructor'da değil, start() sırasında çağrılır.
   */
  private initSlots(): void {
    if (this.slots.size > 0) return;
    for (const m of this.pendingMarkets) {
      const slot = this.store.resolveSlot(m.pair, this.venue);
      // -1: bu çift PriceStore'a kaydedilmemiş. Sessizce atlamak yerine
      // atlanan sayısını sağlıkta göstereceğiz.
      if (slot >= 0) this.slots.set(this.symbolKey(m.venueSymbol), slot);
    }
  }

  /**
   * Gelen mesajdaki sembolü slot tablosundaki anahtara çevirir.
   * Çoğu borsa aynı gösterimi döndürür; farklı olanlar bunu override eder.
   */
  protected symbolKey(venueSymbol: string): string {
    return venueSymbol;
  }

  // --- Alt sınıfların doldurduğu kısım -------------------------------------

  /** Bağlantı URL'i. Async çünkü KuCoin önce REST'ten token almak zorunda. */
  protected abstract endpoint(): Promise<string>;

  /**
   * Bağlantı açıldıktan sonra gönderilecek abonelik mesajları.
   *
   * Borsaların çoğu gelen mesajlara da hız sınırı uygular (Binance ~5 msg/sn,
   * KuCoin bunu aşınca 509 döndürüp abonelikleri sessizce düşürür). Bu yüzden
   * mesajlar `subscribeDelayMs` aralıklarla gönderilir.
   */
  protected abstract subscribeMessages(): Iterable<string | Buffer>;

  /** Gelen ham mesajı çözümleyip tick'leri store'a yazar. */
  protected abstract handleMessage(data: WebSocket.RawData, recvTs: number): void;

  /** Uygulama seviyesi ping formatı (borsaya göre değişir). */
  protected pingMessage(): string | Buffer | null {
    return null;
  }

  /** Abone olunan sembol sayısı — sağlık panelinde gösterilir. */
  protected subscribedCount(): number {
    return this.slots.size;
  }

  // --- Yaşam döngüsü -------------------------------------------------------

  async start(): Promise<void> {
    this.stopped = false;
    this.initSlots();
    await this.open();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.removeAllListeners();
      // terminate(): close handshake'i beklemeden kapat. Kapanışta nazik olmanın
      // bir faydası yok, kaynağı hemen bırakmak istiyoruz.
      ws.terminate();
    }
    this.state = 'idle';
  }

  private async open(): Promise<void> {
    if (this.stopped) return;
    this.state = this.reconnects === 0 ? 'connecting' : 'reconnecting';

    let url: string;
    try {
      url = await this.endpoint();
    } catch (e) {
      this.onFailure(`endpoint çözümlenemedi: ${(e as Error).message}`);
      return;
    }
    if (this.stopped) return;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url, {
        handshakeTimeout: 10_000,
        // Sıkıştırma CPU maliyeti getirir ama book ticker akışları çok
        // tekrarlı JSON olduğu için ağ kazancı net pozitif.
        perMessageDeflate: true,
      });
    } catch (e) {
      this.onFailure((e as Error).message);
      return;
    }

    this.ws = ws;

    ws.on('open', () => {
      if (this.stopped || this.ws !== ws) return;
      this.state = 'live';
      this.attempt = 0;
      this.lastError = null;
      this.lastTickTs = Date.now(); // watchdog'a başlangıç payı ver

      void this.sendSubscriptions(ws);
      this.startPing(ws);
      this.startWatchdog();
    });

    ws.on('message', (data) => {
      if (this.ws !== ws) return;
      const recvTs = Date.now();
      this.lastTickTs = recvTs;
      this.rate.tick(recvTs);
      try {
        this.handleMessage(data, recvTs);
      } catch (e) {
        // Tek bir bozuk mesaj feed'i düşürmemeli; sayacı tut, akışa devam et.
        this.lastError = `mesaj çözümleme: ${(e as Error).message}`;
      }
    });

    ws.on('error', (err) => {
      if (this.ws !== ws) return;
      this.lastError = err.message;
    });

    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      this.clearTimers();
      if (this.stopped) return;
      this.onFailure(`bağlantı kapandı (${code}) ${reason.toString().slice(0, 80)}`);
    });

    // Sunucu ping'ine ws kütüphanesi otomatik pong döner; ayrıca kendi
    // pong'umuzu da canlılık işareti sayarız.
    ws.on('ping', () => {
      this.lastTickTs = Date.now();
    });
    ws.on('pong', () => {
      this.lastTickTs = Date.now();
    });
  }

  /**
   * Abonelik mesajlarını aralıklı gönderir.
   *
   * Yüzlerce sembolü tek seferde göndermek borsanın gelen-mesaj limitine
   * takılır ve en kötüsü SESSİZCE olur: bağlantı açık kalır, bir kısım
   * abonelik düşer, o semboller hiç fiyat almaz. Bu yüzden araya bekleme
   * koyuyoruz — kurulum birkaç saniye uzasın, ama eksiksiz olsun.
   */
  private async sendSubscriptions(ws: WebSocket): Promise<void> {
    try {
      let first = true;
      for (const msg of this.subscribeMessages()) {
        if (this.stopped || this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
        if (!first && this.subscribeDelayMs > 0) {
          await new Promise((r) => setTimeout(r, this.subscribeDelayMs));
          if (this.stopped || this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
        }
        ws.send(msg);
        first = false;
      }
    } catch (e) {
      this.onFailure(`abonelik başarısız: ${(e as Error).message}`);
    }
  }

  /**
   * Bağlantıyı KOPARMADAN sağlık paneline uyarı yazar.
   *
   * `onFailure` bağlantıyı yıkıp yeniden kuruyor; kısmi bir sorun için bu
   * orantısız. Örnek: Kraken tek bir sembolü reddettiğinde diğer 40 sembolün
   * akışını kesmenin anlamı yok — ama reddin kendisi de görünmeden kalmamalı,
   * çünkü bu projede tekrar eden hata sınıfı sessiz başarısızlıktır.
   */
  protected noteWarning(msg: string): void {
    this.lastError = msg;
  }

  private onFailure(msg: string): void {
    this.lastError = msg;
    this.clearTimers();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.terminate();
      this.ws = null;
    }
    if (this.stopped) return;

    this.reconnects++;
    this.state = 'reconnecting';

    // Exponential backoff + tam jitter: 6 feed aynı anda kopsa bile yeniden
    // bağlanma denemeleri zamana yayılır.
    const base = Math.min(this.maxBackoffMs, 500 * 2 ** Math.min(this.attempt, 6));
    const delay = Math.random() * base + 250;
    this.attempt++;

    this.reconnectTimer = setTimeout(() => {
      void this.open();
    }, delay);
  }

  private startPing(ws: WebSocket): void {
    if (this.pingIntervalMs <= 0) return;
    this.pingTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const msg = this.pingMessage();
      try {
        if (msg === null) ws.ping();
        else ws.send(msg);
      } catch {
        /* close handler devralacak */
      }
    }, this.pingIntervalMs);
  }

  /**
   * Sessiz ölüm dedektörü. Bağlantı açık görünürken veri akmıyorsa fiyatlar
   * bayatlar — bu durumda hiç bağlantı olmamasından daha tehlikelidir, çünkü
   * sağlık paneli "live" gösterirken motor eski fiyatlarla fırsat hesaplar.
   */
  private startWatchdog(): void {
    this.watchdogTimer = setInterval(() => {
      if (this.stopped || this.state !== 'live') return;
      const age = Date.now() - this.lastTickTs;
      if (age > this.staleTimeoutMs) {
        this.onFailure(`veri akışı durdu (${Math.round(age / 1000)}s sessiz)`);
      }
    }, Math.max(1000, this.staleTimeoutMs / 3));
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.watchdogTimer = null;
  }

  // --- Sağlık --------------------------------------------------------------

  health(): FeedHealth {
    const now = Date.now();
    return {
      venue: this.venue,
      state: this.state,
      lastTickAgeMs: this.lastTickTs === 0 ? -1 : now - this.lastTickTs,
      msgsPerSec: this.rate.perSec(now),
      reconnects: this.reconnects,
      latencyP50: this.adjusted(0.5),
      latencyP99: this.adjusted(0.99),
      clockSkewMs: this.clockSkewMs,
      subscribedCount: this.subscribedCount(),
      lastError: this.lastError,
    };
  }

  /** Alt sınıflar tick çözümlerken çağırır: borsa saati ile lokal alım farkı. */
  protected recordLatency(exchangeTs: number, recvTs: number): void {
    if (exchangeTs <= 0) return;
    const d = recvTs - exchangeTs;
    // Negatif fark = lokal saat ileride. Saçma büyük değerleri de eleriz.
    if (d < -60_000 || d > 60_000) return;
    if (d < this.minDelta) this.minDelta = d;
    this.latency.record(d);
  }

  /** Tahmini saat kayması (ms). Ölçüm yoksa 0. */
  get clockSkewMs(): number {
    return Number.isFinite(this.minDelta) ? this.minDelta : 0;
  }

  /** Saat kayması düşülmüş göreli gecikme. */
  private adjusted(p: number): number {
    const v = this.latency.percentile(p) - this.clockSkewMs;
    return v > 0 ? v : 0;
  }
}
