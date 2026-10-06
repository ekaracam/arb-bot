/**
 * Scanner — iki aşamalı taramanın uçtan uca davranışı.
 *
 * Buradaki testler fiyat matrisini elle kurup Aşama 1 + Aşama 2'yi çalıştırır
 * ve üretilen Opportunity'yi elle hesaplanmış beklenen değerle karşılaştırır.
 * Kâr formülünü testin içinde tekrar yazmıyoruz — o, kendini doğrulayan bir
 * test olurdu; sayılar dışarıda hesaplanıp sabit olarak yazıldı.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Scanner } from '../src/engine/scanner.ts';
import { PriceStore } from '../src/book/price-store.ts';
import { isCex } from '../src/core/types.ts';
import type { DexId, Opportunity, PairKey, VenueId } from '../src/core/types.ts';
import type { CaprazKontrol, CaprazSonuc } from '../src/feeds/dex/capraz.ts';
import type { DexLegQuoter, DexLegSonuc } from '../src/feeds/dex/leg-quoter.ts';
import {
  fakeDepth,
  fakeRegistry,
  fakeTransfers,
  makeConfig,
  settle,
  type ConfigOverrides,
  type FakeDepth,
  type FakeTransfers,
  type ScannerInternals,
} from './helpers.ts';

const PAIR = 'KOIN/USDT' as PairKey;

interface Rig {
  scanner: Scanner;
  store: PriceStore;
  depth: FakeDepth;
  transfers: FakeTransfers;
  emitted: Opportunity[];
  slot(venue: VenueId): number;
  run(): Promise<void>;
}

/**
 * Sahte DEX bacağı doğrulayıcısı.
 *
 * Gerçeği Jupiter'e HTTP atar; test ağa çıkmamalı. Burada tek değişken
 * quoter'ın döndürdüğü MİKTAR — kâr hesabının DEX tarafını belirleyen şey o.
 */
function fakeLegQuoter(
  opts: { buyBase?: number | null; sellQuote?: number | null; etkiPct?: number } = {},
) {
  const calls: string[] = [];
  // Varsayılan etki 0: testlerin konusu miktar, ince havuz elemesi ayrıca
  // test ediliyor. `etkiPct` verilerek o yol açılır.
  const sar = (m: number | null | undefined): DexLegSonuc | null =>
    m === undefined || m === null ? null : { miktar: m, etkiPct: opts.etkiPct ?? 0 };
  return {
    calls,
    quoter: {
      async buy(venue: DexId, symbol: string, quoteAmount: number): Promise<DexLegSonuc | null> {
        calls.push(`buy:${venue}:${symbol}:${quoteAmount}`);
        return sar(opts.buyBase);
      },
      async sell(venue: DexId, symbol: string, baseAmount: number): Promise<DexLegSonuc | null> {
        calls.push(`sell:${venue}:${symbol}:${baseAmount}`);
        return sar(opts.sellQuote);
      },
    } satisfies DexLegQuoter,
  };
}

function rig(
  opts: {
    pairs?: PairKey[];
    venues?: VenueId[];
    cfg?: ConfigOverrides;
    scanner?: { maxQueueDepth?: number; maxConcurrentChecks?: number };
    legQuoter?: DexLegQuoter | null;
    capraz?: CaprazKontrol | null;
  } = {},
): Rig {
  const pairs = opts.pairs ?? [PAIR];
  const venues = opts.venues ?? (['binance', 'kucoin'] as VenueId[]);

  const store = new PriceStore(pairs, venues);
  const depth = fakeDepth();
  const transfers = fakeTransfers();
  // Registry yalnızca CEX sembollerini tutar; DEX bacakları adres üzerinden
  // eşleştiği için burada yer almaz.
  const cexVenues = venues.filter(isCex);
  const registry = fakeRegistry(Object.fromEntries(pairs.map((p) => [p, cexVenues])));

  // Varsayılan: her coin solana üzerinden transfer edilebilir.
  for (const p of pairs) transfers.setChains(p.split('/')[0]!, ['solana']);

  const scanner = new Scanner(
    makeConfig(opts.cfg),
    store,
    registry,
    depth.cache,
    transfers.provider,
    venues,
    opts.scanner ?? {},
    opts.legQuoter ?? null,
    opts.capraz ?? null,
  );

  const emitted: Opportunity[] = [];
  scanner.onOpportunity((o) => emitted.push(o));

  return {
    scanner,
    store,
    depth,
    transfers,
    emitted,
    slot: (v) => store.resolveSlot(pairs[0]!, v),
    async run() {
      (scanner as unknown as ScannerInternals).evaluate();
      await settle();
    },
  };
}

/** Bir venue'ya L1 kotasyonu yazar. */
function quote(
  r: Rig,
  venue: VenueId,
  bid: number,
  bidQty: number,
  ask: number,
  askQty: number,
  ageMs = 0,
): void {
  const now = Date.now();
  r.store.write(r.slot(venue), bid, bidQty, ask, askQty, now - ageMs, now - ageMs);
}

// ---------------------------------------------------------------------------
// Aşama 1 — ön filtre
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Aşama 2 — DEX bacağı doğrulaması
// ---------------------------------------------------------------------------

test('DEX bacağı quote ile doğrulanır ve fırsat üretebilir', async () => {
  // Ölçülen hata: Solana geniş taraması miktarı 0 yazıyor, l1Fill bu yüzden
  // complete=false dönüyordu ve scanner HER DEX bacağını eliyordu. DexQuoter
  // yazılmıştı ama hiçbir yerden çağrılmıyordu — CEX↔DEX fırsatı yapısal
  // olarak üretilemiyordu.
  const q = fakeLegQuoter({ buyBase: 1000 });
  const r = rig({
    venues: ['jupiter', 'binance'],
    legQuoter: q.quoter,
    cfg: { prefilterPct: 0.001, minNetPct: 0.001, takerFees: { binance: 0 } },
  });

  // DEX'te ucuz al (miktar 0 — quoter doğrulayacak), Binance'te pahalı sat.
  r.store.write(r.slot('jupiter'), 1.0, 0, 1.0, 0, Date.now(), Date.now());
  quote(r, 'binance', 1.05, 1e6, 1.06, 1e6);

  await r.run();

  assert.ok(q.calls.some((c) => c.startsWith('buy:jupiter:KOIN:')), 'DEX alış bacağı quote edilmeliydi');
  assert.equal(r.emitted.length, 1, 'fırsat üretilmeliydi');
  assert.equal(r.emitted[0]!.kind, 'cex-dex');
});

test('CEX→EVM DEX: satış bacağı DEX quote miktarına kırpılır, sinyal üretilir', async () => {
  // Ölçülen yapısal hata: EVM feed'i bidQty'ye tradeSize/ask yazıyor; CEX'ten
  // alınan miktar bundan hep büyük olduğu için satış l1Fill'den tam dönmüyor,
  // quoteDexLeg'e düşüyor ve orada EVM için doğrulayıcı olmadığından her
  // CEX→EVM adayı "derinlik" ile eleniyordu. 265 kayıtta EVM hep alış
  // tarafındaydı. Burada gerçekçi miktar yazılır (baseRig'in 1e6'sı değil).
  const r = rig({
    venues: ['aerodrome', 'binance'],
    cfg: { prefilterPct: 0.001, minNetPct: 0.004, takerFees: { binance: 0 } },
  });
  r.transfers.setChains('KOIN', ['solana', 'base']);
  const now = Date.now();
  const dexAsk = 1.06;
  const bought = 1000 / dexAsk; // feed'in $1000 için yazdığı gerçek miktar
  r.store.write(r.slot('aerodrome'), 1.05, bought, dexAsk, bought, now, now);
  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6);
  await r.run();

  assert.equal(r.scanner.stats.dexQuoteTried, 0, "EVM bacağı quoter'a gitmemeli");
  assert.equal(r.scanner.stats.rejectedByDepth, 0);
  assert.equal(r.emitted.length, 1, 'CEX→EVM DEX sinyali üretilmeliydi');
  const o = r.emitted[0]!;
  assert.equal(o.kind, 'cex-dex');
  assert.equal(o.buy.venue, 'binance');
  assert.equal(o.sell.venue, 'aerodrome');
  // İşlem DEX quote'unun geçerli olduğu miktara kırpıldı.
  assert.ok(Math.abs(o.buy.qty - bought) < 1e-6, `alış miktarı ${o.buy.qty} ≠ ${bought}`);
});

test('quoter rota bulamazsa aday derinlik gerekçesiyle elenir', async () => {
  const q = fakeLegQuoter({});
  const r = rig({
    venues: ['jupiter', 'binance'],
    legQuoter: q.quoter,
    cfg: { prefilterPct: 0.001, minNetPct: 0.001 },
  });
  r.store.write(r.slot('jupiter'), 1.0, 0, 1.0, 0, Date.now(), Date.now());
  quote(r, 'binance', 1.05, 1e6, 1.06, 1e6);

  await r.run();

  assert.equal(r.emitted.length, 0);
  assert.equal(r.scanner.stats.rejectedByDepth, 1);
});

test('quoter yoksa DEX bacağı elenir ama tarama çökmez', async () => {
  const r = rig({
    venues: ['jupiter', 'binance'],
    legQuoter: null,
    cfg: { prefilterPct: 0.001, minNetPct: 0.001 },
  });
  r.store.write(r.slot('jupiter'), 1.0, 0, 1.0, 0, Date.now(), Date.now());
  quote(r, 'binance', 1.05, 1e6, 1.06, 1e6);

  await r.run();

  assert.equal(r.emitted.length, 0);
  assert.equal(r.scanner.stats.rejectedByDepth, 1);
});

// ---------------------------------------------------------------------------
// DEX quote sayaçları
//
// Bu projenin tekrar eden hata sınıfı sessiz başarısızlık: `DexQuoter` uzun
// süre hiç çağrılmadı ve her DEX bacağı `rejectedByDepth` kovasına düştüğü
// için panelde hiçbir iz kalmadı. Sayaçlar "likidite yok" ile "boru hattı
// bozuk" arasındaki farkı görünür kılıyor; testler o ayrımı sabitliyor.
// ---------------------------------------------------------------------------

