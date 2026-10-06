/**
 * DexQuoter (Jupiter Aşama 2) — ARIZA ile "rota yok" ayrımı.
 *
 * ÖLÇÜLEN HATA: panel `665 denendi │ 16 başarılı │ 643 rota yok` derken o
 * 643'ün neredeyse tamamı HTTP 429'du. Her hata `null` + önbellek olarak
 * yutulduğu için kota tükenmesi likidite yokluğu gibi raporlanıyor ve bakan
 * kişi tokenları silmeye yöneliyordu. CoW'daki `errorType` testi buraya
 * kopyalanamaz: Jupiter "rota yok"u HTTP 400 + `errorCode` alanlı JSON ile,
 * kota aşımını ise düz metinli 429 ile verir.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DexQuoter, jupiterHatasiMi } from '../src/feeds/dex/jupiter.ts';
import { HttpError } from '../src/core/http.ts';

test('jupiterHatasiMi: errorCode alanlı JSON veri, düz metin arızadır', () => {
  assert.equal(
    jupiterHatasiMi('{"error":"Could not find any route","errorCode":"COULD_NOT_FIND_ANY_ROUTE"}'),
    true,
  );
  assert.equal(jupiterHatasiMi('Rate limit exceeded, please try again later.'), false);
  assert.equal(jupiterHatasiMi('<html>503</html>'), false);
  assert.equal(jupiterHatasiMi(''), false);
});

/** fetch'i sahteler: her çağrıda verilen hatayı fırlatır, çağrıları sayar. */
function arizaliFetch(hata: Error): { sayac: () => number; geriYukle: () => void } {
  let n = 0;
  const orijinal = globalThis.fetch;
  globalThis.fetch = (async () => {
    n++;
    throw hata;
  }) as typeof globalThis.fetch;
  return { sayac: () => n, geriYukle: () => void (globalThis.fetch = orijinal) };
}

test('429 "rota yok" DEĞİLDİR: fırlatılır ve önbelleğe YAZILMAZ', async () => {
  const f = arizaliFetch(new HttpError(429, 'x', 'Rate limit exceeded, please try again later.'));
  try {
    const q = new DexQuoter();
    await assert.rejects(() => q.quote('in', 'out', 1000n, 6, 9), /429/);
    // Önbellekte `null` olsaydı ikinci çağrı fetch'e hiç gitmezdi.
    await assert.rejects(() => q.quote('in', 'out', 1000n, 6, 9), /429/);
    assert.equal(f.sayac(), 2, 'arıza önbelleğe yazılmamalı — her çağrı uca gitmeli');
    assert.equal(q.stats.failures, 2);
  } finally {
    f.geriYukle();
  }
});

test('400 + errorCode JSON gerçek "rota yok"tur: null döner ve önbelleğe yazılır', async () => {
  const f = arizaliFetch(
    new HttpError(400, 'x', '{"error":"Could not find any route","errorCode":"COULD_NOT_FIND_ANY_ROUTE"}'),
  );
  try {
    const q = new DexQuoter();
    assert.equal(await q.quote('in', 'out', 1000n, 6, 9), null);
    assert.equal(await q.quote('in', 'out', 1000n, 6, 9), null);
    assert.equal(f.sayac(), 1, 'rota yokluğu veridir, 3 sn önbellekte kalmalı');
  } finally {
    f.geriYukle();
  }
});
