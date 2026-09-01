/**
 * Sinyal kalitesi raporu.
 *
 * v1'in varlık sebebi budur. Bot bir fırsat bildirdiğinde o anda gerçek olup
 * olmadığını bilemeyiz; ancak biriken kayıtların DESENİNE bakarak anlayabiliriz.
 *
 * Rapor şu soruları cevaplar:
 *   - Sinyaller hangi coin/borsa çiftlerinde yoğunlaşıyor?
 *   - Kaçı "kapanmayan fark" uyarısı taşıyor (yani muhtemelen ulaşılamaz)?
 *   - Kaçı doğrulanmamış transfer bilgisine dayanıyor?
 *   - Kayma (slippage) ne kadar kâr yiyor?
 *   - Eğer risk limitleri açık olsaydı kaç sinyal geçerdi?
 *
 * Otomasyona geçmeden önce burada "temiz" görünen bir taban elde etmek şart.
 * Aksi halde v2 gerçek parayla aynı sahte sinyalleri kovalar.
 *
 * Kullanım:  npm run calibrate            (tüm kayıtlar)
 *            npm run calibrate -- 2026-08-03
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../src/core/config.ts';
import type { OpportunityRecord } from '../src/persist/ndjson.ts';

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

/**
 * Botun ürettiği kayıt dosyasının TAM adı — NdjsonWriter yalnızca bunu yazar.
 *
 * Kalıbın katı olması şart. Eskiden filtre `endsWith('.ndjson')` idi ve
 * arşivlenmiş dosyaları (`opportunities-2026-08-03.anahtar-oncesi.ndjson`)
 * da içeri alıyordu. Sonuç, farklı dönemlere ait veriyi tek rapora karıştırmaktı:
 * API anahtarı eklenmeden önceki 151 kayıt, sonraki 6 kayıtla toplanınca rapor
 * "sinyallerin %96'sı doğrulanmamış" deyip 1. öncelik olarak zaten yapılmış
 * olan işi öneriyordu. Yanlış veriyle üretilen tavsiye, tavsiyesizlikten kötüdür.
 *
 * Arşiv dosyaları dizinde kalabilir; adı kalıba uymayan her şey atlanır ve
 * atlananlar rapora yazılır — sessizce yok saymak da aynı hatanın başka biçimi.
 */
const KAYIT_DOSYASI = /^opportunities-\d{4}-\d{2}-\d{2}\.ndjson$/;

interface Yukleme {
  readonly records: OpportunityRecord[];
  readonly used: string[];
  readonly skipped: string[];
}

function load(dir: string, day: string | null): Yukleme {
  if (!existsSync(dir)) {
    throw new Error(`Kayıt dizini yok: ${dir} — önce botu çalıştır`);
  }

  const ndjson = readdirSync(dir).filter((f) => f.endsWith('.ndjson'));
  const used: string[] = [];
  const skipped: string[] = [];

  for (const f of ndjson) {
    if (!KAYIT_DOSYASI.test(f)) skipped.push(f);
    else if (day && f !== `opportunities-${day}.ndjson`) continue;
    else used.push(f);
  }

  if (used.length === 0) {
    const ek =
      skipped.length > 0
        ? ` — dizinde ${skipped.length} dosya var ama adları kalıba uymuyor: ${skipped.join(', ')}`
        : '';
    throw new Error(`Kayıt bulunamadı${day ? ` (${day})` : ''}${ek}`);
  }

  const records: OpportunityRecord[] = [];
  for (const f of used) {
    const text = readFileSync(resolve(dir, f), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as OpportunityRecord);
      } catch {
        /* yarım yazılmış son satır olabilir */
      }
    }
  }
  return { records, used, skipped };
}

function pct(n: number, total: number): string {
  return total > 0 ? `%${((n / total) * 100).toFixed(1)}` : '—';
}

function bar(n: number, max: number, width = 24): string {
  const filled = max > 0 ? Math.round((n / max) * width) : 0;
  return '█'.repeat(filled) + C.dim + '·'.repeat(width - filled) + C.reset;
}

