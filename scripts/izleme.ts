/**
 * Zorunlu izleme listesi yönetimi — "bu coin kesinlikle taransın".
 *
 * Botun otomatik keşfi muhafazakârdır ve bazı coinleri haklı olarak eler
 * (stablecoin, kaldıraçlı token, tek borsada listeli çift). Bu kurallar toplu
 * keşifte doğru, tekil coinlerde yanılabilir. Bu araç o kararı coin bazında
 * geri almanı sağlar — ve daha önemlisi, geri almanın İŞE YARAYIP
 * YARAMADIĞINI ölçer.
 *
 * İkinci kısım esas olan: bu botta kapsam kaybı sessizdir. "Ekledim, artık
 * izleniyordur" varsayımı, çift hiç oluşmadığında hiçbir yerde hata
 * üretmez — kullanıcı bir sinyal beklerken sonsuza kadar bekler.
 *
 * Kullanım:
 *   npm run izle                       listeyi göster + her girdiyi DENETLE
 *   npm run izle -- ekle PEPE          coini listeye ekle, sonra denetle
 *   npm run izle -- ekle JUP --not "kaldıraçlı sanılıyordu"
 *   npm run izle -- ekle WIF --quote USD
 *   npm run izle -- ekle BONK --zincir solana --adres <mint> --decimals 5
 *   npm run izle -- cikar PEPE         girdiyi sil
 *
 * `ekle` ve varsayılan komut ağa çıkar (public sembol listeleri + public
 * transfer tabloları); hiçbir feed başlatmaz, WebSocket açmaz, RPC harcamaz.
 * Bot çalışırken de güvenle çalıştırılabilir.
 */

import { loadConfig, tokenCakismasiniDene, ROOT } from '../src/core/config.ts';
import {
  IZLEME_DOSYASI,
  izlemeListesiOku,
  loadIzlemeListesi,
  yazIzlemeListesi,
  type IzlemeDexTokeni,
  type IzlemeGirdisi,
} from '../src/core/izleme-listesi.ts';
import { SymbolRegistry, type ZorunluOzetSatiri } from '../src/normalize/symbol-registry.ts';
import { TransferInfoProvider } from '../src/engine/transfer-info.ts';
import { dexTokensFor } from '../src/feeds/dex/index.ts';
import {
  CEX_IDS,
  CHAIN_IDS,
  DEX_CHAIN,
  DEX_IDS,
  EXCLUDED_BASES,
  type CexId,
  type ChainId,
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

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

// ---------------------------------------------------------------------------
// Argüman ayrıştırma
// ---------------------------------------------------------------------------

interface Args {
  readonly komut: 'listele' | 'ekle' | 'cikar';
  readonly sembol: string | null;
  readonly not: string | null;
  readonly quotes: string[];
  readonly zincir: string | null;
  readonly adres: string | null;
  readonly decimals: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  const konum: string[] = [];
  const bayrak = new Map<string, string>();

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const ad = a.slice(2);
      const deger = argv[i + 1];
      if (deger === undefined || deger.startsWith('--')) {
        throw new Error(`--${ad} bir değer bekliyor`);
      }
      // --quote iki kez verilebilsin: değerleri virgülle biriktiriyoruz.
      const eski = bayrak.get(ad);
      bayrak.set(ad, eski === undefined ? deger : `${eski},${deger}`);
      i++;
    } else {
      konum.push(a);
    }
  }

  // `npm run izle -- PEPE` tek coin denetimi demek (kapsam raporuyla aynı
  // alışkanlık); komut adı verilmediğinde ilk konumsal argüman semboldür.
  const ilk = (konum[0] ?? '').toLowerCase();
  const komut: Args['komut'] =
    ilk === 'ekle' ? 'ekle' : ilk === 'cikar' ? 'cikar' : 'listele';
  const sembolHam = komut === 'listele' ? konum[0] : konum[1];

  return {
    komut,
    sembol: sembolHam?.toUpperCase() ?? null,
    not: bayrak.get('not') ?? null,
    quotes: (bayrak.get('quote') ?? '')
      .split(',')
      .map((q) => q.trim().toUpperCase())
      .filter((q) => q !== ''),
    zincir: bayrak.get('zincir') ?? null,
    adres: bayrak.get('adres') ?? null,
    decimals: bayrak.get('decimals') ?? null,
  };
}

// ---------------------------------------------------------------------------
// Yazma komutları
// ---------------------------------------------------------------------------

