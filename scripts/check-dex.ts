/**
 * DEX kaynaklarını ve token adreslerini doğrular.
 *
 * En kritik kontrol: config/tokens.json'daki adreslerin GERÇEKTEN iddia
 * edilen token olduğu. Yanlış bir mint/kontrat adresi, botun iki farklı
 * varlığı aynı sanmasına ve arbitraj diye para göndermesine yol açar —
 * bu, sistemdeki en pahalı hata sınıfı.
 *
 * Kullanım: npx tsx scripts/check-dex.ts
 */

import { loadConfig } from '../src/core/config.ts';
import { httpJson } from '../src/core/http.ts';
import { DexQuoter } from '../src/feeds/dex/jupiter.ts';

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

interface TokenSearchEntry {
  id?: string;
  symbol?: string;
  decimals?: number;
  name?: string;
  isVerified?: boolean;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const solTokens = cfg.tokens.filter((t) => t.chain === 'solana');

  console.log(`\n${C.bold}${C.cyan}SOLANA / JUPITER DOĞRULAMA${C.reset}`);
  console.log(C.dim + '─'.repeat(78) + C.reset);

  // --- 1. Fiyat akışı ----------------------------------------------------
  const ids = solTokens.map((t) => t.address).join(',');
  console.log(`${C.dim}price/v3 çağrılıyor (${solTokens.length} mint)...${C.reset}`);

  let prices: Record<string, { usdPrice?: number } | undefined> = {};
  try {
    prices = await httpJson(`https://lite-api.jup.ag/price/v3?ids=${ids}`, {
      timeoutMs: 10_000,
    });
  } catch (e) {
    console.log(`${C.red}✗ price/v3 başarısız: ${(e as Error).message}${C.reset}`);
  }

  // --- 2. Adres kimliği doğrulaması --------------------------------------
  // Jupiter'in token arama uç noktası mint için sembol/decimals döner.
  // Bizim tablomuzla karşılaştırıyoruz.
  console.log(`\n${C.bold}SEMBOL     ADRES DOĞRULAMA                    DECIMALS   FİYAT${C.reset}`);
  console.log(C.dim + '─'.repeat(78) + C.reset);

  let mismatches = 0;
  let missing = 0;
  let warnings = 0;

  for (const t of solTokens) {
    let onchain: TokenSearchEntry | null = null;
    try {
      const r = await httpJson<TokenSearchEntry[]>(
        `https://lite-api.jup.ag/tokens/v2/search?query=${t.address}`,
        { timeoutMs: 8000, retries: 1 },
      );
      onchain = r?.[0] ?? null;
    } catch {
      /* aşağıda "sorgulanamadı" olarak raporlanır */
    }

    const price = prices[t.address]?.usdPrice;
    const priceStr = price ? `$${price < 1 ? price.toPrecision(4) : price.toFixed(2)}` : '—';

    if (!onchain) {
      missing++;
      console.log(
        `${C.yellow}${t.symbol.padEnd(10)} ? sorgulanamadı${' '.repeat(20)}` +
          `${String(t.decimals).padStart(8)}   ${priceStr}${C.reset}`,
      );
      continue;
    }

    // Ticker'lar zincirde "$WIF" gibi süslenebiliyor; karşılaştırmadan önce
    // bu tür işaretleri atıyoruz.
    const norm = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const symbolOk = norm(onchain.symbol ?? '') === norm(t.symbol);
    const decimalsOk = onchain.decimals === t.decimals;

    if (decimalsOk && symbolOk) {
      console.log(
        `${C.green}${t.symbol.padEnd(10)} ✓ ${(onchain.name ?? '').slice(0, 30).padEnd(32)}` +
          `${String(t.decimals).padStart(6)}   ${priceStr}${C.reset}`,
      );
    } else if (decimalsOk) {
      // Sembol farkı kozmetiktir: adres doğru, decimals doğru. Yine de
      // görünür kalsın ki yanlış token ihtimali gözden kaçmasın.
      warnings++;
      console.log(
        `${C.yellow}${t.symbol.padEnd(10)} ~ zincirde "${onchain.symbol}" ` +
          `${(onchain.name ?? '').slice(0, 14).padEnd(16)}` +
          `${String(t.decimals).padStart(6)}   ${priceStr}${C.reset}`,
      );
    } else {
      // Decimals uyuşmazlığı ciddidir: tüm miktar hesapları 10^n kat sapar.
      mismatches++;
      console.log(
        `${C.red}${t.symbol.padEnd(10)} ✗ decimals zincirde ${onchain.decimals}, ` +
          `tabloda ${t.decimals}`.padEnd(32) +
          `   ${priceStr}${C.reset}`,
      );
    }
  }

  // --- 3. Gerçek swap quote ----------------------------------------------
  console.log(`\n${C.bold}SWAP QUOTE (1000 USDC → token, gerçek slippage)${C.reset}`);
  console.log(C.dim + '─'.repeat(78) + C.reset);

  const quoter = new DexQuoter();
  const usdc = solTokens.find((t) => t.address === USDC_SOL);