test('sayaçlar: başarılı quote `ok` kovasına düşer', async () => {
  const q = fakeLegQuoter({ buyBase: 1000 });
  const r = rig({
    venues: ['jupiter', 'binance'],
    legQuoter: q.quoter,
    cfg: { prefilterPct: 0.001, minNetPct: 0.001, takerFees: { binance: 0 } },
  });
  r.store.write(r.slot('jupiter'), 1.0, 0, 1.0, 0, Date.now(), Date.now());
  quote(r, 'binance', 1.05, 1e6, 1.06, 1e6);

  await r.run();

  const s = r.scanner.stats;
  assert.equal(s.dexQuoteTried, 1);
  assert.equal(s.dexQuoteOk, 1);
  assert.equal(s.dexQuoteEmpty, 0);
  assert.equal(s.dexQuoteError, 0);
  assert.equal(s.lastDexQuoteError, null);
});

test('sayaçlar: rota yoksa `empty`, hata değil', async () => {
  const q = fakeLegQuoter({});
  const r = rig({
    venues: ['jupiter', 'binance'],
    legQuoter: q.quoter,
    cfg: { prefilterPct: 0.001, minNetPct: 0.001 },
  });
  r.store.write(r.slot('jupiter'), 1.0, 0, 1.0, 0, Date.now(), Date.now());
  quote(r, 'binance', 1.05, 1e6, 1.06, 1e6);

  await r.run();

  const s = r.scanner.stats;
  assert.equal(s.dexQuoteEmpty, 1, 'likidite yokluğu hata sayılmamalı');
  assert.equal(s.dexQuoteError, 0);
});

test('sayaçlar: quoter istisna atarsa `error` ve sebep saklanır', async () => {
  const patlayan: DexLegQuoter = {
    buy: () => Promise.reject(new Error('jupiter 429')),
    sell: () => Promise.reject(new Error('jupiter 429')),
  };
  const r = rig({
    venues: ['jupiter', 'binance'],
    legQuoter: patlayan,
    cfg: { prefilterPct: 0.001, minNetPct: 0.001 },
  });
  r.store.write(r.slot('jupiter'), 1.0, 0, 1.0, 0, Date.now(), Date.now());
  quote(r, 'binance', 1.05, 1e6, 1.06, 1e6);

  await r.run();

  const s = r.scanner.stats;
  assert.equal(s.dexQuoteError, 1);
  assert.equal(s.dexQuoteEmpty, 0, 'istisna "rota yok" ile karışmamalı');
  assert.equal(s.lastDexQuoteError, 'jupiter 429');
  // Tarama çökmemeli: aday yine derinlik gerekçesiyle elenir.
  assert.equal(r.emitted.length, 0);
  assert.equal(s.rejectedByDepth, 1);
});

test('sayaçlar: doğrulayıcı hiç bağlı değilse bu bir HATA olarak görünür', async () => {
  // "hiç çağrılmadı" ile "çağrıldı ama rota yok" ayrımı tam olarak bizi
  // aylarca yanıltan şeydi; bağlantı eksikliği sessiz kalmamalı.
  const r = rig({
    venues: ['jupiter', 'binance'],
    legQuoter: null,
    cfg: { prefilterPct: 0.001, minNetPct: 0.001 },
  });
  r.store.write(r.slot('jupiter'), 1.0, 0, 1.0, 0, Date.now(), Date.now());
  quote(r, 'binance', 1.05, 1e6, 1.06, 1e6);

  await r.run();

  const s = r.scanner.stats;
  assert.equal(s.dexQuoteTried, 1);
  assert.equal(s.dexQuoteError, 1);
  assert.equal(s.lastDexQuoteError, 'doğrulayıcı bağlı değil');
});

test('sayaçlar: CEX↔CEX taramasında DEX quote hiç denenmez', async () => {
  const q = fakeLegQuoter({ buyBase: 1000 });
  const r = rig({ legQuoter: q.quoter, cfg: { prefilterPct: 0.001 } });
  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6);
  quote(r, 'kucoin', 1.05, 1e6, 1.06, 1e6);

  await r.run();

  assert.equal(r.scanner.stats.dexQuoteTried, 0);
});

// ---------------------------------------------------------------------------
// Aşama 1 — doğrulama soğuması
// ---------------------------------------------------------------------------

test('aynı çift soğuma süresi içinde yeniden kuyruğa girmez', async () => {
  // Ölçülen: 59 saniyede 56.653 aday (~960/sn), kuyruk sürekli dolu. Derinlik
  // önbelleği 2 sn TTL'li olduğu için bu tekrarlar aynı defteri okuyup aynı
  // sonuca varıyordu — sadece kota ve kuyruk sırası harcıyorlardı.
  const r = rig({ cfg: { prefilterPct: 0.001, verifyCooldownMs: 60_000 } });
  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6);
  quote(r, 'kucoin', 1.05, 1e6, 1.06, 1e6);

  await r.run();
  const ilk = r.scanner.stats.candidateCount;

  // Fiyatı oynatıp tekrar tara: soğuma dolmadığı için yeni aday olmamalı.
  quote(r, 'kucoin', 1.051, 1e6, 1.061, 1e6);
  await r.run();

  assert.equal(ilk, 1);
  assert.equal(r.scanner.stats.candidateCount, 1, 'soğuma içinde tekrar aday üretilmemeli');
  assert.ok(r.scanner.stats.skippedByCooldown > 0, 'atlanan aday sayaca yansımalı');
});

test('soğuma kapalıyken tekrar aday üretilir', async () => {
  const r = rig({ cfg: { prefilterPct: 0.001, verifyCooldownMs: 0 } });
  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6);
  quote(r, 'kucoin', 1.05, 1e6, 1.06, 1e6);

  await r.run();
  quote(r, 'kucoin', 1.051, 1e6, 1.061, 1e6);
  await r.run();

  assert.equal(r.scanner.stats.candidateCount, 2);
  // CEX↔CEX: "DEX değişmedi" kuralı hiç devreye girmemeli.
  assert.equal(r.scanner.stats.skippedByDexUnchanged, 0);
});

// ---------------------------------------------------------------------------
// Aşama 1 — DEX fiyatı değişmediyse yeniden doğrulama yok
//
// Ölçülen: Jupiter `/swap/v1/quote` ~39 istek/dk ile 30/dk limitini aşıyordu.
// Orta fiyat 11–23 sn'de bir yazılırken çift CEX tick'iyle dirty oluyor ve
// soğuma dolar dolmaz AYNI DEX fiyatıyla yeniden quote ediliyordu.
// ---------------------------------------------------------------------------

/** DEX slotuna orta fiyat yazar (Solana feed'i gibi miktar 0). */
function dexMid(r: Rig, venue: VenueId, price: number, recvTs: number): void {
  r.store.write(r.slot(venue), price, 0, price, 0, recvTs, recvTs);
}

test('CEX↔DEX: DEX yeniden yazılmadan CEX tick’i yeni quote tetiklemez', async () => {
  const q = fakeLegQuoter({ buyBase: 1000 });
  const r = rig({
    venues: ['jupiter', 'binance'],
    legQuoter: q.quoter,
    cfg: { prefilterPct: 0.001, minNetPct: 0.001, verifyCooldownMs: 0 },
  });
  // DEX fiyatı 1 sn önce yazılmış (taze, ama kuyruğa alınmadan ÖNCE).
  dexMid(r, 'jupiter', 1.0, Date.now() - 1000);
  quote(r, 'binance', 1.05, 1e6, 1.06, 1e6);
  await r.run();

  // Soğuma kapalı, yalnızca CEX tarafı oynuyor.
  quote(r, 'binance', 1.051, 1e6, 1.061, 1e6);
  await r.run();

  const alislar = q.calls.filter((c) => c.startsWith('buy:jupiter:'));
  assert.equal(alislar.length, 1, `quoter yalnızca bir kez çağrılmalı: ${q.calls.join(',')}`);
  assert.equal(r.scanner.stats.candidateCount, 1);
  assert.equal(r.scanner.stats.skippedByDexUnchanged, 1);
});

test('CEX↔DEX: DEX yeniden yazılınca çift yeniden kuyruğa alınır', async () => {
  const q = fakeLegQuoter({ buyBase: 1000 });
  const r = rig({
    venues: ['jupiter', 'binance'],
    legQuoter: q.quoter,
    cfg: { prefilterPct: 0.001, minNetPct: 0.001, verifyCooldownMs: 0 },
  });
  dexMid(r, 'jupiter', 1.0, Date.now() - 1000);
  quote(r, 'binance', 1.05, 1e6, 1.06, 1e6);
  await r.run();

  quote(r, 'binance', 1.051, 1e6, 1.061, 1e6);
  await r.run();
  assert.equal(r.scanner.stats.skippedByDexUnchanged, 1);

  // Yeni DEX turu: recvTs son kuyruğa alınma anını geçti.
  dexMid(r, 'jupiter', 1.001, Date.now() + 1);
  await r.run();

  const alislar = q.calls.filter((c) => c.startsWith('buy:jupiter:'));
  assert.equal(alislar.length, 2, `yeni DEX fiyatı yeniden quote edilmeliydi: ${q.calls.join(',')}`);
  assert.equal(r.scanner.stats.candidateCount, 2);
  assert.equal(r.scanner.stats.skippedByDexUnchanged, 1, 'sayaç yalnızca atlamada artar');
});

