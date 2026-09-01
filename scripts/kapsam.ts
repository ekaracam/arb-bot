/**
 * "Bot şu anda neyi izliyor?" — kapsam raporu.
 *
 * Bu botta kapsam kaybı SESSİZDİR: taranmayan bir çift hata üretmez, yalnızca
 * yoktur. Ölçülmüş üç örnek — JUP'ın kaldıraçlı sanılıp altı borsada listeliyken
 * hiç taranmaması, Gate'in `chains[]` yerine varsayılan zincirinin okunması,
 * DEX bacağının quote'a hiç bağlanmaması — hepsi aylarca hiçbir ekranda iz
 * bırakmadan durdu. Panel yalnızca AKAN veriyi gösteriyor; akmayan verinin
 * görünür olacağı tek yer budur.
 *
 * Rapor ağa çıkar (sembol listeleri public uçlardan çekilir) ama HİÇBİR
 * feed başlatmaz, WebSocket açmaz, RPC harcamaz. Bot çalışırken de güvenle
 * çalıştırılabilir.
 *
 * Kullanım:
 *   npm run kapsam              tam rapor
 *   npm run kapsam -- PEPE      tek coin: izleniyor mu, izlenmiyorsa neden
 *   npm run kapsam -- --tumu    taranan tüm çiftleri listele
 *   npm run kapsam -- --yaz     raporu data/kapsam-<tarih>.txt dosyasına da yaz
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadConfig, ROOT } from '../src/core/config.ts';
import { IZLEME_DOSYASI } from '../src/core/izleme-listesi.ts';
import {
  SymbolRegistry,
  isLeveragedTicker,
  zorunluOzet,
  type RegistryStats,
} from '../src/normalize/symbol-registry.ts';
import { dexTokensFor, DEVRE_DISI, RPC_GEREKTIRMEYEN } from '../src/feeds/dex/index.ts';
import {
  CEX_IDS,
  CHAIN_IDS,
  DEX_CHAIN,
  DEX_IDS,
  EXCLUDED_BASES,
  pairKey,
  type CexId,
  type ChainId,
  type DexId,
  type PairKey,
} from '../src/core/types.ts';

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

/** Rapor hem ekrana hem (istenirse) dosyaya gider; dosyada renk kodu olmaz. */
const satirlar: string[] = [];
function yaz(s = ''): void {
  console.log(s);
  satirlar.push(s.replace(/\x1b\[\d+m/g, ''));
}

function base(pair: PairKey): string {
  return pair.slice(0, pair.indexOf('/'));
}

/** Sabit genişlikli sütun — tablo hizası bozulmasın. */
function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
function padL(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dosyaYaz = args.includes('--yaz');
  const tumu = args.includes('--tumu');
  const sorgu = args.find((a) => !a.startsWith('--'))?.toUpperCase() ?? null;

  const cfg = loadConfig();
  const venues: CexId[] = CEX_IDS.filter((v) => cfg.exchanges[v].enabled);

  yaz(`\n${C.bold}${C.cyan}KAPSAM RAPORU${C.reset}  ${C.dim}${new Date().toLocaleString('tr-TR')}${C.reset}`);
  yaz(C.dim + '─'.repeat(78) + C.reset);
  yaz(`${C.dim}sembol listeleri çekiliyor (${venues.length} borsa)...${C.reset}`);

  const registry = await SymbolRegistry.build({
    venues,
    quotesByVenue: Object.fromEntries(venues.map((v) => [v, cfg.exchanges[v].quotes])),
    minVenues: 2,
    excludeBases: EXCLUDED_BASES,
    // Rapor botun GERÇEKTEN neyi izlediğini göstermeli; muafiyetler
    // uygulanmazsa zorunlu listedeki coinler burada eksik görünürdü.
    zorunlu: cfg.izleme.kapsam,
    // Botla AYNI ayar — rapor, botun gerçekten kurduğu çiftleri göstermeli.
    usdVekilBorsalari: ['kraken'],
    // Sorgulanan coinin taranmayan quote'lardaki varlığı da kaydedilsin —
    // muafiyet vermeden, yalnızca teşhis için.
    ...(sorgu ? { gozlem: new Set([sorgu]) } : {}),
  });

  const stats = registry.stats;
  const knownPairs = new Set(registry.pairs);

  // DEX tarafı: botla AYNI fonksiyon (dexTokensFor) kullanılıyor, kopya filtre yok.
  const dexAktif = new Map<DexId, { chain: ChainId; sembol: string[] }>();
  // Liste `DEX_IDS`'ten geliyor, elle yazılmıyor: kopya bir dizi tutmak yeni
  // venue eklendiğinde raporun onu görmemesi demekti (ölçüldü — `cow-base` ve
  // `uniswap-v3-base` eklendikten sonra rapor Base için hâlâ "venue:
  // aerodrome" diyordu).
  // Elle kapatılan venue burada da düşmek zorunda: raporun tek işi botun ŞU
  // ANDA neyi izlediğini söylemek, kapalı bir venue'yu saymak tam olarak
  // engellemek için var olduğu yalanı üretirdi.
  const dexVenues: readonly DexId[] = DEX_IDS.filter((v) => !DEVRE_DISI.includes(v));
  for (const v of dexVenues) {
    const chain = DEX_CHAIN[v];
    dexAktif.set(v, {
      chain,
      sembol: dexTokensFor(cfg, chain, knownPairs).map((x) => x.token.symbol),
    });
  }

  // Zorunlu listenin denetiminde "DEX bacağı var" demek için zincirin gerçekten
  // açık olması gerekir; kapalı zincirin tokeni tabloda dursa da sorulmuyor.
  const dexPairler = new Set<PairKey>();
  for (const v of dexVenues) {
    const chain = DEX_CHAIN[v];
    if (!cfg.chains[chain].enabled) continue;
    if (chain !== 'solana' && !cfg.chains[chain].rpcUrl && !RPC_GEREKTIRMEYEN.includes(v)) {
      continue;
    }
    for (const { pair } of dexTokensFor(cfg, chain, knownPairs)) dexPairler.add(pair);
  }

  if (sorgu) {
    tekCoin(sorgu, registry, stats, cfg, knownPairs, dexAktif);
  } else {
    tamRapor(registry, stats, cfg, knownPairs, dexAktif, venues, tumu, dexPairler);
  }

  if (dosyaYaz) {
    const dir = resolve(ROOT, 'data');
    mkdirSync(dir, { recursive: true });
    const p = resolve(dir, `kapsam-${new Date().toISOString().slice(0, 10)}.txt`);
    writeFileSync(p, satirlar.join('\n') + '\n', 'utf8');
    console.log(`\n${C.green}yazıldı:${C.reset} ${p}`);
  }
}

// ---------------------------------------------------------------------------
// Tam rapor
// ---------------------------------------------------------------------------

function tamRapor(
  registry: SymbolRegistry,
  stats: RegistryStats,
  cfg: ReturnType<typeof loadConfig>,
  knownPairs: ReadonlySet<PairKey>,
  dexAktif: ReadonlyMap<DexId, { chain: ChainId; sembol: string[] }>,
  venues: readonly CexId[],
  tumu: boolean,
  dexPairler: ReadonlySet<PairKey>,
): void {
  // --- 1. Borsa başına eleme hunisi ---------------------------------------
  yaz(`\n${C.bold}1. CEX SEMBOL KEŞFİ${C.reset} ${C.dim}(borsanın verdiği listeden taranan çifte)${C.reset}\n`);
  yaz(
    C.dim +
      pad('borsa', 10) +
      padL('ham', 7) +
      padL('vekil', 7) +
      padL('quote dışı', 12) +
      padL('stablecoin', 12) +
      padL('kaldıraçlı', 12) +
      padL('kabul', 8) +
      padL('taranan', 9) +
      C.reset,
  );

  for (const v of venues) {
    const f = stats.perVenue.get(v);
    const err = registry.failedVenues.get(v);
    if (!f) {
      yaz(`${C.red}${pad(v, 10)}${C.reset} ${C.dim}liste alınamadı — ${(err ?? '').slice(0, 50)}${C.reset}`);
      continue;
    }
    const taranan = registry.symbolsFor(v).length;
    yaz(
      pad(v, 10) +
        padL(String(f.ham), 7) +
        C.dim +
        padL(f.vekil > 0 ? `+${f.vekil}` : '·', 7) +
        C.reset +
        C.dim +
        padL(String(f.quoteDisi), 12) +
        padL(String(f.elenenBase), 12) +
        padL(String(f.kaldiracli), 12) +
        C.reset +
        padL(String(f.kabul), 8) +
        C.green +
        padL(String(taranan), 9) +
        C.reset,
    );
  }
  yaz(
    `\n${C.dim}"kabul" = quote/stablecoin/kaldıraç elemesini geçen; "taranan" = bunlardan ` +
      `en az iki\n  borsada birden bulunup gerçekten izlenen çift sayısı.${C.reset}`,
  );

  // --- 2. Çift dağılımı ----------------------------------------------------
  const dagilim = new Map<number, PairKey[]>();
  for (const pair of registry.pairs) {
    const n = registry.venuesFor(pair).size;
    const arr = dagilim.get(n) ?? [];
    arr.push(pair);
    dagilim.set(n, arr);
  }

  yaz(`\n${C.bold}2. TARANAN ÇİFTLER${C.reset}  ${C.green}${registry.pairCount} çift${C.reset}\n`);
  for (const n of [...dagilim.keys()].sort((a, b) => b - a)) {
    const arr = dagilim.get(n)!;
    const ornek = arr
      .slice(0, 12)
      .map(base)
      .join(' ');
    yaz(
      `  ${C.bold}${n} borsada${C.reset} ${padL(String(arr.length), 4)} çift  ` +
        `${C.dim}${ornek}${arr.length > 12 ? ` +${arr.length - 12}` : ''}${C.reset}`,
    );
  }
  yaz(
    `\n${C.dim}Bir çift ne kadar çok borsada varsa o kadar çok yön denenir: ` +
      `n borsa → n×(n−1) yön.${C.reset}`,
  );

  // --- 3. Elenenler --------------------------------------------------------
  const tek = [...stats.tekBorsada.entries()];
  yaz(`\n${C.bold}3. ELENEN ÇİFTLER${C.reset}\n`);
  yaz(
    `  ${C.yellow}${tek.length}${C.reset} çift yalnızca TEK borsada listeli — arbitrajın karşı tarafı yok.`,
  );
  const tekDagilim = new Map<CexId, number>();
  for (const [, vs] of tek) for (const v of vs) tekDagilim.set(v, (tekDagilim.get(v) ?? 0) + 1);
  yaz(
    `  ${C.dim}` +
      [...tekDagilim.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([v, n]) => `${v}:${n}`)
        .join('  ') +
      C.reset,
  );
  yaz(
    `  ${C.dim}örnek: ` +
      tek
        .slice(0, 10)
        .map(([p, vs]) => `${base(p)}(${vs[0]})`)
        .join(' ') +
      C.reset,
  );

  // --- 4. DEX --------------------------------------------------------------
  yaz(`\n${C.bold}4. DEX KAPSAMI${C.reset} ${C.dim}(tokens.json → CEX'te çifti olanlar)${C.reset}\n`);
  for (const chain of CHAIN_IDS) {
    // Stablecoin girdileri (USDC/USDT) tokens.json'da ROTA için durur, tarama
    // hedefi değildir — "düşen token" diye raporlamak yanıltıcı olurdu.
    const tanimli = cfg.tokens.filter(
      (t) => t.chain === chain && !(EXCLUDED_BASES as readonly string[]).includes(t.symbol.toUpperCase()),
    );
    const izlenen = dexTokensFor(cfg, chain, knownPairs);
    const dusenler = tanimli.filter((t) => !izlenen.some((x) => x.token.symbol === t.symbol));
    const venuesOfChain = [...dexAktif.entries()].filter(([, d]) => d.chain === chain).map(([v]) => v);

    // Feed'in gerçekten kurulup kurulmadığı iki şarta bağlı; kapsam raporu
    // "izleniyor" derken bunları atlarsa kapalı bir zinciri açık gösterir.
    // RPC yokluğu zinciri ancak TÜM venue'ları RPC'ye bağımlıysa öldürür:
    // CoW zincire hiç bağlanmıyor, dolayısıyla Base'de RPC tanımsızken bile
    // fiyat akar. "Devre dışı" demek çalışan bir bacağı kapalı göstermek olur.
    const rpcsizCalisan = venuesOfChain.some((v) => RPC_GEREKTIRMEYEN.includes(v));
    const kapali = !cfg.chains[chain].enabled
      ? 'zincir kapalı (config/chains.json)'
      : chain !== 'solana' && !cfg.chains[chain].rpcUrl && !rpcsizCalisan
        ? 'RPC tanımlı değil (.env)'
        : null;

    yaz(
      `  ${C.bold}${pad(chain, 10)}${C.reset}` +
        (kapali ? `${C.red}DEVRE DIŞI${C.reset} ${C.dim}${kapali}${C.reset} · ` : '') +
        `${C.green}${izlenen.length}${C.reset} izleniyor` +
        ` ${C.dim}/ ${tanimli.length} tanımlı · venue: ${venuesOfChain.join(', ')}${C.reset}`,
    );
    if (izlenen.length > 0) {
      const liste = izlenen.map((x) => x.token.symbol).sort();
      yaz(`    ${C.dim}${liste.slice(0, 30).join(' ')}${liste.length > 30 ? ` +${liste.length - 30}` : ''}${C.reset}`);
    }
    if (dusenler.length > 0) {
      yaz(
        `    ${C.yellow}${dusenler.length} token hiçbir borsada <SYM>/USDT çifti olmadığı için sorulmuyor:${C.reset}` +
          `\n    ${C.dim}${dusenler.slice(0, 20).map((t) => t.symbol).join(' ')}` +
          `${dusenler.length > 20 ? ` +${dusenler.length - 20}` : ''}${C.reset}`,
      );
    }
  }
  yaz(
    `\n${C.dim}DEX'te fiyatı olan ama hiçbir borsada listelenmemiş token boşuna RPC harcar;` +
      `\n  o yüzden CEX çifti şartı var. Ayrıca "izleniyor" = SORULUYOR demektir —` +
      `\n  havuzun $${cfg.scan.tradeSizeQuote} taşıyıp taşımadığı ayrı bir eleme (bkz. panel).${C.reset}`,
  );

  // --- 5. Zorunlu izleme listesi -------------------------------------------
  // Muafiyet vermek yetmez: girdinin işe yarayıp yaramadığı görünmek zorunda.
  // Listede olup hiçbir borsada bulunmayan bir sembol, kullanıcının izlendiğini
  // sandığı ama hiç oluşmamış bir çifttir.
  const zorunlu = zorunluOzet(stats.zorunlu, dexPairler);
  yaz(`\n${C.bold}5. ZORUNLU İZLEME LİSTESİ${C.reset} ${C.dim}(${IZLEME_DOSYASI})${C.reset}\n`);
  if (zorunlu.length === 0) {
    yaz(`  ${C.dim}liste boş — otomatik keşfin elediği bir coini zorla eklemek için:${C.reset}`);
    yaz(`  ${C.dim}npm run izle -- ekle PEPE${C.reset}`);
  } else {
    for (const s of zorunlu) {
      const isaret =
        s.sonuc === 'taraniyor'
          ? `${C.green}✓${C.reset}`
          : s.sonuc === 'tekTarafli'
            ? `${C.yellow}○${C.reset}`
            : `${C.red}✗${C.reset}`;
      yaz(`  ${isaret} ${pad(s.sembol, 12)} ${s.sonuc === 'taraniyor' ? C.dim : C.yellow}${s.aciklama}${C.reset}`);
    }
    const calisan = zorunlu.filter((s) => s.sonuc === 'taraniyor').length;
    yaz(
      `\n  ${C.dim}${calisan}/${zorunlu.length} girdi taranıyor · ayrıntılı denetim: npm run izle${C.reset}`,
    );
  }

  // --- 6. Özet -------------------------------------------------------------
  const coinler = new Set(registry.pairs.map(base));
  const dexCoin = new Set([...dexAktif.values()].flatMap((d) => d.sembol.map((s) => s.toUpperCase())));
  yaz(`\n${C.bold}ÖZET${C.reset}`);
  yaz(
    `  ${C.green}${coinler.size}${C.reset} farklı coin · ${C.green}${registry.pairCount}${C.reset} çift · ` +
      `${venues.length} CEX · ${C.green}${dexCoin.size}${C.reset} coin DEX tarafında da izleniyor`,
  );
  yaz(`  ${C.dim}tek coin sorgusu: npm run kapsam -- PEPE${C.reset}\n`);

  if (tumu) {
    yaz(`${C.bold}TÜM ÇİFTLER${C.reset}`);
    for (const pair of [...registry.pairs].sort()) {
      const vs = [...registry.venuesFor(pair).keys()];
      const dex = [...dexAktif.entries()]
        .filter(([, d]) => d.sembol.some((s) => s.toUpperCase() === base(pair)))
        .map(([v]) => v);
      yaz(
        `  ${pad(base(pair), 14)} ${C.dim}${vs.join(' ')}${dex.length > 0 ? `  ${C.cyan}+${dex.join(' ')}` : ''}${C.reset}`,
      );
    }
    yaz();
  }
}

// ---------------------------------------------------------------------------
// Tek coin sorgusu
// ---------------------------------------------------------------------------

function tekCoin(
  sorgu: string,
  registry: SymbolRegistry,
  stats: RegistryStats,
  cfg: ReturnType<typeof loadConfig>,
  knownPairs: ReadonlySet<PairKey>,
  dexAktif: ReadonlyMap<DexId, { chain: ChainId; sembol: string[] }>,
): void {
  const zorunluGirdi = cfg.izleme.girdi(sorgu);
  yaz(
    `\n${C.bold}${sorgu}${C.reset}` +
      (zorunluGirdi
        ? ` ${C.cyan}[zorunlu izleme listesinde]${C.reset}` +
          (zorunluGirdi.not ? ` ${C.dim}${zorunluGirdi.not}${C.reset}` : '')
        : '') +
      '\n',
  );

  // Hangi çiftlerde geçiyor? (quote birden fazla olabilir)
  const eslesen = registry.pairs.filter((p) => base(p) === sorgu);

  if (eslesen.length > 0) {
    yaz(`${C.green}✓ İZLENİYOR${C.reset}\n`);
    for (const pair of eslesen) {
      yaz(`  ${C.bold}${pair}${C.reset}`);
      for (const [v, sym] of registry.venuesFor(pair)) {
        yaz(`    ${pad(v, 10)} ${C.dim}${sym}${C.reset}`);
      }
    }
  } else {
    yaz(`${C.red}✗ İZLENMİYOR${C.reset}\n`);

    // Zorunlu listedeyken elenmenin sebebi ASLA stablecoin/kaldıraç olamaz —
    // o filtreler bu coin için uygulanmadı. Aşağıdaki sıralı teşhisi olduğu
    // gibi basmak yanlış sebep gösterirdi.
    if (zorunluGirdi) {
      const satir = zorunluOzet(stats.zorunlu).find((s) => s.sembol === sorgu);
      yaz(`  ${C.yellow}sebep:${C.reset} ${satir?.aciklama ?? 'bilinmiyor'}`);
      yaz(`  ${C.dim}ayrıntılı denetim: npm run izle -- ${sorgu}${C.reset}`);
    }
    // Sebebi sırayla ara — eleme sırası keşifteki sırayla aynı olmalı.
    else if ((EXCLUDED_BASES as readonly string[]).includes(sorgu)) {
      yaz(`  ${C.yellow}sebep:${C.reset} EXCLUDED_BASES listesinde (stablecoin) — kasıtlı.`);
    } else if (isLeveragedTicker(sorgu)) {
      yaz(
        `  ${C.yellow}sebep:${C.reset} kaldıraçlı token kalıbına uyuyor (BTC3L, ETHUP...).\n` +
          `  ${C.dim}Bu gerçek bir coinse kalıp hatalıdır — symbol-registry.ts / LEVERAGED.${C.reset}`,
      );
    } else {
      const tekli = [...stats.tekBorsada.entries()].filter(([p]) => base(p) === sorgu);
      if (tekli.length > 0) {
        for (const [p, vs] of tekli) {
          yaz(
            `  ${C.yellow}sebep:${C.reset} ${p} yalnızca ${C.bold}${vs.join(', ')}${C.reset} borsasında listeli.`,
          );
        }
      } else {
        yaz(`  ${C.yellow}sebep:${C.reset} taranan borsaların hiçbirinde ${sorgu}/USDT çifti bulunamadı.`);
      }

      // Teşhis İLK sebepte durmamalı. Ölçülen hata: KTA/USDT yalnızca mexc'te
      // olduğu için rapor "ikinci bir borsada listelenirse girer" diyordu —
      // oysa KTA Kraken'de KTA/USD ve KTA/EUR olarak ZATEN listeli. Doğru
      // cevap "quote farklı", "borsa yok" değil.
      const taranan = new Set(
        CEX_IDS.flatMap((v) => cfg.exchanges[v].quotes ?? []).map((q) => q.toUpperCase()),
      );
      const digerQuotes = (stats.gorulenQuotes.get(sorgu) ?? []).filter((q) => !taranan.has(q));
      if (digerQuotes.length > 0) {
        yaz(
          `  ${C.yellow}ayrıca:${C.reset} ${sorgu} borsalarda ${C.bold}${digerQuotes.join(', ')}${C.reset} ` +
            `quote'unda da listeli ama bu birimler taranmıyor.\n` +
            `  ${C.dim}Taramaya sokmak için:${C.reset} ${C.cyan}npm run izle -- ekle ${sorgu} --quote ${digerQuotes[0]}${C.reset}\n` +
            `  ${C.dim}Ancak işe yaraması için o quote'ta EN AZ İKİ venue gerekir: ${sorgu}/USDT ile\n` +
            `  ${sorgu}/${digerQuotes[0]} ayrı çiftlerdir ve birbirleriyle karşılaştırılmazlar.${C.reset}`,
        );
      } else {
        yaz(`  ${C.dim}Başka bir quote'ta da listeli değil.${C.reset}`);
      }
    }

    if (!zorunluGirdi) {
      yaz(
        `\n  ${C.dim}Elemeyi bu coin için geri almak istiyorsan (stablecoin/kaldıraç filtresi,` +
          `\n  "en az iki borsa" şartı ve quote listesi dahil):${C.reset}\n` +
          `  ${C.cyan}npm run izle -- ekle ${sorgu}${C.reset}`,
      );
    }
  }

  // --- DEX tarafı ---------------------------------------------------------
  const tokenlar = cfg.tokens.filter((t) => t.symbol.toUpperCase() === sorgu);
  yaz(`\n${C.bold}DEX${C.reset}`);
  if (tokenlar.length === 0) {
    yaz(`  ${C.dim}tokens.json'da kayıt yok — DEX bacağı denenmiyor.${C.reset}`);
    yaz(`  ${C.dim}Eklemek için: npm run discover-tokens${C.reset}`);
  } else {
    for (const t of tokenlar) {
      const izleniyor = knownPairs.has(pairKey(t.symbol, 'USDT'));
      const venuesOfChain = [...dexAktif.entries()]
        .filter(([, d]) => d.chain === t.chain)
        .map(([v]) => v);
      yaz(
        `  ${pad(t.chain, 10)} ${C.dim}${t.address}${C.reset}\n` +
          `    ${izleniyor ? `${C.green}sorgulanıyor${C.reset}` : `${C.yellow}sorgulanmıyor — CEX'te ${sorgu}/USDT yok${C.reset}`}` +
          ` ${C.dim}· venue: ${venuesOfChain.join(', ')}${C.reset}`,
      );
    }
  }
  yaz();
}

main().catch((e: Error) => {
  console.error(`\n${C.red}HATA: ${e.message}${C.reset}`);
  process.exit(1);
});
