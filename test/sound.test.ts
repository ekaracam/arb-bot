/**
 * SoundAlert — sesli fırsat uyarısı.
 *
 * Çalıcı fonksiyon enjekte ediliyor: birim testi ses donanımına, PowerShell'e
 * ya da işletim sistemine bağlı olmamalı. Test edilen şey ses değil KARAR —
 * ne zaman çalınır, ne zaman bastırılır, hata nasıl yutulur.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SoundAlert } from '../src/notify/sound.ts';

/** Çağrı sayan sahte çalıcı. */
function spy(): { fn: () => void; count: () => number } {
  let n = 0;
  return { fn: () => void n++, count: () => n };
}

test('ilk uyarı her zaman çalar', () => {
  const s = spy();
  const a = new SoundAlert({ enabled: true, cooldownMs: 15_000, play: s.fn });
  assert.equal(a.alert(0), true);
  assert.equal(s.count(), 1);
});

test('cooldown dolmadan ikinci uyarı bastırılır', () => {
  const s = spy();
  const a = new SoundAlert({ enabled: true, cooldownMs: 15_000, play: s.fn });
  a.alert(0);
  assert.equal(a.alert(5_000), false);
  assert.equal(a.alert(14_999), false);
  assert.equal(s.count(), 1);
  assert.equal(a.stats.suppressed, 2);
});

test('cooldown dolunca tekrar çalar', () => {
  const s = spy();
  const a = new SoundAlert({ enabled: true, cooldownMs: 15_000, play: s.fn });
  a.alert(0);
  assert.equal(a.alert(15_000), true);
  assert.equal(s.count(), 2);
});

test('kapalıyken hiç çalmaz ve bastırılan sayılmaz', () => {
  const s = spy();
  const a = new SoundAlert({ enabled: false, cooldownMs: 15_000, play: s.fn });
  assert.equal(a.alert(0), false);
  assert.equal(a.alert(60_000), false);
  assert.equal(s.count(), 0);
  // Kapalıyken "bastırıldı" demek yanıltıcı olurdu: bastırılan bir şey yok.
  assert.equal(a.stats.suppressed, 0);
});

test('cooldown 0 ise her uyarı çalar', () => {
  const s = spy();
  const a = new SoundAlert({ enabled: true, cooldownMs: 0, play: s.fn });
  assert.equal(a.alert(0), true);
  assert.equal(a.alert(0), true);
  assert.equal(s.count(), 2);
});

test('çalıcı hata fırlatırsa bot etkilenmez, hata saklanır', () => {
  const a = new SoundAlert({
    enabled: true,
    cooldownMs: 0,
    play: () => {
      throw new Error('ses cihazı yok');
    },
  });
  assert.equal(a.alert(0), false);
  assert.equal(a.stats.played, 0);
  assert.equal(a.stats.lastError, 'ses cihazı yok');
});

test('başarısız çalma cooldown saatini yine de ilerletir', () => {
  // Aksi halde ses cihazı olmayan bir makinede her fırsat yeniden denenir ve
  // her denemede bir süreç başlatılır — sessizce CPU yakan bir döngü.
  let calls = 0;
  const a = new SoundAlert({
    enabled: true,
    cooldownMs: 10_000,
    play: () => {
      calls++;
      throw new Error('yok');
    },
  });
  a.alert(0);
  a.alert(1_000);
  assert.equal(calls, 1);
});
