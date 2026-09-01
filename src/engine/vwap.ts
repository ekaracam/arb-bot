/**
 * Gerçekleşebilir fiyat hesabı.
 *
 * Botun en önemli fikri burada: EN İYİ FİYAT, ALABİLECEĞİN FİYAT DEĞİLDİR.
 * Best ask 100 USDT'de 3 adet coin gösteriyorsa ve sen 1000 USDT'lik almak
 * istiyorsan, gerçek maliyetin defterin daha derin seviyelerine yayılır.
 * Ham spread'e bakan bir bot bu yüzden var olmayan fırsatlar bildirir.
 *
 * Buradaki fonksiyonlar defter seviyelerini yürüyerek gerçek ortalama fiyatı
 * ve talebin karşılanıp karşılanmadığını döndürür.
 */

import type { DepthLevel } from '../core/types.ts';

export interface FillResult {
  /** Gerçekleşen ortalama fiyat. Talep karşılanamadıysa kısmi doluma ait. */
  readonly vwap: number;
  /** Gerçekten alınabilen/satılabilen base miktarı. */
  readonly filledBase: number;
  /** Harcanan/elde edilen quote tutarı. */
  readonly filledQuote: number;
  /** Talebin tamamı karşılandı mı? */
  readonly complete: boolean;
  /** En iyi fiyata göre kayma oranı (0.01 = %1). */
  readonly slippage: number;
}

const EMPTY: FillResult = {
  vwap: 0,
  filledBase: 0,
  filledQuote: 0,
  complete: false,
  slippage: 0,
};

/**
 * Verilen quote tutarıyla ask tarafından alım.
 * @param asks artan fiyat sırasında olmalı
 */
export function buyWithQuote(asks: readonly DepthLevel[], quoteAmount: number): FillResult {
  if (asks.length === 0 || !(quoteAmount > 0)) return EMPTY;

  const best = asks[0]![0];
  let remainingQuote = quoteAmount;
  let filledBase = 0;
  let filledQuote = 0;

  for (let i = 0; i < asks.length; i++) {
    const [price, qty] = asks[i]!;
    if (!(price > 0) || !(qty > 0)) continue;

    const levelQuote = price * qty;
    if (levelQuote >= remainingQuote) {
      filledBase += remainingQuote / price;
      filledQuote += remainingQuote;
      remainingQuote = 0;
      break;
    }
    filledBase += qty;
    filledQuote += levelQuote;
    remainingQuote -= levelQuote;
  }

  if (filledBase <= 0) return EMPTY;
  const vwap = filledQuote / filledBase;
  return {
    vwap,
    filledBase,
    filledQuote,
    complete: remainingQuote <= 1e-9,
    slippage: best > 0 ? (vwap - best) / best : 0,
  };
}

/**
 * Verilen base miktarını bid tarafına satış.
 * @param bids azalan fiyat sırasında olmalı
 */
export function sellBase(bids: readonly DepthLevel[], baseAmount: number): FillResult {
  if (bids.length === 0 || !(baseAmount > 0)) return EMPTY;

  const best = bids[0]![0];
  let remainingBase = baseAmount;
  let filledBase = 0;
  let filledQuote = 0;

  for (let i = 0; i < bids.length; i++) {
    const [price, qty] = bids[i]!;
    if (!(price > 0) || !(qty > 0)) continue;

    if (qty >= remainingBase) {
      filledBase += remainingBase;
      filledQuote += remainingBase * price;
      remainingBase = 0;
      break;
    }
    filledBase += qty;
    filledQuote += qty * price;
    remainingBase -= qty;
  }

  if (filledBase <= 0) return EMPTY;
  const vwap = filledQuote / filledBase;
  return {
    vwap,
    filledBase,
    filledQuote,
    complete: remainingBase <= 1e-9,
    // Satışta kayma fiyatın DÜŞMESİ yönündedir; işareti alışla tutarlı
    // tutmak için pozitif "kötüleşme" olarak veriyoruz.
    slippage: best > 0 ? (best - vwap) / best : 0,
  };
}

/**
 * Yalnızca L1 verisiyle (tek seviye) hızlı tahmin.
 *
 * Ön-filtre aşamasında kullanılır: L1 derinliği talebi zaten karşılıyorsa
 * L2 çekmeye gerek yok — REST çağrısından tasarruf ederiz ve gecikme eklemeyiz.
 * Karşılamıyorsa `complete: false` döner ve çağıran L2'ye başvurur.
 */
export function l1Fill(price: number, qty: number, neededBase: number): FillResult {
  if (!(price > 0) || !(qty > 0)) return EMPTY;
  const filledBase = Math.min(qty, neededBase);
  return {
    vwap: price,
    filledBase,
    filledQuote: filledBase * price,
    complete: qty >= neededBase,
    slippage: 0,
  };
}
