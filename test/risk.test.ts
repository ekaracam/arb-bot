/**
 * RiskManager — v1'de pasif, ama kararları kalibrasyon için kaydediliyor.
 * Yanlış çalışan bir "pasif" katman, v2'de otomasyon açıldığında sessizce
 * yanlış limitler uygular; bu yüzden şimdiden test ediliyor.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { RiskManager, DEFAULT_LIMITS } from '../src/risk/limits.ts';
import type { Opportunity, PairKey } from '../src/core/types.ts';

function opp(over: Partial<Opportunity> = {}): Opportunity {
  return {
    id: 'KOIN|binance->kucoin',
    kind: 'cex-cex',
    coin: 'KOIN',
    quote: 'USDT',
    buy: {
      kind: 'cex-buy',
      venue: 'binance',
      pair: 'KOIN/USDT' as PairKey,
      vwap: 1.0,
      bestPrice: 1.0,
      qty: 1000,
      feeQuote: 1,
      ageMs: 100,
    },
    sell: {
      kind: 'cex-sell',
      venue: 'kucoin',
      pair: 'KOIN/USDT' as PairKey,
      vwap: 1.02,
      bestPrice: 1.02,
      qty: 998.5,
      feeQuote: 1,
      ageMs: 100,
    },
    chain: 'solana',
    grossQuote: 20,
    netQuote: 17.45,
    netPct: 0.01745,
    costs: { buyFee: 1, sellFee: 1, withdrawFee: 0.5, gas: 0, bridge: 0 },
    warnings: [],
    transferVerified: true,
    detectedAt: Date.now(),
    worstAgeMs: 500,
    ...over,
  };
}

test('temiz fırsat tüm kontrollerden geçer', () => {
  const r = new RiskManager({ ...DEFAULT_LIMITS, allowUnverified: true });
  const v = r.check(opp());
  assert.deepEqual(v.reasons, []);
  assert.equal(v.allowed, true);
});

test('sermaye limiti aşılırsa işaretlenir', () => {
  const r = new RiskManager({ ...DEFAULT_LIMITS, maxPositionQuote: 500, allowUnverified: true });
  const v = r.check(opp());
  assert.equal(v.allowed, false);
  assert.ok(v.reasons.some((x) => x.includes('sermaye')));
});

test('sermaye limitle tam eşitken kayan nokta yüzünden işaretlenmez', () => {
  // vwap * qty tam 1000 çıkmayabilir (1000.0000000000001). Tolerans olmasaydı
  // tipik yapılandırmada HER fırsat "limit aşıldı" derdi.
  const r = new RiskManager({ ...DEFAULT_LIMITS, maxPositionQuote: 1000, allowUnverified: true });
  const o = opp();
  const v = r.check({ ...o, buy: { ...o.buy, vwap: 0.1, qty: 10_000 } });
  assert.deepEqual(v.reasons, [], `sermaye=${0.1 * 10_000}`);
});

test('bayat sinyal işaretlenir — bacak başına, venue türüne göre', () => {
  const r = new RiskManager({ ...DEFAULT_LIMITS, maxSignalAgeMs: 2000, allowUnverified: true });
  const o = opp();
  const v = r.check({ ...o, buy: { ...o.buy, ageMs: 5000 }, worstAgeMs: 5000 });
  assert.ok(v.reasons.some((x) => x.includes('fiyat yaşı')));

  // DEX bacağı meşru olarak 11–30 sn yaşında olabilir; tek eşik (2 sn) her
  // CEX↔DEX sinyalini engelliyordu (82 risk notunun 82'si buydu).
  const dex = r.check({
    ...o,
    kind: 'cex-dex',
    sell: { ...o.sell, kind: 'dex-sell', venue: 'jupiter', ageMs: 12_000 },
    worstAgeMs: 12_000,
  });
  assert.deepEqual(dex.reasons, [], 'DEX bacağı kendi eşiğiyle ölçülmeli');

  const dexBayat = r.check({
    ...o,
    kind: 'cex-dex',
    sell: { ...o.sell, kind: 'dex-sell', venue: 'jupiter', ageMs: 45_000 },
    worstAgeMs: 45_000,
  });
  assert.ok(dexBayat.reasons.some((x) => x.includes('jupiter fiyat yaşı')));
});

test('doğrulanmamış transfer varsayılan olarak engellenir', () => {
  const r = new RiskManager(DEFAULT_LIMITS);
  assert.equal(DEFAULT_LIMITS.allowUnverified, false);
  const v = r.check(opp({ transferVerified: false }));
  assert.ok(v.reasons.some((x) => x.includes('doğrulanmamış')));
});

test('gerçekçi olmayacak kadar yüksek kâr veri hatası sayılır', () => {
  const r = new RiskManager({ ...DEFAULT_LIMITS, allowUnverified: true });
  const v = r.check(opp({ netPct: 0.5 }));
  assert.ok(v.reasons.some((x) => x.includes('gerçekçi değil')));
});

test('birden fazla ihlal hepsi birden raporlanır', () => {
  const r = new RiskManager({ ...DEFAULT_LIMITS, maxPositionQuote: 10 });
  const o = opp();
  const v = r.check({
    ...o,
    buy: { ...o.buy, ageMs: 99_999 },
    worstAgeMs: 99_999,
    transferVerified: false,
    netPct: 0.9,
  });
  assert.equal(v.reasons.length, 4);
});

test('engellenen fırsatlar sayılır', () => {
  const r = new RiskManager({ ...DEFAULT_LIMITS, allowUnverified: true });
  r.check(opp());
  r.check(opp({ netPct: 0.9 }));
  r.check(opp({ netPct: 0.9 }));
  assert.equal(r.stats.blocked, 2);
});

test('kill-switch günlük kayıp limitinde devreye girer', () => {
  const r = new RiskManager({ ...DEFAULT_LIMITS, maxDailyLossQuote: 100, allowUnverified: true });
  r.recordPnl(-50);
  assert.equal(r.check(opp()).allowed, true);

  r.recordPnl(-60); // toplam -110
  assert.equal(r.stats.killed, true);
  assert.ok(r.check(opp()).reasons.some((x) => x.includes('kill-switch')));
});

test('kâr kill-switch tetiklemez', () => {
  const r = new RiskManager({ ...DEFAULT_LIMITS, maxDailyLossQuote: 100, allowUnverified: true });
  r.recordPnl(500);
  assert.equal(r.stats.killed, false);
  assert.equal(r.stats.dailyPnl, 500);
});
