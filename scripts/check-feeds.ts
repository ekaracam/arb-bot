/**
 * Feed sağlık doğrulaması.
 *
 * Her borsaya gerçekten bağlanır, belirli süre dinler ve ne aldığını raporlar.
 * Botun tamamını çalıştırmadan "hangi borsa çalışıyor, gecikmesi ne, kaç sembol
 * akıyor" sorusunu cevaplar. Coğrafi kısıt veya protokol değişikliği gibi
 * sorunlar burada anında görünür.
 *
 * Kullanım:
 *   npm run feeds              -> hepsi, 30 saniye
 *   npm run feeds -- binance   -> yalnızca binance
 *   npm run feeds -- okx 60    -> okx, 60 saniye
 */

import { loadConfig } from '../src/core/config.ts';
import { PriceStore } from '../src/book/price-store.ts';
import { SymbolRegistry } from '../src/normalize/symbol-registry.ts';
import { createFeed } from '../src/feeds/cex/index.ts';
import { CEX_IDS, type CexId, type Feed } from '../src/core/types.ts';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const requested = args.filter((a) => (CEX_IDS as readonly string[]).includes(a)) as CexId[];
  const durationArg = args.find((a) => /^\d+$/.test(a));
  const durationMs = (durationArg ? Number(durationArg) : 30) * 1000;

  const cfg = loadConfig();
  const venues: CexId[] =
    requested.length > 0
      ? requested
      : CEX_IDS.filter((v) => cfg.exchanges[v].enabled);

  console.log(`${DIM}Sembol listeleri çekiliyor...${RESET}`);
  const t0 = Date.now();

  const registry = await SymbolRegistry.build({
    venues,
    quotesByVenue: Object.fromEntries(venues.map((v) => [v, cfg.exchanges[v].quotes])),
    // Tek borsa test edilirken kesişim şartı anlamsız olur.
    minVenues: venues.length === 1 ? 1 : 2,
    excludeBases: ['USDT', 'USDC', 'DAI', 'FDUSD', 'TUSD', 'BUSD'],
  });

  console.log(
    `${DIM}Kayıt defteri hazır (${Date.now() - t0}ms): ${registry.summary()}${RESET}\n`,
  );

  for (const [venue, err] of registry.failedVenues) {
    console.log(`${RED}✗ ${venue}: sembol listesi alınamadı — ${err}${RESET}`);
  }

  const store = new PriceStore(registry.pairs, venues);
  const feeds: Feed[] = [];

  for (const venue of venues) {
    const markets = registry.symbolsFor(venue);
    if (markets.length === 0) {
      console.log(`${YELLOW}⚠ ${venue}: taranacak sembol yok, atlanıyor${RESET}`);
      continue;
    }
    feeds.push(createFeed(venue, store, markets));
  }

  console.log(`${DIM}${feeds.length} feed başlatılıyor, ${durationMs / 1000}s dinlenecek...${RESET}\n`);

  await Promise.all(
    feeds.map((f) =>
      f.start().catch((e: Error) => {
        console.log(`${RED}✗ ${f.venue} başlatılamadı: ${e.message}${RESET}`);
      }),
    ),
  );

  // Canlı ilerleme: her 5 saniyede bir kısa durum.
  const progress = setInterval(() => {
    const line = feeds
      .map((f) => {
        const h = f.health();
        const c = h.state === 'live' ? GREEN : h.state === 'reconnecting' ? YELLOW : RED;
        return `${c}${f.venue}:${h.msgsPerSec.toFixed(0)}/s${RESET}`;
      })
      .join('  ');
    process.stdout.write(`\r${line}   `);
  }, 5000);

  await new Promise((r) => setTimeout(r, durationMs));
  clearInterval(progress);
  process.stdout.write('\r\x1b[K');

  // --- Rapor --------------------------------------------------------------

  console.log('\n' + '─'.repeat(96));
  console.log(
    'BORSA'.padEnd(10) +
      'DURUM'.padEnd(14) +
      'SEMBOL'.padStart(7) +
      'DOLU'.padStart(7) +
      'MSG/S'.padStart(9) +
      'GECİKME p50/p99'.padStart(18) +
      'SAAT FARKI'.padStart(12) +
      'YENİDEN'.padStart(9),
  );
  console.log('─'.repeat(96));

  let anyFailed = false;

  for (const f of feeds) {
    const h = f.health();

    // Kaç sembol gerçekten fiyat aldı? Abone olmak yetmez, veri akmalı.
    let withData = 0;
    const markets = registry.symbolsFor(f.venue as CexId);
    for (const m of markets) {
      const slot = store.resolveSlot(m.pair, f.venue);
      if (slot >= 0 && store.hasData(slot)) withData++;
    }

    const ok = h.state === 'live' && withData > 0;
    if (!ok) anyFailed = true;

    const color = ok ? GREEN : h.state === 'live' ? YELLOW : RED;
    const mark = ok ? '✓' : h.state === 'live' ? '⚠' : '✗';

    console.log(
      color +
        `${mark} ${f.venue}`.padEnd(10) +
        h.state.padEnd(14) +
        String(h.subscribedCount).padStart(7) +
        String(withData).padStart(7) +
        h.msgsPerSec.toFixed(1).padStart(9) +
        `${h.latencyP50.toFixed(0)}/${h.latencyP99.toFixed(0)}ms`.padStart(18) +
        `${h.clockSkewMs > 0 ? '+' : ''}${h.clockSkewMs.toFixed(0)}ms`.padStart(12) +
        String(h.reconnects).padStart(9) +
        RESET,
    );

    if (h.lastError) {
      console.log(`${DIM}    son hata: ${h.lastError}${RESET}`);
    }
    if (h.state === 'live' && withData === 0) {
      console.log(
        `${YELLOW}    bağlı ama hiç fiyat gelmedi — abonelik formatı veya sembol eşlemesi hatalı olabilir${RESET}`,
      );
    }
    // Ölçüm yapılmadığını gösteren işaret p50'nin 0 olması değil (düzeltilmiş
    // gecikme meşru olarak 0 çıkabilir), hiç saat farkı gözlenmemiş olmasıdır.
    if (h.clockSkewMs === 0 && h.latencyP50 === 0 && withData > 0) {
      console.log(
        `${DIM}    not: bu borsa mesajlarında zaman damgası yok, gecikme ölçülemiyor${RESET}`,
      );
    }
  }

  console.log('─'.repeat(96));

  // Saat kayması: tüm borsalarda benzer ve büyük bir değer görülüyorsa sorun
  // ağda değil, lokal saattedir. Fonksiyonel etkisi yok (tazelik kontrolü
  // lokal saate dayanıyor) ama gecikme ölçümünü anlamsızlaştırır.
  const skews = feeds.map((f) => f.health().clockSkewMs).filter((s) => s !== 0);
  if (skews.length >= 2) {
    const avgSkew = skews.reduce((a, b) => a + b, 0) / skews.length;
    if (Math.abs(avgSkew) > 500) {
      console.log(
        `\n${YELLOW}⚠ Sistem saatin borsalara göre ~${(avgSkew / 1000).toFixed(1)}s kaymış.` +
          ` Yukarıdaki gecikme değerleri bu kayma düşülerek hesaplandı.` +
          `\n  Düzeltmek için (yönetici PowerShell): w32tm /resync${RESET}`,
      );
    }
  }

  // --- Örnek fiyatlar: gözle doğrulama için ------------------------------
  // Sayıların akması yetmez, MAKUL olmaları da gerekir. Bilinen bir çifti
  // tüm borsalarda yan yana basmak, yanlış ondalık/yanlış alan gibi sessiz
  // hataları anında ortaya çıkarır.
  const sample = registry.pairs.find((p) => p.startsWith('BTC/')) ?? registry.pairs[0];
  if (sample) {
    console.log(`\n${sample} — borsalar arası karşılaştırma:`);
    for (const f of feeds) {
      const slot = store.resolveSlot(sample, f.venue);
      if (slot < 0 || !store.hasData(slot)) {
        console.log(`  ${f.venue.padEnd(9)} ${DIM}veri yok${RESET}`);
        continue;
      }
      const bid = store.bid(slot);
      const ask = store.ask(slot);
      const spread = bid > 0 ? ((ask - bid) / bid) * 100 : 0;
      console.log(
        `  ${f.venue.padEnd(9)} bid ${bid.toFixed(2).padStart(12)}  ask ${ask
          .toFixed(2)
          .padStart(12)}  spread ${spread.toFixed(3)}%`,
      );
    }
    console.log(
      `\n${DIM}Bu fiyatlar birbirine yakın olmalı. Biri belirgin şekilde farklıysa` +
        ` o adapter'da ondalık/alan hatası vardır.${RESET}`,
    );
  }

  await Promise.all(feeds.map((f) => f.stop()));
  process.exit(anyFailed ? 1 : 0);
}

main().catch((e: Error) => {
  console.error(`${RED}HATA: ${e.message}${RESET}`);
  console.error(e.stack);
  process.exit(1);
});
