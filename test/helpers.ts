/**
 * Test yardımcıları — Scanner'ı ağa çıkmadan çalıştırabilmek için sahte
 * bağımlılıklar.
 *
 * Scanner'ın dört dış bağımlılığı var (registry, depth, transfers ve config).
 * Hepsi burada deterministik sahtelerle karşılanıyor: testlerde tek değişken
 * fiyat matrisi olsun istiyoruz, borsaların o anki durumu değil.
 */

import type { AppConfig } from '../src/core/config.ts';
import { bosIzlemeListesi } from '../src/core/izleme-listesi.ts';
import type { DepthCache } from '../src/book/depth-cache.ts';
import type { SymbolRegistry } from '../src/normalize/symbol-registry.ts';
import type { TransferInfoProvider } from '../src/engine/transfer-info.ts';
import { CEX_IDS, CHAIN_IDS } from '../src/core/types.ts';
import type {
  CexId,
  ChainId,
  DepthLevel,
  DepthSnapshot,
  PairKey,
  TransferInfo,
} from '../src/core/types.ts';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ConfigOverrides {
  readonly minNetPct?: number;
  readonly prefilterPct?: number;
  readonly tradeSizeQuote?: number;
  readonly maxPriceAgeMs?: number;
  readonly maxDexPriceAgeMs?: number;
  readonly verifyCooldownMs?: number;
  readonly allowUnverifiedTransfer?: boolean;
  readonly hisseTokenEkPct?: number;
  readonly hisseTokenleri?: string[];
  readonly takerFees?: Partial<Record<CexId, number>>;
  readonly gasCostUsd?: Partial<Record<ChainId, number>>;
}

export function makeConfig(o: ConfigOverrides = {}): AppConfig {
  const exchanges = Object.fromEntries(
    CEX_IDS.map((id) => [
      id,
      {
        enabled: true,
        fees: { taker: o.takerFees?.[id] ?? 0.001, maker: 0.001 },
        quotes: ['USDT'],
        transferInfoPublic: id === 'gate' || id === 'kucoin',
      },
    ]),
  ) as AppConfig['exchanges'];

  const chains = Object.fromEntries(
    CHAIN_IDS.map((id) => [
      id,
      { enabled: true, rpcUrl: null, gasCostUsd: o.gasCostUsd?.[id] ?? 0 },
    ]),
  ) as AppConfig['chains'];

  return {
    exchanges,
    chains,
    tokens: [],
    apiKeys: {},
    // Scanner izleme listesini hiç okumaz (muafiyetler yalnızca sembol
    // keşfinde uygulanır); boş liste tip zorunluluğunu karşılar.
    izleme: bosIzlemeListesi(),
    scan: {
      minNetPct: o.minNetPct ?? 0.004,
      tradeSizeQuote: o.tradeSizeQuote ?? 1000,
      maxPriceAgeMs: o.maxPriceAgeMs ?? 3000,
      maxDexPriceAgeMs: o.maxDexPriceAgeMs ?? 30_000,
      // Testlerde varsayılan 0: her test kendi çağrısını kurar, soğuma
      // istemeyen testlerin araya zaman koyması gerekmesin.
      verifyCooldownMs: o.verifyCooldownMs ?? 0,
      evalIntervalMs: 50,
      prefilterPct: o.prefilterPct ?? 0.0015,
      allowUnverifiedTransfer: o.allowUnverifiedTransfer ?? true,
      // Testlerde varsayılan 0: ek kesinti yalnızca onu ölçen testlerde
      // açılsın, diğerlerinin kâr beklentisini sessizce kaydırmasın.
      hisseTokenEkPct: o.hisseTokenEkPct ?? 0,
    },
    hisseTokenleri: new Set(o.hisseTokenleri ?? []),
    telegram: {
      enabled: false,
      token: null,
      chatIds: [],
      cooldownMs: 300_000,
      resendDeltaPct: 0.005,
    },
    solanaPriceSource: 'jupiter',
    jupiterTier: 'free',
    sound: { enabled: false, cooldownMs: 15_000, device: null, volumePct: 20 },
    ui: { enabled: false, refreshHz: 4, maxRows: 15 },
    persist: { enabled: false, dir: '.' },
  };
}

// ---------------------------------------------------------------------------
// SymbolRegistry sahtesi
// ---------------------------------------------------------------------------

