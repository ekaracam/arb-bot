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

/**
 * Belirli bir çıkış cihazına ton çalan C# kodu (PowerShell `Add-Type` ile
 * derlenir — bağımlılık yok, .NET Framework Windows'ta hazır).
 *
 * Neden gerekli: [Console]::Beep her zaman Windows'un VARSAYILAN çıkışına
 * gider. Kulaklık takılınca varsayılan kulaklığa döner ve uyarı kulaklıkta
 * çalar; oysa uyarının amacı ekrandan uzaktayken duyulmak. winmm
 * `waveOutOpen` cihazı NUMARAYLA açar, varsayılandan bağımsızdır.
 *
 * Ton aynı (1 kHz, 800 ms) — ölçülmüş duyulabilirlik tercihi korunuyor.
 * Uçlarda 10 ms yumuşatma var, yoksa hoparlörde tık sesi çıkar. Seviye
 * `SOUND_VOLUME`'dan gelir: tam genlikteki sinüs, sistem ses seviyesinden
 * bağımsız olarak rahatsız edici yüksek çıktı (denendi).
 */
const CIHAZ_SESI_CS = `
using System; using System.Runtime.InteropServices; using System.Threading;
public static class ArbSes {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct CAPS { public ushort mid, pid; public uint ver; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string name; public uint fmts; public ushort ch, res; public uint sup; }
  [StructLayout(LayoutKind.Sequential)]
  struct FMT { public ushort tag, ch; public uint rate, bps; public ushort align, bits, cb; }
  [StructLayout(LayoutKind.Sequential)]
  struct HDR { public IntPtr data; public uint len, rec; public IntPtr user; public uint flags, loops; public IntPtr next, res; }
  [DllImport("winmm.dll")] static extern uint waveOutGetNumDevs();
  [DllImport("winmm.dll", CharSet=CharSet.Unicode)] static extern uint waveOutGetDevCapsW(uint id, ref CAPS c, uint sz);
  [DllImport("winmm.dll")] static extern uint waveOutOpen(out IntPtr h, uint id, ref FMT f, IntPtr cb, IntPtr inst, uint fl);
  [DllImport("winmm.dll")] static extern uint waveOutPrepareHeader(IntPtr h, IntPtr hdr, uint sz);
  [DllImport("winmm.dll")] static extern uint waveOutUnprepareHeader(IntPtr h, IntPtr hdr, uint sz);
  [DllImport("winmm.dll")] static extern uint waveOutWrite(IntPtr h, IntPtr hdr, uint sz);
  [DllImport("winmm.dll")] static extern uint waveOutClose(IntPtr h);
  public static string[] Devices() {
    uint n = waveOutGetNumDevs(); var r = new string[n];
    for (uint i = 0; i < n; i++) { var c = new CAPS(); waveOutGetDevCapsW(i, ref c, (uint)Marshal.SizeOf(c)); r[i] = c.name; }
    return r;
  }
  public static int Find(string match) {
    var d = Devices();
    for (int i = 0; i < d.Length; i++) if (d[i].IndexOf(match, StringComparison.OrdinalIgnoreCase) >= 0) return i;
    return -1;
  }
  public static int Play(uint dev, int hz, int ms, double vol) {
    const int rate = 44100; int n = rate * ms / 1000; int fade = rate / 100;
    var pcm = new short[n];
    for (int i = 0; i < n; i++) {
      double env = Math.Min(1.0, Math.Min(i, n - 1 - i) / (double)fade);
      pcm[i] = (short)(Math.Sin(2 * Math.PI * hz * i / rate) * vol * env * short.MaxValue);
    }
    var f = new FMT { tag = 1, ch = 1, rate = rate, bps = rate * 2, align = 2, bits = 16, cb = 0 };
    IntPtr h; uint e = waveOutOpen(out h, dev, ref f, IntPtr.Zero, IntPtr.Zero, 0);
    if (e != 0) return (int)e;
    var buf = GCHandle.Alloc(pcm, GCHandleType.Pinned);
    var hdr = new HDR { data = buf.AddrOfPinnedObject(), len = (uint)(n * 2) };
    uint sz = (uint)Marshal.SizeOf(hdr); IntPtr p = Marshal.AllocHGlobal((int)sz);
    Marshal.StructureToPtr(hdr, p, false);
    try {
      waveOutPrepareHeader(h, p, sz); waveOutWrite(h, p, sz);
      int off = (int)Marshal.OffsetOf(typeof(HDR), "flags"); int waited = 0;
      while ((Marshal.ReadInt32(p, off) & 1) == 0 && waited < ms + 3000) { Thread.Sleep(20); waited += 20; }
      waveOutUnprepareHeader(h, p, sz);
    } finally { waveOutClose(h); Marshal.FreeHGlobal(p); buf.Free(); }
    return 0;
  }
}
`;