test('DEX↔DEX: bacaklardan BİRİNİN yeniden yazılması yeterli', async () => {
  // "İkisi de" şartı hızlı bacağın yeni fiyatını, yavaş bacak yazana kadar
  // görmezden gelirdi — kapsam kaybı. Muhafazakâr yön: herhangi biri.
  const q = fakeLegQuoter({ buyBase: 1000, sellQuote: 1100 });
  const r = rig({
    venues: ['jupiter', 'raydium', 'binance'],
    legQuoter: q.quoter,
    cfg: { prefilterPct: 0.001, minNetPct: 0.001, verifyCooldownMs: 0 },
  });
  const once = Date.now() - 1000;
  dexMid(r, 'jupiter', 1.0, once);
  dexMid(r, 'raydium', 1.05, once);
  await r.run();
  assert.equal(r.scanner.stats.candidateCount, 1);

  // Hiçbiri yeniden yazılmadan (dirty'yi bir CEX tick'i üretiyor) → atlanır.
  quote(r, 'binance', 1.01, 1e6, 1.04, 1e6);
  await r.run();
  assert.equal(r.scanner.stats.candidateCount, 1);
  assert.equal(r.scanner.stats.skippedByDexUnchanged, 1);

  // Yalnızca satış bacağı (raydium) yeniden yazıldı → kuyruğa alınır.
  dexMid(r, 'raydium', 1.051, Date.now() + 1);
  await r.run();
  assert.equal(r.scanner.stats.candidateCount, 2);
  assert.equal(q.calls.filter((c) => c.startsWith('buy:jupiter:')).length, 2);
});

test('DEX değişmedi kuralı yalnızca AYNI bacak kombinasyonuna uygulanır', async () => {
  // En iyi ask başka venue'ya geçtiyse o rota hiç doğrulanmamıştır; DEX'in
  // yaşı onun için bir şey söylemez.
  const q = fakeLegQuoter({ buyBase: 1000 });
  const r = rig({
    venues: ['jupiter', 'binance', 'kucoin'],
    legQuoter: q.quoter,
    cfg: { prefilterPct: 0.001, minNetPct: 0.001, verifyCooldownMs: 0 },
  });
  dexMid(r, 'jupiter', 1.0, Date.now() - 1000);
  quote(r, 'binance', 1.05, 1e6, 1.06, 1e6);
  quote(r, 'kucoin', 1.04, 1e6, 1.07, 1e6);
  await r.run();
  assert.equal(r.scanner.stats.candidateCount, 1); // jupiter → binance

  // En iyi bid kucoin'e geçti: jupiter → kucoin yeni bir rota.
  quote(r, 'kucoin', 1.08, 1e6, 1.09, 1e6);
  await r.run();
  assert.equal(r.scanner.stats.candidateCount, 2);
  assert.equal(r.scanner.stats.skippedByDexUnchanged, 0);
});

test('EVM DEX kurala tabi değil: CEX tick’i DEX yazılmadan da yeniden kuyruğa alır', async () => {
  // Kural Jupiter kotasını korumak için; EVM bacağı quoter'a gitmez, kota
  // baskısı yok ve CEX defteri değişince hemen yeniden doğrulanması değerli.
  const r = rig({
    venues: ['aerodrome', 'binance'],
    cfg: { prefilterPct: 0.001, minNetPct: 0.004, verifyCooldownMs: 0, takerFees: { binance: 0 } },
  });
  r.transfers.setChains('KOIN', ['solana', 'base']);
  const once = Date.now() - 1000;
  const bought = 1000 / 1.06;
  r.store.write(r.slot('aerodrome'), 1.05, bought, 1.06, bought, once, once);
  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6);
  await r.run();

  quote(r, 'binance', 0.991, 1e6, 1.001, 1e6);
  await r.run();

  assert.equal(r.scanner.stats.candidateCount, 2, 'EVM bacağı eski davranışta kalmalı');
  assert.equal(r.scanner.stats.skippedByDexUnchanged, 0);
});

test('aşama 1: DEX venue’su CEX eşiğinden eski fiyatla da değerlendirilir', async () => {
  // Canlı olarak ölçülen hata: DEX fiyatı HTTP ile çekildiği için periyodu
  // kaynağın limiti belirler (109 mint → 10 sn). CEX eşiği (3 sn) DEX'e de
  // uygulanınca her DEX okuması bayat sayılıyor ve CEX↔DEX fırsatı YAPISAL
  // olarak üretilemiyordu — hiçbir yerde hata görünmeden.
  const r = rig({
    venues: ['binance', 'jupiter'],
    cfg: { prefilterPct: 0.001, maxPriceAgeMs: 3000, maxDexPriceAgeMs: 30_000 },
  });
  quote(r, 'binance', 1.0, 1e6, 1.001, 1e6);
  // 10 saniyelik DEX fiyatı: CEX eşiğini aşar, DEX eşiğinin içinde.
  quote(r, 'jupiter', 1.05, 1e6, 1.051, 1e6, 10_000);

  await r.run();

  assert.equal(r.scanner.stats.candidateCount, 1, 'DEX bacağı değerlendirilmeliydi');
});

test('aşama 2: DEX bacağı CEX eşiğinden eski fiyatla da DOĞRULANIR', async () => {
  // Yukarıdaki Aşama 1 testinin karşılığı — ve tam olarak hatanın yaşadığı yer.
  //
  // Aşama 1 venue türüne göre ayrı eşik kullanıyordu, ama `verify()` düz
  // `maxPriceAgeMs`'i (3 sn) İKİ bacağa birden uyguluyordu. Yani Aşama 1'in
  // kabul ettiği DEX adayı Aşama 2'de sessizce eleniyordu: aynı hata, bir
  // aşama ötede. Jupiter periyodu ~11.4 sn olduğu için CEX↔DEX fırsatı
  // pencerenin yalnızca ~%26'sında doğrulanabiliyordu.
  //
  // Eski test zinciri hatayı göremezdi çünkü `candidateCount`'ta kesiliyordu;
  // bu yüzden buradaki iddia ÜRETİLEN FIRSAT üzerinedir.
  const r = rig({
    venues: ['binance', 'jupiter'],
    cfg: { prefilterPct: 0.001, maxPriceAgeMs: 3000, maxDexPriceAgeMs: 30_000 },
  });
  quote(r, 'binance', 1.0, 1e6, 1.001, 1e6);
  quote(r, 'jupiter', 1.05, 1e6, 1.051, 1e6, 10_000);

  await r.run();

  assert.equal(r.emitted.length, 1, 'DEX bacağı doğrulanıp fırsat üretmeliydi');
  assert.equal(r.emitted[0]!.kind, 'cex-dex');
  // Ayrım önemli: eleme olsaydı `rejectedByStale`'e yazılırdı ve panelde
  // gerçek CEX bayatlığından ayırt edilemezdi.
  assert.equal(r.scanner.stats.rejectedByStale, 0, 'bayatlık gerekçesiyle elenmemeliydi');
});

test('aşama 2: DEX bacağının yaşı kendi eşiğine göre uyarı üretir', async () => {
  // Uyarı eşiği de bacak başına: düz `maxPriceAgeMs / 2` (1.5 sn) ile HER
  // CEX↔DEX fırsatı "fiyat yaşı" uyarısı taşırdı. Her sinyalde çıkan uyarı
  // bilgi taşımaz — bu botta uyarıların değeri seyrek olmalarından geliyor.
  const r = rig({
    venues: ['binance', 'jupiter'],
    cfg: { prefilterPct: 0.001, maxPriceAgeMs: 3000, maxDexPriceAgeMs: 30_000 },
  });
  quote(r, 'binance', 1.0, 1e6, 1.001, 1e6);
  // 10 sn: DEX eşiğinin (30 sn) yarısının altında → uyarı YOK.
  quote(r, 'jupiter', 1.05, 1e6, 1.051, 1e6, 10_000);

  await r.run();

  assert.equal(r.emitted.length, 1);
  assert.ok(
    !r.emitted[0]!.warnings.some((w) => w.includes('fiyat yaşı')),
    `DEX bacağı kendi eşiğine göre taze; uyarı çıkmamalıydı: ${r.emitted[0]!.warnings.join(' | ')}`,
  );
});

test('aşama 2: DEX bacağı kendi eşiğinin yarısını aşınca uyarı çıkar', async () => {
  const r = rig({
    venues: ['binance', 'jupiter'],
    cfg: { prefilterPct: 0.001, maxPriceAgeMs: 3000, maxDexPriceAgeMs: 30_000 },
  });
  quote(r, 'binance', 1.0, 1e6, 1.001, 1e6);
  // 20 sn: hâlâ eşiğin içinde ama yarısını aştı → uyarı taşımalı.
  quote(r, 'jupiter', 1.05, 1e6, 1.051, 1e6, 20_000);

  await r.run();

  assert.equal(r.emitted.length, 1);
  assert.ok(r.emitted[0]!.warnings.some((w) => w.includes('fiyat yaşı')));
});

test('aşama 1: DEX eşiğini de aşan fiyat elenir', async () => {
  const r = rig({
    venues: ['binance', 'jupiter'],
    cfg: { prefilterPct: 0.001, maxPriceAgeMs: 3000, maxDexPriceAgeMs: 30_000 },
  });
  quote(r, 'binance', 1.0, 1e6, 1.001, 1e6);
  quote(r, 'jupiter', 1.05, 1e6, 1.051, 1e6, 45_000);

  await r.run();

  assert.equal(r.scanner.stats.candidateCount, 0);
  assert.ok(r.scanner.stats.staleVenueSkips > 0, 'atlanan okuma sayaca yansımalı');
});

test('aşama 1: CEX venue’su gevşek DEX eşiğinden yararlanamaz', async () => {
  // Eşiğin venue TÜRÜNE bağlı olduğunun kanıtı: aynı yaş, farklı sonuç.
  const r = rig({
    venues: ['binance', 'kucoin'],
    cfg: { prefilterPct: 0.001, maxPriceAgeMs: 3000, maxDexPriceAgeMs: 30_000 },
  });
  quote(r, 'binance', 1.0, 1e6, 1.001, 1e6);
  quote(r, 'kucoin', 1.05, 1e6, 1.051, 1e6, 10_000);

  await r.run();

  assert.equal(r.scanner.stats.candidateCount, 0, 'CEX için 3 sn eşiği geçerli kalmalı');
});

test('aşama 1: ön-eşiğin altındaki fark aday üretmez', async () => {
  const r = rig({ cfg: { prefilterPct: 0.01 } });
  // %0.5 ham fark, eşik %1.
  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6);
  quote(r, 'kucoin', 1.005, 1e6, 1.02, 1e6);

  await r.run();

  assert.equal(r.scanner.stats.candidateCount, 0);
  assert.equal(r.emitted.length, 0);
});

