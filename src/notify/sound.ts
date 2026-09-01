/**
 * Sesli fırsat uyarısı.
 *
 * Amaç: ekrana bakmıyorken fırsatı kaçırmamak. Terminal arayüzü 4 Hz yenilenir
 * ve fırsat satırı 60 saniye sonra düşer — o aralıkta başka bir pencereye
 * bakıyorsan sinyali hiç görmezsin.
 *
 * Bağımlılık eklemedik (bkz. bağımlılık politikası): Node'un ses çalma yeteneği
 * yok, ama Windows'ta [Console]::Beep bir satırlık PowerShell çağrısı ile
 * çalışıyor. Süreç başlatma maliyeti (~150 ms) burada önemsiz, çünkü çağrı hot
 * path'te DEĞİL (Aşama 2'den geçmiş, saniyede en fazla bir kez tetiklenen bir
 * olay) ve ayrıca cooldown ile sınırlı.
 *
 * Ton tercihi ölçüme dayanıyor: sistem bildirim WAV'ı (Windows Notify System
 * Generic) laptop hoparlöründe duyulmadı, aynı koşulda aynı ses seviyesinde
 * 1 kHz beep duyuldu. Ek fayda: WAV yolunun varlığını kontrol etmek gerekmiyor,
 * kurulumdan kuruluma değişen dosya adlarına bağımlılık kalktı.
 *
 * İki koruma şart:
 *  1. COOLDOWN — tek tarama turunda onlarca farklı coin eşiği geçebilir.
 *     Filtresiz çalınca ses kesintisiz bir uğultuya dönüşür ve bilgi taşımaz.
 *  2. HATA YUTMA — ses çalınamaması botu etkilememeli. Ses cihazı yoksa,
 *     PowerShell kısıtlıysa ya da WAV bulunamıyorsa sessizce devam edilir;
 *     sebep bir kez saklanır ve sağlık bilgisi olarak okunabilir.
 */

import { spawn } from 'node:child_process';

/**
 * Uyarı tonu. Saf sinüs/kare ton, sistem bildirim WAV'larından belirgin biçimde
 * duyulur — canlı testte Windows'un kendi bildirim sesi laptop hoparlöründe
 * kaçırılıyordu, bu ton kaçırılmadı. 1 kHz insan kulağının en duyarlı olduğu
 * banda denk gelir.
 */
const BEEP_HZ = 1000;
const BEEP_MS = 800;

export interface SoundOptions {
  readonly enabled: boolean;
  /** İki ses arası asgari süre (ms). */
  readonly cooldownMs: number;
  /**
   * Sesi gerçekten çalan fonksiyon. Testler burayı enjekte eder — birim testi
   * ses kartına bağlı olmamalı.
   */
  readonly play?: () => void;
}

/** Platforma uygun varsayılan çalıcıyı üretir. */
export function defaultPlayer(report?: (sorun: string) => void): () => void {
  if (process.platform === 'win32') {
    return () => {
      // detached KULLANILMIYOR — ölçülmüş hata: Windows'ta detached:true
      // DETACHED_PROCESS bayrağını geçirir, PowerShell konsolsuz başlar ve
      // [Console]::Beep hiçbir şey yapmadan exit 0 döner (~90 ms). Aynı şey
      // SoundPlayer için de geçerliydi. Konsolsuz süreç sessizce başarısız
      // olur; hata kodu bile vermez.
      //
      // detached:false ile çocuk, botun konsolunu miras alır ve ton çalar.
      // unref() yine de çağrılıyor: bot kapanırken bu sürecin bitmesini
      // beklemesin (unref detached'dan bağımsız çalışır).
      const t0 = Date.now();
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `[Console]::Beep(${BEEP_HZ},${BEEP_MS})`],
        { detached: false, stdio: 'ignore', windowsHide: true },
      );

      child.on('error', (e: Error) => report?.(e.message));

      // Sessiz başarısızlık dedektörü: ton BEEP_MS boyunca çalar, dolayısıyla
      // süreç en az o kadar yaşamalı. Çok erken çıkması "çalmadı" demektir.
      child.on('exit', () => {
        const gecen = Date.now() - t0;
        if (gecen < BEEP_MS / 2) {
          report?.(
            `beep süreci ${gecen} ms'de çıktı (ton ${BEEP_MS} ms sürmeliydi) — ` +
              `bot konsolsuz çalışıyor olabilir, ses çalınmadı`,
          );
        }
      });

      child.unref();
    };
  }

  // Diğer platformlar: terminal zili. Node'un yerleşik ses yeteneği yok ve
  // bunun için bağımlılık eklemek politikaya aykırı.
  return () => {
    process.stdout.write('\x07');
  };
}

export class SoundAlert {
  // -Infinity, 0 değil: 0 başlangıcı "hiç çalınmadı" ile "epoch'ta çalındı"yı
  // aynı şeye indirger ve ilk uyarıyı cooldown'a takılmış gibi gösterir.
  private lastAt = Number.NEGATIVE_INFINITY;
  private playedCount = 0;
  private suppressedCount = 0;
  private lastError: string | null = null;
  private readonly play: () => void;

  constructor(private readonly opts: SoundOptions) {
    // Varsayılan çalıcı asenkron çalışır; sorunu ancak süreç bittikten sonra
    // bilebiliriz, bu yüzden hatayı geri bildirimle alıyoruz.
    this.play = opts.play ?? defaultPlayer((sorun) => (this.lastError = sorun));
  }

  get stats(): {
    played: number;
    suppressed: number;
    lastError: string | null;
  } {
    return {
      played: this.playedCount,
      suppressed: this.suppressedCount,
      lastError: this.lastError,
    };
  }

  /**
   * Uyarı sesini çalar.
   * @returns ses gerçekten tetiklendiyse true; kapalıysa ya da cooldown
   *          dolmadıysa false
   */
  alert(now: number = Date.now()): boolean {
    if (!this.opts.enabled) return false;

    if (now - this.lastAt < this.opts.cooldownMs) {
      this.suppressedCount++;
      return false;
    }

    this.lastAt = now;
    try {
      this.play();
      this.playedCount++;
      return true;
    } catch (e) {
      // Ses çalamamak botun işleyişini durdurmaz.
      this.lastError = (e as Error).message;
      return false;
    }
  }
}
