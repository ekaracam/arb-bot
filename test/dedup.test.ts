/**
 * Deduper — canlı testte 75 saniyede 210 özdeş kayıt üreten hata modunun
 * savunması. Üç ayrı yerde farklı ayarla kullanılıyor, bu yüzden uç ayarlar
 * (cooldown 0, improveDelta 0) da test ediliyor.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Deduper } from '../src/notify/dedup.ts';

test('ilk görülen fırsat her zaman geçer', () => {
  const d = new Deduper({ cooldownMs: 1000, improveDeltaPct: 0.01 });
  assert.equal(d.shouldEmit('a', 0.05, 0), true);
});

test('cooldown dolmadan aynı fırsat tekrar geçmez', () => {
  const d = new Deduper({ cooldownMs: 1000, improveDeltaPct: 0.01 });
  d.shouldEmit('a', 0.05, 0);
  assert.equal(d.shouldEmit('a', 0.05, 500), false);
  assert.equal(d.shouldEmit('a', 0.05, 999), false);
});

test('cooldown dolunca tekrar geçer', () => {
  const d = new Deduper({ cooldownMs: 1000, improveDeltaPct: 0.01 });
  d.shouldEmit('a', 0.05, 0);
  assert.equal(d.shouldEmit('a', 0.05, 1000), true);
});

test('belirgin iyileşme cooldown beklemeden geçer', () => {
  const d = new Deduper({ cooldownMs: 10_000, improveDeltaPct: 0.01 });
  d.shouldEmit('a', 0.05, 0);
  assert.equal(d.shouldEmit('a', 0.052, 100), false, 'küçük iyileşme geçmemeli');
  assert.equal(d.shouldEmit('a', 0.08, 200), true, 'eşiği aşan iyileşme geçmeli');
});

test('eşiğe tam oturan iyileşme kayan nokta yüzünden geçmeyebilir', () => {
  // 0.06 - 0.05 = 0.009999999999999995 < 0.01. Karşılaştırma tam eşitlikte
  // güvenilir değil. Gerçek net% değerleri eşiğe tam oturmadığı için pratik
  // etkisi yok; sınırda deterministik davranış bekleyen test yazılmamalı.
  const d = new Deduper({ cooldownMs: 10_000, improveDeltaPct: 0.01 });
  d.shouldEmit('a', 0.05, 0);
  assert.equal(d.shouldEmit('a', 0.06, 100), false);
});

test('kötüleşme geçmez', () => {
  const d = new Deduper({ cooldownMs: 10_000, improveDeltaPct: 0.01 });
  d.shouldEmit('a', 0.05, 0);
  assert.equal(d.shouldEmit('a', 0.01, 100), false);
});

test('geçen kayıt referans net% değerini günceller', () => {
  const d = new Deduper({ cooldownMs: 10_000, improveDeltaPct: 0.01 });
  d.shouldEmit('a', 0.05, 0);
  assert.equal(d.shouldEmit('a', 0.08, 100), true); // geçer, referans 0.08 olur
  assert.equal(d.shouldEmit('a', 0.085, 200), false, 'referans artık 0.08 olmalı');
  assert.equal(d.shouldEmit('a', 0.12, 300), true);
});

test('farklı kimlikler birbirini etkilemez', () => {
  const d = new Deduper({ cooldownMs: 10_000, improveDeltaPct: 1 });
  assert.equal(d.shouldEmit('a', 0.05, 0), true);
  assert.equal(d.shouldEmit('b', 0.05, 0), true);
  assert.equal(d.shouldEmit('a', 0.05, 1), false);
});

test('persistence: ilk görülme anını korur, güncellemeler kaydırmaz', () => {
  // Scanner bunu cooldown:0 ile kullanıyor — her çağrı "geçer" ama fırsatın
  // YAŞI ilk görülme anından ölçülmeye devam etmeli. Aksi halde 75 saniyedir
  // kapanmayan fark hiç yaşlanmamış görünürdü.
  const d = new Deduper({ cooldownMs: 0, improveDeltaPct: 0 });
  d.shouldEmit('a', 0.05, 1000);
  d.shouldEmit('a', 0.05, 20_000);
  d.shouldEmit('a', 0.05, 50_000);

  const p = d.persistence('a', 50_000);
  assert.equal(p.ageMs, 49_000, 'yaş ilk görülmeden ölçülmeli');
  assert.equal(p.count, 3);
});

test('persistence: bilinmeyen kimlik sıfır döner', () => {
  const d = new Deduper({ cooldownMs: 0, improveDeltaPct: 0 });
  assert.deepEqual(d.persistence('yok', 1000), { ageMs: 0, count: 0 });
});

test('maxEntries: bellek sınırsız büyümez', () => {
  const d = new Deduper({ cooldownMs: 0, improveDeltaPct: 0, maxEntries: 10 });
  for (let i = 0; i < 100; i++) d.shouldEmit(`id-${i}`, 0.01, i);
  assert.ok(d.size <= 10, `size=${d.size}`);
});

test('prune: eski kayıtlar temizlenir, tazeler kalır', () => {
  const d = new Deduper({ cooldownMs: 0, improveDeltaPct: 0 });
  d.shouldEmit('eski', 0.05, 0);
  d.shouldEmit('taze', 0.05, 9000);

  d.prune(5000, 10_000);

  assert.equal(d.size, 1);
  assert.equal(d.persistence('eski', 10_000).count, 0, 'eski silinmeliydi');
  assert.equal(d.persistence('taze', 10_000).count, 1);
});

test('prune sonrası aynı kimlik yeniden "ilk görülen" sayılır', () => {
  const d = new Deduper({ cooldownMs: 10_000, improveDeltaPct: 1 });
  d.shouldEmit('a', 0.05, 0);
  d.prune(100, 1000);
  assert.equal(d.shouldEmit('a', 0.05, 1001), true);
});

// ---------------------------------------------------------------------------
// Epizot sınırı
//
// Ölçülmüş hata: `firstSeen` hiç sıfırlanmadığı için kapanıp yeniden açılan
// bir fark "saatlerdir kapanmıyor" diye işaretleniyordu. Kalibrasyon raporunda
// bu uyarı en baskın kategoriydi (%37.5) — yani kalite metriğini bozan şeyin
// kendisi bir ölçüm hatasıydı.
// ---------------------------------------------------------------------------

test('epizot: boşluktan sonra yaş sıfırlanır', () => {
  const d = new Deduper({ cooldownMs: 0, improveDeltaPct: 0, episodeGapMs: 15_000 });
  d.shouldEmit('a', 0.05, 1000);
  // 20 sn sessizlik: fark kapandı, sonra yeniden açıldı.
  d.shouldEmit('a', 0.05, 21_000);
  d.shouldEmit('a', 0.05, 23_000);

  const p = d.persistence('a', 23_000);
  assert.equal(p.ageMs, 2000, 'yaş YENİ epizodun başından ölçülmeli');
  assert.equal(p.count, 2, 'sayaç da epizotla birlikte sıfırlanmalı');
});

test('epizot: kesintisiz görülen fark sıfırlanmaz', () => {
  // Asıl risk burada: boşluk eşiği fazla dar olsaydı gerçek "kapanmayan fark"
  // uyarısını kaçırırdık. Boşluktan kısa aralıklarla görülen fırsat tek epizot.
  const d = new Deduper({ cooldownMs: 0, improveDeltaPct: 0, episodeGapMs: 15_000 });
  for (let t = 0; t <= 60_000; t += 10_000) d.shouldEmit('a', 0.05, t);

  assert.equal(d.persistence('a', 60_000).ageMs, 60_000);
});

test('epizot: tam boşluk sınırında sıfırlanmaz (kıl payı kesintisiz)', () => {
  const d = new Deduper({ cooldownMs: 0, improveDeltaPct: 0, episodeGapMs: 15_000 });
  d.shouldEmit('a', 0.05, 0);
  d.shouldEmit('a', 0.05, 15_000);
  assert.equal(d.persistence('a', 15_000).ageMs, 15_000);
});

test('epizot: varsayılan kapalı — eski davranış korunur', () => {
  // Telegram ve disk kaydı yaşı hiç okumuyor; onlar için davranış değişmemeli.
  const d = new Deduper({ cooldownMs: 0, improveDeltaPct: 0 });
  d.shouldEmit('a', 0.05, 0);
  d.shouldEmit('a', 0.05, 10 * 60_000);
  assert.equal(d.persistence('a', 10 * 60_000).ageMs, 10 * 60_000);
});

test('epizot boşluğu son GÖRÜLME anından ölçülür, son yayından değil', () => {
  // Cooldown'lı tüketicide `at` yalnızca yayınlandığında ilerler. Boşluğu
  // ondan ölçseydik, kesintisiz açık duran bir fırsat her cooldown penceresi
  // dolduğunda "kapandı" sayılır ve yaş sürekli sıfırlanırdı.
  const d = new Deduper({
    cooldownMs: 300_000,
    improveDeltaPct: 1,
    episodeGapMs: 15_000,
  });
  // 2 sn aralıkla 60 sn boyunca görülüyor ama cooldown yüzünden hiç
  // yayınlanmıyor (ilk çağrı hariç).
  for (let t = 0; t <= 60_000; t += 2000) d.shouldEmit('a', 0.05, t);

  assert.equal(d.persistence('a', 60_000).ageMs, 60_000, 'tek epizot olmalı');
});

test('prune ölçüsü son görülme — yayınlanmayan ama canlı kayıt silinmez', () => {
  const d = new Deduper({ cooldownMs: 300_000, improveDeltaPct: 1 });
  d.shouldEmit('a', 0.05, 0);
  // Yayınlanmıyor (cooldown), ama görülmeye devam ediyor.
  d.shouldEmit('a', 0.05, 9000);

  d.prune(5000, 10_000);

  assert.equal(d.size, 1, 'hâlâ canlı olan kayıt silinmemeliydi');
});
