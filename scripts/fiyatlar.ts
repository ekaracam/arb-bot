/**
 * Taranan her coin için venue bazında fiyat tablosu.
 *
 * `kapsam` "bot neyi izliyor?" sorusunu feed açmadan cevaplar; bu script bir
 * adım ötesini sorar: **izlenen çiftin o venue'da GERÇEKTEN fiyatı var mı?**
 * İkisi aynı şey değil ve aradaki fark bu botta tam olarak sessiz kalan yer —
 * bir çift `kapsam`'da "izleniyor" görünürken feed hiç veri yazmıyor olabilir
 * (abonelik sınırı aşılmış, havuz yok, uç nokta kota vermiyor). Boş hücre
 * burada görünür.
 *
 * `null` = o venue o çift için fiyat YAZMADI. Sebebini söylemez, varlığını
 * söyler; sebep için `kapsam` ve panelin teşhis sütununa bakılır.
 *
 * Fiyat = **orta fiyat** ((bid+ask)/2). Tek sütunda bid/ask'i birleştirmek
 * tabloyu iki katına çıkarırdı ve bu tablonun sorusu kâr değil KAPSAM.
 * Gerçek kâr hesabı zaten VWAP'la Aşama 2'de yapılıyor (bkz. scanner).
 *
 * Kullanım:
 *   npm run fiyatlar            60 sn dinle, tabloyu yaz
 *   npm run fiyatlar -- 120     dinleme süresini uzat (yavaş DEX turları için)
 *   npm run fiyatlar -- 60 BTC  yalnızca sembolü eşleşenler (ekran çıktısı)
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadConfig, ROOT } from '../src/core/config.ts';
import { PriceStore } from '../src/book/price-store.ts';
import { SymbolRegistry } from '../src/normalize/symbol-registry.ts';
import { createFeed } from '../src/feeds/cex/index.ts';
import { createDexFeeds } from '../src/feeds/dex/index.ts';
import {
  CEX_IDS,
  DEX_IDS,
  EXCLUDED_BASES,
  type CexId,
  type DexId,
  type Feed,
  type PairKey,
  type VenueId,
} from '../src/core/types.ts';

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

/**
 * Varsayılan dinleme süresi.
 *
 * CEX'ler saniyeler içinde dolar, tabloyu belirleyen DEX turlarıdır: ölçülen
 * tur süreleri jupiter ~11 sn, aerodrome ~7 sn, uniswap-v3-base ~14 sn. 60 sn
 * hepsine birkaç tur bırakır. Kısaltmak DEX sütunlarını haksızca `null`
 * gösterir — yani tablonun cevaplamak için var olduğu soruyu bozar.
 */
const VARSAYILAN_SN = 60;

