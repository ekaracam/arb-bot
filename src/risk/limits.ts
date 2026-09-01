/**
 * Risk kontrolleri — v1'de PASİF.
 *
 * v1 hiç emir göndermediği için burada uygulanacak bir şey yok. Yine de
 * kuralları şimdi yazıyoruz ve her fırsatı bunlardan geçiriyoruz: sonuç
 * yalnızca loglanır ve fırsata uyarı olarak eklenir.
 *
 * Faydası şu: otomasyona geçmeden ÖNCE, "eğer bu kurallar açık olsaydı kaç
 * sinyal reddedilirdi" sorusunu gerçek veriyle cevaplayabiliyoruz. Limitleri
 * canlı parayla kalibre etmek pahalı bir öğrenme yöntemi olurdu.
 */

import type { Opportunity } from '../core/types.ts';

export interface RiskLimits {
  /** Tek işlemde riske atılabilecek azami sermaye (quote). */
  readonly maxPositionQuote: number;
  /** Günlük kümülatif kayıp limiti (quote). Aşılırsa kill-switch. */
  readonly maxDailyLossQuote: number;
  /** Bu yaştan eski fiyata dayanan fırsat yürütülmez (ms). */
  readonly maxSignalAgeMs: number;
  /** Doğrulanmamış transfer bilgisiyle işlem yapılsın mı? */
  readonly allowUnverified: boolean;
  /** Gerçekçi olmayacak kadar yüksek kâr — genelde veri hatasıdır. */
  readonly implausibleNetPct: number;
}

export const DEFAULT_LIMITS: RiskLimits = {
  maxPositionQuote: 1000,
  maxDailyLossQuote: 200,
  maxSignalAgeMs: 2000,
  allowUnverified: false,
  // %20 üzeri "fırsat" neredeyse her zaman bozuk fiyat, delist edilmiş coin
  // veya çekimi kapalı bir varlıktır. Otomasyonda bunlara girmek felakettir.
  implausibleNetPct: 0.2,
};

export interface RiskVerdict {
  readonly allowed: boolean;
  readonly reasons: readonly string[];
}

export class RiskManager {
  private dailyPnl = 0;
  private dayStamp = '';
  private killed = false;
  private blockedCount = 0;

  constructor(private readonly limits: RiskLimits = DEFAULT_LIMITS) {}

  get stats() {
    return {
      dailyPnl: this.dailyPnl,
      killed: this.killed,
      blocked: this.blockedCount,
    };
  }

  /** v1'de sonucu yalnızca raporlanır, uygulanmaz. */
  check(opp: Opportunity): RiskVerdict {
    this.rollDay();
    const reasons: string[] = [];

    if (this.killed) {
      reasons.push('kill-switch aktif (günlük kayıp limiti aşıldı)');
    }

    // Kayan nokta toleransı: işlem büyüklüğü limitle aynı ayarlandığında
    // (tipik durum) 1000.0000000000001 > 1000 karşılaştırması her fırsatı
    // gereksizce işaretliyordu.
    const capital = opp.buy.vwap * opp.buy.qty;
    if (capital > this.limits.maxPositionQuote * (1 + 1e-9)) {
      reasons.push(
        `sermaye ${capital.toFixed(0)} > limit ${this.limits.maxPositionQuote}`,
      );
    }

    if (opp.worstAgeMs > this.limits.maxSignalAgeMs) {
      reasons.push(`sinyal yaşı ${opp.worstAgeMs}ms > ${this.limits.maxSignalAgeMs}ms`);
    }

    if (!opp.transferVerified && !this.limits.allowUnverified) {
      reasons.push('transfer durumu doğrulanmamış');
    }

    if (opp.netPct > this.limits.implausibleNetPct) {
      reasons.push(
        `net %${(opp.netPct * 100).toFixed(1)} gerçekçi değil — muhtemelen veri hatası veya çekimi kapalı coin`,
      );
    }

    if (reasons.length > 0) this.blockedCount++;
    return { allowed: reasons.length === 0, reasons };
  }

  /** v2'de gerçekleşen işlem sonucu buraya bildirilecek. */
  recordPnl(quote: number): void {
    this.rollDay();
    this.dailyPnl += quote;
    if (this.dailyPnl <= -this.limits.maxDailyLossQuote) {
      this.killed = true;
    }
  }

  private rollDay(): void {
    const day = new Date().toISOString().slice(0, 10);
    if (day !== this.dayStamp) {
      this.dayStamp = day;
      this.dailyPnl = 0;
      this.killed = false;
    }
  }
}
