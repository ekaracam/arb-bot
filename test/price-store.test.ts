/**
 * PriceStore — hot path'in temeli.
 *
 * Buradaki tek hata sınıfı slot aritmetiğidir: yanlış hesaplanan bir slot,
 * bir borsanın fiyatını başka bir borsanın satırına yazar ve motor tamamen
 * uydurma bir spread görür. Sessiz ve felaket bir hata olduğu için slot
 * matematiği ayrıca test ediliyor.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PriceStore } from '../src/book/price-store.ts';
import type { PairKey, VenueId } from '../src/core/types.ts';

const PAIRS = ['A/USDT', 'B/USDT', 'C/USDT'] as PairKey[];
const VENUES = ['binance', 'kucoin', 'okx'] as VenueId[];

test('resolveSlot: her (çift, borsa) kombinasyonu benzersiz slot alır', () => {
  const s = new PriceStore(PAIRS, VENUES);
  const slots = new Set<number>();

  for (const p of PAIRS) {
    for (const v of VENUES) {
      const slot = s.resolveSlot(p, v);
      assert.ok(slot >= 0, `${p}/${v} çözümlenemedi`);
      assert.ok(!slots.has(slot), `slot çakışması: ${p}/${v} → ${slot}`);
      slots.add(slot);
    }
  }
  assert.equal(slots.size, PAIRS.length * VENUES.length);
});

test('slot → çift/borsa dönüşümü resolveSlot ile tutarlı', () => {
  const s = new PriceStore(PAIRS, VENUES);
  for (let pi = 0; pi < PAIRS.length; pi++) {
    for (const v of VENUES) {
      const slot = s.resolveSlot(PAIRS[pi]!, v);
      assert.equal(s.slotVenue(slot), v);
      assert.equal(s.slotPairIndex(slot), pi);
      assert.equal(s.pairAt(s.slotPairIndex(slot)), PAIRS[pi]);
    }
  }
});

test('resolveSlot: tanınmayan çift veya borsa için -1', () => {
  const s = new PriceStore(PAIRS, VENUES);
  assert.equal(s.resolveSlot('YOK/USDT' as PairKey, 'binance'), -1);
  assert.equal(s.resolveSlot(PAIRS[0]!, 'gate'), -1);
});

test('write/read: alanlar birbirine karışmıyor', () => {
  const s = new PriceStore(PAIRS, VENUES);
  const slot = s.resolveSlot(PAIRS[1]!, 'kucoin');
  s.write(slot, 10, 11, 12, 13, 14, 15);

  assert.equal(s.bid(slot), 10);
  assert.equal(s.bidQty(slot), 11);
  assert.equal(s.ask(slot), 12);
  assert.equal(s.askQty(slot), 13);
  assert.equal(s.exchangeTs(slot), 14);
  assert.equal(s.recvTs(slot), 15);
});

test('write bir slota yazmak komşu slotları bozmuyor', () => {
  const s = new PriceStore(PAIRS, VENUES);
  const hedef = s.resolveSlot(PAIRS[1]!, 'kucoin');
  const komsu = s.resolveSlot(PAIRS[1]!, 'okx');

  s.write(komsu, 99, 99, 99, 99, 99, 99);
  s.write(hedef, 1, 2, 3, 4, 5, 6);

  assert.equal(s.bid(komsu), 99);
  assert.equal(s.ask(komsu), 99);
  assert.equal(s.recvTs(komsu), 99);
});

test('hasData: yazılmamış slot veri taşımıyor sayılır', () => {
  const s = new PriceStore(PAIRS, VENUES);
  const slot = s.resolveSlot(PAIRS[0]!, 'okx');
  assert.equal(s.hasData(slot), false);
  s.write(slot, 1, 1, 1, 1, 0, Date.now());
  assert.equal(s.hasData(slot), true);
});

test('flushDirty: aynı çifte birden çok yazma tek kayıt üretir', () => {
  const s = new PriceStore(PAIRS, VENUES);
  const now = Date.now();
  s.write(s.resolveSlot(PAIRS[0]!, 'binance'), 1, 1, 1, 1, now, now);
  s.write(s.resolveSlot(PAIRS[0]!, 'kucoin'), 1, 1, 1, 1, now, now);
  s.write(s.resolveSlot(PAIRS[0]!, 'okx'), 1, 1, 1, 1, now, now);

  const out: number[] = [];
  assert.deepEqual(s.flushDirty(out), [0]);
});

test('flushDirty: tükettikten sonra liste boşalır', () => {
  const s = new PriceStore(PAIRS, VENUES);
  const now = Date.now();
  s.write(s.resolveSlot(PAIRS[2]!, 'binance'), 1, 1, 1, 1, now, now);

  const out: number[] = [];
  assert.deepEqual(s.flushDirty(out), [2]);
  assert.deepEqual(s.flushDirty(out), []);
  assert.equal(s.dirtyCount, 0);
});

test('flushDirty: aynı diziyi yeniden kullanır (allocation yok)', () => {
  const s = new PriceStore(PAIRS, VENUES);
  const now = Date.now();
  const out: number[] = [];

  s.write(s.resolveSlot(PAIRS[0]!, 'binance'), 1, 1, 1, 1, now, now);
  const first = s.flushDirty(out);
  assert.equal(first, out, 'verilen tampon döndürülmeli');

  s.write(s.resolveSlot(PAIRS[1]!, 'binance'), 1, 1, 1, 1, now, now);
  const second = s.flushDirty(out);
  assert.equal(second, out);
  assert.deepEqual(second, [1], 'önceki turun kalıntısı taşınmamalı');
});

test('flush sonrası tekrar yazma çifti yeniden dirty yapar', () => {
  const s = new PriceStore(PAIRS, VENUES);
  const now = Date.now();
  const slot = s.resolveSlot(PAIRS[1]!, 'binance');
  const out: number[] = [];

  s.write(slot, 1, 1, 1, 1, now, now);
  s.flushDirty(out);
  s.write(slot, 2, 2, 2, 2, now, now);
  assert.deepEqual(s.flushDirty(out), [1]);
});
