/**
 * Telegram MarkdownV2 biçimlendirme.
 *
 * Kritik nokta: MarkdownV2'de kaçırılan TEK bir özel karakter mesajın
 * tamamını düşürür (Telegram 400 döner). Coin adları kullanıcı verisi değil
 * borsa verisidir ve içinde nokta, tire, alt çizgi geçebilir. Bu yüzden
 * kaçış fonksiyonu ayrıca test ediliyor.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { esc, formatOpportunity, formatRow, level, YESIL_PCT } from '../src/notify/format.ts';
import type { Opportunity, PairKey } from '../src/core/types.ts';

/** Telegram MarkdownV2'nin kaçış zorunlu kıldığı karakterlerin tamamı. */
const OZEL = '_*[]()~`>#+-=|{}.!\\';

test('esc: MarkdownV2 özel karakterlerinin tamamı kaçırılır', () => {
  for (const ch of OZEL) {
    assert.equal(esc(ch), `\\${ch}`, `kaçırılmayan karakter: ${ch}`);
  }
});

test('esc: sıradan metin bozulmaz', () => {
  assert.equal(esc('BTC USDT 123'), 'BTC USDT 123');
});

test('esc: ters bölü tek kez kaçırılır', () => {
  assert.equal(esc('a\\b'), 'a\\\\b');
});

function opp(over: Partial<Opportunity> = {}): Opportunity {
  return {
    id: 'KOIN|binance->kucoin',
    kind: 'cex-cex',
    coin: 'KOIN',
    quote: 'USDT',
    buy: {
      kind: 'cex-buy',
      venue: 'binance',
      pair: 'KOIN/USDT' as PairKey,
      vwap: 1.0,
      bestPrice: 1.0,
      qty: 1000,
      feeQuote: 1,
      ageMs: 120,
    },
    sell: {
      kind: 'cex-sell',
      venue: 'kucoin',
      pair: 'KOIN/USDT' as PairKey,
      vwap: 1.02,
      bestPrice: 1.02,
      qty: 998.5,
      feeQuote: 1.018,
      ageMs: 80,
    },
    chain: 'solana',
    grossQuote: 20,
    netQuote: 17.45,
    netPct: 0.01745,
    costs: { buyFee: 1, sellFee: 1.018, withdrawFee: 0.51, gas: 0, bridge: 0 },
    warnings: [],
    transferVerified: true,
    detectedAt: Date.now(),
    worstAgeMs: 120,
    ...over,
  };
}

/**
 * Mesajdaki her özel karakter ya kaçırılmış ya da bilinçli biçimlendirme
 * olmalı. Biçimlendirme karakterlerini (* ` ) çıkardıktan sonra geriye
 * kaçırılmamış özel karakter kalmamalı.
 */
function kacirilmamisVar(msg: string): string[] {
  const bulunan: string[] = [];
  for (let i = 0; i < msg.length; i++) {
    const ch = msg[i]!;
    // Ters bölü bir sonraki karakteri kaçırır; ikisini birden atla.
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '*' || ch === '`') continue; // bilinçli biçimlendirme
    if (OZEL.includes(ch)) bulunan.push(`${ch}@${i}`);
  }
  return bulunan;
}

test('formatOpportunity: normal fırsatta kaçırılmamış özel karakter yok', () => {
  assert.deepEqual(kacirilmamisVar(formatOpportunity(opp())), []);
});

test('formatOpportunity: nokta ve tire içeren coin adı mesajı bozmaz', () => {
  const m = formatOpportunity(opp({ coin: 'A.B-C_D' }));
  assert.deepEqual(kacirilmamisVar(m), []);
  assert.ok(m.includes('A\\.B\\-C\\_D'));
});

test('formatOpportunity: uyarılar da kaçırılır', () => {
  const m = formatOpportunity(
    opp({ warnings: ['bu fark 75sn\'dir kapanmıyor (çekim kapalı?)', 'alışta %1.20 kayma'] }),
  );
  assert.deepEqual(kacirilmamisVar(m), []);
});

test('formatOpportunity: negatif net kâr mesajı bozmaz', () => {
  assert.deepEqual(kacirilmamisVar(formatOpportunity(opp({ netQuote: -5.2, netPct: -0.005 }))), []);
});

test('formatOpportunity: doğrulanmamış transfer açık uyarı taşır', () => {
  const m = formatOpportunity(opp({ transferVerified: false }));
  assert.ok(m.includes('elle kontrol et'));
  assert.deepEqual(kacirilmamisVar(m), []);
});

test('formatOpportunity: VWAP L1 fiyatından farklıysa ikisi de gösterilir', () => {
  const o = opp();
  const m = formatOpportunity({
    ...o,
    buy: { ...o.buy, vwap: 1.01, bestPrice: 1.0 },
  });
  assert.ok(m.includes('L1:'), 'L1 referansı gösterilmeli');
  assert.deepEqual(kacirilmamisVar(m), []);
});

