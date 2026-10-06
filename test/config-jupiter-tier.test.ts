/**
 * `JUPITER_TIER` — tek doğrulama yeri `loadConfig()` (`jupiterTierCoz`).
 *
 * Ayrı dosyada: config.ts'i değer olarak import etmek `.env`'i süreç ortamına
 * yükler; diğer test dosyalarının ortamını etkilemesin.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { jupiterTierCoz } from '../src/core/config.ts';

test('JUPITER_TIER: boş/tanımsız = free, büyük/küçük harf ve boşluk tolere edilir', () => {
  assert.equal(jupiterTierCoz(undefined), 'free');
  assert.equal(jupiterTierCoz(''), 'free');
  assert.equal(jupiterTierCoz('free'), 'free');
  assert.equal(jupiterTierCoz(' Developer '), 'developer');
});

test('JUPITER_TIER tanınmayan değerde HATA — sessiz varsayılan yok', () => {
  assert.throws(() => jupiterTierCoz('pro'), /JUPITER_TIER geçersiz: "pro"/);
  assert.throws(() => jupiterTierCoz('devloper'), /JUPITER_TIER/);
  assert.throws(() => jupiterTierCoz('launch'), /JUPITER_TIER/);
});
