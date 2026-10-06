/**
 * Host bazlı 429 geri çekilmesi + Jupiter kademe limitleri.
 *
 * ÖLÇÜLEN HATA: Jupiter `lite-api` 30 istek/dk (60 sn kayan pencere) verirken
 * kova 60/dk varsayıyordu ve 429'dan sonra hiçbir fren yoktu; Aşama 2 kuyruğu
 * doymuş olduğu için bot kayan pencereyi sürekli dolu tuttu (panel: `133 hata
 * (HTTP 429 …/swap/v1…)`). Tarama ise `retries: 1` ile her 429'u ikinci bir
 * istekle ödüllendiriyordu.
 *
 * Ağa çıkılmaz: `globalThis.fetch` sahtelenir, zaman `mock.timers` ile ilerletilir.
 */

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import {
  GERI_CEKILME_ILK_MS,
  GERI_CEKILME_TAVAN_MS,
  GeriCekilmeHatasi,
  HttpError,
  geriCekilmeDurumu,
  geriCekilmeleriSifirla,
  hostKovasi,
  httpJson,
  kapaliHostlar,
  retryAfterMs,
} from '../src/core/http.ts';
import { DexQuoter, jupiterKademesi } from '../src/feeds/dex/jupiter.ts';
import {
  JupiterPriceSource,
  guvenliAralik,
  periyotButceUyarisi,
} from '../src/feeds/dex/solana-price.ts';

interface SahteCevap {
  readonly status: number;
  readonly govde?: string;
  readonly basliklar?: Record<string, string>;
}

/** Sıradaki cevapları sırayla döndüren sahte fetch; çağrıları sayar. */
function sahteFetch(cevaplar: SahteCevap[]): { sayac: () => number; geriYukle: () => void } {
  let n = 0;
  const orijinal = globalThis.fetch;
  globalThis.fetch = (async () => {
    const c = cevaplar[Math.min(n, cevaplar.length - 1)]!;
    n++;
    return new Response(c.govde ?? '{}', { status: c.status, headers: c.basliklar ?? {} });
  }) as typeof globalThis.fetch;
  return { sayac: () => n, geriYukle: () => void (globalThis.fetch = orijinal) };
}

function saatiDondur(t: TestContext): number {
  const simdi = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: simdi });
  return simdi;
}

const RATE = { status: 429, govde: 'Rate limit exceeded, please try again later.' };
const OK = { status: 200, govde: '{"ok":true}' };

// --- Kademe ----------------------------------------------------------------

// Belgelenen limitler (0.5 / 1 / 10 rps) %85 payla kullanılır — tam limitte
// koşan kova canlıda yine 429 aldı (bkz. JUPITER_GUVENLIK_PAYI).
const yakin = (a: number, b: number): void => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

test('anahtarsız lite-api: kova 0.425 rps patlama 1, tarama 25.5/dk', () => {
  const s = new JupiterPriceSource(null, 'free');
  assert.equal(s.kademe, 'lite');
  yakin(s.perMinute, 25.5);
  const k = hostKovasi('lite-api.jup.ag')!;
  assert.equal(k.patlama, 1);
  yakin(k.saniyeBasina, 0.425);
});

test('anahtarlı kademeler: free 1 rps / developer 10 rps — kova ve perMinute aynı kaynaktan', () => {
  const dev = new JupiterPriceSource('k', 'developer');
  yakin(dev.perMinute, 510);
  yakin(hostKovasi('api.jup.ag')!.patlama, 8.5);
  yakin(hostKovasi('api.jup.ag')!.saniyeBasina, 8.5);

  const free = new JupiterPriceSource('k', 'free');
  yakin(free.perMinute, 51);
  assert.equal(hostKovasi('api.jup.ag')!.patlama, 1);
  yakin(hostKovasi('api.jup.ag')!.saniyeBasina, 0.85);
  // Kova ile perMinute ayrışamaz: ikisi de aynı satırdan türüyor.
  assert.equal(hostKovasi('api.jup.ag')!.saniyeBasina * 60, free.perMinute);
});

