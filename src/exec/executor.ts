/**
 * Yürütme katmanı — v2 (otomasyon) giriş noktası.
 *
 * v1'de otomatik işlem YOK. Ama v1 bittikten sonra otomasyon eklemek bir
 * yeniden yazım olmasın diye sınırı şimdiden çiziyoruz: motor bir fırsat
 * bulduğunda onu bir ExecutionPlan'a çevirip Executor'a verir. v1'de tek
 * implementasyon NotifyOnlyExecutor'dur ve yalnızca bildirir.
 *
 * v2'de yapılacak tek şey LiveExecutor eklemek; scanner, feed ve fiyat
 * katmanlarının hiçbiri değişmez.
 */

import type { Opportunity, VenueId } from '../core/types.ts';

export type LegState =
  | 'pending'
  | 'buying'
  | 'bought'
  | 'transferring'
  | 'selling'
  | 'sold'
  | 'failed';

export interface PlannedLeg {
  readonly seq: number;
  readonly action: 'buy' | 'withdraw' | 'sell';
  readonly venue: VenueId;
  readonly symbol: string;
  readonly qty: number;
  readonly limitPrice: number;
  /**
   * İdempotans anahtarı. v2'de aynı emrin ağ hatası sonrası iki kez
   * gönderilmesini önler — bu, gerçek parayla çalışırken en tehlikeli
   * hata sınıfıdır.
   */
  readonly clientOrderId: string;
}

export interface ExecutionPlan {
  readonly opportunityId: string;
  readonly createdAt: number;
  readonly legs: readonly PlannedLeg[];
  /** Planın dayandığı beklenen net kâr (quote cinsinden). */
  readonly expectedNetQuote: number;
  readonly capitalRequired: number;
}

export interface Executor {
  readonly name: string;
  /** @returns plan kabul edildiyse true */
  execute(plan: ExecutionPlan, opp: Opportunity): Promise<boolean>;
}

/**
 * Fırsatı yürütülebilir adımlara çevirir.
 *
 * v1'de bu plan yalnızca kayda geçer ve bildirimde gösterilir; kimse
 * çalıştırmaz. Ama planı ŞİMDİ üretmek, otomasyona geçerken hangi bilginin
 * eksik olduğunu bugünden görmemizi sağlıyor.
 */
export function buildPlan(opp: Opportunity, buySymbol: string, sellSymbol: string): ExecutionPlan {
  const stamp = `${opp.id}-${opp.detectedAt}`;
  return {
    opportunityId: opp.id,
    createdAt: opp.detectedAt,
    expectedNetQuote: opp.netQuote,
    capitalRequired: opp.buy.vwap * opp.buy.qty,
    legs: [
      {
        seq: 0,
        action: 'buy',
        venue: opp.buy.venue,
        symbol: buySymbol,
        qty: opp.buy.qty,
        // Limit fiyatı VWAP'a koyuyoruz: piyasa emri beklenenden kötü
        // dolabilir ve arbitrajı zarara çevirebilir.
        limitPrice: opp.buy.vwap,
        clientOrderId: `${stamp}-buy`,
      },
      {
        seq: 1,
        action: 'withdraw',
        venue: opp.buy.venue,
        symbol: opp.coin,
        qty: opp.sell.qty,
        limitPrice: 0,
        clientOrderId: `${stamp}-wd`,
      },
      {
        seq: 2,
        action: 'sell',
        venue: opp.sell.venue,
        symbol: sellSymbol,
        qty: opp.sell.qty,
        limitPrice: opp.sell.vwap,
        clientOrderId: `${stamp}-sell`,
      },
    ],
  };
}

/** v1'in tek yürütücüsü: hiçbir emir göndermez. */
export class NotifyOnlyExecutor implements Executor {
  readonly name = 'notify-only';
  private planned = 0;
  private lastPlan: ExecutionPlan | null = null;

  get plansSeen(): number {
    return this.planned;
  }

  /** En son üretilen plan — otomasyona geçmeden önce gözden geçirmek için. */
  get mostRecentPlan(): ExecutionPlan | null {
    return this.lastPlan;
  }

  async execute(plan: ExecutionPlan): Promise<boolean> {
    this.planned++;
    this.lastPlan = plan;
    // Kasıtlı olarak emir göndermiyor. Otomasyon v2'de LiveExecutor ile gelecek.
    return false;
  }
}
