/**
 * Salt-okunur API anahtarı doğrulaması.
 *
 * İmzalı endpoint'in cevap VERMESİ yeterli değildir — asıl risk cevabı yanlış
 * ayrıştırmaktır. Borsalar zincir kodlarını farklı yazar (Bybit "ARBI", OKX
 * "USDT-Arbitrum One", Binance "ARBITRUM"); eşleşme tutmazsa tablo sessizce
 * boş kalır ve borsa "doğrulandı" görünürken her coin "transfer edilemez"
 * çıkar. Bu, doğrulama eklemenin amacını tersine çevirir.
 *
 * Üç kademe (verify-contracts.ts ile aynı mantık):
 *   1. bağlantı  — anahtar geçerli mi, imza kabul ediliyor mu?
 *   2. zincir    — taradığımız zincirler tabloda görünüyor mu?
 *   3. içerik    — bilinen bir coin makul bir kayıt döndürüyor mu?
 *
 * 3. adım kritik: dolu bir tablo doğru ayrıştırıldığını göstermez.
 *
 * Kullanım: npm run verify-keys
 * Anahtarlar .env'den okunur ve HİÇBİR ZAMAN ekrana basılmaz.
 */

import { loadConfig } from '../src/core/config.ts';
import { TransferInfoProvider, clockSkews } from '../src/engine/transfer-info.ts';
import { CEX_IDS, CHAIN_IDS, type CexId, type ChainId } from '../src/core/types.ts';

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
 * Çekim ücretini hiçbir uçtan vermeyen borsalar.
 *
 * Kraken `/0/private/WithdrawMethods` ağ listesi ve asgari tutar veriyor ama
 * ücret vermiyor; genel bir ücret tablosu uç noktası yok. Bu bir anahtar/izin
 * sorunu DEĞİL, borsanın kapsamı — raporda ayırt edilmezse kullanıcı olmayan
 * bir ayarı arar.
 */
const UCRET_VERMEYEN: CexId[] = ['kraken'];

/** Her zincirde varlığı beklenen, likit ve yaygın listelenen referans coinler. */
const PROBES: Record<ChainId, string[]> = {
  solana: ['SOL', 'JUP', 'BONK'],
  base: ['ETH', 'USDC'],
  arbitrum: ['ARB', 'USDC', 'ETH'],
};

