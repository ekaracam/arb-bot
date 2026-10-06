/**
 * Kaldıraçlı token elemesi.
 *
 * Bu filtre iki yönde de pahalıdır: kaldıraçlı bir token'ı kaçırmak sahte
 * fırsat üretir (BTC3L'in fiyatı BTC'yi izlemez), gerçek bir coini elemek ise
 * SESSİZ kapsam kaybıdır — çift hiç oluşmaz, hiçbir yerde hata görünmez.
 *
 * İkinci hata canlı olarak yaşandı: JUP "UP" ile bittiği için altı borsada da
 * listeli olmasına rağmen hiç taranmadı.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isLeveragedTicker,
  usdVekiliUygula,
  type VenueMarket,
} from '../src/normalize/symbol-registry.ts';
import type { CexId, PairKey } from '../src/core/types.ts';

test('gerçek kaldıraçlı token’lar elenir', () => {
  for (const t of ['BTC3L', 'BTC3S', 'ETH5L', 'ETHUP', 'BTCDOWN', 'ETHBULL', 'ADABEAR']) {
    assert.equal(isLeveragedTicker(t), true, `${t} kaldıraçlı sayılmalıydı`);
  }
});

test('sonek gerçek coin adının parçasıysa elenmez', () => {
  // Hepsi altı borsada listeli gerçek varlıklar; taban üç karakterden kısa
  // olduğu için sonek kalıbına takılmamalılar.
  for (const t of ['JUP', 'SUP', 'CUP', 'SOUP']) {
    assert.equal(isLeveragedTicker(t), false, `${t} elenmemeliydi`);
  }
});

test('rakamla başlayan gerçek ticker’lar elenmez', () => {
  for (const t of ['1INCH', '2Z']) {
    assert.equal(isLeveragedTicker(t), false, `${t} elenmemeliydi`);
  }
});

test('sonek içeren ama sonda olmayan ticker elenmez', () => {
  for (const t of ['PUMP', 'TRUMP', 'UPTOKEN', 'BULLISH1']) {
    assert.equal(isLeveragedTicker(t), false, `${t} elenmemeliydi`);
  }
});

// ---------------------------------------------------------------------------
// Kraken USD → USDT vekili
// ---------------------------------------------------------------------------
//
// `pairKey` quote'u içerdiği için `KTA/USD` ile `KTA/USDT` ayrı çiftlerdir ve
// karşılaştırılmazlar. Kraken'in USDT piyasası dar olduğundan, orada listeli
// bir coin başka borsada USDT'de listeliyken çift hiç oluşmuyordu — ölçüldü:
// 54 coin (KTA, MSOL, JITOSOL, WBT, BGB…) bu yüzden HİÇ taranmıyordu.

function mkt(venueSymbol: string, base: string, quote: string): VenueMarket {
  return { venueSymbol, base, quote, pair: `${base}/${quote}` as PairKey };
}

test('USDT çifti YOKSA USD çifti USDT yerine sayılır', () => {
  const vekil = new Set<string>();
  const kayit = new Map<string, Set<CexId>>();
  const out = usdVekiliUygula([mkt('KTA/USD', 'KTA', 'USD')], vekil, 'kraken', kayit);

  const usdt = out.find((m) => m.quote === 'USDT');
  assert.ok(usdt, 'USDT vekili üretilmeli');
  assert.equal(usdt!.pair, 'KTA/USDT');
  // venueSymbol DEĞİŞMEMELİ: borsaya hâlâ KTA/USD diye abone oluyoruz.
  // Değiştirmek sessiz bir abonelik hatası olurdu — bağlantı açık kalır,
  // çift hiç veri almaz.
  assert.equal(usdt!.venueSymbol, 'KTA/USD');
  assert.ok(vekil.has('KTA'));
  assert.ok(kayit.get('KTA')?.has('kraken'));
});

test('USDT çifti VARSA USD çifti vekil YAPILMAZ', () => {
  const vekil = new Set<string>();
  const kayit = new Map<string, Set<CexId>>();
  const out = usdVekiliUygula(
    [mkt('BTC/USD', 'BTC', 'USD'), mkt('BTC/USDT', 'BTC', 'USDT')],
    vekil,
    'kraken',
    kayit,
  );

  // Gerçek USDT çifti varken doğru karşılaştırma odur. Vekil de eklemek aynı
  // coini iki kez, biri baz riski taşıyan iki fiyatla taramak olurdu.
  assert.equal(out.filter((m) => m.quote === 'USDT').length, 1);
  assert.equal(vekil.size, 0, 'BTC vekil listesine girmemeli');
});

test('vekil orijinal USD kaydını SİLMEZ', () => {
  const out = usdVekiliUygula(
    [mkt('KTA/USD', 'KTA', 'USD')],
    new Set(),
    'kraken',
    new Map(),
  );
  // `quotes` listesine USD eklenirse o çift ayrıca taranabilmeli.
  assert.ok(out.some((m) => m.quote === 'USD' && m.pair === 'KTA/USD'));
});

test('kaldıraçlı kalıbı: sonek ancak taban aynı borsada listeliyse sayılır (SYRUP)', () => {
  // İkinci ölçülen kurban: SYRUP ("SYR"+"UP") üç karakter şartını geçtiği için
  // kaldıraçlı sayılıyor ve hiç taranmıyordu. Kimlik kuralı: taban listeli mi?
  const bases = new Set(['BTC', 'ETH', 'OP', 'SYRUP', 'JUP', 'GROUP', 'SOL']);
  for (const t of ['BTC3L', 'ETHUP', 'OP3L', 'SOLDOWN', 'ETHBULL']) {
    assert.equal(isLeveragedTicker(t, bases), true, `${t} kaldıraçlı sayılmalıydı`);
  }
  for (const t of ['SYRUP', 'JUP', 'GROUP', 'STARTUP', 'PITBULL', 'SOUP']) {
    assert.equal(isLeveragedTicker(t, bases), false, `${t} elenmemeliydi`);
  }
  // Küme verilmezse yaklaşık kalıp: taban ≥ 3 karakter.
  assert.equal(isLeveragedTicker('BTC3L'), true);
  assert.equal(isLeveragedTicker('JUP'), false);
});