function dexTokeniKur(args: Args): IzlemeDexTokeni | null {
  const verilen = [args.zincir, args.adres, args.decimals].filter((x) => x !== null);
  if (verilen.length === 0) return null;
  if (verilen.length < 3) {
    // Yarım DEX bilgisi sessizce yok sayılırsa kullanıcı DEX bacağını
    // eklediğini sanır — tam olarak kaçındığımız durum.
    throw new Error(
      'DEX bilgisi için --zincir, --adres ve --decimals ÜÇÜ birden gerekli\n' +
        '  örnek: npm run izle -- ekle BONK --zincir solana --adres DezX... --decimals 5',
    );
  }

  const zincir = args.zincir!.toLowerCase();
  if (!(CHAIN_IDS as readonly string[]).includes(zincir)) {
    throw new Error(`geçersiz zincir "${zincir}" — beklenen: ${CHAIN_IDS.join(', ')}`);
  }
  const decimals = Number(args.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error(`--decimals 0-18 arası tam sayı olmalı, alınan: ${args.decimals}`);
  }

  return { zincir: zincir as ChainId, adres: args.adres!, decimals };
}

function ekle(args: Args): string {
  if (!args.sembol) throw new Error('ekle bir sembol bekliyor: npm run izle -- ekle PEPE');

  const liste = loadIzlemeListesi(ROOT);
  const mevcut = liste.girdi(args.sembol);
  const yeniDex = dexTokeniKur(args);

  // Var olan girdiyi silmiyoruz, üstüne ekliyoruz: kullanıcı önce coini
  // ekleyip sonra DEX adresini öğrenmiş olabilir.
  const dex: IzlemeDexTokeni[] = [...(mevcut?.dex ?? [])];
  if (yeniDex) {
    const i = dex.findIndex((d) => d.zincir === yeniDex.zincir);
    if (i >= 0) dex[i] = yeniDex;
    else dex.push(yeniDex);
  }

  const girdi: IzlemeGirdisi = {
    sembol: args.sembol,
    quotes: [...new Set([...(mevcut?.quotes ?? []), ...args.quotes])],
    dex,
    not: args.not ?? mevcut?.not ?? null,
  };

  const girdiler = [...liste.girdiler.filter((g) => g.sembol !== args.sembol), girdi];

  // tokens.json ile çelişki DİSKE YAZMADAN denenir. Ölçüldü: önce yazıp sonra
  // doğrulamak, kullanıcıyı botu hiç başlatamaz halde bırakıyordu — hata
  // mesajı doğruydu ama dosya çoktan bozulmuştu.
  tokenCakismasiniDene(izlemeListesiOku({ coinler: girdiler }));
  const p = yazIzlemeListesi(ROOT, girdiler);

  console.log(
    `${C.green}${mevcut ? 'güncellendi' : 'eklendi'}:${C.reset} ${C.bold}${args.sembol}${C.reset}` +
      (girdi.quotes.length > 0 ? ` ${C.dim}quotes: ${girdi.quotes.join(' ')}${C.reset}` : '') +
      (dex.length > 0 ? ` ${C.dim}dex: ${dex.map((d) => d.zincir).join(' ')}${C.reset}` : ''),
  );
  console.log(`${C.dim}${p}${C.reset}`);
  return args.sembol;
}

function cikar(args: Args): void {
  if (!args.sembol) throw new Error('cikar bir sembol bekliyor: npm run izle -- cikar PEPE');

  const liste = loadIzlemeListesi(ROOT);
  if (!liste.girdi(args.sembol)) {
    throw new Error(`"${args.sembol}" listede yok — mevcut: ${liste.girdiler.map((g) => g.sembol).join(', ') || '(boş)'}`);
  }
  const p = yazIzlemeListesi(
    ROOT,
    liste.girdiler.filter((g) => g.sembol !== args.sembol),
  );
  console.log(`${C.green}çıkarıldı:${C.reset} ${C.bold}${args.sembol}${C.reset}`);
  console.log(`${C.dim}${p}${C.reset}`);
}

// ---------------------------------------------------------------------------
// Denetim — girdi GERÇEKTEN işe yarıyor mu?
// ---------------------------------------------------------------------------

