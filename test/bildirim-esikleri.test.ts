import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bildirimEsigi, bildirimEsikleriniCoz } from '../src/core/bildirim-esikleri.ts';

test('bildirim eşikleri: coin büyük harfe çevrilir, değer yüzde olarak kalır', () => {
  const e = bildirimEsikleriniCoz({ coinler: { elizaos: 10, PEPE: 5 } });
  assert.equal(e.coinler.get('ELIZAOS'), 10);
  assert.equal(e.coinler.get('PEPE'), 5);
  assert.equal(e.turler.size, 0);
});

test('bildirim eşikleri: öncelik coin > tür > genel', () => {
  const e = bildirimEsikleriniCoz({ coinler: { ELIZAOS: 10 }, turler: { 'cex-cex': 5 } });
  assert.equal(bildirimEsigi('ELIZAOS', 'cex-cex', e, 1.8), 10);
  assert.equal(bildirimEsigi('elizaos', 'cex-dex', e, 1.8), 10);
  assert.equal(bildirimEsigi('CARDS', 'cex-cex', e, 1.8), 5);
  assert.equal(bildirimEsigi('CARDS', 'cex-dex', e, 1.8), 1.8);
  assert.equal(bildirimEsigi('CARDS', 'dex-dex', e, 1.8), 1.8);
});

test('bildirim eşikleri: alanlar yoksa boş', () => {
  const e = bildirimEsikleriniCoz({ $aciklama: ['not'] });
  assert.equal(e.coinler.size, 0);
  assert.equal(e.turler.size, 0);
});

test('bildirim eşikleri: yanlış alan adı sessizce yok sayılmaz', () => {
  assert.throws(() => bildirimEsikleriniCoz({ coin: { ELIZAOS: 10 } }), /bilinmeyen alan "coin"/);
});

test('bildirim eşikleri: bilinmeyen tür hata verir', () => {
  assert.throws(() => bildirimEsikleriniCoz({ turler: { 'cex-cexx': 5 } }), /bilinmeyen tür/);
});

test('bildirim eşikleri: geçersiz değer başlangıçta hata verir', () => {
  assert.throws(() => bildirimEsikleriniCoz({ coinler: { ELIZAOS: '10' } }), /ELIZAOS/);
  assert.throws(() => bildirimEsikleriniCoz({ coinler: { ELIZAOS: 0 } }), /ELIZAOS/);
  assert.throws(() => bildirimEsikleriniCoz({ coinler: { ELIZAOS: 150 } }), /ELIZAOS/);
  assert.throws(() => bildirimEsikleriniCoz({ turler: { 'cex-cex': -1 } }), /cex-cex/);
  assert.throws(() => bildirimEsikleriniCoz({ coinler: [10] }), /nesne/);
  assert.throws(() => bildirimEsikleriniCoz([]), /kök/);
});

test('bildirim eşikleri: aynı coin iki yazımla tanımlanamaz', () => {
  assert.throws(
    () => bildirimEsikleriniCoz({ coinler: { elizaos: 10, ELIZAOS: 5 } }),
    /iki kez/,
  );
});

test('bildirim eşikleri: depodaki dosya geçerli — ELIZAOS %10, cex-cex %5', () => {
  const govde: unknown = JSON.parse(readFileSync('config/bildirim-esikleri.json', 'utf8'));
  const e = bildirimEsikleriniCoz(govde);
  assert.equal(e.coinler.get('ELIZAOS'), 10);
  assert.equal(e.turler.get('cex-cex'), 5);
});