function main(): void {
  const cfg = loadConfig();
  const day = process.argv.slice(2).find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? null;
  const { records, used, skipped } = load(cfg.persist.dir, day);

  if (records.length === 0) {
    console.log('Kayıt yok.');
    return;
  }

  const first = Math.min(...records.map((r) => r.ts));
  const last = Math.max(...records.map((r) => r.ts));
  const hours = (last - first) / 3_600_000;

  console.log(`\n${C.bold}${C.cyan}SİNYAL KALİTESİ RAPORU${C.reset}`);
  console.log(C.dim + '─'.repeat(72) + C.reset);
  console.log(
    `${records.length} sinyal · ${hours.toFixed(1)} saat · ` +
      `${new Date(first).toLocaleString('tr-TR')} → ${new Date(last).toLocaleString('tr-TR')}`,
  );
  console.log(`${C.dim}kaynak: ${used.join(', ')}${C.reset}`);
  if (skipped.length > 0) {
    // Atlanan dosyayı göstermezsek kullanıcı raporun neden beklediğinden az
    // kayıt içerdiğini anlayamaz.
    console.log(`${C.dim}atlanan (ad kalıba uymuyor): ${skipped.join(', ')}${C.reset}`);
  }

  // --- Güvenilirlik göstergeleri -----------------------------------------
  const stale = records.filter((r) =>
    r.warnings.some((w) => w.includes('kapanmıyor')),
  ).length;
  const unverified = records.filter((r) => !r.transferVerified).length;
  const highSlip = records.filter((r) => r.warnings.some((w) => w.includes('kayma'))).length;
  const implausible = records.filter((r) => r.netPct > 0.2).length;

  console.log(`\n${C.bold}GÜVENİLİRLİK${C.reset}`);
  const flag = (n: number): string =>
    n / records.length > 0.5 ? C.red : n / records.length > 0.2 ? C.yellow : C.green;

  console.log(
    `${flag(stale)}kapanmayan fark${C.reset}      ${String(stale).padStart(6)}  ${pct(stale, records.length).padStart(7)}` +
      `  ${C.dim}gerçek arbitraj saniyeler içinde kapanır${C.reset}`,
  );
  console.log(
    `${flag(unverified)}transfer doğrulanmamış${C.reset} ${String(unverified).padStart(6)}  ${pct(unverified, records.length).padStart(7)}` +
      `  ${C.dim}binance/bybit/okx/mexc — public API yok${C.reset}`,
  );
  console.log(
    `${flag(implausible)}net %20 üzeri${C.reset}         ${String(implausible).padStart(6)}  ${pct(implausible, records.length).padStart(7)}` +
      `  ${C.dim}neredeyse her zaman veri hatası${C.reset}`,
  );
  console.log(
    `${C.dim}belirgin kayma          ${String(highSlip).padStart(6)}  ${pct(highSlip, records.length).padStart(7)}` +
      `  L1 fiyatı gerçekleşmiyor${C.reset}`,
  );

  // Hiçbir uyarı taşımayan sinyaller — v2'nin hedefleyeceği küme.
  const clean = records.filter(
    (r) => r.warnings.length === 0 && r.transferVerified && r.netPct <= 0.2,
  );
  console.log(
    `\n${C.bold}${clean.length > 0 ? C.green : C.red}TEMİZ SİNYAL: ${clean.length}${C.reset}` +
      ` ${C.dim}(${pct(clean.length, records.length)} — uyarısız, doğrulanmış, makul)${C.reset}`,
  );
  if (clean.length > 0) {
    const avgNet = clean.reduce((a, r) => a + r.netPct, 0) / clean.length;
    const totalQuote = clean.reduce((a, r) => a + r.netQuote, 0);
    console.log(
      `${C.dim}  ortalama net %${(avgNet * 100).toFixed(2)} · ` +
        `toplam teorik kâr ${totalQuote.toFixed(0)} USDT · ` +
        `saatte ${(clean.length / Math.max(hours, 0.01)).toFixed(1)} sinyal${C.reset}`,
    );
  }

  // --- Dağılımlar --------------------------------------------------------
  const byCoin = new Map<string, number>();
  const byRoute = new Map<string, number>();
  const byChain = new Map<string, number>();
  for (const r of records) {
    byCoin.set(r.coin, (byCoin.get(r.coin) ?? 0) + 1);
    const route = `${r.buyVenue} → ${r.sellVenue}`;
    byRoute.set(route, (byRoute.get(route) ?? 0) + 1);
    const ch = r.chain ?? '(yok)';
    byChain.set(ch, (byChain.get(ch) ?? 0) + 1);
  }

  const top = (m: Map<string, number>, n: number): [string, number][] =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

  console.log(`\n${C.bold}EN ÇOK SİNYAL ÜRETEN COİNLER${C.reset}`);
  const coinTop = top(byCoin, 8);
  const coinMax = coinTop[0]?.[1] ?? 1;
  for (const [coin, n] of coinTop) {
    console.log(`  ${coin.padEnd(14)} ${String(n).padStart(5)}  ${bar(n, coinMax)}`);
  }
  // Tek bir coin'in baskın olması, o coin'in gerçekten kârlı değil
  // gerçekten ULAŞILAMAZ olduğunun göstergesidir.
  if (coinTop[0] && coinTop[0][1] / records.length > 0.4) {
    console.log(
      `  ${C.yellow}⚠ ${coinTop[0][0]} sinyallerin ${pct(coinTop[0][1], records.length)}'ini oluşturuyor` +
        ` — bu coin muhtemelen transfer edilemiyor${C.reset}`,
    );
  }

  console.log(`\n${C.bold}EN ÇOK KULLANILAN ROTALAR${C.reset}`);
  const routeTop = top(byRoute, 6);
  const routeMax = routeTop[0]?.[1] ?? 1;
  for (const [route, n] of routeTop) {
    console.log(`  ${route.padEnd(20)} ${String(n).padStart(5)}  ${bar(n, routeMax)}`);
  }

  console.log(`\n${C.bold}ZİNCİRLER${C.reset}`);
  for (const [chain, n] of top(byChain, 5)) {
    console.log(`  ${chain.padEnd(14)} ${String(n).padStart(5)}  ${pct(n, records.length)}`);
  }

  // --- Kayma etkisi ------------------------------------------------------
  let l1Net = 0;
  let realNet = 0;
  for (const r of records) {
    // L1'e bakan naif bir botun göreceği kâr ile VWAP'a dayanan gerçek kâr.
    const naive = (r.sellBest - r.buyBest) / r.buyBest;
    l1Net += naive;
    realNet += r.netPct;
  }
  const avgNaive = (l1Net / records.length) * 100;
  const avgReal = (realNet / records.length) * 100;
  console.log(`\n${C.bold}HAM SPREAD vs GERÇEK KÂR${C.reset}`);
  console.log(`  L1 spread'e bakan bot görürdü : %${avgNaive.toFixed(2)}`);
  console.log(`  VWAP + ücretlerle gerçek      : %${avgReal.toFixed(2)}`);
  console.log(
    `  ${C.dim}fark: %${(avgNaive - avgReal).toFixed(2)} — ` +
      `derinlik ve komisyon doğrulaması olmasa bu kadar fazla kâr sanırdık${C.reset}`,
  );

  // --- Karar -------------------------------------------------------------
  console.log(`\n${C.dim}${'─'.repeat(72)}${C.reset}`);
  const cleanRatio = clean.length / records.length;
  if (cleanRatio >= 0.3 && clean.length >= 20) {
    console.log(
      `${C.green}${C.bold}Sinyal kalitesi otomasyon için değerlendirilebilir.${C.reset}`,
    );
    console.log(
      `${C.dim}Yine de v2'ye geçmeden önce temiz sinyallerden birkaçını elle` +
        ` uygulayıp gerçekten dolduğunu doğrula.${C.reset}`,
    );
  } else {
    console.log(`${C.yellow}${C.bold}Otomasyona geçmek için henüz erken.${C.reset}`);
    console.log(
      `${C.dim}Temiz sinyal oranı ${pct(clean.length, records.length)}. Öncelik sırasıyla:${C.reset}`,
    );
    const oneriler: string[] = [];
    if (unverified / records.length > 0.3) {
      oneriler.push(
        `Borsalara salt-okunur API anahtarı ekle — sinyallerin ` +
          `${pct(unverified, records.length)}'i çekim durumu bilinmediği için şüpheli.`,
      );
    }
    if (stale / records.length > 0.3) {
      oneriler.push(
        `Kapanmayan farklar baskın (${pct(stale, records.length)}). Bu coinleri ` +
          `taramadan çıkarmayı düşün.`,
      );
    }
    oneriler.push(`Daha uzun süre veri topla (şu an ${hours.toFixed(1)} saat).`);
    // Numara listeye göre veriliyor: sabit yazılınca ilk iki madde elendiğinde
    // ekranda tek başına "3." kalıyordu.
    oneriler.forEach((o, i) => console.log(`  ${i + 1}. ${o}`));
  }
  console.log('');
}

try {
  main();
} catch (e) {
  console.error(`${C.red}HATA: ${(e as Error).message}${C.reset}`);
  process.exit(1);
}