test('aşama 1: en iyi alış ve satış aynı borsadaysa aday üretilmez', async () => {
  const r = rig();
  // binance hem en düşük ask hem en yüksek bid — bu arbitraj değil, spread.
  quote(r, 'binance', 1.5, 1e6, 1.0, 1e6);
  quote(r, 'kucoin', 1.0, 1e6, 1.4, 1e6);

  await r.run();

  assert.equal(r.scanner.stats.candidateCount, 0);
});

test('aşama 1: bayat fiyat taramaya girmez', async () => {
  const r = rig({ cfg: { maxPriceAgeMs: 1000 } });
  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6, 5000); // 5 sn eski
  quote(r, 'kucoin', 1.1, 1e6, 1.12, 1e6, 0);

  await r.run();

  // binance bayat olduğu için hesaba katılmaz; geriye tek borsa kalır ve
  // tek borsada arbitraj olmaz.
  assert.equal(r.scanner.stats.candidateCount, 0);
  assert.equal(r.emitted.length, 0);
});

test('bayatlık iki taraftan birini düşürdüyse rejectedByStale artar', async () => {
  const r = rig({ cfg: { maxPriceAgeMs: 1000 } });
  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6, 5000);
  quote(r, 'kucoin', 1.1, 1e6, 1.12, 1e6, 0);
  await r.run();

  // Geriye tek taze borsa kaldı; arbitraj iki taraf istiyor.
  assert.equal(r.scanner.stats.rejectedByStale, 1);
  assert.equal(r.scanner.stats.staleVenueSkips, 1);
});

test('her iki borsa da bayatsa rejectedByStale artar', async () => {
  const r = rig({ cfg: { maxPriceAgeMs: 1000 } });
  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6, 5000);
  quote(r, 'kucoin', 1.1, 1e6, 1.12, 1e6, 5000);
  await r.run();

  assert.equal(r.scanner.stats.rejectedByStale, 1);
  assert.equal(r.scanner.stats.staleVenueSkips, 2);
});

test('yeterli taze borsa kaldıysa çift elenmez ama atlanan okuma sayılır', async () => {
  const r = rig({
    venues: ['binance', 'kucoin', 'okx'] as VenueId[],
    cfg: { maxPriceAgeMs: 1000 },
  });
  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6, 0);
  quote(r, 'kucoin', 1.05, 1e6, 1.06, 1e6, 0);
  quote(r, 'okx', 9.9, 1e6, 9.9, 1e6, 5000); // bayat, saçma fiyat

  await r.run();

  // İki taze borsa yeterli: çift elenmedi, fırsat üretildi.
  assert.equal(r.scanner.stats.rejectedByStale, 0);
  assert.equal(r.emitted.length, 1);
  // Ama bayat okuma yine de sayıldı — feed sağlığı görünür kalmalı.
  assert.equal(r.scanner.stats.staleVenueSkips, 1);
  // Ve bayat borsanın saçma fiyatı hesaba girmedi.
  assert.equal(r.emitted[0]!.sell.venue, 'kucoin');
});

// Sakin defter: "değişince yayınlayan" borsada L1 değişmediği için yaşlanan
// slot, borsa başka sembollere yazmaya devam ediyorsa taranır — ama kâr
// hesabına L1 değil zorunlu çekilen REST defteri girer.
const DIGER = 'DIGER/USDT' as PairKey;

function sakinRig(): Rig {
  return rig({ pairs: [PAIR, DIGER], cfg: { maxPriceAgeMs: 1000 } });
}

/** Borsanın BAŞKA bir sembolüne taze yazım — venue veri akıtıyor. */
function venueCanli(r: Rig, venue: VenueId): void {
  const now = Date.now();
  r.store.write(r.store.resolveSlot(DIGER, venue), 5, 1e6, 5.01, 1e6, now, now);
}

test('sakin defter: borsa canlıysa aday üretir ve REST defteri ZORUNLU çekilir', async () => {
  const r = sakinRig();
  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6, 10_000); // L1 10 sn'dir değişmedi
  venueCanli(r, 'binance');
  quote(r, 'kucoin', 1.05, 1e6, 1.06, 1e6, 0);
  r.depth.set('binance', PAIR, { asks: [[1.0, 1e6]] });

  await r.run();

  // L1 miktarı talebi karşılasa da bayat L1 kâra girmez.
  assert.equal(r.depth.calls.length, 1);
  assert.equal(r.depth.calls[0]!.venue, 'binance');
  assert.equal(r.emitted.length, 1);
  assert.equal(r.scanner.stats.rejectedByStale, 0);
  // Yayın yaşı kullanılan değerin (REST defteri) yaşıdır, L1'in değil.
  assert.ok(r.emitted[0]!.buy.ageMs < 1000, `yaş ${r.emitted[0]!.buy.ageMs}`);
});

test('sakin defter: REST defteri farkı kapatmışsa sinyal üretilmez', async () => {
  const r = sakinRig();
  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6, 10_000);
  venueCanli(r, 'binance');
  quote(r, 'kucoin', 1.05, 1e6, 1.06, 1e6, 0);
  // Gerçek defter artık 1.06'dan satıyor — sakin görünen L1 yanlıştı.
  r.depth.set('binance', PAIR, { asks: [[1.06, 1e6]] });

  await r.run();

  assert.equal(r.depth.calls.length, 1);
  assert.equal(r.emitted.length, 0);
});

test('sakin defter: borsa hiç veri akıtmıyorsa bayat sayılır', async () => {
  const r = sakinRig();
  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6, 10_000);
  quote(r, 'kucoin', 1.05, 1e6, 1.06, 1e6, 0);

  await r.run();

  assert.equal(r.scanner.stats.candidateCount, 0);
  assert.equal(r.scanner.stats.rejectedByStale, 1);
});

test('sakin defter: üst sınırı (60 sn) aşan L1 borsa canlı olsa da bayattır', async () => {
  const r = sakinRig();
  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6, 61_000);
  venueCanli(r, 'binance');
  quote(r, 'kucoin', 1.05, 1e6, 1.06, 1e6, 0);

  await r.run();

  assert.equal(r.scanner.stats.candidateCount, 0);
  assert.equal(r.depth.calls.length, 0);
});

test('hiç veri yazılmamış borsa bayat sayılmaz', async () => {
  // recvTs=0 "hiç tick gelmedi" demek; bunu bayatlık olarak saymak
  // başlangıçta sayaçları şişirirdi.
  const r = rig({ venues: ['binance', 'kucoin', 'okx'] as VenueId[] });
  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6, 0);
  quote(r, 'kucoin', 1.05, 1e6, 1.06, 1e6, 0);
  // okx'e hiç yazılmadı

  await r.run();

  assert.equal(r.scanner.stats.staleVenueSkips, 0);
  assert.equal(r.scanner.stats.rejectedByStale, 0);
});

test('aşama 1: yalnızca dirty çiftler taranır', async () => {
  const r = rig({ pairs: ['A/USDT', 'B/USDT'] as PairKey[] });
  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6);
  await r.run();

  // flushDirty tükettikten sonra yeni tick yoksa tur bile sayılmaz.
  const before = r.scanner.stats.evalCount;
  (r.scanner as unknown as ScannerInternals).evaluate();
  assert.equal(r.scanner.stats.evalCount, before, 'dirty yoksa tarama turu harcanmamalı');
});

// ---------------------------------------------------------------------------
// Aşama 2 — kâr hesabı
// ---------------------------------------------------------------------------

test('aşama 2: L1 derinliği yetiyorsa L2 defteri hiç çekilmez', async () => {
  const r = rig();
  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6);
  quote(r, 'kucoin', 1.02, 1e6, 1.03, 1e6);

  await r.run();

  assert.equal(r.depth.calls.length, 0, 'L1 yetiyorken REST çağrısı yapılmamalı');
  assert.equal(r.emitted.length, 1);
});

test('aşama 2: net kâr komisyon + çekim ücretini içerir', async () => {
  const r = rig({ cfg: { takerFees: { binance: 0.001, kucoin: 0.001 } } });
  r.transfers.setRule('binance', 'KOIN', 'solana', { withdrawFee: 0.5 });

  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6);
  quote(r, 'kucoin', 1.02, 1e6, 1.03, 1e6);

  await r.run();

  assert.equal(r.emitted.length, 1);
  const o = r.emitted[0]!;

  // 1000 USDT → 1000 KOIN @1.00
  // komisyon base'ten: 1000 * 0.999 = 999
  // çekim ücreti:      999 - 0.5    = 998.5
  // satış:             998.5 * 1.02 = 1018.47
  // satış komisyonu:   1018.47 * 0.001 = 1.01847
  // net:               1018.47 - 1.01847 - 1000 = 17.45153
  assert.equal(o.coin, 'KOIN');
  assert.equal(o.buy.venue, 'binance');
  assert.equal(o.sell.venue, 'kucoin');
  assert.ok(Math.abs(o.netQuote - 17.45153) < 1e-6, `netQuote=${o.netQuote}`);
  assert.ok(Math.abs(o.netPct - 0.01745153) < 1e-9, `netPct=${o.netPct}`);
  assert.equal(o.chain, 'solana');
  assert.equal(o.kind, 'cex-cex');
});

test('aşama 2: eşiğin altında kalan net kâr yayınlanmaz', async () => {
  // %0.4 ham fark, iki tarafta %0.1 komisyon → net negatife yakın.
  const r = rig({ cfg: { minNetPct: 0.004, prefilterPct: 0.001 } });
  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6);
  quote(r, 'kucoin', 1.004, 1e6, 1.01, 1e6);

  await r.run();

  assert.equal(r.scanner.stats.candidateCount, 1, 'aday üretilmeli');
  assert.equal(r.emitted.length, 0, 'ama kâr eşiği geçmemeli');
});

