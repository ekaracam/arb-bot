/**
 * EVM kontrat ve token doğrulaması.
 *
 * Kontrat adresleri dokümantasyondan veya arama sonucundan kopyalanmaz —
 * ZİNCİRDEN doğrulanır. Yanlış bir router/quoter adresi ya hiç cevap vermez
 * ya da (çok daha kötüsü) sessizce anlamsız fiyat döndürür.
 *
 * Üç kademe:
 *   1. getCode  — adreste gerçekten kontrat var mı?
 *   2. ERC20    — token'ın symbol/decimals değerleri tablomuzla eşleşiyor mu?
 *   3. quote    — quoter gerçekten makul bir fiyat döndürüyor mu?
 *
 * 3. adım kritik: bir kontratın var olması doğru kontrat olduğunu göstermez.
 * Gerçek bir fiyat isteyip sonucun akla yatkın olduğunu kontrol ediyoruz.
 *
 * Kullanım: npx tsx scripts/verify-contracts.ts
 * .env'de RPC yoksa public RPC'ye düşer (doğrulama için yeterli, bot için değil).
 */

import { createPublicClient, http, parseAbi, formatUnits, type Address } from 'viem';
import { base, arbitrum } from 'viem/chains';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, ROOT } from '../src/core/config.ts';
import type { DexContracts } from '../src/feeds/dex/index.ts';
import { HttpCowQuoter } from '../src/feeds/dex/cow.ts';

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

const ERC20_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
]);

const AERODROME_ABI = parseAbi([
  'struct Route { address from; address to; bool stable; address factory; }',
  'function getAmountsOut(uint256 amountIn, Route[] routes) view returns (uint256[] amounts)',
]);

