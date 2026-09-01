/**
 * Fırsat tekrarı filtresi.
 *
 * Bir arbitraj fırsatı açık kaldığı sürece tarayıcı onu her turda (50ms)
 * yeniden üretir. Filtresiz bırakılırsa 75 saniyede aynı fırsattan 210 kayıt
 * oluşuyor — canlı testte tam olarak bu oldu. Bu hem Telegram'ı kullanılamaz
 * hale getirir hem de kalibrasyon verisini tek bir coin'in kopyalarıyla
 * doldurup işe yaramaz kılar.
 *
 * Kural: aynı fırsat ya cooldown dolduğunda ya da belirgin şekilde
 * İYİLEŞTİĞİNDE tekrar geçer. Kötüleşmesi zaten ilgilendirmiyor.
 */

export interface DedupOptions {
  readonly cooldownMs: number;
  /** Cooldown dolmadan tekrar geçmek için gereken net% iyileşmesi. */
  readonly improveDeltaPct: number;
  /** Bellekte tutulacak azami kayıt — sınırsız büyümeyi önler. */
  readonly maxEntries?: number;
  /**
   * Fırsatın KAPANMIŞ sayılması için gereken sessizlik süresi (ms).
   *
   * Bu süre boyunca hiç görülmeyen bir fırsat tekrar ortaya çıktığında yeni
   * bir epizot başlar ve yaş sayacı sıfırlanır.
   *
   * NEDEN VAR: `firstSeen` bir kez yazılıp hiç sıfırlanmıyordu, yani yaş
   * "şu anki fark ne kadardır açık" değil "bu fırsat ilk kez ne zaman
   * görüldü" anlamına geliyordu. Sabahleyin 10 saniye açılıp kapanan bir
   * fark akşam yeniden açıldığında "8 saattir kapanmıyor" diye
   * işaretleniyordu. Kalibrasyonda bu uyarı en baskın kategoriydi (%37.5);
   * yani kalite metriğimizi bozan şeyin kendisi bir ölçüm hatasıydı.
   *
   * 0 (varsayılan) = sıfırlama yok. Yaşı okumayan tüketiciler (Telegram,
   * disk kaydı) için davranış değişmesin diye eski davranış korunuyor.
   */
  readonly episodeGapMs?: number;
}

interface Entry {
  /** Son YAYIN anı — cooldown bu alandan ölçülür. */
  at: number;
  netPct: number;
  /**
   * Son GÖRÜLME anı. `at`'ten ayrı tutulmak zorunda: cooldown'lı
   * tüketicilerde (Telegram 5 dk) `at` yalnızca yayınlandığında ilerler,
   * dolayısıyla epizot boşluğunu ondan ölçmek kesintisiz açık duran bir
   * fırsatı her cooldown penceresinde "kapandı" sayardı.
   */
  lastSeen: number;
  /** İçinde bulunduğumuz epizodun başlangıcı — "kapanmayan fırsat" tespiti için. */
  firstSeen: number;
  count: number;
}

export class Deduper {
  private readonly seen = new Map<string, Entry>();

  constructor(private readonly opts: DedupOptions) {}

  get size(): number {
    return this.seen.size;
  }

  /**
   * @returns bu fırsat yayınlanmalı mı
   */
  shouldEmit(id: string, netPct: number, now = Date.now()): boolean {
    const prev = this.seen.get(id);

    if (!prev) {
      this.record(id, netPct, now, now);
      return true;
    }

    // Araya epizot boşluğundan uzun bir sessizlik girdiyse fark kapanmış ve
    // yeniden açılmış demektir: yaş sayacı sıfırdan başlar.
    const gap = this.opts.episodeGapMs ?? 0;
    if (gap > 0 && now - prev.lastSeen > gap) {
      prev.firstSeen = now;
      prev.count = 0;
    }
    prev.lastSeen = now;

    prev.count++;
    const pass =
      now - prev.at >= this.opts.cooldownMs ||
      netPct - prev.netPct >= this.opts.improveDeltaPct;

    if (pass) {
      prev.at = now;
      prev.netPct = netPct;
    }
    return pass;
  }

  /**
   * İçinde bulunulan epizot ne kadardır sürüyor (ms) ve o epizotta kaç kez
   * görüldü.
   *
   * Uzun süre kapanmayan bir fırsat, kârlı olduğu için değil ULAŞILAMAZ
   * olduğu için oradadır: çekim kapalı, coin delist sürecinde ya da defter
   * hayalet emirlerle dolu. Piyasa o farkı kapatabilseydi çoktan kapatırdı.
   *
   * Epizot sınırı `shouldEmit` içinde belirlendiği için bu metot ondan SONRA
   * çağrılmalıdır; tersi sırada kapanmış bir epizodun yaşı okunur.
   */
  persistence(id: string, now = Date.now()): { ageMs: number; count: number } {
    const e = this.seen.get(id);
    if (!e) return { ageMs: 0, count: 0 };
    return { ageMs: now - e.firstSeen, count: e.count };
  }

  private record(id: string, netPct: number, at: number, firstSeen: number): void {
    const max = this.opts.maxEntries ?? 5000;
    if (this.seen.size >= max) {
      // En eski kaydı at. Tam LRU değil ama sınırsız büyümeyi önlemeye yeter.
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.set(id, { at, netPct, firstSeen, lastSeen: at, count: 1 });
  }

  /**
   * Uzun süredir GÖRÜLMEYEN kayıtları temizler.
   *
   * Ölçü `at` (son yayın) değil `lastSeen` olmalı: cooldown'lı bir tüketicide
   * kesintisiz açık duran fırsat yayınlanmadığı sürece `at`'i ilerletmez ve
   * hâlâ canlıyken silinirdi — silinince de yaş sayacı sıfırlanır, yani tam
   * olarak ölçmek istediğimiz "kapanmıyor" bilgisini kaybederdik.
   */
  prune(maxAgeMs: number, now = Date.now()): void {
    for (const [id, e] of this.seen) {
      if (now - e.lastSeen > maxAgeMs) this.seen.delete(id);
    }
  }
}