test('formatOpportunity: zincir yoksa transfer satırı basılmaz', () => {
  const m = formatOpportunity(opp({ chain: null }));
  assert.ok(!m.includes('Transfer:'));
});

// ---------------------------------------------------------------------------
// Terminal satırı
// ---------------------------------------------------------------------------

test('formatRow: verilen genişliği asla aşmaz', () => {
  for (const w of [20, 40, 60, 100]) {
    assert.ok(formatRow(opp(), w).length <= w, `genişlik ${w} aşıldı`);
  }
});

test('formatRow: doğrulanmamış fırsat "?" ile işaretlenir', () => {
  assert.equal(formatRow(opp({ transferVerified: false }), 100)[0], '?');
  assert.equal(formatRow(opp({ transferVerified: true }), 100)[0], ' ');
});

test('formatRow: uzun coin adı sütun düzenini kaydırmaz', () => {
  const kisa = formatRow(opp({ coin: 'BTC' }), 100);
  const uzun = formatRow(opp({ coin: 'ABCDEFGHIJKL' }), 100);
  assert.equal(kisa.length, uzun.length);
});

// ---------------------------------------------------------------------------
// MarkdownV2 kaçışı — SESSİZ mesaj kaybının kaynağı
//
// ÖLÇÜLEN HATA (2026-09-01): çapraz kontrol satırı parantezleri ham bıraktı.
// MarkdownV2'de `(` ve `)` özeldir; kaçışsız TEK karakter Telegram'a mesajın
// TAMAMINI HTTP 400 ile reddettiriyor. `notify()` bunu göremez — o yalnızca
// "sıraya alındı" der, gerçek gönderim `drain()` içinde ve hatası yalnızca bir
// sayaca yazılıyordu. Sonuç: koşu günlüğü "📤 KTA → telegram" derken mesaj
// hiç ulaşmadı.
//
// Bu test tek bir satırı değil, ÇIKTININ TAMAMINI tarıyor: aynı sınıf hata
// yeni bir satır eklendiğinde tekrar edecek.
// ---------------------------------------------------------------------------

/** Kasıtlı biçimlendirmeyi (kalın, kod) söküp geriye kalan metni verir. */
function biciminiSok(s: string): string {
  return s.replace(/\*[^*]*\*/g, '').replace(/`[^`]*`/g, '');
}

/** MarkdownV2'de kaçış İSTEYEN ama kaçırılmamış karakterleri bulur. */
function kacirilmamis(s: string): string[] {
  const ozel = '_[]()~>#+-=|{}.!';
  const bulunan: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (!ozel.includes(c)) continue;
    if (i > 0 && s.charCodeAt(i - 1) === 92) continue;
    bulunan.push(`${c} @${i}`);
  }
  return bulunan;
}

test('çapraz kontrol satırı MarkdownV2 kaçışını bozmaz', () => {
  const o = opp({
    capraz: { kaynak: 'cow', venue: 'aerodrome', sapmaPct: 0.0123 },
  });
  const metin = formatOpportunity(o);

  assert.ok(metin.includes('Çapraz'), 'çapraz satırı basılmalı');
  assert.deepEqual(
    kacirilmamis(biciminiSok(metin)),
    [],
    `kaçırılmamış özel karakter var — Telegram mesajın TAMAMINI düşürür:\n${metin}`,
  );
});

test('negatif sapmada da kaçış bozulmaz', () => {
  const o = opp({
    capraz: { kaynak: 'cow', venue: 'uniswap-v3-base', sapmaPct: -0.0456 },
  });
  assert.deepEqual(kacirilmamis(biciminiSok(formatOpportunity(o))), []);
});

test('kaçış doğrulayıcısı BOZUK metni gerçekten yakalar', () => {
  // Doğrulayıcı boş yere geçmemeli: kaçışsız parantezi görmezse yukarıdaki iki
  // test hiçbir şey ölçmez ve aynı hata sessizce geri döner.
  assert.deepEqual(kacirilmamis(biciminiSok('🔍 Çapraz (cow vs aerodrome)')).length, 2);
  // `String.raw`: düz dizide '\(' TypeScript'te GEÇERSİZ bir kaçıştır ve
  // sessizce '(' olur — asıl hatanın ('\+' → '+') birebir aynısı.
  assert.equal(kacirilmamis(biciminiSok(String.raw`🔍 Çapraz \(cow\)`)).length, 0);
});

test('level: renk eşikleri %1.8 yeşil, %3 sarı, %7 kırmızı', () => {
  assert.equal(YESIL_PCT, 1.8);
  assert.equal(level(0.018), '🟢');
  assert.equal(level(0.03), '🟡');
  assert.equal(level(0.07), '🔴');
});