const UNIV3_QUOTER_ABI = parseAbi([
  'struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }',
  'function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

const ALGEBRA_QUOTER_ABI = parseAbi([
  'function quoteExactInputSingle(address tokenIn, address tokenOut, uint256 amountIn, uint160 limitSqrtPrice) returns (uint256 amountOut, uint16 fee)',
]);

let failures = 0;
let warnings = 0;

function ok(msg: string): void {
  console.log(`  ${C.green}✓${C.reset} ${msg}`);
}
function warn(msg: string): void {
  warnings++;
  console.log(`  ${C.yellow}~${C.reset} ${msg}`);
}
function bad(msg: string): void {
  failures++;
  console.log(`  ${C.red}✗${C.reset} ${msg}`);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const dex = JSON.parse(
    readFileSync(resolve(ROOT, 'config/dex.json'), 'utf8'),
  ) as DexContracts;

  const chains = [
    {
      id: 'base' as const,
      viemChain: base,
      rpc: cfg.chains.base.rpcUrl ?? dex.publicRpc.base,
      isPublic: !cfg.chains.base.rpcUrl,
    },
    {
      id: 'arbitrum' as const,
      viemChain: arbitrum,
      rpc: cfg.chains.arbitrum.rpcUrl ?? dex.publicRpc.arbitrum,
      isPublic: !cfg.chains.arbitrum.rpcUrl,
    },
  ];

  for (const chain of chains) {
    console.log(`\n${C.bold}${C.cyan}${chain.id.toUpperCase()}${C.reset}`);
    console.log(C.dim + '─'.repeat(74) + C.reset);
    if (chain.isPublic) {
      console.log(
        `${C.dim}  public RPC kullanılıyor (${chain.rpc}) — doğrulama için yeterli,` +
          ` bot için kendi RPC'ni tanımla${C.reset}`,
      );
    }

    const client = createPublicClient({
      chain: chain.viemChain,
      transport: http(chain.rpc, { timeout: 15_000 }),
    });

    // --- Bağlantı --------------------------------------------------------
    let blockNumber: bigint;
    try {
      blockNumber = await client.getBlockNumber();
      ok(`RPC bağlantısı — blok ${blockNumber}`);
    } catch (e) {
      bad(`RPC bağlanamadı: ${(e as Error).message}`);
      continue;
    }

    // --- Multicall3 ------------------------------------------------------
    const mc = dex.multicall3 as Address;
    const mcCode = await client.getCode({ address: mc });
    if (mcCode && mcCode !== '0x') ok(`Multicall3 ${mc.slice(0, 10)}…`);
    else bad(`Multicall3 bu zincirde bulunamadı: ${mc}`);

    // --- Tokenlar --------------------------------------------------------
    const tokens = cfg.tokens.filter((t) => t.chain === chain.id);
    console.log(`\n  ${C.bold}Tokenlar (${tokens.length})${C.reset}`);

    // Tüm tokenları TEK multicall ile okuyoruz. Token başına ayrı RPC çağrısı
    // yapmak public uç noktaları boğuyor (ilk denemede Base'de 4 token bu
    // yüzden okunamadı) — ve zaten botun kendisi de multicall kullanacak,
    // bu yüzden doğruladığımız yol gerçek yol olsun.
    const calls = tokens.flatMap((t) => [
      { address: t.address as Address, abi: ERC20_ABI, functionName: 'symbol' } as const,
      { address: t.address as Address, abi: ERC20_ABI, functionName: 'decimals' } as const,
    ]);

    let results: { status: 'success' | 'failure'; result?: unknown }[] = [];
    try {
      results = (await client.multicall({
        contracts: calls,
        allowFailure: true,
      })) as typeof results;
    } catch (e) {
      bad(`multicall başarısız: ${(e as Error).message.slice(0, 70)}`);
    }

    const norm = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      const symRes = results[i * 2];
      const decRes = results[i * 2 + 1];

      if (!symRes || symRes.status !== 'success' || !decRes || decRes.status !== 'success') {
        bad(`${t.symbol}: ERC20 okunamadı — adres yanlış olabilir (${t.address})`);
        continue;
      }

      const symbol = String(symRes.result);
      const decimals = Number(decRes.result);

      if (decimals !== t.decimals) {
        // En tehlikeli hata: miktarlar 10^n kat sapar.
        bad(`${t.symbol}: decimals zincirde ${decimals}, tabloda ${t.decimals} — DÜZELTİLMELİ`);
      } else if (norm(symbol) !== norm(t.symbol)) {
        warn(`${t.symbol}: zincirdeki sembol "${symbol}" (decimals doğru, kozmetik fark)`);
      } else {
        ok(`${t.symbol.padEnd(8)} ${symbol.padEnd(10)} decimals ${decimals}`);
      }
    }

    // --- DEX kontratları -------------------------------------------------
    console.log(`\n  ${C.bold}DEX kontratları${C.reset}`);

    const weth = tokens.find((t) => t.symbol === 'WETH');
    const usdc = tokens.find((t) => t.symbol === 'USDC');

    if (chain.id === 'base') {
      const { router, factory } = dex.base.aerodrome;
      await checkContract(client, router as Address, 'Aerodrome Router');
      await checkContract(client, factory as Address, 'Aerodrome Factory');

      // Gerçek quote: 1 WETH → USDC. Sonuç makul bir ETH fiyatı olmalı.
      if (weth && usdc) {
        try {
          const amounts = (await client.readContract({
            address: router as Address,
            abi: AERODROME_ABI,
            functionName: 'getAmountsOut',
            args: [
              BigInt(10) ** BigInt(weth.decimals),
              [
                {
                  from: weth.address as Address,
                  to: usdc.address as Address,
                  stable: false,
                  factory: factory as Address,
                },
              ],
            ],
          })) as bigint[];

          const out = Number(formatUnits(amounts[amounts.length - 1]!, usdc.decimals));
          if (out > 100 && out < 100_000) {
            ok(`Aerodrome quote: 1 WETH → ${out.toFixed(2)} USDC ${C.dim}(makul)${C.reset}`);
          } else {
            bad(`Aerodrome quote akla yatkın değil: 1 WETH → ${out} USDC`);
          }
        } catch (e) {
          bad(`Aerodrome getAmountsOut başarısız: ${(e as Error).message.slice(0, 70)}`);
        }
      }
    }

    // Uniswap V3 hem Base'de hem Arbitrum'da kurulu; doğrulama TEK
    // fonksiyondan geçiyor. İki zincire ayrı kopya yazmak, birinin
    // güncellenip diğerinin unutulması demekti.
    if (chain.id === 'base' || chain.id === 'arbitrum') {
      await uniV3Dogrula(client, dex[chain.id].uniswapV3, weth, usdc);
    }

    // CoW zincire bağlanmıyor (HTTP toplayıcı), yani "kontratta kod var mı"
    // sorusunun karşılığı yok. Doğrulanabilecek tek şey uçtanın gerçekten
    // makul bir fiyat döndürmesi — ve doğrulanması gereken de tam olarak bu:
    // yanlış zincir yolu (`base` vs `arbitrum_one`) sessizce başka bir
    // piyasanın fiyatını döndürürdü.
    if (chain.id === 'base' && weth && usdc) {
      try {
        const out = await new HttpCowQuoter('base').quote(
          weth.address,
          usdc.address,
          BigInt(10) ** BigInt(weth.decimals),
        );
        if (out === null) {
          bad('CoW: 1 WETH → USDC için rota dönmedi');
        } else {
          const usd = Number(formatUnits(out, usdc.decimals));
          if (usd > 100 && usd < 100_000) {
            ok(`CoW quote: 1 WETH → ${usd.toFixed(2)} USDC ${C.dim}(makul)${C.reset}`);
          } else {
            bad(`CoW quote akla yatkın değil: 1 WETH → ${usd} USDC`);
          }
        }
      } catch (e) {
        bad(`CoW quote başarısız: ${(e as Error).message.slice(0, 70)}`);
      }
    }

    if (chain.id === 'arbitrum') {
      const cam = dex.arbitrum.camelot;
      const camOk = await checkContract(client, cam.quoterV2 as Address, 'Camelot Quoter');

      if (camOk && weth && usdc) {
        try {
          const { result } = await client.simulateContract({
            address: cam.quoterV2 as Address,
            abi: ALGEBRA_QUOTER_ABI,
            functionName: 'quoteExactInputSingle',
            args: [
              weth.address as Address,
              usdc.address as Address,
              BigInt(10) ** BigInt(weth.decimals),
              BigInt(0),
            ],
          });
          const out = Number(formatUnits((result as readonly bigint[])[0]!, usdc.decimals));
          if (out > 100 && out < 100_000) {
            ok(`Camelot quote: 1 WETH → ${out.toFixed(2)} USDC`);
          } else {
            bad(`Camelot quote akla yatkın değil: ${out}`);
          }
        } catch (e) {
          bad(
            `Camelot quote başarısız: ${(e as Error).message.slice(0, 70)} — ` +
              `quoter adresi veya ABI yanlış olabilir`,
          );
        }
      }
    }
  }

  // --- Özet ---------------------------------------------------------------
  console.log(`\n${C.dim}${'─'.repeat(74)}${C.reset}`);
  if (failures > 0) {
    console.log(
      `${C.red}${C.bold}${failures} doğrulama başarısız.${C.reset} ` +
        `Bu adresler düzeltilmeden EVM DEX taraması açılmamalı.`,
    );
    process.exit(1);
  }
  console.log(
    `${C.green}${C.bold}✓ Tüm EVM kontratları ve tokenlar doğrulandı.${C.reset}` +
      (warnings > 0 ? ` ${C.yellow}(${warnings} kozmetik uyarı)${C.reset}` : ''),
  );
  console.log('');
}

/**
 * Yalnızca getCode'a ihtiyacı var. viem'in tam client tipi zincire göre
 * özelleştiği için burada yapısal (minimal) bir tip kullanıyoruz.
 */
interface CodeReader {
  getCode(args: { address: Address }): Promise<string | undefined>;
}

async function checkContract(
  client: CodeReader,
  address: Address,
  label: string,
): Promise<boolean> {
  try {
    const code = await client.getCode({ address });
    if (code && code !== '0x') {
      ok(`${label.padEnd(24)} ${address.slice(0, 10)}… ${C.dim}(${(code.length - 2) / 2} bayt)${C.reset}`);
      return true;
    }
    bad(`${label}: adreste kontrat YOK — ${address}`);
    return false;
  } catch (e) {
    bad(`${label}: kontrol edilemedi — ${(e as Error).message.slice(0, 50)}`);
    return false;
  }
}

/**
 * Uniswap V3 kurulumunun zincirden doğrulaması: kontratlar var mı, quoter
 * makul fiyat veriyor mu.
 *
 * Üçüncü kademe (quote) şart: yanlış bir quoter adresi sessizce anlamsız
 * fiyat döndürür, "adreste kontrat var" kontrolünü geçer ve hata ancak
 * canlıda görünür.
 */
async function uniV3Dogrula(
  client: Parameters<typeof checkContract>[0] & {
    simulateContract(args: never): Promise<{ result: unknown }>;
  },
  uni: { quoterV2: string; factory: string; feeTiers: number[] },
  weth: { address: string; decimals: number } | undefined,
  usdc: { address: string; decimals: number } | undefined,
): Promise<void> {
  await checkContract(client, uni.quoterV2 as Address, 'Uniswap V3 QuoterV2');
  await checkContract(client, uni.factory as Address, 'Uniswap V3 Factory');
  if (!weth || !usdc) return;

  let quoted = false;
  for (const fee of uni.feeTiers) {
    try {
      // QuoterV2 view değil; simulate ile eth_call üzerinden çağırıyoruz.
      const { result } = await client.simulateContract({
        address: uni.quoterV2 as Address,
        abi: UNIV3_QUOTER_ABI,
        functionName: 'quoteExactInputSingle',
        args: [
          {
            tokenIn: weth.address as Address,
            tokenOut: usdc.address as Address,
            amountIn: BigInt(10) ** BigInt(weth.decimals),
            fee,
            sqrtPriceLimitX96: BigInt(0),
          },
        ],
      } as never);
      const out = Number(formatUnits((result as readonly bigint[])[0]!, usdc.decimals));
      if (out > 100 && out < 100_000) {
        ok(`Uniswap V3 (%${fee / 10000}) quote: 1 WETH → ${out.toFixed(2)} USDC`);
        quoted = true;
        break;
      }
    } catch {
      /* bu fee tier'da havuz olmayabilir; sıradakini dene */
    }
  }
  if (!quoted) bad('Uniswap V3: hiçbir fee tier için geçerli quote alınamadı');
}

main().catch((e: Error) => {
  console.error(`${C.red}HATA: ${e.message}${C.reset}`);
  process.exit(1);
});
