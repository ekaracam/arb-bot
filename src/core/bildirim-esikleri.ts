/**
 * Bildirim eşikleri (`config/bildirim-esikleri.json`) — Telegram + sesli uyarı.
 *
 * NEDEN VAR: genel eşik (`YESIL_PCT`, %1.8) her sinyal sınıfına uymuyor.
 * - Tek bir coin kanalı boğabiliyor. Ölçüldü (2026-10-07): ELIZAOS günün 492
 *   kaydının 276'sıydı (%56), net %0.4–8.4.
 * - CEX↔CEX farkları günün kayıtlarının çoğunluğu (315/498) ve kullanıcı
 *   bunları ancak büyük farkta görmek istiyor.
 * Genel eşiği yükseltmek diğer sinyalleri de susturacağı için eşik coin ya da
 * fırsat türü bazında ezilir.
 *
 * ÖNCELİK: coin > tür > genel. En özel tanım kazanır — ELIZAOS'a %10 yazmak,
 * hangi türde gelirse gelsin %10 demektir.
 *
 * Yalnızca bildirimi etkiler. Disk kaydı ve panel değişmez — kalibrasyon
 * verisi kaybolmasın, sinyal görünür kalsın.
 *
 * Ayrıştırma diskten ayrı (`bildirimEsikleriniCoz`) ki test dosya biçimini
 * doğrudan zorlayabilsin.
 */

import type { OpportunityKind } from './types.ts';

const KAYNAK = 'config/bildirim-esikleri.json';
const ALANLAR = new Set(['$aciklama', 'coinler', 'turler']);
const TURLER: readonly OpportunityKind[] = ['cex-cex', 'cex-dex', 'dex-dex'];

export interface BildirimEsikleri {
  /** Coin (büyük harf) → net yüzde eşiği. */
  readonly coinler: ReadonlyMap<string, number>;
  /** Fırsat türü → net yüzde eşiği. */
  readonly turler: ReadonlyMap<OpportunityKind, number>;
}

export const BOS_BILDIRIM_ESIKLERI: BildirimEsikleri = {
  coinler: new Map(),
  turler: new Map(),
};

function nesneMi(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function yuzde(alan: string, ad: string, deger: unknown): number {
  if (typeof deger !== 'number' || !Number.isFinite(deger) || deger <= 0 || deger > 100) {
    throw new Error(
      `${KAYNAK}: ${alan}."${ad}" eşiği 0'dan büyük, en fazla 100 bir sayı olmalı ` +
        `(yüzde olarak, ör. 10) — gelen: ${JSON.stringify(deger)}`,
    );
  }
  return deger;
}

/**
 * Dosya gövdesini çözer.
 *
 * Yanlış yazılmış bir girdi sessizce yok SAYILMAZ, başlangıçta hata verir —
 * `"coinler"` yerine `"coin"` yazmak, kullanıcı ELIZAOS'u susturduğunu
 * sanırken hiçbir şey yapmamak olurdu (izleme listesindeki kuralın aynısı).
 */
export function bildirimEsikleriniCoz(govde: unknown): BildirimEsikleri {
  if (!nesneMi(govde)) throw new Error(`${KAYNAK}: kök bir nesne olmalı`);
  for (const alan of Object.keys(govde)) {
    if (!ALANLAR.has(alan)) {
      throw new Error(`${KAYNAK}: bilinmeyen alan "${alan}" (beklenen: coinler, turler)`);
    }
  }

  const coinler = new Map<string, number>();
  const hamCoinler = govde['coinler'];
  if (hamCoinler !== undefined) {
    if (!nesneMi(hamCoinler)) {
      throw new Error(`${KAYNAK}: "coinler" bir nesne olmalı ({ "COIN": yüzde })`);
    }
    for (const [hamCoin, deger] of Object.entries(hamCoinler)) {
      const coin = hamCoin.trim().toUpperCase();
      if (coin === '') throw new Error(`${KAYNAK}: boş coin adı`);
      // "elizaos" ile "ELIZAOS" aynı coin: ikisi birden yazılmışsa hangisinin
      // geçerli olduğu belirsiz kalır.
      if (coinler.has(coin)) throw new Error(`${KAYNAK}: coinler."${coin}" iki kez tanımlı`);
      coinler.set(coin, yuzde('coinler', hamCoin, deger));
    }
  }

  const turler = new Map<OpportunityKind, number>();
  const hamTurler = govde['turler'];
  if (hamTurler !== undefined) {
    if (!nesneMi(hamTurler)) {
      throw new Error(`${KAYNAK}: "turler" bir nesne olmalı ({ "cex-cex": yüzde })`);
    }
    for (const [tur, deger] of Object.entries(hamTurler)) {
      if (!(TURLER as readonly string[]).includes(tur)) {
        throw new Error(
          `${KAYNAK}: bilinmeyen tür "${tur}" (geçerli: ${TURLER.join(', ')})`,
        );
      }
      turler.set(tur as OpportunityKind, yuzde('turler', tur, deger));
    }
  }

  return { coinler, turler };
}

/** Sinyal için geçerli bildirim eşiği (net yüzde): coin > tür > varsayılan. */
export function bildirimEsigi(
  coin: string,
  tur: OpportunityKind,
  esikler: BildirimEsikleri,
  varsayilanPct: number,
): number {
  return esikler.coinler.get(coin.toUpperCase()) ?? esikler.turler.get(tur) ?? varsayilanPct;
}
