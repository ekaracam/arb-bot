/**
 * DEX feed kurulumu.
 *
 * Bir DEX yalnızca şu koşullarda taramaya katılır:
 *   - zincir config'te etkinse
 *   - EVM ise RPC tanımlıysa (public RPC bot için yetersiz, kasıtlı olarak
 *     otomatik fallback yapmıyoruz — sessizce rate-limit yemektense açıkça
 *     devre dışı kalması iyi)
 *   - tokens.json'da o zincirde en az bir token varsa
 *   - o token'ın karşılık geldiği çift CEX tarafında da taranıyorsa
 *
 * Son madde önemli: DEX'te fiyatı olan ama hiçbir borsada listelenmemiş bir
 * token'ı taramak boşuna RPC harcar.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Address } from 'viem';
import type { AppConfig, TokenEntry } from '../../core/config.ts';
import { ROOT } from '../../core/config.ts';
import type { PriceStore } from '../../book/price-store.ts';
import { pairKey, type ChainId, type DexId, type Feed, type PairKey } from '../../core/types.ts';
import { SolanaMidFeed, type SolanaToken } from './solana-feed.ts';
import { createSolanaPriceSource, type SolanaPriceSource } from './solana-price.ts';
import { RaydiumPriceSource } from './raydium.ts';
import { EvmDexFeed, type EvmToken } from './evm.ts';
import { CowFeed, type CowToken } from './cow.ts';

interface UniV3Contracts {
  quoterV2: string;
  factory: string;
  feeTiers: number[];
}

export interface DexContracts {
  multicall3: string;
  base: {
    aerodrome: { router: string; factory: string };
    uniswapV3: UniV3Contracts;
  };
  arbitrum: {
    uniswapV3: UniV3Contracts;
    camelot: { quoterV2: string; factory: string };
  };
  publicRpc: { base: string; arbitrum: string };
}

export function loadDexContracts(): DexContracts {
  const p = resolve(ROOT, 'config/dex.json');
  if (!existsSync(p)) throw new Error('config/dex.json bulunamadı');
  return JSON.parse(readFileSync(p, 'utf8')) as DexContracts;
}

/** Bir DEX venue'sunun taramaya katılıp katılamayacağını anlatan sonuç. */
export interface DexSetupResult {
  readonly feed: Feed | null;
  readonly venue: DexId;
  /** Devre dışıysa sebebi — başlangıç özetinde gösterilir. */
  readonly skipReason: string | null;
  readonly tokenCount: number;
}

/** Quote para birimi olarak kullanılacak stablecoin sembolü. */
const QUOTE_SYMBOL = 'USDC';

/**
 * Zincir RPC'si olmadan da çalışabilen DEX venue'ları.
 *
 * CoW zincire hiç bağlanmıyor (HTTP quote API'si), yani `BASE_RPC_URL`
 * tanımsızken bile Base'de fiyat üretebiliyor. Bu tek satırlık gerçek iki
 * yerde birden bilinmek zorunda: `createDexFeeds` CoW kurulumunu EVM
 * döngüsünün dışında tutuyor, `scripts/kapsam.ts` de zinciri "RPC yok →
 * devre dışı" diye raporlamamalı. Ayrı ayrı yazılsalardı rapor, çalışan bir
 * venue'yu kapalı gösterirdi — ve bu botta raporun yalan söylemesi, eksik
 * özellikten pahalıdır.
 */
export const RPC_GEREKTIRMEYEN: readonly DexId[] = ['cow-base'];

