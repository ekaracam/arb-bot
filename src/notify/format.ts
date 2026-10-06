/**
 * Telegram mesaj biçimlendirme (MarkdownV2).
 *
 * Mesajın işi kullanıcıyı ikna etmek değil, KARAR VERDİRMEK: net kâr, gerçek
 * gerçekleşme fiyatları, transfer yolu ve güven düzeyi tek bakışta görünmeli.
 * Bu yüzden ham spread değil VWAP, ve doğrulanmamış veri varsa açık uyarı.
 */

import type { Opportunity } from '../core/types.ts';

/** MarkdownV2 kaçış — eksik kaçış Telegram'da mesajın tamamını düşürür. */
export function esc(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (m) => `\\${m}`);
}

function num(n: number, digits = 2): string {
  return esc(n.toFixed(digits));
}

/** Fiyatın büyüklüğüne göre makul ondalık sayısı. */
function price(n: number): string {
  const d = n >= 1000 ? 2 : n >= 1 ? 4 : n >= 0.01 ? 6 : 8;
  return esc(n.toFixed(d));
}

// Renk eşikleri (net %) kullanıcının seçimi; YEŞİL altı Telegram'a ve sesli uyarıya gitmez.
export const YESIL_PCT = 1.8;
export const SARI_PCT = 3;
export const KIRMIZI_PCT = 7;

export function level(netPct: number): string {
  const p = netPct * 100;
  if (p >= KIRMIZI_PCT) return '🔴';
  if (p >= SARI_PCT) return '🟡';
  return '🟢';
}

export function formatOpportunity(o: Opportunity): string {
  const pct = o.netPct * 100;
  const lines: string[] = [];

  lines.push(`${level(o.netPct)} *${esc(o.coin)}/${esc(o.quote)}* — net *%${num(pct)}*`);
  lines.push('');

  lines.push(
    `📥 AL  \`${esc(o.buy.venue)}\` @ ${price(o.buy.vwap)}` +
      (o.buy.vwap !== o.buy.bestPrice ? ` ${esc('(L1:')} ${price(o.buy.bestPrice)}${esc(')')}` : ''),
  );
  lines.push(
    `📤 SAT \`${esc(o.sell.venue)}\` @ ${price(o.sell.vwap)}` +
      (o.sell.vwap !== o.sell.bestPrice
        ? ` ${esc('(L1:')} ${price(o.sell.bestPrice)}${esc(')')}`
        : ''),
  );

  if (o.chain) {
    lines.push(`🔗 Transfer: \`${esc(o.chain)}\``);
  }
  lines.push('');

  const capital = o.buy.vwap * o.buy.qty;
  lines.push(`💰 Sermaye: ${num(capital)} ${esc(o.quote)}`);
  lines.push(`✅ Net kâr: *${num(o.netQuote)} ${esc(o.quote)}*`);
  lines.push(
    `💸 Maliyet: alım ${num(o.costs.buyFee)} \\+ satım ${num(o.costs.sellFee)}` +
      ` \\+ çekim ${num(o.costs.withdrawFee)}`,
  );
  lines.push(`⏱ Fiyat yaşı: ${esc(String(o.worstAgeMs))}ms`);

  // Çapraz kontrol UYARIDAN AYRI basılıyor ve uyuşma durumunda da görünür.
  // Sebebi: "kontrol edildi ve uydu" ile "hiç kontrol edilmedi" farklı
  // şeylerdir, ama ikisi de sessizlikle temsil edilirse ayırt edilemez —
  // kullanıcı kontrolün hiç çalışmadığı bir gecede sinyale fazladan güvenir.
  if (o.capraz) {
    const sap = o.capraz.sapmaPct * 100;
    // MarkdownV2'de parantez ve artı ÖZEL karakterdir; kaçışsız bırakılan tek
    // karakter mesajın TAMAMINI düşürür (HTTP 400) ve `notify()` bunu göremez,
    // çünkü o yalnızca "sıraya alındı" der. Ölçüldü: bu satırın ilk sürümü
    // parantezleri ham bıraktı ve `capraz` taşıyan ilk sinyal (KTA) hiç
    // ulaşmadı. Metnin tamamı `esc`'ten geçirilerek yazılmalı.
    lines.push(
      `🔍 Çapraz ${esc(`(${o.capraz.kaynak} vs ${o.capraz.venue}):`)} ` +
        `${sap > 0 ? esc('+') : ''}${num(sap)}${esc('%')}`,
    );
  }

  if (o.warnings.length > 0) {
    lines.push('');
    lines.push('⚠️ *Uyarılar*');
    for (const w of o.warnings) lines.push(`• ${esc(w)}`);
  }

  if (!o.transferVerified) {
    lines.push('');
    lines.push(
      esc('Bu borsaların çekim/yatırma durumu public API ile doğrulanamıyor. ') +
        esc('İşlemden önce elle kontrol et.'),
    );
  }

  return lines.join('\n');
}

/** Terminal tablosu için tek satırlık özet. */
export function formatRow(o: Opportunity, width: number): string {
  const pct = (o.netPct * 100).toFixed(2);
  const route = `${o.buy.venue}→${o.sell.venue}`;
  const flag = o.transferVerified ? ' ' : '?';
  const row =
    `${flag}${o.coin.padEnd(12)}` +
    `${(pct + '%').padStart(8)}` +
    `${o.netQuote.toFixed(2).padStart(10)}` +
    `  ${route.padEnd(18)}` +
    `${(o.chain ?? '-').padEnd(9)}` +
    `${(o.worstAgeMs + 'ms').padStart(7)}`;
  return row.length > width ? row.slice(0, width) : row;
}
