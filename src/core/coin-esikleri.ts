/**
 * Coin bazında bildirim eşikleri (`config/coin-esikleri.json`).
 *
 * NEDEN VAR: tek bir coin bildirim kanalını boğabiliyor. Ölçüldü
 * (2026-10-07): ELIZAOS günün 492 kaydının 276'sıydı (%56), net %0.4–8.4.
 * Genel eşiği (`YESIL_PCT`) yükseltmek diğer coinlerin sinyalini de keserdi;
 * eşik coin bazında ezilir.
 *
 * Yalnızca Telegram + sesli uyarıyı etkiler. Disk kaydı ve panel değişmez —
 * kalibrasyon verisi kaybolmasın, sinyal görünür kalsın.
 *
 * Ayrıştırma ağdan/diskten ayrı (`coinEsikleriniCoz`) ki test dosya
 * biçimini doğrudan zorlayabilsin.
 */

/** Dosyada izin verilen üst seviye alanlar. */
const ALANLAR = new Set(['$aciklama', 'esikler']);

/**
 * Dosya gövdesini çözer: coin (büyük harf) → net yüzde eşiği.
 *
 * Yanlış yazılmış bir girdi sessizce yok SAYILMAZ, başlangıçta hata verir —
 * `"esikler"` yerine `"esik"` yazmak, kullanıcı ELIZAOS'u susturduğunu
 * sanırken hiçbir şey yapmamak olurdu (izleme listesindeki kuralın aynısı).
 */
export function coinEsikleriniCoz(govde: unknown): ReadonlyMap<string, number> {
  const kaynak = 'config/coin-esikleri.json';
  if (typeof govde !== 'object' || govde === null || Array.isArray(govde)) {
    throw new Error(`${kaynak}: kök bir nesne olmalı`);
  }
  for (const alan of Object.keys(govde)) {
    if (!ALANLAR.has(alan)) {
      throw new Error(`${kaynak}: bilinmeyen alan "${alan}" (beklenen: esikler)`);
    }
  }
  const esikler = (govde as Record<string, unknown>)['esikler'];
  if (esikler === undefined) return new Map();
  if (typeof esikler !== 'object' || esikler === null || Array.isArray(esikler)) {
    throw new Error(`${kaynak}: "esikler" bir nesne olmalı ({ "COIN": yüzde })`);
  }

  const sonuc = new Map<string, number>();
  for (const [hamCoin, deger] of Object.entries(esikler)) {
    const coin = hamCoin.trim().toUpperCase();
    if (coin === '') throw new Error(`${kaynak}: boş coin adı`);
    if (typeof deger !== 'number' || !Number.isFinite(deger) || deger <= 0 || deger > 100) {
      throw new Error(
        `${kaynak}: "${hamCoin}" eşiği 0'dan büyük, en fazla 100 bir sayı olmalı ` +
          `(yüzde olarak, ör. 10) — gelen: ${JSON.stringify(deger)}`,
      );
    }
    // "elizaos" ile "ELIZAOS" aynı coin: ikisi birden yazılmışsa hangisinin
    // geçerli olduğu belirsiz kalır.
    if (sonuc.has(coin)) throw new Error(`${kaynak}: "${coin}" iki kez tanımlı`);
    sonuc.set(coin, deger);
  }
  return sonuc;
}

/** Coin için geçerli bildirim eşiği (net yüzde): özel tanım yoksa varsayılan. */
export function bildirimEsigi(
  coin: string,
  esikler: ReadonlyMap<string, number>,
  varsayilanPct: number,
): number {
  return esikler.get(coin.toUpperCase()) ?? varsayilanPct;
}
