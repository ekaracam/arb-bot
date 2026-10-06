/**
 * Allocation-free gecikme ve throughput ölçümü.
 *
 * "Düşük gecikmeli" iddiası ancak ölçülürse anlamlıdır. Her feed kendi
 * LatencyTracker'ını tutar; check-feeds scripti ve terminal sağlık paneli
 * bunları okur.
 *
 * Percentile hesabı için sabit boyutlu bir ring buffer üzerinde çalışırız:
 * yeni değer yazmak O(1) ve allocation'sızdır, percentile okumak O(n log n)
 * ama yalnızca saniyede birkaç kez (render sırasında) çağrılır.
 */

export class LatencyTracker {
  private readonly buf: Float64Array;
  private readonly scratch: Float64Array;
  private idx = 0;
  private filled = 0;

  constructor(capacity = 2048) {
    this.buf = new Float64Array(capacity);
    this.scratch = new Float64Array(capacity);
  }

  /** Hot path'ten çağrılır — allocation yok. */
  record(ms: number): void {
    this.buf[this.idx] = ms;
    this.idx = (this.idx + 1) % this.buf.length;
    if (this.filled < this.buf.length) this.filled++;
  }

  get count(): number {
    return this.filled;
  }

  /** @param p 0..1 arası, örn. 0.99 */
  percentile(p: number): number {
    if (this.filled === 0) return 0;
    const n = this.filled;
    // Sıralama girdiyi bozmasın diye scratch'e kopyala (yeni dizi ayırmıyoruz).
    this.scratch.set(this.buf.subarray(0, n));
    const view = this.scratch.subarray(0, n);
    view.sort();
    const rank = Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1));
    return view[rank] ?? 0;
  }

  reset(): void {
    this.idx = 0;
    this.filled = 0;
  }
}

/**
 * Kayan pencerede mesaj/saniye sayacı.
 * Tam doğru değil (1 sn'lik kovalara yuvarlar) ama sağlık paneli için yeterli
 * ve tick başına maliyeti tek bir integer artırımı.
 */
export class RateCounter {
  private buckets = new Float64Array(10); // 10 x 1sn = 10sn pencere
  private lastSec = 0;

  tick(now: number): void {
    const sec = Math.floor(now / 1000);
    if (sec !== this.lastSec) {
      // Aradaki boşlukları temizle (feed sustuysa eski değerler sayılmasın).
      const gap = Math.min(this.buckets.length, sec - this.lastSec);
      for (let i = 0; i < gap; i++) {
        this.buckets[(sec - i) % this.buckets.length] = 0;
      }
      this.lastSec = sec;
    }
    this.buckets[sec % this.buckets.length]! += 1;
  }

  perSec(now: number): number {
    const sec = Math.floor(now / 1000);
    const L = this.buckets.length;
    // Kovalar yalnızca `tick()` sırasında temizleniyor; feed sustuğunda hiç
    // tick gelmediği için eski değerler duruyor ve bir saat sessiz feed bile
    // eski hızını gösteriyordu — "sessiz ölüm" sınıfının panelde canlı
    // görünmesi demek. Pencereden eski son tick → 0; aradaki saniyeler ise
    // tick almadıkları için (kova temizlenmemiş olsa da) sıfır sayılır.
    if (sec - this.lastSec >= L) return 0;
    // Mevcut saniye henüz dolmadığı için onu hariç tutup önceki 9 saniyeye bakarız.
    let sum = 0;
    let n = 0;
    for (let i = 1; i < L; i++) {
      const s = sec - i;
      if (s <= this.lastSec) sum += this.buckets[((s % L) + L) % L]!;
      n++;
    }
    return n > 0 ? sum / n : 0;
  }
}

/**
 * Uçtan uca boru hattı gecikmesi:
 *   exchangeTs → recvTs   (ağ + borsa gecikmesi)
 *   recvTs     → evalTs   (bizim işleme süremiz)
 *   evalTs     → notifyTs (bildirim gönderimi)
 *
 * Ortadaki adım bizim kontrolümüzde olan tek kısım; regresyonu burada yakalarız.
 */
export class PipelineMetrics {
  readonly network = new LatencyTracker();
  readonly processing = new LatencyTracker();
  readonly notify = new LatencyTracker();

  recordNetwork(exchangeTs: number, recvTs: number): void {
    // Borsa saati bizimkiyle senkron olmayabilir; negatif değerleri atarız.
    if (exchangeTs > 0) {
      const d = recvTs - exchangeTs;
      if (d >= 0 && d < 60_000) this.network.record(d);
    }
  }

  summary(): { netP50: number; netP99: number; procP50: number; procP99: number } {
    return {
      netP50: this.network.percentile(0.5),
      netP99: this.network.percentile(0.99),
      procP50: this.processing.percentile(0.5),
      procP99: this.processing.percentile(0.99),
    };
  }
}