/** Cihaz bulunamadığında betiğin çıkış kodu; stderr'e cihaz listesi yazılır. */
const CIHAZ_YOK_KODU = 2;

const ADD_TYPE = `Add-Type -TypeDefinition @'${CIHAZ_SESI_CS}'@`;

function psTirnak(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * -EncodedCommand: betik komut satırına UTF-16LE base64 olarak girer, yani
 * tırnak kaçışı ve Türkçe karakterli cihaz adları sorun çıkarmaz. Komut olarak
 * verilen betik ExecutionPolicy'ye de tabi değil (bkz. CLAUDE.md, "Windows'ta
 * çalıştırma") — `-File` olsaydı Restricted politikada çalışmazdı.
 */
function powershellArgs(satirlar: readonly string[]): string[] {
  // Akış yönlendirilince PowerShell ilerleme kayıtlarını stderr'e CLIXML
  // olarak basar ve cihaz adları konsol kod sayfasıyla bozulur — ikisi de
  // hata mesajını okunmaz yapıyordu (ölçüldü).
  const onsoz = [`$ProgressPreference = 'SilentlyContinue'`, `[Console]::OutputEncoding = [Text.Encoding]::UTF8`];
  const kodlu = Buffer.from([...onsoz, ...satirlar].join('\n'), 'utf16le').toString('base64');
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', kodlu];
}

/**
 * Windows'taki çıkış cihazlarının adları (winmm, en fazla 31 karakter).
 * Başlangıçta `SOUND_DEVICE`'ın eşleşip eşleşmediğini göstermek için — çalma
 * anındaki eşleşmeme yalnızca `lastError`'a düşer ve panelde görünmez.
 */
export function sesCihazlari(): Promise<string[]> {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const args = powershellArgs([ADD_TYPE, `[Console]::Out.Write(([ArbSes]::Devices() -join [char]10))`]);
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (out += d));
    child.on('error', () => resolve([]));
    child.on('close', () => resolve(out.split('\n').map((s) => s.trim()).filter(Boolean)));
  });
}

export interface SoundOptions {
  readonly enabled: boolean;
  /** İki ses arası asgari süre (ms). */
  readonly cooldownMs: number;
  /** Çıkış cihazı adının bir parçası; `null` → Windows'un varsayılan çıkışı. */
  readonly device?: string | null;
  /** Ton seviyesi, % (yalnızca `device` tanımlıyken). */
  readonly volumePct?: number;
  /**
   * Sesi gerçekten çalan fonksiyon. Testler burayı enjekte eder — birim testi
   * ses kartına bağlı olmamalı.
   */
  readonly play?: () => void;
}

/**
 * Platforma uygun varsayılan çalıcıyı üretir.
 * @param volumePct yalnızca cihaz yolunda geçerli (1–100); Beep'in seviyesi ayarlanamaz.
 * @param cihaz Windows'ta çıkış cihazı adının bir parçası (büyük/küçük harf
 *        duyarsız). `null` → [Console]::Beep, yani varsayılan çıkış.
 */
export function defaultPlayer(
  report?: (sorun: string) => void,
  cihaz: string | null = null,
  volumePct = 20,
): () => void {
  const seviye = (Math.min(100, Math.max(1, volumePct)) / 100).toFixed(3);
  if (process.platform === 'win32' && cihaz !== null) {
    const args = powershellArgs([
      ADD_TYPE,
      `$i = [ArbSes]::Find(${psTirnak(cihaz)})`,
      `if ($i -lt 0) { [Console]::Error.Write(([ArbSes]::Devices() -join ' | ')); exit ${CIHAZ_YOK_KODU} }`,
      `exit [ArbSes]::Play([uint32]$i, ${BEEP_HZ}, ${BEEP_MS}, ${seviye})`,
    ]);
    return () => {
      // Cihaz bulunamazsa varsayılana DÜŞÜLMEZ: varsayılan çoğu zaman tam
      // kaçınılmak istenen kulaklıktır. Sebep lastError'a ve başlangıç
      // loguna yazılır.
      const child = spawn('powershell.exe', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      let hata = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d: string) => (hata += d));
      child.on('error', (e: Error) => report?.(e.message));
      child.on('close', (kod) => {
        if (kod === CIHAZ_YOK_KODU) {
          report?.(`ses cihazı "${cihaz}" bulunamadı — mevcut: ${hata.trim()}`);
        } else if (kod !== 0) {
          report?.(`ses cihazı "${cihaz}" açılamadı (çıkış kodu ${kod}) ${hata.trim()}`);
        }
      });
      child.unref();
    };
  }

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
    this.play = opts.play ?? defaultPlayer((sorun) => (this.lastError = sorun), opts.device ?? null, opts.volumePct);
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
