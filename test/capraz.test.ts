/**
 * CoW çapraz kontrolü — ağa çıkmadan.
 *
 * Konusu fiyat doğruluğu değil DAVRANIŞ: "rota yok" (veri) ile "ulaşamıyoruz"
 * (arıza) ayrı sonuçlanmalı, önbellek CoW'un dar kovasını sinyal
 * tekrarlarından korumalı, ve kontrol kendi kendini doğrulamamalı.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CaprazKontrolSeti, CowCaprazKontrol } from '../src/feeds/dex/capraz.ts';
import { COW_CHAINS } from '../src/feeds/dex/cow.ts';
import type { CowQuoter } from '../src/feeds/dex/cow.ts';
import type { TokenEntry } from '../src/core/config.ts';

const TOKENS: TokenEntry[] = [
  { symbol: 'USDC', chain: 'base', address: '0xusdc', decimals: 6 },
  { symbol: 'KOIN', chain: 'base', address: '0xkoin', decimals: 18 },
  // AYNI ticker, başka zincirde FARKLI adres — kimlik kuralının bu testteki
  // karşılığı: arbitrum bacağı base tokenıyla karşılaştırılmamalı.
  { symbol: 'USDC', chain: 'arbitrum', address: '0xarbusdc', decimals: 6 },
  { symbol: 'KOIN', chain: 'arbitrum', address: '0xarbkoin', decimals: 18 },
  { symbol: 'KOIN', chain: 'solana', address: 'koin111', decimals: 9 },
];

function sahteQuoter(
  cikti: bigint | null,
  opts: { firlat?: boolean } = {},
): CowQuoter & { cagri: number } {
  const q = {
    cagri: 0,
    async quote(): Promise<bigint | null> {
      q.cagri++;
      if (opts.firlat) throw new Error('CoW erişimi engellendi (HTTP 403)');
      return cikti;
    },
  };
  return q;
}

test('sapma bizim iyimserliğimizi POZİTİF olarak ölçer', async () => {
  // CoW $1000 için 90 KOIN veriyor, biz 99 hesapladık → %10 iyimseriz.
  const q = sahteQuoter(90n * 10n ** 18n);
  const c = new CowCaprazKontrol('base', TOKENS, q);

  const s = await c.kontrol('aerodrome', 'KOIN', 'buy', 1000, 99);
  assert.ok(s);
  assert.equal(s.kaynak, 'cow');
  assert.ok(Math.abs(s.miktar - 90) < 1e-9);
  assert.ok(Math.abs(s.sapmaPct - 0.1) < 1e-9);
});

test('kötümser yön NEGATİF sapma verir (uyarı üretmeyecek yön)', async () => {
  const q = sahteQuoter(100n * 10n ** 18n);
  const c = new CowCaprazKontrol('base', TOKENS, q);
  const s = await c.kontrol('aerodrome', 'KOIN', 'buy', 1000, 95);
  assert.ok(s && s.sapmaPct < 0);
});

test('"rota yok" null döner ve ÖNBELLEĞE yazılır', async () => {
  const q = sahteQuoter(null);
  const c = new CowCaprazKontrol('base', TOKENS, q);

  assert.equal(await c.kontrol('aerodrome', 'KOIN', 'buy', 1000, 99), null);
  assert.equal(await c.kontrol('aerodrome', 'KOIN', 'buy', 1000, 99), null);
  // Rota yokluğu KALICI bir veri; her sinyal tekrarında yeniden sormak CoW'un
  // dar kovasını boşa harcardı.
  assert.equal(q.cagri, 1);
  assert.equal(c.stats.rotasiz, 1);
});

test('ARIZA önbelleğe yazılmaz — blok geçicidir', async () => {
  // Ölçülmüş ders: CoW'un önündeki CDN geçici blok koyuyor. Arızayı "rota yok"
  // gibi önbelleğe yazmak, blok kalktıktan sonra da tokenı kör bırakırdı.
  const q = sahteQuoter(null, { firlat: true });
  const c = new CowCaprazKontrol('base', TOKENS, q);

  assert.equal(await c.kontrol('aerodrome', 'KOIN', 'buy', 1000, 99), null);
  assert.equal(await c.kontrol('aerodrome', 'KOIN', 'buy', 1000, 99), null);
  assert.equal(q.cagri, 2, 'arıza sonrası yeniden denenmeli');
  assert.equal(c.stats.hata, 2);
  assert.equal(c.stats.rotasiz, 0, 'arıza "rota yok" kovasına düşmemeli');
  assert.ok(c.stats.sonHata?.includes('403'));
});

test('yakın girdide önbellek kullanılır, uzak girdide yeniden sorulur', async () => {
  const q = sahteQuoter(90n * 10n ** 18n);
  const c = new CowCaprazKontrol('base', TOKENS, q);

  await c.kontrol('aerodrome', 'KOIN', 'buy', 1000, 99);
  await c.kontrol('aerodrome', 'KOIN', 'buy', 1020, 99); // %2 → bant içinde
  assert.equal(q.cagri, 1);

  await c.kontrol('aerodrome', 'KOIN', 'buy', 1200, 99); // %20 → bant dışında
  assert.equal(q.cagri, 2);
});

test('cow-base venue’su KENDİSİYLE doğrulanmaz', () => {
  const c = new CowCaprazKontrol('base', TOKENS, sahteQuoter(1n));
  assert.equal(c.destekler('cow-base'), false);
  assert.equal(c.destekler('aerodrome'), true);
  assert.equal(c.destekler('uniswap-v3-base'), true);
});

test('başka zincirin venue’su desteklenmez', () => {
  const c = new CowCaprazKontrol('base', TOKENS, sahteQuoter(1n));
  assert.equal(c.destekler('jupiter'), false);
  assert.equal(c.destekler('raydium'), false);
  assert.equal(c.destekler('camelot'), false);
});

test('base USDC yoksa kontrol hazır değildir (sessizce çalışıyormuş gibi yapmaz)', () => {
  const usdcsiz = TOKENS.filter((t) => !(t.chain === 'base' && t.symbol === 'USDC'));
  const c = new CowCaprazKontrol('base', usdcsiz, sahteQuoter(1n));
  assert.equal(c.ready, false);
  assert.equal(c.destekler('aerodrome'), false);
});

test('satış yönünde girdi base, çıktı quote birimindedir', async () => {
  const cagrilar: string[] = [];
  const q: CowQuoter = {
    async quote(sat, al, miktar) {
      cagrilar.push(`${sat}->${al}:${miktar}`);
      return 750n * 10n ** 6n; // 750 USDC
    },
  };
  const c = new CowCaprazKontrol('base', TOKENS, q);

  const s = await c.kontrol('aerodrome', 'KOIN', 'sell', 100, 800);
  assert.ok(s);
  assert.ok(Math.abs(s.miktar - 750) < 1e-9);
  // 100 KOIN, 18 decimals ile ham birime çevrilmeli.
  assert.equal(cagrilar[0], '0xkoin->0xusdc:100000000000000000000');
});

// ---------------------------------------------------------------------------
// Çok zincirli set (base + arbitrum)
// ---------------------------------------------------------------------------

test('COW_CHAINS elle yazılmaz — base ve arbitrum içerir', () => {
  assert.deepEqual([...COW_CHAINS].sort(), ['arbitrum', 'base']);
});

test('set: her venue KENDİ zincirinin kontrolüne gider', async () => {
  const izler: string[] = [];
  const kaynak = (chain: 'base' | 'arbitrum') => {
    const q: CowQuoter = {
      async quote(sat, al, miktar) {
        izler.push(`${chain}:${sat}->${al}:${miktar}`);
        return 90n * 10n ** 18n;
      },
    };
    return new CowCaprazKontrol(chain, TOKENS, q);
  };
  const set = new CaprazKontrolSeti([kaynak('base'), kaynak('arbitrum')]);

  await set.kontrol('aerodrome', 'KOIN', 'buy', 1000, 99);
  await set.kontrol('camelot', 'KOIN', 'buy', 1000, 99);

  // Adresler zincire göre AYRIŞMALI: arbitrum bacağı base USDC'siyle
  // sorulsaydı, farklı iki tokenı aynı sanmış olurduk.
  assert.deepEqual(izler, [
    'base:0xusdc->0xkoin:1000000000',
    'arbitrum:0xarbusdc->0xarbkoin:1000000000',
  ]);
});

test('set: desteklediği venue’ler iki zincirin birleşimidir', () => {
  const set = new CaprazKontrolSeti([
    new CowCaprazKontrol('base', TOKENS, sahteQuoter(1n)),
    new CowCaprazKontrol('arbitrum', TOKENS, sahteQuoter(1n)),
  ]);
  assert.equal(set.destekler('aerodrome'), true);
  assert.equal(set.destekler('uniswap-v3-base'), true);
  assert.equal(set.destekler('camelot'), true);
  assert.equal(set.destekler('uniswap-v3'), true);
  assert.equal(set.destekler('cow-base'), false);
  assert.equal(set.destekler('jupiter'), false);
});

test('set: sayaçlar toplanır, boş set hazır değildir', async () => {
  const b = new CowCaprazKontrol('base', TOKENS, sahteQuoter(90n * 10n ** 18n));
  const a = new CowCaprazKontrol('arbitrum', TOKENS, sahteQuoter(null));
  const set = new CaprazKontrolSeti([b, a]);

  await set.kontrol('aerodrome', 'KOIN', 'buy', 1000, 99);
  await set.kontrol('camelot', 'KOIN', 'buy', 1000, 99);

  assert.equal(set.stats.denendi, 2);
  assert.equal(set.stats.basarili, 1);
  assert.equal(set.stats.rotasiz, 1);
  assert.equal(set.ready, true);
  assert.equal(new CaprazKontrolSeti([]).ready, false);
});