test('aşama 2: L1 sığsa L2 defteri çekilir ve VWAP kullanılır', async () => {
  const r = rig();
  // binance L1'de yalnızca 10 adet var, 1000 USDT için 1000 adet lazım.
  quote(r, 'binance', 0.99, 10, 1.0, 10);
  quote(r, 'kucoin', 1.05, 1e6, 1.06, 1e6);

  r.depth.set('binance', PAIR, {
    asks: [
      [1.0, 10],
      [1.01, 500],
      [1.02, 2000],
    ],
  });

  await r.run();

  assert.equal(r.depth.calls.length, 1, 'sığ L1 için L2 çekilmeli');
  assert.equal(r.depth.calls[0]!.venue, 'binance');
  assert.equal(r.emitted.length, 1);

  const o = r.emitted[0]!;
  assert.ok(o.buy.vwap > o.buy.bestPrice, 'VWAP en iyi fiyattan kötü olmalı');
  assert.ok(
    o.warnings.some((w) => w.includes('alışta')),
    `kayma uyarısı bekleniyordu: ${JSON.stringify(o.warnings)}`,
  );
});

test('aşama 2: defterin tamamı bile yetmiyorsa fırsat reddedilir', async () => {
  const r = rig();
  quote(r, 'binance', 0.99, 5, 1.0, 5);
  quote(r, 'kucoin', 1.05, 1e6, 1.06, 1e6);

  // Toplam defter 20 USDT'lik — 1000 USDT'lik talebi karşılamıyor.
  r.depth.set('binance', PAIR, { asks: [[1.0, 20]] });

  await r.run();

  assert.equal(r.emitted.length, 0);
  assert.equal(r.scanner.stats.rejectedByDepth, 1);
});

test('aşama 2: L2 defteri ÇEKİLEMEZSE fırsat düşer ve ARIZA olarak sayılır', async () => {
  const r = rig();
  quote(r, 'binance', 0.99, 5, 1.0, 5);
  quote(r, 'kucoin', 1.05, 1e6, 1.06, 1e6);
  // depth.set çağrılmadı → fetcher null döner = çekilemedi (429/timeout).

  await r.run();

  assert.equal(r.emitted.length, 0);
  // Altyapı bloğu ile ince defter AYRI kovada: aynı sayaçta görünselerdi
  // "derinlikten düşenlerin %94'ü ince CEX defteri" sonucu çıkarılamazdı.
  assert.equal(r.scanner.stats.rejectedByDepthFetch, 1);
  assert.equal(r.scanner.stats.rejectedByDepth, 0);
  assert.match(r.scanner.stats.lastDepthFetchError ?? '', /binance/);
});

test('aşama 2: defter çekildi ama BOŞ ise "derinlik yok" sayılır', async () => {
  const r = rig();
  quote(r, 'binance', 0.99, 5, 1.0, 5);
  quote(r, 'kucoin', 1.05, 1e6, 1.06, 1e6);
  r.depth.set('binance', PAIR, { asks: [], bids: [] });

  await r.run();

  assert.equal(r.emitted.length, 0);
  assert.equal(r.scanner.stats.rejectedByDepth, 1);
  assert.equal(r.scanner.stats.rejectedByDepthFetch, 0);
});

// ---------------------------------------------------------------------------
// Transfer yolu
// ---------------------------------------------------------------------------

test('çekim kapalıysa fırsat üretilmez', async () => {
  const r = rig();
  r.transfers.setRule('binance', 'KOIN', 'solana', { withdrawEnabled: false });

  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6);
  quote(r, 'kucoin', 1.05, 1e6, 1.06, 1e6);

  await r.run();

  assert.equal(r.emitted.length, 0);
  assert.equal(r.scanner.stats.rejectedByTransfer, 1);
});

test('yatırma kapalıysa fırsat üretilmez', async () => {
  const r = rig();
  r.transfers.setRule('kucoin', 'KOIN', 'solana', { depositEnabled: false });

  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6);
  quote(r, 'kucoin', 1.05, 1e6, 1.06, 1e6);

  await r.run();

  assert.equal(r.emitted.length, 0);
  assert.equal(r.scanner.stats.rejectedByTransfer, 1);
});

test('ortak zincir yoksa fırsat üretilmez', async () => {
  const r = rig();
  r.transfers.setChains('KOIN', []);

  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6);
  quote(r, 'kucoin', 1.05, 1e6, 1.06, 1e6);

  await r.run();

  assert.equal(r.emitted.length, 0);
  assert.equal(r.scanner.stats.rejectedByTransfer, 1);
});

test('net kâr makul sınırı aşarsa uyarı taşır ama yayınlanır', async () => {
  const r = rig();
  // %77'lik RWA sinyali gerçekte böyle görünüyordu: iki borsanın fiyatı
  // arasında iki katı fark. Eleme DEĞİL uyarı bekliyoruz — sebebi bilinmeyen
  // bir sinyali sessizce yutmak, onu görünür kılmaktan tehlikeli.
  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6);
  quote(r, 'kucoin', 2.3, 1e6, 2.33, 1e6);

  await r.run();

  assert.equal(r.emitted.length, 1);
  assert.ok(
    r.emitted[0]!.warnings.some((w) => w.includes('veri hatası')),
    `makul olmayan kâr uyarısı bekleniyordu, gelen: ${JSON.stringify(r.emitted[0]!.warnings)}`,
  );
});

test('makul aralıktaki kâr uyarı taşımaz', async () => {
  const r = rig();
  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6);
  quote(r, 'kucoin', 1.05, 1e6, 1.06, 1e6);

  await r.run();

  assert.equal(r.emitted.length, 1);
  assert.ok(!r.emitted[0]!.warnings.some((w) => w.includes('veri hatası')));
});

// ---------------------------------------------------------------------------
// Kimlik kuralı: aynı ticker ≠ aynı varlık
//
// Canlı testte ölçülen durum: gate "RWA" ile Allo'yu (BSC, 0x9c8b…), kucoin
// "RWA" ile RWA Inc'i (Base, 0xe2b1…) kastediyordu ve bot aradaki %77'lik
// farkı 8 saat boyunca fırsat sanıp bildirdi. Aynı zincirde de oluyor
// (DEFAI/solana: kucoin `hwfh2kn2…`, gate `8zx6ecj3…`) — o durumda zincir
// kesişimi kontrolü de kurtarmaz, tek dayanak adrestir.
// ---------------------------------------------------------------------------

test('kimlik: iki borsa farklı kontrat bildiriyorsa fırsat üretilmez', async () => {
  const r = rig();
  r.transfers.setRule('binance', 'KOIN', 'solana', { address: 'Hwfh2kn2Ry' });
  r.transfers.setRule('kucoin', 'KOIN', 'solana', { address: '8zx6EcJ3fi' });

  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6);
  quote(r, 'kucoin', 1.05, 1e6, 1.06, 1e6);

  await r.run();

  assert.equal(r.emitted.length, 0);
  assert.equal(r.scanner.stats.rejectedByAddress, 1);
  // Kimlik çakışması transfer gerekçesiyle KARIŞMAMALI: biri kalıcı bir veri
  // gerçeği, diğeri yarın değişebilecek operasyonel bir durum.
  assert.equal(r.scanner.stats.rejectedByTransfer, 0);
});

test('kimlik: adresler aynıysa fırsat geçer', async () => {
  const r = rig();
  r.transfers.setRule('binance', 'KOIN', 'solana', { address: 'Hwfh2kn2Ry' });
  r.transfers.setRule('kucoin', 'KOIN', 'solana', { address: 'Hwfh2kn2Ry' });

  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6);
  quote(r, 'kucoin', 1.05, 1e6, 1.06, 1e6);

  await r.run();

  assert.equal(r.emitted.length, 1);
  assert.equal(r.scanner.stats.rejectedByAddress, 0);
});

test('kimlik: EVM adresinde harf düzeni farkı çakışma sayılmaz', async () => {
  const r = rig();
  // Aynı adres, biri checksum'lı biri düz — borsalar bunu farklı yazıyor.
  r.transfers.setRule('binance', 'KOIN', 'solana', {
    address: '0x912ce59144191c1204e64559fe8253a0e49e6548',
  });
  r.transfers.setRule('kucoin', 'KOIN', 'solana', {
    address: '0x912CE59144191C1204E64559FE8253a0e49E6548'.toLowerCase(),
  });

  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6);
  quote(r, 'kucoin', 1.05, 1e6, 1.06, 1e6);

  await r.run();

  assert.equal(r.emitted.length, 1);
});

test('kimlik: tek taraf adres bilmiyorsa fırsat elenmez', async () => {
  const r = rig();
  // Bybit kontrat adresi HİÇ vermiyor. Bilinmeyeni çakışma sayan bir kontrol
  // o borsanın bütün rotalarını sessizce yok ederdi.
  r.transfers.setRule('binance', 'KOIN', 'solana', { address: 'Hwfh2kn2Ry' });
  r.transfers.setRule('kucoin', 'KOIN', 'solana', { address: null });

  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6);
  quote(r, 'kucoin', 1.05, 1e6, 1.06, 1e6);

  await r.run();

  assert.equal(r.emitted.length, 1);
  assert.equal(r.scanner.stats.rejectedByAddress, 0);
});

test('kimlik: bir zincirde çakışsa da uyuşan zincir varsa o seçilir', async () => {
  const r = rig();
  r.transfers.setChains('KOIN', ['arbitrum', 'solana']);
  r.transfers.setRule('binance', 'KOIN', 'arbitrum', { address: '0xaaa1111111' });
  r.transfers.setRule('kucoin', 'KOIN', 'arbitrum', { address: '0xbbb2222222' });
  r.transfers.setRule('binance', 'KOIN', 'solana', { address: 'Hwfh2kn2Ry' });
  r.transfers.setRule('kucoin', 'KOIN', 'solana', { address: 'Hwfh2kn2Ry' });

  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6);
  quote(r, 'kucoin', 1.05, 1e6, 1.06, 1e6);

  await r.run();

  assert.equal(r.emitted.length, 1);
  assert.equal(r.emitted[0]!.chain, 'solana');
  // Fırsat reddedilmedi, yalnızca rota değişti — sayaç artmamalı.
  assert.equal(r.scanner.stats.rejectedByAddress, 0);
});