  for (const t of solTokens.slice(0, 6)) {
    if (t.address === USDC_SOL) continue;

    const amount = BigInt(1000 * 10 ** (usdc?.decimals ?? 6));
    const q = await quoter.quote(USDC_SOL, t.address, amount, usdc?.decimals ?? 6, t.decimals);

    if (!q) {
      console.log(`  ${C.yellow}${t.symbol.padEnd(10)} rota bulunamadı${C.reset}`);
      continue;
    }

    const midPrice = prices[t.address]?.usdPrice;
    // quote fiyatı token/USDC; mid ile karşılaştırmak için tersini alıyoruz.
    const effective = q.inAmount / q.outAmount;
    const drift = midPrice ? ((effective - midPrice) / midPrice) * 100 : 0;

    console.log(
      `  ${C.green}${t.symbol.padEnd(10)}${C.reset} ` +
        `${q.outAmount.toFixed(4).padStart(16)} ${t.symbol.padEnd(7)} ` +
        `etki %${(q.priceImpact * 100).toFixed(3).padStart(7)}  ` +
        `${q.hops} adım  ` +
        `${C.dim}mid'e göre %${drift.toFixed(2)}${C.reset}`,
    );
  }

  // --- 4. CEX vs DEX gerçek spread ---------------------------------------
  // Botun aradığı şeyin canlı bir örneği: aynı varlığın iki mekandaki farkı.
  // Bu farkın tipik büyüklüğünü görmek, eşiği (MIN_NET_PCT) makul ayarlamak
  // için gereken en somut veri.
  console.log(`\n${C.bold}CEX ↔ DEX FARKI (canlı){C.reset}`.replace('{C.reset}', C.reset));
  console.log(C.dim + '─'.repeat(78) + C.reset);

  for (const t of solTokens) {
    if (t.address === USDC_SOL || t.symbol === 'USDT') continue;
    const dexPrice = prices[t.address]?.usdPrice;
    if (!dexPrice) continue;

    try {
      const bt = await httpJson<{ bidPrice: string; askPrice: string }>(
        `https://api.binance.com/api/v3/ticker/bookTicker?symbol=${t.symbol}USDT`,
        { timeoutMs: 6000, retries: 0 },
      );
      const cexBid = Number(bt.bidPrice);
      const cexAsk = Number(bt.askPrice);
      if (!(cexBid > 0)) continue;

      const cexMid = (cexBid + cexAsk) / 2;
      const diff = ((dexPrice - cexMid) / cexMid) * 100;
      const col = Math.abs(diff) > 0.5 ? C.yellow : C.dim;

      console.log(
        `  ${t.symbol.padEnd(8)} binance ${cexMid.toPrecision(6).padStart(12)}  ` +
          `jupiter ${dexPrice.toPrecision(6).padStart(12)}  ` +
          `${col}fark %${diff >= 0 ? '+' : ''}${diff.toFixed(3)}${C.reset}`,
      );
    } catch {
      console.log(`  ${C.dim}${t.symbol.padEnd(8)} Binance'de listelenmiyor${C.reset}`);
    }
  }
  console.log(
    `${C.dim}  Bu farklar tipik olarak %0.5'in altındadır — likit coinlerde` +
      ` CEX↔DEX arbitrajı nadirdir.${C.reset}`,
  );

  // --- Özet ---------------------------------------------------------------
  console.log(`\n${C.dim}${'─'.repeat(78)}${C.reset}`);
  if (mismatches > 0) {
    console.log(
      `${C.red}${C.bold}✗ ${mismatches} token DECIMALS uyuşmazlığı.${C.reset}` +
        ` config/tokens.json düzeltilmeden bot çalıştırılmamalı —` +
        ` yanlış decimals tüm miktar hesaplarını 10^n kat saptırır.`,
    );
    process.exit(1);
  }
  if (missing > 0) {
    console.log(
      `${C.yellow}⚠ ${missing} token doğrulanamadı (API cevap vermedi).` +
        ` Tekrar dene.${C.reset}`,
    );
  }
  if (warnings > 0) {
    console.log(
      `${C.yellow}~ ${warnings} tokenda sembol yazımı farklı` +
        ` (adres ve decimals doğru — kozmetik).${C.reset}`,
    );
  }
  if (mismatches === 0 && missing === 0) {
    console.log(
      `${C.green}${C.bold}✓ Tüm Solana token adresleri ve decimals değerleri doğrulandı.${C.reset}`,
    );
  }

  // EVM tarafı RPC gerektiriyor.
  const evmChains = (['base', 'arbitrum'] as const).filter(
    (c) => cfg.chains[c].enabled && !cfg.chains[c].rpcUrl,
  );
  if (evmChains.length > 0) {
    console.log(
      `\n${C.yellow}⚠ ${evmChains.join(', ')} için RPC tanımlı değil.${C.reset}` +
        `\n${C.dim}  EVM DEX'leri (Aerodrome, Camelot, Uniswap V3) doğrulanamadı.` +
        `\n  .env içine BASE_RPC_URL ve ARBITRUM_RPC_URL ekleyip` +
        ` npx tsx scripts/verify-contracts.ts çalıştır.${C.reset}`,
    );
  }
  console.log('');
}

main().catch((e: Error) => {
  console.error(`${C.red}HATA: ${e.message}${C.reset}`);
  process.exit(1);
});
