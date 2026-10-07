import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bildirimEsigi, coinEsikleriniCoz } from '../src/core/coin-esikleri.ts';

test('coin eşikleri: büyük harfe çevrilir, değer yüzde olarak kalır', () => {
  const m = coinEsikleriniCoz({ esikler: { elizaos: 10, PEPE: 5 } });
  assert.equal(m.get('ELIZAOS'), 10);
  assert.equal(m.get('PEPE'), 5);
  assert.equal(m.size, 2);
});

test('coin eşikleri: özel eşik varsa o, yoksa genel eşik', () => {
  const m = coinEsikleriniCoz({ esikler: { ELIZAOS: 10 } });
  assert.equal(bildirimEsigi('ELIZAOS', m, 1.8), 10);
  assert.equal(bildirimEsigi('elizaos', m, 1.8), 10);
  assert.equal(bildirimEsigi('CARDS', m, 1.8), 1.8);
});

test('coin eşikleri: esikler alanı yoksa boş harita', () => {
  assert.equal(coinEsikleriniCoz({ $aciklama: ['not'] }).size, 0);
});

test('coin eşikleri: yanlış alan adı sessizce yok sayılmaz', () => {
  assert.throws(() => coinEsikleriniCoz({ esik: { ELIZAOS: 10 } }), /bilinmeyen alan "esik"/);
});

test('coin eşikleri: geçersiz değer başlangıçta hata verir', () => {
  assert.throws(() => coinEsikleriniCoz({ esikler: { ELIZAOS: '10' } }), /ELIZAOS/);
  assert.throws(() => coinEsikleriniCoz({ esikler: { ELIZAOS: 0 } }), /ELIZAOS/);
  assert.throws(() => coinEsikleriniCoz({ esikler: { ELIZAOS: 150 } }), /ELIZAOS/);
  assert.throws(() => coinEsikleriniCoz({ esikler: [10] }), /nesne/);
  assert.throws(() => coinEsikleriniCoz([]), /kök/);
});

test('coin eşikleri: aynı coin iki yazımla tanımlanamaz', () => {
  assert.throws(
    () => coinEsikleriniCoz({ esikler: { elizaos: 10, ELIZAOS: 5 } }),
    /iki kez/,
  );
});

test('coin eşikleri: depodaki dosya geçerli ve ELIZAOS %10', () => {
  const govde: unknown = JSON.parse(readFileSync('config/coin-esikleri.json', 'utf8'));
  assert.equal(coinEsikleriniCoz(govde).get('ELIZAOS'), 10);
});