test('kademe: anahtar yoksa lite, varsa config kademesi (varsayılan free)', () => {
  assert.equal(jupiterKademesi(null, 'developer'), 'lite');
  assert.equal(jupiterKademesi('k', 'developer'), 'developer');
  assert.equal(jupiterKademesi('k'), 'free');
});

test('periyot: 134 token anahtarsız ~27 sn, 30 sn bütçenin içinde', () => {
  const s = new JupiterPriceSource(null, 'free');
  const aralik = guvenliAralik(Math.ceil(134 / s.chunkSize), s.perMinute, 5000, s.taramaPayi);
  assert.equal(aralik, 26_891);
  assert.equal(periyotButceUyarisi(aralik, 30_000), null);
  // ~240 token (6 istek/tur) bütçeyi aşar → yapısal uyarı.
  const buyuk = guvenliAralik(6, s.perMinute, 5000, s.taramaPayi);
  assert.match(periyotButceUyarisi(buyuk, 30_000) ?? '', /AŞIYOR/);
});

// --- retry-after -------------------------------------------------------------

test('retryAfterMs: saniye, HTTP tarihi ve bozuk değer', () => {
  const simdi = Date.parse('2026-10-06T12:00:00Z');
  assert.equal(retryAfterMs('7', simdi), 7000);
  assert.equal(retryAfterMs('Tue, 06 Oct 2026 12:00:20 GMT', simdi), 20_000);
  assert.equal(retryAfterMs('abc', simdi), null);
  assert.equal(retryAfterMs(null, simdi), null);
  assert.equal(retryAfterMs('', simdi), null);
});

// --- Geri çekilme -------------------------------------------------------------

