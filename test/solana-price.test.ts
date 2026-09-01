/**
 * Tarama periyodunun kaynak limitinden türetilmesi.
 *
 * Sabit periyot yazmak, token listesi büyüdüğünde SESSİZ bir hata üretir:
 * tur başına istek sayısı artar, kaynak 429 döndürmeye başlar, feed açık kalır
 * ve panel "live" derken fiyatlar bayatlar. Periyodu limitten türetmek bu hata
 * sınıfını baştan imkânsız kılıyor — o yüzden davranış burada sabitleniyor.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  guvenliAralik,
  GeckoTerminalPriceSource,
  JupiterPriceSource,
  createSolanaPriceSource,
} from '../src/feeds/dex/solana-price.ts';

test('limit bolca yetiyorsa taban periyot korunur', () => {
  // 1 istek/tur, dakikada 600 hakkımız var: 5 sn taban rahatça sığar.
  assert.equal(guvenliAralik(1, 600, 5000), 5000);
});

test('limit yetmiyorsa periyot uzatılır', () => {
  // 4 istek/tur, dakikada 30 hak → %80 doluluk hedefiyle 10 sn.
  assert.equal(guvenliAralik(4, 30, 5000), 10_000);
});

test('pay sıfır ya da negatifse taban korunur', () => {
  assert.equal(guvenliAralik(4, 30, 5000, 0), 5000);
});

test('token listesi büyüdükçe periyot da büyür', () => {
  const az = guvenliAralik(2, 30, 5000);
  const cok = guvenliAralik(8, 30, 5000);
  assert.ok(cok > az, 'daha çok istek daha uzun periyot gerektirmeli');
});

test('periyot hiçbir zaman tabanın altına inmez', () => {
  assert.equal(guvenliAralik(1, 100_000, 5000), 5000);
});

test('anlamsız girdi tabanı bozmaz', () => {
  assert.equal(guvenliAralik(0, 30, 5000), 5000);
  assert.equal(guvenliAralik(4, 0, 5000), 5000);
});

test('tarama payı düştükçe periyot uzar', () => {
  // Aşama 2 ile kova paylaşan kaynakta pay düşüktür; periyot bunu yansıtmalı.
  const paylasan = guvenliAralik(3, 60, 5000, 0.35);
  const ozel = guvenliAralik(3, 60, 5000, 0.8);
  assert.ok(paylasan > ozel);
  assert.equal(paylasan, 8572);
});

test('jupiter lite: 113 mint taramaya kovanın yalnızca bir kısmını verir', () => {
  // Ölçülen hata: 5 sn'lik tarama kovayı doldurup doğrulamayı aç bırakıyordu
  // (kuyruk 40'ta sabit, 28 binden fazla aday doğrulanamadan atıldı).
  const s = new JupiterPriceSource(null);
  const chunks = Math.ceil(113 / s.chunkSize);
  assert.equal(chunks, 3);
  assert.ok(guvenliAralik(chunks, s.perMinute, 5000, s.taramaPayi) > 5000);
});

test('geckoterminal limiti ÖLÇÜLEN değerden gelir', () => {
  // Belge 30/dk diyor ama 24/dk'da 429 alındı. perMinute belgeye göre
  // yazılırsa feed sessizce 429 yemeye başlar.
  const s = new GeckoTerminalPriceSource();
  assert.ok(s.perMinute <= 10, 'ölçülen sınır belgelenenin altında');
  assert.equal(Math.ceil(113 / s.chunkSize), 4);
});

test('jupiter anahtarlı/anahtarsız farklı limit bildirir', () => {
  // Anahtarsız lite-api dar; anahtar limiti belirgin biçimde açar. Aynı
  // sayıyı döndürselerdi periyot hesabı anahtarı görmezden gelirdi.
  assert.ok(new JupiterPriceSource(null).perMinute < new JupiterPriceSource('k').perMinute);
});

test('kaynak seçimi ada göre doğru sınıfı verir', () => {
  assert.equal(createSolanaPriceSource('geckoterminal', null).ad, 'geckoterminal');
  assert.equal(createSolanaPriceSource('jupiter', null).ad, 'jupiter');
});
