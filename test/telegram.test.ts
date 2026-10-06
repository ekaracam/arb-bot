/**
 * TelegramNotifier — birden fazla alıcı.
 *
 * Bir fırsat listede kaç chat id varsa o kadar `sendMessage` çağrısı üretir.
 * Konu doğruluk değil DAVRANIŞ: bir alıcı düşerse diğerleri etkilenmemeli,
 * hangi alıcının düştüğü görünür olmalı, ve hız sınırı chat başına değil
 * bot token'ı BAŞINA (paylaşılan) uygulanmalı.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { TelegramNotifier } from '../src/notify/telegram.ts';
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
      ageMs: 120,
    },
    sell: {
      kind: 'cex-sell',
      venue: 'kucoin',
      pair: 'KOIN/USDT' as PairKey,
      vwap: 1.02,
      bestPrice: 1.02,
      qty: 998.5,
      feeQuote: 1.018,
      ageMs: 80,
    },
    chain: 'solana',
    grossQuote: 20,
    netQuote: 17.45,
    netPct: 0.01745,
    costs: { buyFee: 1, sellFee: 1.018, withdrawFee: 0.51, gas: 0, bridge: 0 },
    warnings: [],
    transferVerified: true,
    detectedAt: Date.now(),
    worstAgeMs: 120,
    ...over,
  };
}

/** fetch'i sahteler; her çağrının gövdesindeki chat_id'yi kaydeder. */
function sahteFetch(
  cevapVer: (chatId: string) => { ok: boolean; status?: number; body?: string },
): { cagrilar: string[]; geriYukle: () => void } {
  const orijinal = globalThis.fetch;
  const cagrilar: string[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const govde = JSON.parse(String(init?.body)) as { chat_id: string };
    cagrilar.push(govde.chat_id);
    const r = cevapVer(govde.chat_id);
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 400),
      text: async () => r.body ?? '',
      json: async () => JSON.parse(r.body ?? '{}'),
    } as Response;
  }) as typeof fetch;
  return { cagrilar, geriYukle: () => (globalThis.fetch = orijinal) };
}

test('tek fırsat, N chat id → N ayrı sendMessage çağrısı', async () => {
  const f = sahteFetch(() => ({ ok: true }));
  try {
    const t = new TelegramNotifier({
      token: 'x',
      chatIds: ['111', '222', '333'],
      cooldownMs: 0,
      resendDeltaPct: 0,
      maxPerSec: 1000,
    });
    t.notify(opp());
    await new Promise((r) => setTimeout(r, 50));

    assert.deepEqual(f.cagrilar, ['111', '222', '333']);
    assert.equal(t.stats.sent, 3, 'her chat AYRI bir teslimat sayılmalı');
  } finally {
    f.geriYukle();
  }
});

test('bir chat düşerse diğerleri etkilenmez', async () => {
  const f = sahteFetch((chatId) =>
    chatId === '222'
      ? { ok: false, status: 403, body: '{"description":"bot was blocked by the user"}' }
      : { ok: true },
  );
  try {
    const t = new TelegramNotifier({
      token: 'x',
      chatIds: ['111', '222', '333'],
      cooldownMs: 0,
      resendDeltaPct: 0,
      maxPerSec: 1000,
    });
    t.notify(opp());
    await new Promise((r) => setTimeout(r, 50));

    assert.deepEqual(f.cagrilar, ['111', '222', '333'], 'sıradaki alıcı ATLANMAMALI');
    assert.equal(t.stats.sent, 2);
    assert.equal(t.stats.failed, 1);
    // Hangi alıcının düştüğü GÖRÜNÜR olmalı — üç kişilik listede "hata var"
    // demek yeterli değil, kullanıcı hangisini düzelteceğini bilmeli.
    assert.match(t.stats.lastError ?? '', /chat 222/);
  } finally {
    f.geriYukle();
  }
});

test('tek alıcı geriye dönük aynı şekilde çalışır', async () => {
  const f = sahteFetch(() => ({ ok: true }));
  try {
    const t = new TelegramNotifier({
      token: 'x',
      chatIds: ['999'],
      cooldownMs: 0,
      resendDeltaPct: 0,
      maxPerSec: 1000,
    });
    t.notify(opp());
    await new Promise((r) => setTimeout(r, 50));

    assert.deepEqual(f.cagrilar, ['999']);
    assert.equal(t.stats.sent, 1);
  } finally {
    f.geriYukle();
  }
});

test('boş chatIds listesi hiçbir yere göndermez, hata da vermez', async () => {
  const f = sahteFetch(() => ({ ok: true }));
  try {
    const t = new TelegramNotifier({
      token: 'x',
      chatIds: [],
      cooldownMs: 0,
      resendDeltaPct: 0,
      maxPerSec: 1000,
    });
    t.notify(opp());
    await new Promise((r) => setTimeout(r, 20));

    assert.deepEqual(f.cagrilar, []);
    assert.equal(t.stats.sent, 0);
    assert.equal(t.stats.failed, 0);
  } finally {
    f.geriYukle();
  }
});