test('429 → host kapanır, YENİDEN DENENMEZ, kapalıyken fetch çağrılmaz, süre dolunca açılır, başarı sıfırlar', async (t) => {
  geriCekilmeleriSifirla();
  const simdi = saatiDondur(t);
  const f = sahteFetch([RATE, RATE, OK]);
  try {
    const url = 'https://a.test/x';
    // retries: 2 verilse bile 429 ikinci bir istekle ödüllendirilmez.
    await assert.rejects(() => httpJson(url, { retries: 2 }), (e: unknown) => {
      return e instanceof HttpError && e.status === 429 && !(e instanceof GeriCekilmeHatasi);
    });
    assert.equal(f.sayac(), 1);
    assert.deepEqual(geriCekilmeDurumu('a.test'), {
      host: 'a.test',
      bloklandiUntil: simdi + GERI_CEKILME_ILK_MS,
      ardisik: 1,
    });
    assert.equal(kapaliHostlar().length, 1);

    // Kapalıyken ağa ÇIKILMAZ ve hata panelde okunur.
    await assert.rejects(() => httpJson(url), (e: unknown) => {
      assert.ok(e instanceof GeriCekilmeHatasi);
      assert.equal(e.status, 429, 'çağıranın "429 = arıza" ayrımı aynen işlemeli');
      assert.match(e.message, /^a\.test geri çekilmede \(15 sn/);
      return true;
    });
    assert.equal(f.sayac(), 1, 'kapalıyken fetch çağrılmamalı');

    // Süre dolar → yeniden denenir; ikinci 429 süreyi İKİYE katlar.
    t.mock.timers.tick(GERI_CEKILME_ILK_MS);
    await assert.rejects(() => httpJson(url), /HTTP 429/);
    assert.equal(f.sayac(), 2);
    const d = geriCekilmeDurumu('a.test');
    assert.equal(d.ardisik, 2);
    assert.equal(d.bloklandiUntil - Date.now(), GERI_CEKILME_ILK_MS * 2);

    // Süre dolar → başarı kapanmayı tamamen sıfırlar.
    t.mock.timers.tick(GERI_CEKILME_ILK_MS * 2);
    assert.deepEqual(await httpJson(url), { ok: true });
    assert.deepEqual(geriCekilmeDurumu('a.test'), { host: 'a.test', bloklandiUntil: 0, ardisik: 0 });
    assert.equal(kapaliHostlar().length, 0);
  } finally {
    f.geriYukle();
  }
});

test('retry-after başlığına uyulur', async (t) => {
  geriCekilmeleriSifirla();
  saatiDondur(t);
  const f = sahteFetch([{ ...RATE, basliklar: { 'retry-after': '7' } }, OK]);
  try {
    const url = 'https://b.test/x';
    await assert.rejects(() => httpJson(url), /HTTP 429/);
    t.mock.timers.tick(6_999);
    await assert.rejects(() => httpJson(url), GeriCekilmeHatasi);
    assert.equal(f.sayac(), 1);
    t.mock.timers.tick(1);
    assert.deepEqual(await httpJson(url), { ok: true });
    assert.equal(f.sayac(), 2);
  } finally {
    f.geriYukle();
  }
});

test('üstel geri çekilmenin tavanı SONLU (5 dk)', async (t) => {
  geriCekilmeleriSifirla();
  saatiDondur(t);
  const f = sahteFetch([RATE]);
  try {
    const url = 'https://c.test/x';
    const sureler: number[] = [];
    for (let i = 0; i < 8; i++) {
      await assert.rejects(() => httpJson(url), /HTTP 429/);
      const kalan = geriCekilmeDurumu('c.test').bloklandiUntil - Date.now();
      sureler.push(kalan);
      t.mock.timers.tick(kalan);
    }
    assert.deepEqual(sureler.slice(0, 5), [15_000, 30_000, 60_000, 120_000, 240_000]);
    assert.ok(sureler.slice(5).every((s) => s === GERI_CEKILME_TAVAN_MS));
  } finally {
    f.geriYukle();
  }
});

test('aynı patlamanın uçuştaki istekleri süreyi KATLAMAZ', async (t) => {
  geriCekilmeleriSifirla();
  saatiDondur(t);
  let birak: () => void = () => {};
  const kapi = new Promise<void>((r) => (birak = r));
  const orijinal = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async () => {
    n++;
    await kapi;
    return new Response(RATE.govde, { status: 429 });
  }) as typeof globalThis.fetch;
  try {
    const url = 'https://d.test/x';
    const istekler = [httpJson(url), httpJson(url), httpJson(url)];
    // Üçü de kovadan geçip ağa çıksın.
    while (n < 3) await new Promise((r) => setImmediate(r));
    birak();
    for (const p of istekler) await assert.rejects(p, /HTTP 429/);
    const d = geriCekilmeDurumu('d.test');
    assert.equal(d.ardisik, 1, 'üç eşzamanlı 429 tek kapanmadır');
    assert.equal(d.bloklandiUntil - Date.now(), GERI_CEKILME_ILK_MS);
  } finally {
    globalThis.fetch = orijinal;
  }
});

test('5xx hâlâ yeniden denenir (yalnızca 429 frenlenir)', async () => {
  geriCekilmeleriSifirla();
  const f = sahteFetch([{ status: 503, govde: 'x' }, OK]);
  try {
    assert.deepEqual(await httpJson('https://e.test/x', { retries: 1 }), { ok: true });
    assert.equal(f.sayac(), 2);
    assert.equal(geriCekilmeDurumu('e.test').ardisik, 0);
  } finally {
    f.geriYukle();
  }
});

test('DexQuoter: 429 sonrası doğrulama ağa çıkmadan fırlatır, "rota yok" sayılmaz', async () => {
  geriCekilmeleriSifirla();
  const f = sahteFetch([RATE]);
  try {
    const q = new DexQuoter({ apiKey: null });
    await assert.rejects(() => q.quote('in', 'out', 1000n, 6, 9), /HTTP 429/);
    await assert.rejects(
      () => q.quote('in', 'out', 2000n, 6, 9),
      /lite-api\.jup\.ag geri çekilmede/,
    );
    assert.equal(f.sayac(), 1, 'geri çekilmede uca istek gitmemeli');
  } finally {
    f.geriYukle();
    geriCekilmeleriSifirla();
  }
});
