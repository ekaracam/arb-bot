/**
 * SolanaMidFeed — referans fiyat kontrolü.
 *
 * ÖLÇÜLEN HATA (2026-09-01): Raydium `mint/price` TEK HAVUZUN orta fiyatını
 * veriyor ve 108 mint'in 9'unda Jupiter'den %26–%2630 sapıyordu (FIGHT %2630,
 * GORK %547, W %255). O sapık fiyatlar devasa ham fark üretiyor, kuyruk ham
 * farka göre sıralı olduğu için tepeyi işgal ediyor ve doğrulama bütçesinin
 * TAMAMINI yakıyordu: 7 dakikada kâr hesabına ulaşan 12 çiftin 12'si de bu
 * sınıftandı, net oranları %-17 ile %-99.95 arası.
 *
 * Testin konusu fiyat doğruluğu değil KARAR: hangi fiyat yazılır, hangisi
 * yazılmaz, ve referans yokken ne olur.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SolanaMidFeed, type SolanaToken } from '../src/feeds/dex/solana-feed.ts';
import type { SolanaPriceSource } from '../src/feeds/dex/solana-price.ts';
import { PriceStore } from '../src/book/price-store.ts';
import { pairKey, type PairKey, type VenueId } from '../src/core/types.ts';

const PAIR = pairKey('KOIN', 'USDT');
const MINT = 'mint111';

function kaynak(fiyat: number): SolanaPriceSource {
  return {
    ad: 'sahte',
    chunkSize: 50,
    perMinute: 600,
    taramaPayi: 0.8,
    async fetchPrices() {
      return new Map([[MINT, fiyat]]);
    },
  };
}

function kur(raydiumFiyat: number) {
  const venues: VenueId[] = ['jupiter', 'raydium'];
  const store = new PriceStore([PAIR], venues);
  const slot = store.resolveSlot(PAIR, 'raydium');
  const tokens: SolanaToken[] = [
    { symbol: 'KOIN', mint: MINT, decimals: 9, pair: PAIR, slot },
  ];
  const feed = new SolanaMidFeed(store, tokens, {
    venue: 'raydium',
    priceSource: kaynak(raydiumFiyat),
    referansVenue: 'jupiter',
    maxReferansYasiMs: 30_000,
  });
  return { store, feed, slot, jupSlot: store.resolveSlot(PAIR, 'jupiter') };
}

/** Referans venue'ya taze bir fiyat yazar. */
function referansYaz(store: PriceStore, slot: number, fiyat: number, yasMs = 0): void {
  const t = Date.now() - yasMs;
  store.write(slot, fiyat, 0, fiyat, 0, t, t);
}

test('referanstan çok sapan fiyat store’a YAZILMAZ', async () => {
  // FIGHT vakası: raydium 0.0926, jupiter 0.0034 — %2630 sapma.
  const r = kur(0.0926);
  referansYaz(r.store, r.jupSlot, 0.0034);

  await r.feed.start();
  await r.feed.stop();

  assert.equal(r.store.ask(r.slot), 0, 'sapık fiyat yazılmamalıydı');
  assert.match(r.feed.health().lastError ?? '', /saptığı için yazılmadı/);
  assert.match(r.feed.health().lastError ?? '', /KOIN/);
});

test('referansla uyumlu fiyat normal yazılır', async () => {
  const r = kur(1.02);
  referansYaz(r.store, r.jupSlot, 1.0);

  await r.feed.start();
  await r.feed.stop();

  assert.equal(r.store.ask(r.slot), 1.02);
  assert.equal(r.feed.health().lastError, null);
});

test('referans YOKSA fiyat yazılır — kontrol zorunlu değil', async () => {
  // Kritik kural: kontrolü şart koşmak, referans venue düştüğünde BU venue'yu
  // de sessizce susturur. Bir arıza iki venue'yu birden öldürmemeli.
  const r = kur(99.0);
  // jupiter slotuna hiç yazılmadı.

  await r.feed.start();
  await r.feed.stop();

  assert.equal(r.store.ask(r.slot), 99.0);
});

test('referans BAYATSA fiyat yazılır', async () => {
  const r = kur(99.0);
  referansYaz(r.store, r.jupSlot, 1.0, 60_000); // 60 sn eski

  await r.feed.start();
  await r.feed.stop();

  assert.equal(r.store.ask(r.slot), 99.0, 'bayat referansla karar verilmemeli');
});

test('referans venue’su verilmeyen feed hiç kontrol yapmaz', async () => {
  const venues: VenueId[] = ['jupiter', 'raydium'];
  const store = new PriceStore([PAIR], venues);
  const slot = store.resolveSlot(PAIR, 'jupiter');
  const feed = new SolanaMidFeed(
    store,
    [{ symbol: 'KOIN', mint: MINT, decimals: 9, pair: PAIR, slot }],
    { venue: 'jupiter', priceSource: kaynak(1.0) },
  );

  await feed.start();
  await feed.stop();

  assert.equal(store.ask(slot), 1.0);
});
