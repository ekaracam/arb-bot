/**
 * Fırsat kayıtları (NDJSON).
 *
 * Bu, v1'in en değerli çıktısıdır ve otomasyona geçişin ön koşuludur.
 *
 * Bot bir fırsat bildirdiğinde bunun GERÇEKTEN kârlı olup olmadığını o anda
 * bilemeyiz — ancak fiyatların sonraki hareketine bakarak anlayabiliriz.
 * Her sinyali, tespit anındaki tam durumuyla diske yazıyoruz; calibrate.ts
 * daha sonra bu kayıtlar üzerinden "sinyallerin kaçı gerçekti" raporunu
 * üretiyor. Bu ölçüm yapılmadan otomatik işleme geçmek körlemesine para
 * riske atmaktır.
 *
 * Yazma asenkron ve tamponlu: disk I/O fiyat işleme yolunu asla bekletmez.
 */

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { resolve } from 'node:path';
import type { Opportunity } from '../core/types.ts';

export interface OpportunityRecord {
  readonly ts: number;
  readonly id: string;
  readonly kind: string;
  readonly coin: string;
  readonly quote: string;
  readonly netPct: number;
  readonly netQuote: number;
  readonly chain: string | null;
  readonly buyVenue: string;
  readonly buyVwap: number;
  readonly buyBest: number;
  readonly sellVenue: string;
  readonly sellVwap: number;
  readonly sellBest: number;
  readonly qty: number;
  readonly costs: Opportunity['costs'];
  readonly transferVerified: boolean;
  readonly warnings: readonly string[];
  /**
   * DEX bacağının bağımsız ikinci kaynakla karşılaştırması (CoW).
   *
   * ÖLÇÜLEN EKSİK: çapraz kontrol canlıda ilk kez çalıştığında (`capraz[1/1]`,
   * `KTA aerodrome->kraken`) sonucu panele ve Telegram'a gitti ama DİSKE
   * GİTMEDİ — bu serileştirici alanları tek tek seçiyor ve `capraz` listede
   * yoktu. Sonucu: `calibrate` kontrolün ne sıklıkla çalıştığını ve ne kadar
   * saptığını HİÇ ölçemezdi. Kontrolün kendisi kadar, sonucunun ölçülebilir
   * olması da gerekiyor.
   */
  readonly capraz?: Opportunity['capraz'];
  readonly worstAgeMs: number;
}

export class NdjsonWriter {
  private stream: WriteStream | null = null;
  private buffer: string[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private written = 0;
  private lastError: string | null = null;
  private currentDay = '';

  constructor(private readonly dir: string) {}

  get stats(): { written: number; buffered: number; lastError: string | null } {
    return { written: this.written, buffered: this.buffer.length, lastError: this.lastError };
  }

  start(): void {
    mkdirSync(this.dir, { recursive: true });
    this.rotate();
    // Tamponu saniyede bir boşalt: kayıt kaybını sınırlarken hot path'i
    // disk I/O ile yavaşlatmıyoruz.
    this.flushTimer = setInterval(() => this.flush(), 1000);
  }

  async stop(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    this.flush();
    const s = this.stream;
    this.stream = null;
    // `end()` beklenmezse `process.exit` son parçayı diske inmeden keser ve
    // kapanışta basılan `written` da son yazımı içermez.
    if (s) await new Promise<void>((r) => s.end(() => r()));
  }

  write(opp: Opportunity): void {
    const rec: OpportunityRecord = {
      ts: opp.detectedAt,
      id: opp.id,
      kind: opp.kind,
      coin: opp.coin,
      quote: opp.quote,
      netPct: opp.netPct,
      netQuote: opp.netQuote,
      chain: opp.chain,
      buyVenue: opp.buy.venue,
      buyVwap: opp.buy.vwap,
      buyBest: opp.buy.bestPrice,
      sellVenue: opp.sell.venue,
      sellVwap: opp.sell.vwap,
      sellBest: opp.sell.bestPrice,
      qty: opp.buy.qty,
      costs: opp.costs,
      transferVerified: opp.transferVerified,
      warnings: opp.warnings,
      ...(opp.capraz ? { capraz: opp.capraz } : {}),
      worstAgeMs: opp.worstAgeMs,
    };
    this.buffer.push(JSON.stringify(rec));
  }

  private flush(): void {
    if (this.buffer.length === 0) return;
    this.rotate();
    if (!this.stream) return;

    const chunk = this.buffer.join('\n') + '\n';
    const count = this.buffer.length;
    this.buffer = [];

    this.stream.write(chunk, (err) => {
      if (err) this.lastError = err.message;
      else this.written += count;
    });
  }

  /** Günlük dosya döndürme — tek dosyanın sınırsız büyümesini önler. */
  private rotate(): void {
    const day = new Date().toISOString().slice(0, 10);
    if (day === this.currentDay && this.stream) return;

    this.stream?.end();
    this.currentDay = day;
    this.stream = createWriteStream(resolve(this.dir, `opportunities-${day}.ndjson`), {
      flags: 'a',
    });
    const s = this.stream;
    s.on('error', (e) => {
      this.lastError = e.message;
      // Hatalı akış kapanmış sayılır; `null` bırakmak bir sonraki `flush`'ın
      // `rotate` ile yeniden açmasını sağlar. Eskiden akış UTC gün dönene
      // kadar kapalı kalıyor ve o güne kadarki her kayıt kayboluyordu.
      if (this.stream === s) this.stream = null;
    });
  }
}
