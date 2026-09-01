/**
 * Raydium venue'sü — ağa çıkmayan kısımlar.
 *
 * Konusu quote matematiği değil KİMLİK: aynı zincirde iki DEX venue'sü olunca
 * "hangi bacağı kime soruyoruz" sorusu yapısal hale geliyor. Yanlış cevap
 * sessizdir — Raydium'da ölçülen fiyat Jupiter rotasıyla doğrulanır, sayı
 * makul görünür, ama o rota uygulanamaz.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  JupiterLegQuoter,
  RaydiumLegQuoter,
  VenueLegQuoter,
  type DexLegQuoter,
} from '../src/feeds/dex/leg-quoter.ts';
import type { TokenEntry } from '../src/core/config.ts';
import { DEX_CHAIN, DEX_IDS } from '../src/core/types.ts';

const TOKENS: TokenEntry[] = [
  { symbol: 'USDC', chain: 'solana', address: 'usdc111', decimals: 6 },
  { symbol: 'KOIN', chain: 'solana', address: 'koin111', decimals: 9 },
];

test('raydium DEX_IDS ve DEX_CHAIN’de tanımlı', () => {
  assert.ok(DEX_IDS.includes('raydium'));
  assert.equal(DEX_CHAIN['raydium'], 'solana');
});

test('JupiterLegQuoter raydium bacağını CEVAPLAMAZ', async () => {
  // Zincir bazlı imzada bu çağrı sessizce Jupiter rotasını döndürüyordu.
  const q = new JupiterLegQuoter(TOKENS, {
    async quote() {
      return { price: 1, inAmount: 1, outAmount: 500, priceImpact: 0, hops: 1 };
    },
  });
  assert.equal(await q.buy('raydium', 'KOIN', 1000), null);
  assert.equal(await q.buy('jupiter', 'KOIN', 1000), 500);
});

test('RaydiumLegQuoter jupiter bacağını CEVAPLAMAZ', async () => {
  const q = new RaydiumLegQuoter(TOKENS, {
    async quote() {
      return 500 * 10 ** 9;
    },
  });
  assert.equal(await q.buy('jupiter', 'KOIN', 1000), null);
  assert.equal(await q.buy('raydium', 'KOIN', 1000), 500);
});

test('RaydiumLegQuoter ham miktarı decimals ile insan birimine çevirir', async () => {
  const cagrilar: string[] = [];
  const q = new RaydiumLegQuoter(TOKENS, {
    async quote(gir: string, cik: string, miktar: bigint) {
      cagrilar.push(`${gir}->${cik}:${miktar}`);
      // satış: 2 KOIN → 7.5 USDC (6 decimals)
      return 7_500_000;
    },
  });

  assert.equal(await q.sell('raydium', 'KOIN', 2), 7.5);
  // Girdi KOIN'in decimals'ıyla (9) ham birime çevrilmeli.
  assert.equal(cagrilar[0], 'koin111->usdc111:2000000000');
});

test('VenueLegQuoter her venue’yu kendi doğrulayıcısına yollar', async () => {
  const izler: string[] = [];
  const sahte = (ad: string): DexLegQuoter => ({
    async buy(v) {
      izler.push(`${ad}:buy:${v}`);
      return 1;
    },
    async sell(v) {
      izler.push(`${ad}:sell:${v}`);
      return 1;
    },
  });

  const r = new VenueLegQuoter(
    new Map([
      ['jupiter', sahte('jup')],
      ['raydium', sahte('ray')],
    ]),
  );

  await r.buy('jupiter', 'KOIN', 1);
  await r.sell('raydium', 'KOIN', 1);
  assert.deepEqual(izler, ['jup:buy:jupiter', 'ray:sell:raydium']);
});

test('VenueLegQuoter tanımadığı venue için null döner (sessizce yanlış cevap vermez)', async () => {
  const r = new VenueLegQuoter(new Map());
  assert.equal(await r.buy('raydium', 'KOIN', 1), null);
});

test('rota yoksa quote token eksikse doğrulayıcı hazır değildir', () => {
  const usdcsiz: TokenEntry[] = [
    { symbol: 'KOIN', chain: 'solana', address: 'koin111', decimals: 9 },
  ];
  assert.equal(
    new RaydiumLegQuoter(usdcsiz, { async quote() { return null; } }).ready,
    false,
  );
});

// ---------------------------------------------------------------------------
// Üstel geri çekilme
//
// ÖLÇÜLEN HATA (canlı koşu, 2026-09-01): `transaction-v1.raydium.io` 12 dakika
// sürekli yükten sonra IP'yi blokladı — 20/20 istek **429 + HTML gövde**, 7 ms.
// Quoter'da fren olmadığı için bot bloklu uca dakikada ~120 istek atmayı
// sürdürdü; WAF kararını süregelen yüke göre verdiğinden bu kendi kendini
// besleyen bir tuzak (CoW'da ölçülmüş dersin aynısı).
// ---------------------------------------------------------------------------

import { RaydiumQuoter, raydiumHatasiMi } from '../src/feeds/dex/raydium.ts';
import { HttpError } from '../src/core/http.ts';

test('raydiumHatasiMi: JSON gövde veri, HTML gövde arızadır', () => {
  assert.equal(raydiumHatasiMi('{"success":false,"msg":"no route"}'), true);
  assert.equal(raydiumHatasiMi('<!doctype html><html>429</html>'), false);
  assert.equal(raydiumHatasiMi(''), false);
});

/** httpJson'ı taklit eden quoter: her çağrıda verilen hatayı fırlatır. */
function arizaliQuoter(hata: Error): { q: RaydiumQuoter; sayac: () => number } {
  let n = 0;
  const q = new RaydiumQuoter();
  const orijinal = globalThis.fetch;
  // fetch'i değil httpJson'ı değiştiremiyoruz; bunun yerine fetch'i sahteliyoruz.
  globalThis.fetch = (async () => {
    n++;
    throw hata;
  }) as typeof globalThis.fetch;
  return {
    q,
    sayac: () => {
      globalThis.fetch = orijinal;
      return n;
    },
  };
}

test('ardışık ARIZA sonrası istek atılmaz (bloklu uca yüklenilmez)', async () => {
  const html = '<!doctype html><html>429</html>';
  const { q, sayac } = arizaliQuoter(new HttpError(429, 'x', html));
  let firlatan = 0;

  // Tolerans 3: ilk üç deneme uca gider, sonrası geri çekilmeye takılır.
  for (let i = 0; i < 8; i++) {
    // Her çağrı FARKLI anahtar kullanmalı, yoksa önbellek devreye girer.
    await q.quote('in', `out${i}`, BigInt(1000 + i)).catch(() => {
      firlatan++;
    });
  }
  const istek = sayac();

  assert.ok(firlatan >= 3, 'arıza yutulmamalı — sayaç doğru kovaya düşsün');
  assert.ok(istek <= 3, `bloklandıktan sonra istek atılmamalı, atılan: ${istek}`);
  assert.ok(q.stats.bloklu > 0, 'geri çekilme penceresi açılmalı');
  assert.ok(q.stats.sonHata?.includes('429'));
});
