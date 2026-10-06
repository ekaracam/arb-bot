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
  /** Birden fazla chat id — her fırsat listedeki HERKESE ayrı gönderilir. */
  readonly chatIds: readonly string[];
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
      // ÖLÇÜLEN EKSİK: bu alan buradan hep dışa açıktı ama HİÇBİR YERDE
      // OKUNMUYORDU — ne panel ne koşu günlüğü. Kaçırılmamış tek bir
      // MarkdownV2 karakteri Telegram'a mesajın tamamını HTTP 400 ile
      // reddettirdi; görünen tek şey `failed` sayacının artmasıydı ve koşu
      // günlüğü "📤 → telegram" demeye devam etti (o satır GÖNDERİLDİ değil
      // SIRAYA ALINDI demek: `notify()` kuyruğa ekler, gönderim `drain()`
      // içinde). Hata, kullanıcının "mesaj gelmedi" demesiyle bulundu.
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

  /**
   * Kuyruğu boşaltır — her METİN, `chatIds` listesindeki HERKESE ayrı bir
   * `sendMessage` çağrısı olarak gider.
   *
   * Hız sınırı SÜRE toplamı üzerinden uygulanıyor: Telegram'ın ~30 msg/sn
   * limiti bot token'ı BAŞINA, chat başına değil. Yani 3 kişilik bir listede
   * tek fırsat 3 ayrı API çağrısı demektir ve aralarındaki boşluk da aynı
   * kovadan sayılmalı — chat'e göre ayrı sayaç tutmak, üç kişiye art arda
   * gönderirken kotayı üçe katlamış gibi davranırdı.
   */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    const minGap = 1000 / (this.opts.maxPerSec ?? 20);

    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        for (let i = 0; i < this.opts.chatIds.length; i++) {
          const chatId = this.opts.chatIds[i]!;
          const t0 = Date.now();
          // 429: Telegram `retry_after` söyler; `send` o kadar bekleyip
          // 'retry' döner ve mesaj BİR kez daha denenir. Eskiden bekleyip
          // `return` ediyordu — mesaj o alıcıya hiç gitmiyor, panelde
          // yalnızca `failed` artıyordu.
          let sonuc = await this.send(item.text, chatId);
          if (sonuc === 'retry') sonuc = await this.send(item.text, chatId);
          if (sonuc === 'retry') {
            this.failedCount++;
            this.lastError = `chat ${chatId}: iki kez 429 — mesaj düşürüldü`;
          }
          const elapsed = Date.now() - t0;
          const dahaVar = this.queue.length > 0 || i < this.opts.chatIds.length - 1;
          if (elapsed < minGap && dahaVar) {
            await new Promise((r) => setTimeout(r, minGap - elapsed));
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async send(text: string, chatId: string): Promise<'ok' | 'retry' | 'failed'> {
    const url = `https://api.telegram.org/bot${this.opts.token}/sendMessage`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10_000);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'MarkdownV2',
          disable_web_page_preview: true,
        }),
        signal: ac.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');

        // 429: Telegram ne kadar bekleyeceğimizi söyler, uyar ve yeniden
        // dene (çağıran taraf). Başarısızlık SAYILMAZ — nihai sonuç belli
        // değil. Gövde JSON olmayabilir (proxy/CDN); parse hatası eskiden
        // `catch` dalına düşüp `failed`'i ikinci kez artırıyor ve gerçek HTTP
        // durumunu parse hatasıyla eziyordu.
        if (res.status === 429) {
          let retry = 1;
          try {
            retry = Number(
              (JSON.parse(body) as { parameters?: { retry_after?: number } }).parameters
                ?.retry_after ?? 1,
            );
          } catch {
            /* gövde JSON değil — varsayılan 1 sn */
          }
          if (!Number.isFinite(retry) || retry <= 0) retry = 1;
          await new Promise((r) => setTimeout(r, Math.min(30_000, retry * 1000)));
          return 'retry';
        }

        this.failedCount++;
        // chat id METNE dahil: bir kişi botu engellediğinde ya da hiç
        // başlatmadığında (Telegram bunu "chat not found" ile reddeder) hata
        // sessizce başka bir alıcının hatasıyla karışmamalı — hangi alıcının
        // düştüğü görünür olmalı.
        this.lastError = `chat ${chatId}: HTTP ${res.status}: ${body.slice(0, 150)}`;
        return 'failed';
      }

      // `lastError` BAŞARIDA sıfırlanmaz — kod tabanının diğer "son hata"
      // alanlarıyla (`lastDexQuoteError`, `sonInceHavuz`) aynı kural: yalnızca
      // YENİ bir hatayla üzerine yazılır. Aksi halde çoklu alıcıda bir chat'in
      // hatası, hemen ardından başka bir chat'e giden başarılı gönderimle
      // sessizce silinirdi — üç alıcılı bir listede ikincisi düşse bile
      // üçüncüsü başarılı olduğu an panel "hata yok" derdi.
      this.sentCount++;
      return 'ok';
    } catch (e) {
      this.failedCount++;
      this.lastError = `chat ${chatId}: ${(e as Error).message}`;
      return 'failed';
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