/**
 * Kod duruyor ama kurulmuyor — venue bazında elle kapatma.
 *
 * `cow-base` ÖLÇÜLDÜ ve bugün hiçbir katkı vermiyor, iki bağımsız sebeple:
 *
 *  1. **Erişim kapalı.** CoW'un önündeki CloudFront IP'yi blokluyor ve blok
 *     kalıcılaştı: 10 dakikalık koşuda feed `connecting → failed`, 5 yeniden
 *     deneme, **0 başarılı tur**. Doğrudan sorguda da `HTTP 403 + HTML`.
 *  2. **Blok kalksa bile bütçeye sığmıyor.** 79 token × 2 bacak, kova 2/sn →
 *     periyot ~99 sn, `MAX_DEX_PRICE_AGE_MS` 30 sn. Fiyatlar yazıldıkları
 *     anda bayat olurdu.
 *
 * Kapatmanın ölçülen maliyeti yok: Base'de 2 adımlı WETH rotası açıldığından
 * beri aerodrome + uniswap-v3-base aynı tokenları zaten fiyatlıyor. Kazancı
 * ise somut — ölü venue panelde kırmızı satır olmayı ve (renderer'daki
 * teşhis sırası yüzünden) CANLI venue'ların uyarısını gizlemeyi bırakıyor.
 *
 * `DEX_IDS`'ten SİLİNMEDİ, kasıtlı: venue orada durduğu sürece `PriceStore`
 * sütunu ayrılmaya devam eder ve listeden çıkarmak `main.ts`/`kapsam` gibi
 * tek kaynaktan okuyan yerlerde geriye dönük tutarsızlık üretir. Geri açmak
 * için bu diziden çıkarmak yeterli.
 *
 * Doğru çözüm kapatmak değil YER DEĞİŞTİRMEK: CoW'un mimarideki yeri Aşama 2
 * (Solana'da `DexQuoter`'ın yaptığı iş), orada istek sayısı turla değil aday
 * sayısıyla ölçeklenir. Bkz. CLAUDE.md "Bilinen boşluklar".
 */
export const DEVRE_DISI: readonly DexId[] = ['cow-base'];

const DEVRE_DISI_SEBEP: Partial<Record<DexId, string>> = {
  'cow-base': 'elle kapatıldı — CloudFront bloğu + periyot bütçeyi aşıyor',
};

/**
 * DEX venue'ları için PriceStore'da yer ayrılabilmesi adına, hangi çiftlerin
 * DEX tarafında da izleneceğini önceden hesaplar.
 */
export function dexPairsFor(cfg: AppConfig, chain: ChainId): PairKey[] {
  return cfg.tokens
    .filter((t) => t.chain === chain && t.symbol.toUpperCase() !== QUOTE_SYMBOL)
    .map((t) => pairKey(t.symbol, 'USDT'));
}

/**
 * Bir zincirde DEX tarafında izlenmeye ADAY tokenlar.
 *
 * Slot çözümü hariç tüm eleme burada toplanır: quote token'ın kendisi taranmaz
 * ve CEX'te `<SYMBOL>/USDT` çifti yoksa token hiç sorulmaz.
 *
 * Dışa açık olmasının sebebi `scripts/kapsam.ts`: rapor botun gerçekten neyi
 * izlediğini göstermeli. Filtreyi script'te kopyalamak, iki tarafın zamanla
 * ayrışıp raporun yalan söylemesi demekti — ve bu tam olarak raporun engellemek
 * için var olduğu hata sınıfı.
 */
export function dexTokensFor(
  cfg: AppConfig,
  chain: ChainId,
  knownPairs: ReadonlySet<PairKey>,
): { token: TokenEntry; pair: PairKey }[] {
  const out: { token: TokenEntry; pair: PairKey }[] = [];
  for (const t of cfg.tokens) {
    if (t.chain !== chain) continue;
    if (t.symbol.toUpperCase() === QUOTE_SYMBOL) continue;
    const pair = pairKey(t.symbol, 'USDT');
    if (!knownPairs.has(pair)) continue;
    out.push({ token: t, pair });
  }
  return out;
}

/** 2 adımlı rotanın ara tokeni — EVM zincirlerinde WETH. */
const HOP_SYMBOL = 'WETH';

/**
 * Zincirin ara tokeni (`config/tokens.json`'dan).
 *
 * Bulunamazsa 2 adımlı rota kapanır ve feed eski davranışına (yalnızca
 * doğrudan token↔USDC) döner. Sessizce yanlış adres uydurmaktansa yeteneği
 * kapatmak doğru: WETH girdisi zaten tabloda duruyor ve `verify-contracts`
 * onu zincirden doğruluyor.
 */