async function main(): Promise<void> {
  const cfg = loadConfig();
  const keyed = CEX_IDS.filter((v) => cfg.apiKeys[v]);

  console.log(`\n${C.bold}${C.cyan}API ANAHTARI DOĞRULAMA${C.reset}`);
  console.log(C.dim + '─'.repeat(72) + C.reset);

  if (keyed.length === 0) {
    console.log(`${C.yellow}.env içinde hiç API anahtarı tanımlı değil.${C.reset}`);
    console.log(`${C.dim}Bkz. .env.example — <BORSA>_API_KEY / _API_SECRET${C.reset}\n`);
    process.exit(1);
  }

  console.log(`anahtar tanımlı: ${keyed.join(', ')}`);
  console.log(
    `${C.dim}gate ve kucoin durumu ZATEN public API'den doğrulanır; gate anahtarı ` +
      `yalnızca gerçek çekim ücretini ekler${C.reset}\n`,
  );

  const provider = new TransferInfoProvider({ credentials: cfg.apiKeys });
  await provider.refresh();

  // --- Saat kayması -------------------------------------------------------
  const skews = [...clockSkews().entries()];
  if (skews.length > 0) {
    const worst = Math.max(...skews.map(([, ms]) => Math.abs(ms)));
    const col = worst > 1500 ? C.yellow : C.green;
    console.log(`${C.bold}SAAT KAYMASI${C.reset} ${C.dim}(borsa − lokal)${C.reset}`);
    console.log(
      '  ' + skews.map(([v, ms]) => `${v} ${ms > 0 ? '+' : ''}${ms}ms`).join('  ·  '),
    );
    console.log(
      `  ${col}en büyük sapma ${(worst / 1000).toFixed(1)} sn${C.reset}` +
        (worst > 1500
          ? ` ${C.dim}— imzada düzeltiliyor, ama sistem saatini senkronla (w32tm /resync)${C.reset}`
          : ''),
    );
    console.log();
  }

  // --- Borsa borsa --------------------------------------------------------
  const verified = new Set(provider.verifiedVenues);
  let hardFail = 0;
  let softFail = 0;

  for (const venue of keyed) {
    const err = provider.credentialErrors.get(venue);

    // GATE AYRI DEĞERLENDİRİLİR: durumu ve kontrat adresi zaten public uçtan
    // doğrulanıyor, anahtarın eklediği TEK şey çekim ücreti. Ücret çekimi
    // başarısız olsa bile borsa doğrulanmış KALIR — bunu "bağlantı başarısız"
    // saymak yanlış teşhis olurdu (kullanıcı çalışan bir anahtarı arar).
    if (venue === 'gate') {
      if (err) {
        console.log(`${C.yellow}~ gate${C.reset} — durum doğrulandı, ama ücret tablosu alınamadı`);
        console.log(`  ${C.dim}${err.slice(0, 200)}${C.reset}`);
        console.log(`  ${C.dim}${diagnose(err)}${C.reset}`);
        console.log(
          `  ${C.dim}Etkisi: çekim ücreti tahmine düşer. Sinyaller üretilmeye devam eder ` +
            `ama kâr hesabı ucuz coinlerde sapar.${C.reset}\n`,
        );
        softFail++;
      } else {
        console.log(`${C.green}✓ gate${C.reset} — çekim ücreti tablosu alındı (gerçek ücretler)`);
        const s = provider.lookup('gate', 'SOL', 'solana', 150);
        console.log(
          `  ${C.dim}örnek SOL/solana: çekim=${s.withdrawEnabled ? 'açık' : 'kapalı'} ` +
            `ücret=${s.withdrawFee.toFixed(6)} SOL${C.reset}\n`,
        );
      }
      continue;
    }

    if (err || !verified.has(venue)) {
      console.log(`${C.red}✗ ${venue}${C.reset} — bağlantı başarısız`);
      console.log(`  ${C.dim}${(err ?? 'bilinmeyen hata').slice(0, 200)}${C.reset}`);
      console.log(`  ${C.dim}${diagnose(err ?? '')}${C.reset}\n`);
      hardFail++;
      continue;
    }

    // 2. kademe: taradığımız zincirler tabloda var mı?
    const chainHits: string[] = [];
    let missingChain = false;
    for (const chain of CHAIN_IDS) {
      const found = PROBES[chain].filter((c) => {
        const info = provider.lookup(venue, c, chain, 100);
        return info.withdrawEnabled || info.depositEnabled;
      });
      if (found.length > 0) {
        chainHits.push(`${C.green}${chain}${C.reset}${C.dim}(${found.join(',')})${C.reset}`);
      } else {
        chainHits.push(`${C.yellow}${chain}: eşleşme yok${C.reset}`);
        missingChain = true;
      }
    }

    console.log(`${C.green}✓ ${venue}${C.reset} — imza kabul edildi`);
    console.log(`  ${chainHits.join('  ')}`);

    // 3. kademe: içerik makul mü? Ücreti olan bir kayıt bulmayı bekleriz.
    const sample = provider.lookup(venue, 'SOL', 'solana', 150);
    console.log(
      `  ${C.dim}örnek SOL/solana: çekim=${sample.withdrawEnabled ? 'açık' : 'kapalı'} ` +
        `yatırma=${sample.depositEnabled ? 'açık' : 'kapalı'} ` +
        `ücret=${Number.isFinite(sample.withdrawFee) ? sample.withdrawFee.toFixed(6) : '?'} SOL` +
        // Kraken çekim ücretini HİÇBİR uçtan vermiyor; burada görünen değer
        // tahmindir. Bunu yazmazsak kullanıcı eksik bir ayar arar.
        (UCRET_VERMEYEN.includes(venue) ? ' (tahmin — bu borsa ücret vermiyor)' : '') +
        C.reset,
    );

    if (missingChain) {
      console.log(
        `  ${C.yellow}⚠ bir veya daha fazla zincirde hiç eşleşme yok — zincir kodu` +
          ` ayrıştırması hatalı olabilir (CHAIN_ALIASES)${C.reset}`,
      );
      softFail++;
    }
    console.log();
  }

  // --- Özet ---------------------------------------------------------------
  console.log(C.dim + '─'.repeat(72) + C.reset);
  const stillUnverified = provider.unverifiedVenues;
  console.log(`doğrulanan borsalar : ${C.green}${provider.verifiedVenues.join(', ')}${C.reset}`);
  console.log(
    `doğrulanamayan      : ` +
      (stillUnverified.length > 0
        ? `${C.yellow}${stillUnverified.join(', ')}${C.reset}`
        : `${C.green}yok — tamamı doğrulandı${C.reset}`),
  );
  console.log(`${C.dim}toplam ${provider.coinsKnown} coin biliniyor${C.reset}`);

  if (hardFail > 0) {
    console.log(`\n${C.red}${C.bold}${hardFail} borsa bağlanamadı.${C.reset} Anahtarları kontrol et.`);
    process.exit(1);
  }
  if (softFail > 0) {
    console.log(
      `\n${C.yellow}${C.bold}Bağlantılar çalışıyor ama ${softFail} borsada zincir eşleşmesi eksik.${C.reset}`,
    );
    console.log(`${C.dim}Bu sessiz bir hatadır: borsa doğrulanmış görünür, coinler transfer edilemez sanılır.${C.reset}`);
    process.exit(2);
  }
  console.log(`\n${C.green}${C.bold}Tüm anahtarlar çalışıyor ve zincirler eşleşiyor.${C.reset}\n`);
}

/** Sık görülen hata kodlarını insan diline çevirir. */
function diagnose(msg: string): string {
  if (/-2008|-2015|10003|50111|10072/.test(msg)) {
    return 'anahtar geçersiz veya bu borsaya ait değil — kopyalarken boşluk kalmış olabilir';
  }
  if (/-1022|50113/.test(msg)) return 'imza reddedildi — API secret yanlış';
  if (/-1021|10002/.test(msg)) return 'zaman damgası reddedildi — sistem saatini senkronla';
  if (/IP|ip white|50110/i.test(msg)) return 'IP kısıtlaması — bu makinenin IP adresini izin listesine ekle';
  if (/permission|yetki|40[13]/i.test(msg)) return 'anahtarın okuma yetkisi yok';
  return 'anahtarın doğru borsaya ait ve okuma yetkili olduğunu kontrol et';
}

main().catch((e: Error) => {
  console.error(`\n${C.red}HATA: ${e.message}${C.reset}`);
  process.exit(1);
});
