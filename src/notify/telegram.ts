/**
 * Telegram bildirimi — ham Bot API.
 *
 * SDK kullanmıyoruz: bize gereken tek şey `sendMessage`. telegraf gibi bir
 * kütüphane onlarca transitive bağımlılık, kendi event döngüsü ve polling
 * altyapısı getirir; hiçbirine ihtiyacımız yok.
 *
 * İki koruma şart:
 *  1. DEDUP — aynı fırsat saniyede birçok kez tetiklenir (her tick fiyatı
 *     birazcık oynatır). Filtresiz gönderim kullanıcıyı bildirime boğar ve
 *     bot kullanılamaz hale gelir.
 *  2. KUYRUK — Telegram saniyede ~30 mesaj kabul eder. Aşınca 429 döner ve
 *     mesajlar kaybolur. Gönderimi sıraya alıp hızını kendimiz sınırlıyoruz.
 */

import type { Opportunity } from '../core/types.ts';
import { formatOpportunity } from './format.ts';
import { Deduper } from './dedup.ts';

export interface TelegramOptions {
  readonly token: string;
  readonly chatId: string;
  /** Aynı fırsat için tekrar gönderim arası minimum süre (ms). */
  readonly cooldownMs: number;
  /** Cooldown dolmadan tekrar göndermek için gereken net% değişimi. */
  readonly resendDeltaPct: number;
  /** Saniyede en fazla kaç mesaj. */
  readonly maxPerSec?: number;
}

export class TelegramNotifier {
  private readonly dedup: Deduper;
  private readonly queue: { text: string; opp: Opportunity }[] = [];
  private draining = false;

  private sentCount = 0;
  private suppressedCount = 0;
  private failedCount = 0;
  private lastError: string | null = null;

  constructor(private readonly opts: TelegramOptions) {
    this.dedup = new Deduper({
      cooldownMs: opts.cooldownMs,
      improveDeltaPct: opts.resendDeltaPct,
    });
  }

  get stats() {
    return {
      sent: this.sentCount,
      suppressed: this.suppressedCount,
      failed: this.failedCount,
      queued: this.queue.length,
      lastError: this.lastError,
    };
  }

  /**
   * Fırsatı bildirime alır. Dedup kurallarına takılırsa sessizce atılır.
   * @returns gönderim sıraya alındıysa true
   */
  notify(opp: Opportunity): boolean {
    if (!this.dedup.shouldEmit(opp.id, opp.netPct)) {
      this.suppressedCount++;
      return false;
    }

    this.queue.push({ text: formatOpportunity(opp), opp });
    void this.drain();
    return true;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    const minGap = 1000 / (this.opts.maxPerSec ?? 20);

    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        const t0 = Date.now();
        await this.send(item.text);
        const elapsed = Date.now() - t0;
        if (elapsed < minGap && this.queue.length > 0) {
          await new Promise((r) => setTimeout(r, minGap - elapsed));
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async send(text: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.opts.token}/sendMessage`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10_000);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.opts.chatId,
          text,
          parse_mode: 'MarkdownV2',
          disable_web_page_preview: true,
        }),
        signal: ac.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.failedCount++;
        this.lastError = `HTTP ${res.status}: ${body.slice(0, 150)}`;

        // 429: Telegram ne kadar bekleyeceğimizi söyler, uyarız.
        if (res.status === 429) {
          const retry = Number(
            (JSON.parse(body || '{}') as { parameters?: { retry_after?: number } })
              .parameters?.retry_after ?? 1,
          );
          await new Promise((r) => setTimeout(r, Math.min(30_000, retry * 1000)));
        }
        return;
      }

      this.sentCount++;
      this.lastError = null;
    } catch (e) {
      this.failedCount++;
      this.lastError = (e as Error).message;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Başlangıçta bağlantıyı doğrular — token/chat_id hatasını erken yakalar. */
  async verify(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.opts.token}/getMe`);
      if (!res.ok) {
        return { ok: false, detail: `getMe HTTP ${res.status} — bot token hatalı olabilir` };
      }
      const body = (await res.json()) as { result?: { username?: string } };
      return { ok: true, detail: `@${body.result?.username ?? 'bilinmeyen'}` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}