async function denetle(sadece: string | null): Promise<void> {
  // Config'i yazma komutlarından SONRA yüklüyoruz: loadConfig() sonucu
  // önbelleğe alıyor ve izleme listesini içine katıyor, yani ekleme öncesi
  // yüklenen config yeni girdiyi hiç görmezdi.
  const cfg = loadConfig();
  const liste = cfg.izleme;

  if (liste.girdiler.length === 0) {
    console.log(`\n${C.dim}izleme listesi boş — ${IZLEME_DOSYASI}${C.reset}`);
    console.log(`${C.dim}ekle: npm run izle -- ekle PEPE${C.reset}\n`);
    return;
  }
  if (sadece && !liste.girdi(sadece)) {
    throw new Error(
      `"${sadece}" izleme listesinde yok — mevcut: ${liste.girdiler.map((g) => g.sembol).join(', ')}\n` +
        `  eklemek için: npm run izle -- ekle ${sadece}\n` +
        `  coinin neden taranmadığını görmek için: npm run kapsam -- ${sadece}`,
    );
  }

  const venues: CexId[] = CEX_IDS.filter((v) => cfg.exchanges[v].enabled);
  console.log(
    `\n${C.bold}${C.cyan}İZLEME LİSTESİ DENETİMİ${C.reset}  ` +
      `${C.dim}${liste.girdiler.length} girdi · ${venues.length} borsa${C.reset}`,
  );
  console.log(`${C.dim}${'─'.repeat(78)}${C.reset}`);
  console.log(`${C.dim}sembol listeleri ve transfer tabloları çekiliyor...${C.reset}`);

  const [registry, transfers] = await Promise.all([
    SymbolRegistry.build({
      venues,
      quotesByVenue: Object.fromEntries(venues.map((v) => [v, cfg.exchanges[v].quotes])),
      minVenues: 2,
      excludeBases: EXCLUDED_BASES,
      zorunlu: liste.kapsam,
    }),
    (async () => {
      const t = new TransferInfoProvider({
        credentials: cfg.apiKeys,
        tradeSizeQuote: cfg.scan.tradeSizeQuote,
      });
      await t.refresh();
      return t;
    })(),
  ]);

  // DEX tarafı botun kendi filtresinden geçirilir (kopya filtre tutmak, iki
  // tarafın ayrışıp raporun yalan söylemesi demekti).
  const knownPairs = new Set(registry.pairs);
  const dexPairler = new Set<PairKey>();
  const dexVenueOf = new Map<PairKey, string[]>();
  for (const venue of DEX_IDS) {
    const chain = DEX_CHAIN[venue];
    if (!cfg.chains[chain].enabled) continue;
    if (chain !== 'solana' && !cfg.chains[chain].rpcUrl) continue;
    for (const { pair } of dexTokensFor(cfg, chain, knownPairs)) {
      dexPairler.add(pair);
      dexVenueOf.set(pair, [...(dexVenueOf.get(pair) ?? []), venue]);
    }
  }

  const ozet = registry.zorunluOzet(dexPairler).filter((s) => !sadece || s.sembol === sadece);

  for (const s of ozet) {
    satirYaz(s, cfg, transfers, dexVenueOf);
  }

  if (!sadece) {
    const calisan = ozet.filter((s) => s.sonuc === 'taraniyor').length;
    console.log(
      `\n${C.bold}ÖZET${C.reset}  ${C.green}${calisan}${C.reset}/${ozet.length} girdi taranıyor` +
        (calisan < ozet.length
          ? `  ${C.yellow}${ozet.length - calisan} girdi şu an hiçbir şey yapmıyor${C.reset}`
          : ''),
    );
  }
  console.log();
}