test('birden fazla zincir varsa en ucuz çekim ücreti seçilir', async () => {
  const r = rig();
  r.transfers.setChains('KOIN', ['arbitrum', 'solana']);
  r.transfers.setRule('binance', 'KOIN', 'arbitrum', { withdrawFee: 5 });
  r.transfers.setRule('binance', 'KOIN', 'solana', { withdrawFee: 0.1 });

  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6);
  quote(r, 'kucoin', 1.05, 1e6, 1.06, 1e6);

  await r.run();

  assert.equal(r.emitted.length, 1);
  assert.equal(r.emitted[0]!.chain, 'solana');
});

test('doğrulanmamış transfer: allowUnverified=false ise reddedilir', async () => {
  const r = rig({ cfg: { allowUnverifiedTransfer: false } });
  r.transfers.setRule('binance', 'KOIN', 'solana', { verified: false });

  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6);
  quote(r, 'kucoin', 1.05, 1e6, 1.06, 1e6);

  await r.run();

  assert.equal(r.emitted.length, 0);
  assert.equal(r.scanner.stats.rejectedByTransfer, 1);
});

test('doğrulanmamış transfer: allowUnverified=true ise uyarıyla geçer', async () => {
  const r = rig({ cfg: { allowUnverifiedTransfer: true } });
  r.transfers.setRule('binance', 'KOIN', 'solana', { verified: false });

  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6);
  quote(r, 'kucoin', 1.05, 1e6, 1.06, 1e6);

  await r.run();

  assert.equal(r.emitted.length, 1);
  assert.equal(r.emitted[0]!.transferVerified, false);
  assert.ok(r.emitted[0]!.warnings.some((w) => w.includes('doğrulanamadı')));
});

test('çekim ücreti bakiyeyi silip süpürüyorsa fırsat reddedilir', async () => {
  const r = rig();
  // 1000 USDT ile 1000 coin alınıyor; çekim ücreti 5000 coin.
  r.transfers.setRule('binance', 'KOIN', 'solana', { withdrawFee: 5000 });

  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6);
  quote(r, 'kucoin', 1.05, 1e6, 1.06, 1e6);

  await r.run();

  assert.equal(r.emitted.length, 0);
  assert.equal(r.scanner.stats.rejectedByTransfer, 1);
});

// ---------------------------------------------------------------------------
// Kuyruk yönetimi
// ---------------------------------------------------------------------------

test('kuyruk taşınca en DÜŞÜK kârlı aday atılır', async () => {
  const pairs = ['A/USDT', 'B/USDT', 'C/USDT'] as PairKey[];
  const r = rig({
    pairs,
    scanner: { maxQueueDepth: 2, maxConcurrentChecks: 0 }, // drain kilitli
  });
  const store = r.store;
  const now = Date.now();
  const s = (p: PairKey, v: VenueId): number => store.resolveSlot(p, v);

  // A: %1, B: %10, C: %5 ham fark
  store.write(s(pairs[0]!, 'binance'), 0.99, 1e6, 1.0, 1e6, now, now);
  store.write(s(pairs[0]!, 'kucoin'), 1.01, 1e6, 1.02, 1e6, now, now);
  store.write(s(pairs[1]!, 'binance'), 0.99, 1e6, 1.0, 1e6, now, now);
  store.write(s(pairs[1]!, 'kucoin'), 1.1, 1e6, 1.12, 1e6, now, now);
  store.write(s(pairs[2]!, 'binance'), 0.99, 1e6, 1.0, 1e6, now, now);
  store.write(s(pairs[2]!, 'kucoin'), 1.05, 1e6, 1.06, 1e6, now, now);

  (r.scanner as unknown as ScannerInternals).evaluate();

  assert.equal(r.scanner.stats.candidateCount, 3);
  assert.equal(r.scanner.stats.droppedCount, 1, 'bir aday düşürülmeliydi');
  assert.equal(r.scanner.stats.queueDepth, 2);
});

test('aynı çift+yön doğrulamadayken tekrar kuyruğa alınmaz', async () => {
  const r = rig({ scanner: { maxConcurrentChecks: 0 } });
  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6);
  quote(r, 'kucoin', 1.05, 1e6, 1.06, 1e6);

  (r.scanner as unknown as ScannerInternals).evaluate();
  quote(r, 'kucoin', 1.06, 1e6, 1.07, 1e6);
  (r.scanner as unknown as ScannerInternals).evaluate();

  assert.equal(r.scanner.stats.candidateCount, 1);
  assert.equal(r.scanner.stats.queueDepth, 1);
});

// ---------------------------------------------------------------------------
// Sahte sinyal savunmaları
// ---------------------------------------------------------------------------

test('fiyat yaşı eşiğin yarısını geçerse uyarı eklenir', async () => {
  const r = rig({ cfg: { maxPriceAgeMs: 3000 } });
  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6, 2000); // yaş 2000 > 1500
  quote(r, 'kucoin', 1.05, 1e6, 1.06, 1e6, 0);

  await r.run();

  assert.equal(r.emitted.length, 1);
  assert.ok(
    r.emitted[0]!.warnings.some((w) => w.includes('fiyat yaşı')),
    JSON.stringify(r.emitted[0]!.warnings),
  );
});

// ---------------------------------------------------------------------------
// Asgari çekim tutarı (withdrawMin)
// ---------------------------------------------------------------------------

test('asgari çekim tutarı karşılanmıyorsa fırsat üretilmez', async () => {
  const r = rig();
  // Borsa bu coin'i ancak 100000 adetten fazlaysa çektiriyor; biz ~1000 adet
  // transfer edecektik. Bu transfer gerçekte hiç yapılamaz.
  r.transfers.setRule('binance', 'KOIN', 'solana', { withdrawMin: 100_000 });

  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6);
  quote(r, 'kucoin', 1.05, 1e6, 1.06, 1e6);

  await r.run();

  assert.equal(r.emitted.length, 0);
  assert.equal(r.scanner.stats.rejectedByTransfer, 1);
});

test('asgari çekim tutarı karşılanıyorsa fırsat geçer', async () => {
  const r = rig();
  r.transfers.setRule('binance', 'KOIN', 'solana', { withdrawMin: 500 });

  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6);
  quote(r, 'kucoin', 1.05, 1e6, 1.06, 1e6);

  await r.run();

  assert.equal(r.emitted.length, 1);
});

test('asgari çekim komisyon SONRASI miktara uygulanır', async () => {
  // 1000 USDT → 1000 coin, %1 komisyon sonrası 990 coin çekilecek.
  // Asgari 995 ise bu transfer yapılamaz.
  const r = rig({ cfg: { takerFees: { binance: 0.01 } } });
  r.transfers.setRule('binance', 'KOIN', 'solana', { withdrawMin: 995 });

  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6);
  quote(r, 'kucoin', 1.1, 1e6, 1.12, 1e6);

  await r.run();

  assert.equal(r.emitted.length, 0, 'komisyon öncesi 1000 ≥ 995 ama sonrası 990 < 995');
  assert.equal(r.scanner.stats.rejectedByTransfer, 1);
});

test('asgari çekimi karşılamayan zincir elenir, karşılayan zincir seçilir', async () => {
  const r = rig();
  r.transfers.setChains('KOIN', ['arbitrum', 'solana']);
  // arbitrum daha ucuz ama asgari tutarı karşılanamıyor.
  r.transfers.setRule('binance', 'KOIN', 'arbitrum', { withdrawFee: 0.1, withdrawMin: 100_000 });
  r.transfers.setRule('binance', 'KOIN', 'solana', { withdrawFee: 2 });

  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6);
  quote(r, 'kucoin', 1.05, 1e6, 1.06, 1e6);

  await r.run();

  assert.equal(r.emitted.length, 1);
  assert.equal(r.emitted[0]!.chain, 'solana', 'ucuz ama ulaşılamaz zincir seçilmemeli');
});

// ---------------------------------------------------------------------------
// Maliyet dökümünün tutarlılığı
// ---------------------------------------------------------------------------

test('costs dökümü netQuote ile birebir denkleşir', async () => {
  const r = rig({ cfg: { takerFees: { binance: 0.001, kucoin: 0.001 } } });
  r.transfers.setRule('binance', 'KOIN', 'solana', { withdrawFee: 0.5 });

  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6);
  quote(r, 'kucoin', 1.02, 1e6, 1.03, 1e6);

  await r.run();
  const o = r.emitted[0]!;

  const toplamMaliyet =
    o.costs.buyFee + o.costs.sellFee + o.costs.withdrawFee + o.costs.gas + o.costs.bridge;

  assert.ok(
    Math.abs(o.grossQuote - toplamMaliyet - o.netQuote) < 1e-9,
    `gross=${o.grossQuote} costs=${toplamMaliyet} net=${o.netQuote}`,
  );
  // Alış komisyonu satış fiyatıyla değerleniyor: 1000 * 0.001 * 1.02 = 1.02
  assert.ok(Math.abs(o.costs.buyFee - 1.02) < 1e-9, `buyFee=${o.costs.buyFee}`);
});

test('costs dökümü gas dahil olduğunda da denkleşir', async () => {
  const r = rig({
    venues: ['binance', 'kucoin', 'jupiter'] as VenueId[],
    cfg: { gasCostUsd: { solana: 0.5 } },
  });
  r.transfers.setRule('binance', 'KOIN', 'solana', { withdrawFee: 0.5 });

  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6);
  quote(r, 'kucoin', 1.02, 1e6, 1.03, 1e6);
  quote(r, 'jupiter', 1.04, 1e6, 1.05, 1e6);

  await r.run();

  assert.equal(r.emitted.length, 1);
  const o = r.emitted[0]!;
  assert.equal(o.kind, 'cex-dex');
  assert.equal(o.costs.gas, 0.5, 'DEX bacağı için gas kesilmeli');

  const toplamMaliyet =
    o.costs.buyFee + o.costs.sellFee + o.costs.withdrawFee + o.costs.gas + o.costs.bridge;
  assert.ok(
    Math.abs(o.grossQuote - toplamMaliyet - o.netQuote) < 1e-9,
    `gross=${o.grossQuote} costs=${toplamMaliyet} net=${o.netQuote}`,
  );
});

test('fırsat kimliği coin ve yönü içerir — ters yön ayrı fırsattır', async () => {
  const r = rig();
  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6);
  quote(r, 'kucoin', 1.05, 1e6, 1.06, 1e6);
  await r.run();

  assert.equal(r.emitted[0]!.id, 'KOIN|binance->kucoin');
});