/** Her çifti verilen borsalarda "PAIR" biçiminde listelenmiş sayar. */
export function fakeRegistry(
  map: Readonly<Record<string, readonly CexId[]>>,
  /** `<COIN>` → USD vekili kullanan borsalar (bkz. usdVekiliUygula). */
  usdVekili: Readonly<Record<string, readonly CexId[]>> = {},
): SymbolRegistry {
  const byPair = new Map<string, ReadonlyMap<CexId, string>>();
  for (const [pair, venues] of Object.entries(map)) {
    byPair.set(pair, new Map(venues.map((v) => [v, pair.replace('/', '')])));
  }
  const vekil = new Map(
    Object.entries(usdVekili).map(([b, vs]) => [b.toUpperCase(), new Set(vs)]),
  );
  return {
    venuesFor: (pair: PairKey) => byPair.get(pair) ?? new Map<CexId, string>(),
    // Scanner bunu her fırsatta çağırıyor; sahtede eksik bırakmak tüm tarayıcı
    // testlerini "is not a function" ile düşürürdü.
    usdVekiliMi: (base: string, venue: CexId) =>
      vekil.get(base.toUpperCase())?.has(venue) ?? false,
  } as unknown as SymbolRegistry;
}

// ---------------------------------------------------------------------------
// DepthCache sahtesi
// ---------------------------------------------------------------------------

export interface FakeDepth {
  readonly cache: DepthCache;
  /** Kaç kez L2 defteri istendi — Aşama 2'nin gerçekten tetiklendiğini ölçer. */
  readonly calls: { venue: CexId; pair: string }[];
  set(venue: CexId, pair: string, book: { bids?: DepthLevel[]; asks?: DepthLevel[] }): void;
}

export function fakeDepth(): FakeDepth {
  const books = new Map<string, { bids: DepthLevel[]; asks: DepthLevel[] }>();
  const calls: { venue: CexId; pair: string }[] = [];

  const cache = {
    get(venue: CexId, pair: PairKey): Promise<DepthSnapshot | null> {
      calls.push({ venue, pair });
      const b = books.get(`${venue}:${pair}`);
      if (!b) return Promise.resolve(null);
      return Promise.resolve({ venue, pair, bids: b.bids, asks: b.asks, ts: Date.now() });
    },
  } as unknown as DepthCache;

  return {
    cache,
    calls,
    set(venue, pair, book) {
      books.set(`${venue}:${pair}`, { bids: book.bids ?? [], asks: book.asks ?? [] });
    },
  };
}

// ---------------------------------------------------------------------------
// TransferInfoProvider sahtesi
// ---------------------------------------------------------------------------

export interface TransferRule {
  readonly withdrawEnabled?: boolean;
  readonly depositEnabled?: boolean;
  readonly withdrawFee?: number;
  readonly withdrawMin?: number;
  readonly verified?: boolean;
  /**
   * Borsanın bu zincirde bildirdiği kontrat/mint adresi.
   *
   * Varsayılan `null` = "adres bilinmiyor". Kimlik çapraz kontrolü yalnızca
   * İKİ taraf da adres bildirdiğinde karar verdiği için, adres kurmayan
   * mevcut testler bu kontrolden hiç etkilenmez — kasıtlı: çakışma testi
   * adresi AÇIKÇA kuran testtir.
   */
  readonly address?: string | null;
}

export interface FakeTransfers {
  readonly provider: TransferInfoProvider;
  /** coin için hangi zincirler mümkün. */
  setChains(coin: string, chains: ChainId[]): void;
  /** venue+coin+chain için kural. Tanımsızsa varsayılan: her şey açık, doğrulanmış. */
  setRule(venue: CexId, coin: string, chain: ChainId, rule: TransferRule): void;
}

export function fakeTransfers(defaults: TransferRule = {}): FakeTransfers {
  const chains = new Map<string, ChainId[]>();
  const rules = new Map<string, TransferRule>();

  const provider = {
    chainsFor: (coin: string): ChainId[] => chains.get(coin.toUpperCase()) ?? [],
    lookup: (venue: CexId, coin: string, chain: ChainId): TransferInfo => {
      const r = rules.get(`${venue}:${coin.toUpperCase()}:${chain}`) ?? defaults;
      return {
        venue,
        coin: coin.toUpperCase(),
        chain,
        withdrawEnabled: r.withdrawEnabled ?? true,
        depositEnabled: r.depositEnabled ?? true,
        withdrawFee: r.withdrawFee ?? 0,
        withdrawMin: r.withdrawMin ?? 0,
        verified: r.verified ?? true,
        fetchedAt: Date.now(),
        address: r.address ?? null,
      };
    },
  } as unknown as TransferInfoProvider;

  return {
    provider,
    setChains(coin, c) {
      chains.set(coin.toUpperCase(), c);
    },
    setRule(venue, coin, chain, rule) {
      rules.set(`${venue}:${coin.toUpperCase()}:${chain}`, rule);
    },
  };
}

// ---------------------------------------------------------------------------
// Scanner'ın private aşamalarını testten tetiklemek
// ---------------------------------------------------------------------------

/**
 * Aşama 1 private; testte zamanlayıcı beklemek yerine doğrudan çağırıyoruz.
 * Böylece test hem hızlı hem deterministik oluyor.
 */
export interface ScannerInternals {
  evaluate(): void;
}

/** Aşama 2 async; kuyruğun boşalması için birkaç makrotask bekle. */
export async function settle(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 0));
}