/** Tek girdinin tam teşhisi: CEX durumu, DEX durumu, adres çapraz kontrolü. */
function satirYaz(
  s: ZorunluOzetSatiri,
  cfg: ReturnType<typeof loadConfig>,
  transfers: TransferInfoProvider,
  dexVenueOf: ReadonlyMap<PairKey, string[]>,
): void {
  const girdi = cfg.izleme.girdi(s.sembol);
  const isaret =
    s.sonuc === 'taraniyor'
      ? `${C.green}✓${C.reset}`
      : s.sonuc === 'tekTarafli'
        ? `${C.yellow}○${C.reset}`
        : `${C.red}✗${C.reset}`;

  console.log(`\n${isaret} ${C.bold}${s.sembol}${C.reset}${girdi?.not ? `  ${C.dim}${girdi.not}${C.reset}` : ''}`);

  for (const [pair, venues] of s.durum.ciftler) {
    const dexler = dexVenueOf.get(pair) ?? [];
    console.log(
      `    ${pad(pair, 14)} ${C.dim}${venues.join(' ')}${C.reset}` +
        (dexler.length > 0 ? `  ${C.cyan}+${dexler.join(' ')}${C.reset}` : ''),
    );
  }

  if (s.sonuc !== 'taraniyor') {
    console.log(`    ${C.yellow}${s.aciklama}${C.reset}`);
  } else if (s.durum.muafiyetler.length > 0) {
    // Muafiyet olmasa bu coin taranmıyor olurdu — girdinin katkısı budur.
    const parca = s.aciklama.split(' · muafiyet: ')[1];
    if (parca) console.log(`    ${C.dim}muafiyet olmasa elenecekti: ${parca}${C.reset}`);
  }

  // Elle girilen adres, keşfin çoğunluk kuralından geçmemiştir; tek koruma
  // borsaların bildirdiği adresle karşılaştırmaktır. `pickChain` bunu çalışma
  // anında zaten yapıyor ama sessizce — uyuşmazlık orada rotayı eler ve
  // kullanıcı sebebini göremez.
  for (const d of girdi?.dex ?? []) {
    const bildirenler: { venue: CexId; adres: string }[] = [];
    for (const v of CEX_IDS) {
      const bilgi = transfers.lookup(v, s.sembol, d.zincir, 1);
      if (bilgi.address) bildirenler.push({ venue: v, adres: bilgi.address });
    }
    const bizim = d.zincir === 'solana' ? d.adres : d.adres.toLowerCase();
    const uyan = bildirenler.filter((b) => b.adres === bizim);
    const uymayan = bildirenler.filter((b) => b.adres !== bizim);

    const kisa = `${d.adres.slice(0, 6)}…${d.adres.slice(-4)}`;
    if (uymayan.length > 0) {
      console.log(
        `    ${C.red}ADRES ÇELİŞKİSİ${C.reset} ${d.zincir} ${C.dim}${kisa}${C.reset} — ` +
          uymayan.map((b) => `${b.venue}: ${b.adres.slice(0, 6)}…${b.adres.slice(-4)}`).join(', '),
      );
      console.log(
        `    ${C.dim}Aynı ticker, aynı zincir, farklı token demek. pickChain o borsanın` +
          ` rotasını\n    çalışma anında eler; adresi doğrulamadan sinyale güvenme.${C.reset}`,
      );
    } else if (uyan.length > 0) {
      console.log(
        `    ${C.green}adres doğrulandı${C.reset} ${d.zincir} ${C.dim}${kisa} · ` +
          `${uyan.map((b) => b.venue).join(', ')} aynı adresi bildiriyor${C.reset}`,
      );
    } else {
      console.log(
        `    ${C.yellow}adres kontrolsüz${C.reset} ${d.zincir} ${C.dim}${kisa} — ` +
          `hiçbir borsa bu coin için adres vermiyor;\n    zincirden doğrula: ` +
          `${d.zincir === 'solana' ? 'npm run dex' : 'npm run verify-contracts'}${C.reset}`,
      );
    }

    // Token tabloya girse bile CEX çifti yoksa DEX'e hiç sorulmaz.
    const pairVar = [...s.durum.ciftler.keys()].some((p) => dexVenueOf.has(p));
    if (!pairVar) {
      console.log(
        `    ${C.dim}DEX bacağı henüz sorulmuyor — ${s.sembol}/USDT çifti CEX tarafında` +
          ` oluşmadan\n    token sorgulanmıyor (boşuna RPC harcamamak için).${C.reset}`,
      );
    }
  }

  if ((girdi?.dex.length ?? 0) === 0 && s.sonuc === 'tekTarafli') {
    console.log(
      `    ${C.dim}DEX bacağı eklersen tek borsa yeter:` +
        `\n    npm run izle -- ekle ${s.sembol} --zincir solana --adres <mint> --decimals <n>${C.reset}`,
    );
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.komut === 'cikar') {
    cikar(args);
    await denetle(null);
    return;
  }

  if (args.komut === 'ekle') {
    // Eklemenin ardından SADECE o coini denetliyoruz: "ekledim, oldu mu?"
    // sorusunun cevabı aynı komutun çıktısında olmalı.
    const sembol = ekle(args);
    await denetle(sembol);
    return;
  }

  await denetle(args.sembol);
}

main().catch((e: Error) => {
  console.error(`\n${C.red}HATA: ${e.message}${C.reset}`);
  process.exit(1);
});
