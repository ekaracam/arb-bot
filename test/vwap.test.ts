/**
 * VWAP hesabı — botun en kritik mantığı.
 *
 * Burada bir hata olması, gerçekleşmeyecek fiyatlara dayanan sinyaller
 * üretmek demektir. Testler özellikle "kısmi dolum" ve "defter yetersiz"
 * durumlarına odaklanıyor, çünkü sessizce yanlış sonuç veren durumlar
 * bunlar.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buyWithQuote, sellBase, l1Fill } from '../src/engine/vwap.ts';
import type { DepthLevel } from '../src/core/types.ts';

const close = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps;

test('buyWithQuote: tek seviye yeterliyse VWAP en iyi fiyata eşittir', () => {
  const asks: DepthLevel[] = [[100, 10]];
  const r = buyWithQuote(asks, 500);

  assert.equal(r.complete, true);
  assert.ok(close(r.vwap, 100));
  assert.ok(close(r.filledBase, 5));
  assert.ok(close(r.slippage, 0));
});

test('buyWithQuote: birden fazla seviyeye yayılınca VWAP kötüleşir', () => {
  // 100'de 1 adet (=100 USDT), 110'da 10 adet. 1000 USDT harcıyoruz.
  const asks: DepthLevel[] = [
    [100, 1],
    [110, 10],
  ];
  const r = buyWithQuote(asks, 1000);

  assert.equal(r.complete, true);
  // 100 USDT ilk seviyeden 1 adet, kalan 900 USDT 110'dan 8.1818 adet
  const expectedBase = 1 + 900 / 110;
  assert.ok(close(r.filledBase, expectedBase, 1e-9));
  assert.ok(close(r.vwap, 1000 / expectedBase, 1e-9));

  // En iyi fiyat 100'dü, gerçekleşen ~109 → kayma pozitif ve belirgin.
  assert.ok(r.vwap > 100);
  assert.ok(r.slippage > 0.08);
});

test('buyWithQuote: defter yetersizse complete=false döner', () => {
  // Toplam defter değeri 100*1 + 110*1 = 210 USDT, 1000 istiyoruz.
  const asks: DepthLevel[] = [
    [100, 1],
    [110, 1],
  ];
  const r = buyWithQuote(asks, 1000);

  // Bu, "bu boyutta işlem yapılamaz" demektir; tarayıcı fırsatı elemeli.
  assert.equal(r.complete, false);
  assert.ok(r.filledBase > 0);
  assert.ok(r.filledQuote <= 210 + 1e-9);
});

test('buyWithQuote: boş defter güvenli boş sonuç verir', () => {
  const r = buyWithQuote([], 1000);
  assert.equal(r.complete, false);
  assert.equal(r.filledBase, 0);
  assert.equal(r.vwap, 0);
});

test('sellBase: kısmi seviyeler doğru toplanır', () => {
  const bids: DepthLevel[] = [
    [100, 2],
    [90, 5],
  ];
  const r = sellBase(bids, 4);

  assert.equal(r.complete, true);
  // 2 adet 100'den, 2 adet 90'dan = 380 USDT
  assert.ok(close(r.filledQuote, 380));
  assert.ok(close(r.vwap, 95));
  // Satışta kayma fiyatın düşmesidir; pozitif "kötüleşme" olarak raporlanır.
  assert.ok(close(r.slippage, (100 - 95) / 100));
});

test('sellBase: talep defterden büyükse complete=false', () => {
  const bids: DepthLevel[] = [[100, 1]];
  const r = sellBase(bids, 10);
  assert.equal(r.complete, false);
  assert.ok(close(r.filledBase, 1));
});

test('sellBase: sıfır ve negatif seviyeler atlanır', () => {
  const bids: DepthLevel[] = [
    [0, 5],
    [100, 2],
  ];
  const r = sellBase(bids, 2);
  assert.equal(r.complete, true);
  assert.ok(close(r.vwap, 100));
});

test('l1Fill: L1 derinliği yetiyorsa complete, yetmiyorsa değil', () => {
  const enough = l1Fill(100, 10, 5);
  assert.equal(enough.complete, true);
  assert.ok(close(enough.vwap, 100));
  assert.ok(close(enough.filledBase, 5));

  const notEnough = l1Fill(100, 3, 5);
  assert.equal(notEnough.complete, false);
  assert.ok(close(notEnough.filledBase, 3));
});

test('l1Fill: geçersiz fiyat/miktar boş sonuç verir', () => {
  assert.equal(l1Fill(0, 10, 5).filledBase, 0);
  assert.equal(l1Fill(100, 0, 5).filledBase, 0);
});

test('alış ve satış birlikte: kâr hesabı kaymayı içerir', () => {
  // Naif bakış: 100'den al, 105'e sat → %5 kâr.
  // Gerçek: derinlik sığ, iki taraf da kayıyor.
  const asks: DepthLevel[] = [
    [100, 1],
    [104, 100],
  ];
  const bids: DepthLevel[] = [
    [105, 1],
    [101, 100],
  ];

  const buy = buyWithQuote(asks, 1000);
  const sell = sellBase(bids, buy.filledBase);

  assert.equal(buy.complete, true);
  assert.equal(sell.complete, true);

  const naivePct = (105 - 100) / 100;
  const realPct = (sell.vwap - buy.vwap) / buy.vwap;

  // Asıl mesele: gerçek kâr naif hesabın çok altında ve hatta negatif.
  assert.ok(realPct < naivePct);
  assert.ok(realPct < 0, `derinlik sığken bu işlem zararda olmalı, bulunan: ${realPct}`);
});