function hopToken(cfg: AppConfig, chain: ChainId): Address | undefined {
  const t = cfg.tokens.find(
    (x) => x.chain === chain && x.symbol.toUpperCase() === HOP_SYMBOL,
  );
  return t ? (t.address as Address) : undefined;
}

export function createDexFeeds(
  cfg: AppConfig,
  store: PriceStore,
  knownPairs: ReadonlySet<PairKey>,
): DexSetupResult[] {
  const out: DexSetupResult[] = [];
  const contracts = loadDexContracts();

  /**
   * Elle kapatılmış venue'yu diğer tüm kontrollerden ÖNCE eler.
   *
   * Sıra önemli: kapatma sebebi "RPC yok"tan da "token yok"tan da daha
   * kesindir, sonraya bırakılırsa rapor yanlış sebebi gösterir.
   */
  const kapali = (venue: DexId): boolean => {
    if (!DEVRE_DISI.includes(venue)) return false;
    out.push({
      feed: null,
      venue,
      skipReason: DEVRE_DISI_SEBEP[venue] ?? 'elle kapatıldı',
      tokenCount: 0,
    });
    return true;
  };

  // --- Solana venue'ları --------------------------------------------------
  //
  // İKİ venue, TEK feed sınıfı. `jupiter` bir toplayıcı (rotayı o kuruyor),
  // `raydium` tek bir AMM (kendi havuzunda ne varsa onu söylüyor) — ikisi
  // farklı fiyat üretir ve tarayıcı için ayrı mekanlardır. Aynı zincirde
  // oldukları için aralarındaki fark transfer gerektirmez (`pickChain`in
  // DEX→DEX dalı), yani gerçekten uygulanabilir bir rotadır.
  //
  // `SOLANA_PRICE_SOURCE` YALNIZCA jupiter venue'sünün Aşama 1 kaynağını
  // seçer; raydium'unki tanımı gereği Raydium'dur. İkisini tek ayara bağlamak,
  // "raydium venue'sü geckoterminal fiyatı yazıyor" gibi kendi kimliğine
  // aykırı bir duruma yol açardı.
  const solanaVenues: { venue: DexId; kaynak: () => SolanaPriceSource }[] = [
    {
      venue: 'jupiter',
      kaynak: () =>
        createSolanaPriceSource(
          cfg.solanaPriceSource,
          process.env['JUPITER_API_KEY'] ?? null,
        ),
    },
    { venue: 'raydium', kaynak: () => new RaydiumPriceSource() },
  ];

  for (const sv of solanaVenues) {
    if (kapali(sv.venue)) continue;
    if (!cfg.chains.solana.enabled) {
      out.push({ feed: null, venue: sv.venue, skipReason: 'solana kapalı', tokenCount: 0 });
      continue;
    }

    const tokens: SolanaToken[] = [];
    for (const { token: t, pair } of dexTokensFor(cfg, 'solana', knownPairs)) {
      const slot = store.resolveSlot(pair, sv.venue);
      if (slot < 0) continue;
      tokens.push({
        symbol: t.symbol,
        mint: t.address,
        decimals: t.decimals,
        pair,
        slot,
      });
    }

    out.push({
      feed:
        tokens.length > 0
          ? new SolanaMidFeed(store, tokens, { venue: sv.venue, priceSource: sv.kaynak() })
          : null,
      venue: sv.venue,
      skipReason: tokens.length === 0 ? 'eşleşen token yok' : null,
      tokenCount: tokens.length,
    });
  }

  // --- EVM zincirleri -----------------------------------------------------
  const evmSetups: {
    venue: DexId;
    chain: ChainId;
    envKey: string;
    build: (rpc: string, tokens: EvmToken[], quote: EvmToken) => Feed;
  }[] = [
    {
      venue: 'aerodrome',
      chain: 'base',
      envKey: 'BASE_RPC_URL',
      build: (rpcUrl, tokens, quote) =>
        new EvmDexFeed(store, {
          venue: 'aerodrome',
          chain: 'base',
          rpcUrl,
          quoteToken: { address: quote.address, decimals: quote.decimals },
          tokens,
          tradeSize: cfg.scan.tradeSizeQuote,
          maxPriceAgeMs: cfg.scan.maxDexPriceAgeMs,
          hopToken: hopToken(cfg, 'base'),
          aerodrome: {
            router: contracts.base.aerodrome.router as Address,
            factory: contracts.base.aerodrome.factory as Address,
          },
        }),
    },
    {
      venue: 'camelot',
      chain: 'arbitrum',
      envKey: 'ARBITRUM_RPC_URL',
      build: (rpcUrl, tokens, quote) =>
        new EvmDexFeed(store, {
          venue: 'camelot',
          chain: 'arbitrum',
          rpcUrl,
          quoteToken: { address: quote.address, decimals: quote.decimals },
          tokens,
          tradeSize: cfg.scan.tradeSizeQuote,
          maxPriceAgeMs: cfg.scan.maxDexPriceAgeMs,
          hopToken: hopToken(cfg, 'arbitrum'),
          camelot: { quoterV2: contracts.arbitrum.camelot.quoterV2 as Address },
        }),
    },
    {
      // Aerodrome ile AYNI zincirde ikinci venue — Arbitrum'daki Camelot/UniV3
      // ikilisinin Base karşılığı. Ölçüldü: Base'de doğrudan USDC havuzu olan
      // tokenların bir kısmı Aerodrome'da değil Uniswap V3'te.
      //
      // Venue ID'sinin zincir soneki taşımasının sebebi `DEX_CHAIN`'in birebir
      // eşleme olması: aynı protokol iki zincirde ayrı kimlik ister.
      venue: 'uniswap-v3-base',
      chain: 'base',
      envKey: 'BASE_RPC_URL',
      build: (rpcUrl, tokens, quote) =>
        new EvmDexFeed(store, {
          venue: 'uniswap-v3-base',
          chain: 'base',
          rpcUrl,
          quoteToken: { address: quote.address, decimals: quote.decimals },
          tokens,
          tradeSize: cfg.scan.tradeSizeQuote,
          maxPriceAgeMs: cfg.scan.maxDexPriceAgeMs,
          hopToken: hopToken(cfg, 'base'),
          // WETH/USDC Base'de en likit havuz ve tier'ı 500 (zincirden
          // doğrulandı: factory.getPool(WETH,USDC,500) gerçek havuz döndürüyor).
          hopQuoteFee: 500,
          uniswapV3: {
            quoterV2: contracts.base.uniswapV3.quoterV2 as Address,
            feeTiers: contracts.base.uniswapV3.feeTiers,
          },
        }),
    },
    {
      // Camelot ile AYNI zincirde ikinci bir venue. Gereksiz görünüyor ama
      // ölçüldü: Arbitrum'da likidite ikiye bölünmüş durumda. Camelot'ta
      // ARB fiyatlanıyor, GRT ve UNI ise iki rotada da revert ediyor —
      // onlar Uniswap V3'te. Tek venue ile Arbitrum kapsamı yapısal olarak
      // eksik kalıyordu; `uniswap-v3` zaten DEX_IDS'te tanımlıydı ve evm.ts
      // destekliyordu, yalnızca hiç kurulmuyordu.
      venue: 'uniswap-v3',
      chain: 'arbitrum',
      envKey: 'ARBITRUM_RPC_URL',
      build: (rpcUrl, tokens, quote) =>
        new EvmDexFeed(store, {
          venue: 'uniswap-v3',
          chain: 'arbitrum',
          rpcUrl,
          quoteToken: { address: quote.address, decimals: quote.decimals },
          tokens,
          tradeSize: cfg.scan.tradeSizeQuote,
          maxPriceAgeMs: cfg.scan.maxDexPriceAgeMs,
          hopToken: hopToken(cfg, 'arbitrum'),
          hopQuoteFee: 500,
          uniswapV3: {
            quoterV2: contracts.arbitrum.uniswapV3.quoterV2 as Address,
            // TÜM tier'lar soruluyor ve en iyi çıktı seçiliyor; tek tier
            // sabitlemek ölçümde yanlış fiyat üretti (bkz. buildQuoteGroup).
            feeTiers: contracts.arbitrum.uniswapV3.feeTiers,
          },
        }),
    },
  ];

  for (const setup of evmSetups) {
    if (kapali(setup.venue)) continue;

    if (!cfg.chains[setup.chain].enabled) {
      out.push({
        feed: null,
        venue: setup.venue,
        skipReason: `${setup.chain} kapalı`,
        tokenCount: 0,
      });
      continue;
    }

    const rpc = cfg.chains[setup.chain].rpcUrl;
    if (!rpc) {
      out.push({
        feed: null,
        venue: setup.venue,
        skipReason: `RPC yok (.env → ${setup.envKey})`,
        tokenCount: 0,
      });
      continue;
    }

    const quoteEntry = cfg.tokens.find(
      (t) => t.chain === setup.chain && t.symbol.toUpperCase() === QUOTE_SYMBOL,
    );
    if (!quoteEntry) {
      out.push({
        feed: null,
        venue: setup.venue,
        skipReason: `${setup.chain} için ${QUOTE_SYMBOL} tanımlı değil`,
        tokenCount: 0,
      });
      continue;
    }

    const tokens: EvmToken[] = [];
    for (const { token: t, pair } of dexTokensFor(cfg, setup.chain, knownPairs)) {
      const slot = store.resolveSlot(pair, setup.venue);
      if (slot < 0) continue;
      tokens.push({
        symbol: t.symbol,
        address: t.address as Address,
        decimals: t.decimals,
        pair,
        slot,
      });
    }

    out.push({
      feed:
        tokens.length > 0
          ? setup.build(rpc, tokens, {
              symbol: quoteEntry.symbol,
              address: quoteEntry.address as Address,
              decimals: quoteEntry.decimals,
              pair: pairKey(quoteEntry.symbol, 'USDT'),
              slot: -1,
            })
          : null,
      venue: setup.venue,
      skipReason: tokens.length === 0 ? 'eşleşen token yok' : null,
      tokenCount: tokens.length,
    });
  }

  // --- CoW Protocol -------------------------------------------------------
  // EVM döngüsünün DIŞINDA kuruluyor çünkü tek ortak koşulu paylaşmıyor: CoW
  // zincire hiç bağlanmıyor (HTTP quote API'si), yani `rpcUrl` yokluğu onu
  // devre dışı bırakmamalı. Aynı döngüye sokmak, RPC tanımsızken botun
  // fiyatlayabileceği tek venue'yu sessizce kapatırdı.
  if (!kapali('cow-base')) {
    const venue: DexId = 'cow-base';
    const chain: ChainId = 'base';

    if (!cfg.chains[chain].enabled) {
      out.push({ feed: null, venue, skipReason: `${chain} kapalı`, tokenCount: 0 });
    } else {
      const quoteEntry = cfg.tokens.find(
        (t) => t.chain === chain && t.symbol.toUpperCase() === QUOTE_SYMBOL,
      );
      if (!quoteEntry) {
        out.push({
          feed: null,
          venue,
          skipReason: `${chain} için ${QUOTE_SYMBOL} tanımlı değil`,
          tokenCount: 0,
        });
      } else {
        const tokens: CowToken[] = [];
        for (const { token: t, pair } of dexTokensFor(cfg, chain, knownPairs)) {
          const slot = store.resolveSlot(pair, venue);
          if (slot < 0) continue;
          tokens.push({
            symbol: t.symbol,
            address: t.address,
            decimals: t.decimals,
            pair,
            slot,
          });
        }

        out.push({
          feed:
            tokens.length > 0
              ? new CowFeed(store, {
                  venue,
                  chain,
                  quoteToken: { address: quoteEntry.address, decimals: quoteEntry.decimals },
                  tokens,
                  tradeSize: cfg.scan.tradeSizeQuote,
                  maxPriceAgeMs: cfg.scan.maxDexPriceAgeMs,
                })
              : null,
          venue,
          skipReason: tokens.length === 0 ? 'eşleşen token yok' : null,
          tokenCount: tokens.length,
        });
      }
    }
  }

  return out;
}