// ---------------------------------------------------------------------------
// Venue kimliği — aynı zincirde iki DEX
//
// `raydium` eklendiğinde ortaya çıkan hata sınıfı: doğrulayıcı arayüzü ZİNCİR
// alıyordu ve `jupiter` de `raydium` da 'solana' diyor. Yani Raydium'da
// ölçülen fiyat Jupiter rotasıyla doğrulanırdı — uygulanamayacak bir rotayı
// kâr hesabına sokmak. Kimlik kuralının venue tarafındaki karşılığı.
// ---------------------------------------------------------------------------

test('DEX doğrulaması bacağın KENDİ venue’suna sorulur', async () => {
  const q = fakeLegQuoter({ buyBase: 1000 });
  const r = rig({
    venues: ['raydium', 'binance'],
    legQuoter: q.quoter,
    cfg: { prefilterPct: 0.001, minNetPct: 0.001, takerFees: { binance: 0 } },
  });

  r.store.write(r.slot('raydium'), 1.0, 0, 1.0, 0, Date.now(), Date.now());
  quote(r, 'binance', 1.05, 1e6, 1.06, 1e6);

  await r.run();

  assert.ok(
    q.calls.some((c) => c.startsWith('buy:raydium:KOIN:')),
    `raydium bacağı raydium'a sorulmalıydı, çağrılar: ${q.calls.join(',')}`,
  );
  assert.equal(r.emitted.length, 1);
});

// ---------------------------------------------------------------------------
// DEX bacağının ikinci görüşü (çapraz kontrol)
// ---------------------------------------------------------------------------

function fakeCapraz(
  sapmaPct: number | null,
  opts: { firlat?: boolean } = {},
): { kontrol: CaprazKontrol; cagrilar: string[] } {
  const cagrilar: string[] = [];
  return {
    cagrilar,
    kontrol: {
      destekler: (v) => v === 'aerodrome' || v === 'uniswap-v3-base',
      async kontrol(venue, symbol, yon, girdi, bizimCikti): Promise<CaprazSonuc | null> {
        cagrilar.push(`${venue}:${yon}:${symbol}`);
        if (opts.firlat) throw new Error('CoW erişimi engellendi');
        if (sapmaPct === null) return null;
        return {
          kaynak: 'cow',
          miktar: bizimCikti / (1 + sapmaPct),
          sapmaPct,
        };
      },
    },
  };
}

/** Base DEX'te ucuz alış, binance'te pahalı satış — quote miktarı yazılı. */
function baseRig(capraz: CaprazKontrol | null) {
  const r = rig({
    venues: ['aerodrome', 'binance'],
    capraz,
    cfg: { prefilterPct: 0.001, minNetPct: 0.004, takerFees: { binance: 0 } },
  });
  // EVM feed'i miktarı ZATEN yazıyor (Solana'nın aksine), yani leg quoter'a
  // hiç gidilmez — çapraz kontrolün tek konusu bu rota.
  const now = Date.now();
  r.store.write(r.slot('aerodrome'), 1.0, 1e6, 1.0, 1e6, now, now);
  quote(r, 'binance', 1.05, 1e6, 1.06, 1e6);
  return r;
}

test('çapraz kontrol: ikinci kaynak daha kötü diyorsa uyarı düşer', async () => {
  const c = fakeCapraz(0.02); // biz %2 iyimseriz, minNetPct %0.4
  const r = baseRig(c.kontrol);
  await r.run();

  assert.equal(r.emitted.length, 1, 'kontrol ELEME değil uyarıdır — sinyal yayınlanmalı');
  const o = r.emitted[0]!;
  assert.ok(
    o.warnings.some((w) => w.includes('iyimser')),
    `uyarı bekleniyordu: ${JSON.stringify(o.warnings)}`,
  );
  assert.equal(o.capraz?.kaynak, 'cow');
  assert.equal(o.capraz?.venue, 'aerodrome');
});

test('çapraz kontrol: sapma kâr eşiğinin altındaysa uyarı YOK ama kayıt VAR', async () => {
  // Uyuşma da bilgidir: "kontrol edildi ve uydu" ile "hiç kontrol edilmedi"
  // ayırt edilebilmeli, yoksa kontrolün çalışmadığı bir gecede sinyale
  // fazladan güvenilir.
  const c = fakeCapraz(0.001);
  const r = baseRig(c.kontrol);
  await r.run();

  const o = r.emitted[0]!;
  assert.ok(!o.warnings.some((w) => w.includes('iyimser')));
  assert.ok(o.capraz, 'sapma küçük olsa da kayıt taşınmalı');
});

test('çapraz kontrol: BİZ kötümsersek uyarı yok', async () => {
  const c = fakeCapraz(-0.05);
  const r = baseRig(c.kontrol);
  await r.run();
  assert.ok(!r.emitted[0]!.warnings.some((w) => w.includes('iyimser')));
});

test('çapraz kontrol arızası sinyali ÖLDÜRMEZ', async () => {
  // CoW'un önündeki CDN bloğu ölçülmüş bir gerçek. Blok anında tüm base
  // sinyallerinin susması, kontrolün faydasından büyük bir zarar olurdu.
  const c = fakeCapraz(null, { firlat: true });
  const r = baseRig(c.kontrol);
  await r.run();

  assert.equal(r.emitted.length, 1);
  assert.equal(r.emitted[0]!.capraz, undefined, 'kontrol yapılamadıysa alan boş kalmalı');
});

test('çapraz kontrol desteklemediği venue’ya hiç sorulmaz', async () => {
  const c = fakeCapraz(0.5);
  const r = rig({
    venues: ['jupiter', 'binance'],
    capraz: c.kontrol,
    legQuoter: fakeLegQuoter({ buyBase: 1000 }).quoter,
    cfg: { prefilterPct: 0.001, minNetPct: 0.001, takerFees: { binance: 0 } },
  });
  r.store.write(r.slot('jupiter'), 1.0, 0, 1.0, 0, Date.now(), Date.now());
  quote(r, 'binance', 1.05, 1e6, 1.06, 1e6);
  await r.run();

  assert.equal(c.cagrilar.length, 0, 'solana bacağı CoW’a sorulmamalı');
  assert.equal(r.emitted.length, 1);
});

// ---------------------------------------------------------------------------
// Tokenlaştırılmış hisse senetleri (xStocks) — ek kesinti
//
// ÖLÇÜLDÜ: Gate ve MEXC bu çiftlere normal çiftlerle BİREBİR aynı taker
// oranını uyguluyor (%0.2 / %0.05), yani borsanın komisyon tarifesi bu
// maliyeti içermiyor. Kullanıcı Bybit'e Solana üzerinden yaptığı transferde
// ~%1.5 kayıp ölçtü. Modellenmezse bu 13 token sistematik bir sahte sinyal
// kaynağıdır: %0.4 eşiğini geçen her hisse fırsatı gerçekte zarardadır.
// ---------------------------------------------------------------------------

test('hisse tokeninde ek kesinti kâra yansır ve fırsatı eler', async () => {
  const kur = (hisse: string[]) => {
    const r = rig({
      venues: ['binance', 'kucoin'],
      cfg: {
        prefilterPct: 0.001,
        minNetPct: 0.004,
        takerFees: { binance: 0, kucoin: 0 },
        hisseTokenleri: hisse,
        hisseTokenEkPct: 0.015,
      },
    });
    // %1 ham fark: ek kesinti yokken sinyal, iki bacakta %1.5 kesintiyle yok.
    quote(r, 'binance', 0.99, 1e6, 1.0, 1e6);
    quote(r, 'kucoin', 1.01, 1e6, 1.02, 1e6);
    return r;
  };

  const listesiz = kur([]);
  await listesiz.run();
  assert.equal(listesiz.emitted.length, 1, 'ek kesinti yokken fırsat üretilmeliydi');

  const listeli = kur(['KOIN']);
  await listeli.run();
  assert.equal(listeli.emitted.length, 0, 'ek kesinti fırsatı elemeliydi');
});

test('ek kesinti uygulandığında sinyal bunu UYARI olarak taşır', async () => {
  const r = rig({
    venues: ['binance', 'kucoin'],
    cfg: {
      prefilterPct: 0.001,
      minNetPct: 0.004,
      takerFees: { binance: 0, kucoin: 0 },
      hisseTokenleri: ['KOIN'],
      hisseTokenEkPct: 0.001,
    },
  });
  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6);
  quote(r, 'kucoin', 1.01, 1e6, 1.02, 1e6);
  await r.run();

  assert.equal(r.emitted.length, 1);
  assert.ok(
    r.emitted[0]!.warnings.some((w) => w.includes('hisse tokeni')),
    `uyarı bekleniyordu: ${JSON.stringify(r.emitted[0]!.warnings)}`,
  );
});

test('ek kesinti DEX bacağına uygulanmaz (havuz ücreti quote fiyatında)', async () => {
  const q = fakeLegQuoter({ buyBase: 1000 });
  const r = rig({
    venues: ['jupiter', 'binance'],
    legQuoter: q.quoter,
    cfg: {
      prefilterPct: 0.001,
      minNetPct: 0.001,
      takerFees: { binance: 0 },
      hisseTokenleri: ['KOIN'],
      hisseTokenEkPct: 0.015,
    },
  });
  r.store.write(r.slot('jupiter'), 1.0, 0, 1.0, 0, Date.now(), Date.now());
  quote(r, 'binance', 1.05, 1e6, 1.06, 1e6);
  await r.run();

  assert.equal(r.emitted.length, 1, 'tek CEX bacağı %1.5, brüt %5 — fırsat kalmalı');
  // Alış DEX'te: alış komisyonu sıfır olmalı.
  assert.equal(r.emitted[0]!.buy.feeQuote, 0);
});

// ---------------------------------------------------------------------------
// Makul olmayan HAM fark — Aşama 1 elemesi
//
// ÖLÇÜLDÜ (2026-09-01): kuyruk ham farka göre sıralandığı için tepeyi her
// zaman BOZUK fiyatlar işgal ediyor. 7 dakikada kâr hesabına ulaşan 12 çiftin
// 12'si de bozuk kaynaklıydı ve net oranları %-17 ile %-99.95 arasındaydı.
// Yani doğrulama kapasitesinin TAMAMI sinyale dönüşemeyecek adaylara gidiyordu.
// ---------------------------------------------------------------------------