/** Sayıyı tabloya yazılacak biçime çevirir; veri yoksa boş dize. */
function fiyatYaz(v: number | null): string {
  if (v === null) return '';
  // Kripto fiyatları 6 basamak arasında geziniyor (BTC ~70000, BONK ~0.00002);
  // sabit ondalık ikisini birden temsil edemez.
  if (v >= 1000) return v.toFixed(2);
  if (v >= 1) return v.toFixed(4);
  if (v >= 0.0001) return v.toFixed(8);
  return v.toExponential(4);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const sure = Number(args.find((a) => /^\d+$/.test(a)) ?? VARSAYILAN_SN);
  const filtre = args.find((a) => !/^\d+$/.test(a) && !a.startsWith('--'))?.toUpperCase() ?? null;

  const cfg = loadConfig();
  const venues: CexId[] = CEX_IDS.filter((v) => cfg.exchanges[v].enabled);

  console.log(`${C.dim}Sembol listeleri çekiliyor...${C.reset}`);
  // Kayıt defteri ayarları `main.ts` ile AYNI olmak zorunda: farklı olursa
  // tablo, botun taradığından başka bir kümeyi anlatır ve bu tam olarak
  // raporun engellemek için var olduğu hata sınıfıdır.
  const registry = await SymbolRegistry.build({
    venues,
    quotesByVenue: Object.fromEntries(venues.map((v) => [v, cfg.exchanges[v].quotes])),
    minVenues: 2,
    excludeBases: EXCLUDED_BASES,
    zorunlu: cfg.izleme.kapsam,
    usdVekilBorsalari: ['kraken'],
  });

  const allVenues: VenueId[] = [...venues, ...DEX_IDS];
  const store = new PriceStore(registry.pairs, allVenues);

  /**
   * Venue başına GERÇEKTEN abone olunan çift sayısı.
   *
   * Doluluk oranının paydası bu olmak zorunda. `store.resolveSlot()` her
   * (çift, venue) ikilisi için slot döndürür — matris tam dolu ayrılıyor —
   * dolayısıyla onu payda saymak her venue'ya 1213 yazar ve binance'i "1213
   * çiftin 395'ini yazabilmiş" gibi gösterir. Oysa binance zaten 407 sembole
   * abone; sorun kapsam değil, o an fiyat gelmemiş olması.
   */
  const izlenen = new Map<VenueId, number>();

  const feeds: Feed[] = [];
  for (const venue of venues) {
    const markets = registry.symbolsFor(venue);
    if (markets.length === 0) continue;
    izlenen.set(venue, new Set(markets.map((m) => m.pair)).size);
    feeds.push(createFeed(venue, store, markets));
  }

  const knownPairs = new Set(registry.pairs);
  const aktifDex: DexId[] = [];
  for (const setup of createDexFeeds(cfg, store, knownPairs)) {
    if (!setup.feed) continue;
    feeds.push(setup.feed);
    aktifDex.push(setup.venue);
    izlenen.set(setup.venue, setup.tokenCount);
  }

  console.log(
    `${registry.pairCount} çift · ${venues.length} CEX · ${aktifDex.length} DEX · ` +
      `${sure} sn dinleniyor...`,
  );
  await Promise.all(feeds.map((f) => f.start()));
  await new Promise((r) => setTimeout(r, sure * 1000));

  // --- Anlık görüntü ------------------------------------------------------
  // Sütun listesi AKTİF venue'lardan: kurulmamış bir DEX için sütun açmak,
  // her satırı `null` olan ve hiçbir şey anlatmayan bir sütun demek.
  const sutunlar: VenueId[] = [...venues, ...aktifDex];
  const satirlar: { sembol: string; cift: PairKey; fiyat: (number | null)[] }[] = [];

  for (const cift of registry.pairs) {
    const fiyat = sutunlar.map((v) => {
      const slot = store.resolveSlot(cift, v);
      if (slot < 0 || !store.hasData(slot)) return null;
      const bid = store.bid(slot);
      const ask = store.ask(slot);
      // Tek taraflı defter de fiyattır: DEX bacağının bir yönü fiyatlanıp
      // diğeri fiyatlanamayabiliyor ve bunu `null` saymak veriyi gizlerdi.
      if (bid > 0 && ask > 0) return (bid + ask) / 2;
      if (bid > 0) return bid;
      if (ask > 0) return ask;
      return null;
    });
    satirlar.push({ sembol: cift.split('/')[0]!, cift, fiyat });
  }

  await Promise.all(feeds.map((f) => f.stop()));

  // --- CSV ----------------------------------------------------------------
  const basliklar = ['sembol', 'cift', ...sutunlar];
  const csv = [basliklar.join(',')];
  for (const s of satirlar) {
    csv.push([s.sembol, s.cift, ...s.fiyat.map(fiyatYaz)].join(','));
  }
  const dir = resolve(ROOT, 'data');
  mkdirSync(dir, { recursive: true });
  const p = resolve(dir, `fiyatlar-${new Date().toISOString().slice(0, 10)}.csv`);
  writeFileSync(p, csv.join('\n') + '\n', 'utf8');

  // --- Ekran --------------------------------------------------------------
  const gosterilecek = filtre
    ? satirlar.filter((s) => s.sembol.includes(filtre))
    : satirlar.slice(0, 40);

  const w = Math.max(10, ...sutunlar.map((v) => v.length));
  console.log(
    `\n${C.bold}${'SEMBOL'.padEnd(12)}${sutunlar.map((v) => v.padStart(w + 1)).join('')}${C.reset}`,
  );
  for (const s of gosterilecek) {
    console.log(
      s.cift.padEnd(12) +
        s.fiyat
          .map((f) => {
            // Önce hizala, SONRA renklendir: ANSI kodları görünmez ama
            // `padStart` onları da sayar, sırayı ters çevirmek sütunları kaydırır.
            const hizali = (f === null ? 'null' : fiyatYaz(f)).padStart(w + 1);
            return f === null ? `${C.dim}${hizali}${C.reset}` : hizali;
          })
          .join(''),
    );
  }
  if (!filtre && satirlar.length > gosterilecek.length) {
    console.log(`${C.dim}… ${satirlar.length - gosterilecek.length} satır daha (CSV'de)${C.reset}`);
  }

  // --- Kapsam özeti -------------------------------------------------------
  // Asıl bilgi tablonun kendisinde değil DOLULUK oranında: bir venue'nun
  // sütununun boş kalması, o feed'in sessizce çalışmadığının tek işareti.
  console.log(`\n${C.bold}sütun doluluğu${C.reset} ${C.dim}(fiyat yazılan çift / o venue'da izlenen çift)${C.reset}`);
  sutunlar.forEach((v, i) => {
    const n = izlenen.get(v) ?? 0;
    const dolu = satirlar.filter((s) => s.fiyat[i] !== null).length;
    const oran = n > 0 ? (100 * dolu) / n : 0;
    const renk = oran >= 90 ? C.green : oran >= 50 ? C.yellow : C.dim;
    console.log(
      `  ${v.padEnd(18)}${renk}${String(dolu).padStart(5)}${C.reset} / ${String(n).padEnd(5)}` +
        ` ${C.dim}%${oran.toFixed(0)}${C.reset}`,
    );
  });

  const hicbiri = satirlar.filter((s) => s.fiyat.every((f) => f === null)).length;
  const tekVenue = satirlar.filter((s) => s.fiyat.filter((f) => f !== null).length === 1).length;
  console.log(
    `\n${satirlar.length} çift · ${C.dim}hiçbir venue'da fiyatı olmayan:${C.reset} ${hicbiri}` +
      ` · ${C.dim}yalnızca tek venue'da fiyatı olan (arbitraj YAPILAMAZ):${C.reset} ${tekVenue}`,
  );
  console.log(`\n${C.green}yazıldı:${C.reset} ${p}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