const makulDegilSayaci = (r: Rig): number =>
  (r.scanner.stats as unknown as { makulDegilAday: number }).makulDegilAday;

test('ham farkı %20 üstü aday SAYILIR ama elenmez', async () => {
  const r = rig({
    venues: ['binance', 'kucoin'],
    cfg: { prefilterPct: 0.001, minNetPct: 0.001, takerFees: { binance: 0, kucoin: 0 } },
  });

  // %100 ham fark — ticker çakışmasının tipik imzası.
  quote(r, 'binance', 0.99, 1e6, 1.0, 1e6);
  quote(r, 'kucoin', 2.0, 1e6, 2.02, 1e6);
  await r.run();

  assert.ok(makulDegilSayaci(r) > 0, 'sayaç artmalı — sessiz davranış teşhis edilemez');
  // Kuyruk boşken doğrulanır ve UYARISIYLA yayınlanır: eleme değil, öncelik
  // düşürme. Elemek `IMPLAUSIBLE_NET_PCT` ağını ulaşılamaz yapardı.
  assert.equal(r.emitted.length, 1);
  assert.ok(r.emitted[0]!.warnings.some((w) => w.includes('veri hatası')));
});

test('makul olmayan aday kuyruk dolduğunda İLK atılan olur', async () => {
  // Asıl mesele buydu: bozuk fiyatın ham farkı her zaman en büyük olduğu için
  // kuyruğun tepesini o işgal ediyor ve gerçek adayları aç bırakıyordu.
  const r = rig({
    pairs: ['AAA/USDT' as PairKey, 'BBB/USDT' as PairKey],
    venues: ['binance', 'kucoin'],
    scanner: { maxQueueDepth: 1, maxConcurrentChecks: 1 },
    cfg: { prefilterPct: 0.001, minNetPct: 0.001, takerFees: { binance: 0, kucoin: 0 } },
  });

  const now = Date.now();
  const yaz = (pair: PairKey, venue: VenueId, bid: number, ask: number) =>
    r.store.write(r.store.resolveSlot(pair, venue), bid, 1e6, ask, 1e6, now, now);

  // AAA: bozuk (%100 ham fark). BBB: gerçek (%2 ham fark).
  yaz('AAA/USDT' as PairKey, 'binance', 0.99, 1.0);
  yaz('AAA/USDT' as PairKey, 'kucoin', 2.0, 2.02);
  yaz('BBB/USDT' as PairKey, 'binance', 0.99, 1.0);
  yaz('BBB/USDT' as PairKey, 'kucoin', 1.02, 1.03);

  await r.run();

  // Kuyruk tek kişilik: hayatta kalan GERÇEK aday olmalı.
  assert.equal(r.emitted.length, 1);
  assert.equal(r.emitted[0]!.coin, 'BBB', 'gerçek aday bozuk adayın önünde olmalı');
});


// ---------------------------------------------------------------------------
// İnce havuz — fiyat doğru, derinlik yok
//
// ÖLÇÜLEN ÖRNEK (ZEUS): orta fiyatı Jupiter'le %2.5 uyumlu, yani referans
// filtresi haklı olarak geçiriyor. Ama $500'lük quote birim fiyatı 3.5 KATINA
// çıkıyor — havuz doğru fiyatlı, sadece o büyüklüğü taşımıyor. Kâr hesabı
// bunu zaten yakalıyordu (net %-99) ama eleme "derinlik yok" kovasına düşüyor
// ve panelde rotasızlıkla aynı görünüyordu.
// ---------------------------------------------------------------------------

test('fiyat etkisi eşiği aşan DEX bacağı elenir ve AYRI sayılır', async () => {
  const q = fakeLegQuoter({ buyBase: 1000, etkiPct: 2.5 }); // %250 etki
  const r = rig({
    venues: ['jupiter', 'binance'],
    legQuoter: q.quoter,
    cfg: { prefilterPct: 0.001, minNetPct: 0.001, takerFees: { binance: 0 } },
  });
  r.store.write(r.slot('jupiter'), 1.0, 0, 1.0, 0, Date.now(), Date.now());
  quote(r, 'binance', 1.05, 1e6, 1.06, 1e6);
  await r.run();

  const st = r.scanner.stats as unknown as {
    rejectedByImpact: number;
    sonInceHavuz: string | null;
  };
  assert.equal(r.emitted.length, 0, 'taşımayan havuz sinyal üretmemeli');
  assert.equal(st.rejectedByImpact, 1);
  // Sebep GÖRÜNÜR olmalı: "rota yok" ile aynı kovaya düşerse teşhis
  // kullanıcıyı token silmeye yöneltir.
  assert.match(st.sonInceHavuz ?? '', /KOIN\/jupiter etki %250/);
});

test('makul fiyat etkisi bacağı elemez', async () => {
  const q = fakeLegQuoter({ buyBase: 1000, etkiPct: 0.02 }); // %2
  const r = rig({
    venues: ['jupiter', 'binance'],
    legQuoter: q.quoter,
    cfg: { prefilterPct: 0.001, minNetPct: 0.001, takerFees: { binance: 0 } },
  });
  r.store.write(r.slot('jupiter'), 1.0, 0, 1.0, 0, Date.now(), Date.now());
  quote(r, 'binance', 1.05, 1e6, 1.06, 1e6);
  await r.run();

  assert.equal(r.emitted.length, 1);
  assert.equal((r.scanner.stats as unknown as { rejectedByImpact: number }).rejectedByImpact, 0);
});

test('etki bilgisi YOKSA bacak elenmez (bilinmeyen ≠ kötü)', async () => {
  // Kaynak etkiyi vermiyorsa karar veremeyiz. Kötümser davranmak, etki
  // alanını doldurmayan bir kaynağın tüm bacaklarını sessizce yok ederdi.
  const q = fakeLegQuoter({ buyBase: 1000 });
  const r = rig({
    venues: ['jupiter', 'binance'],
    legQuoter: {
      buy: async () => ({ miktar: 1000, etkiPct: null }),
      sell: async () => ({ miktar: 1000, etkiPct: null }),
    },
    cfg: { prefilterPct: 0.001, minNetPct: 0.001, takerFees: { binance: 0 } },
  });
  void q;
  r.store.write(r.slot('jupiter'), 1.0, 0, 1.0, 0, Date.now(), Date.now());
  quote(r, 'binance', 1.05, 1e6, 1.06, 1e6);
  await r.run();

  assert.equal(r.emitted.length, 1);
});

test('ince havuz HATIRLANIR: kuyruk dolunca gerçek adaya yenilir', async () => {
  // Ölçüldü: 7 dakikada 440 ince-havuz elemesi, ama sorunlu token sayısı ~56 —
  // aynı gerçeği defalarca öğreniyorduk. Hafıza ELEME değil öncelik düşürme:
  // kapasite boşken aday yeniden denenir (likidite geri gelmiş olabilir),
  // kapasite doluyken gerçek adayın önünü tıkamaz. Gerçek koşuda kuyruk sürekli
  // dolu olduğu için pratikte tasarruf tamdır.
  const q = fakeLegQuoter({ buyBase: 1000, etkiPct: 2.5 });
  const r = rig({
    pairs: ['AAA/USDT' as PairKey, 'BBB/USDT' as PairKey],
    venues: ['jupiter', 'binance'],
    legQuoter: q.quoter,
    scanner: { maxQueueDepth: 1, maxConcurrentChecks: 1 },
    cfg: { prefilterPct: 0.001, minNetPct: 0.001, takerFees: { binance: 0 } },
  });

  const yaz = (pair: PairKey, jupAsk: number, binBid: number) => {
    const t = Date.now();
    r.store.write(r.store.resolveSlot(pair, 'jupiter'), jupAsk, 0, jupAsk, 0, t, t);
    r.store.write(r.store.resolveSlot(pair, 'binance'), binBid, 1e6, binBid + 0.01, 1e6, t, t);
  };

  // İlk tur: yalnızca AAA var, quote atılır ve ince havuz öğrenilir.
  yaz('AAA/USDT' as PairKey, 1.0, 1.10);
  await r.run();
  assert.ok(q.calls.length > 0, 'ilk turda quote atılmalıydı');
  const st = () => r.scanner.stats as unknown as { inceHavuzOnceliksiz: number };
  assert.ok(st().inceHavuzOnceliksiz === 0, 'ilk turda hafıza henüz boş');

  // İkinci tur: AAA (ince, ham fark BÜYÜK) ile BBB (sağlam, ham fark küçük)
  // tek kişilik kuyrukta yarışıyor. Hafıza olmasaydı AAA kazanırdı.
  yaz('AAA/USDT' as PairKey, 1.0, 1.10);
  yaz('BBB/USDT' as PairKey, 1.0, 1.02);
  await r.run();

  assert.ok(st().inceHavuzOnceliksiz > 0, 'öncelik düşürme sayılmalı');
  assert.ok(
    q.calls.some((c) => c.includes(':BBB:')),
    `gerçek aday doğrulanmalıydı, çağrılar: ${q.calls.join(',')}`,
  );
});

test('havuz düzelirse hafıza silinir', async () => {
  const q = fakeLegQuoter({ buyBase: 1000, etkiPct: 0.01 });
  const r = rig({
    venues: ['jupiter', 'binance'],
    legQuoter: q.quoter,
    cfg: { prefilterPct: 0.001, minNetPct: 0.001, takerFees: { binance: 0 } },
  });
  const t = Date.now();
  r.store.write(r.slot('jupiter'), 1.0, 0, 1.0, 0, t, t);
  r.store.write(r.slot('binance'), 1.05, 1e6, 1.06, 1e6, t, t);
  await r.run();

  assert.equal(r.emitted.length, 1);
  assert.equal(
    (r.scanner.stats as unknown as { inceHavuzOnceliksiz: number }).inceHavuzOnceliksiz,
    0,
  );
});
