/**
 * Giriş noktası — tüm katmanları bağlar ve çalıştırır.
 *
 * Akış:
 *   sembol keşfi → PriceStore → WebSocket feed'ler ──┐
 *                                                     ├→ Scanner (2 aşamalı)
 *   transfer bilgisi (KuCoin/Gate public) ────────────┘        │
 *                                                              ▼
 *                                   Telegram · terminal UI · NDJSON · risk/plan
 */

import { appendFileSync } from 'node:fs';
import { loadConfig } from './core/config.ts';
import { PriceStore } from './book/price-store.ts';
import { DepthCache } from './book/depth-cache.ts';
import { SymbolRegistry } from './normalize/symbol-registry.ts';
import { createFeed } from './feeds/cex/index.ts';
import { TransferInfoProvider, clockSkews } from './engine/transfer-info.ts';
import { Scanner } from './engine/scanner.ts';
import { TelegramNotifier } from './notify/telegram.ts';
import { YESIL_PCT } from './notify/format.ts';
import { bildirimEsigi } from './core/coin-esikleri.ts';
import { SoundAlert, sesCihazlari } from './notify/sound.ts';
import { Renderer, type ChainStatus, type RenderState } from './ui/renderer.ts';
import { NdjsonWriter } from './persist/ndjson.ts';
import { RiskManager, DEFAULT_LIMITS } from './risk/limits.ts';
import { Deduper } from './notify/dedup.ts';
import { NotifyOnlyExecutor, buildPlan, type Executor } from './exec/executor.ts';
import { createDexFeeds, dexTokensFor } from './feeds/dex/index.ts';
import { DexQuoter } from './feeds/dex/jupiter.ts';
import { RaydiumQuoter } from './feeds/dex/raydium.ts';
import { CaprazKontrolSeti, CowCaprazKontrol } from './feeds/dex/capraz.ts';
import { COW_CHAINS, HttpCowQuoter } from './feeds/dex/cow.ts';
import {
  JupiterLegQuoter,
  RaydiumLegQuoter,
  VenueLegQuoter,
  type DexLegQuoter,
} from './feeds/dex/leg-quoter.ts';
import {
  CEX_IDS,
  CHAIN_IDS,
  DEX_CHAIN,
  DEX_IDS,
  EXCLUDED_BASES,
  isDex,
  type CexId,
  type DexId,
  type Feed,
  type Opportunity,
  type PairKey,
  type VenueId,
} from './core/types.ts';

/**
 * RPC URL'inden yalnızca host'u çıkarır.
 *
 * Tam URL'i ekrana basmıyoruz: Alchemy/Infura gibi sağlayıcılarda API anahtarı
 * URL yolunun içindedir ve terminal görüntüsü çoğu zaman paylaşılır.
 */
function rpcHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return 'geçersiz URL';
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const startedAt = Date.now();
  const logs: string[] = [];

  /**
   * Koşu günlüğü — `RUN_LOG=<dosya>` verilirse açılır.
   *
   * NEDEN VAR: panel yalnızca ŞU ANI gösteriyor ve log halkası 50 satırda
   * kesiliyor. Uzun bir koşudan sonra "ne oldu" sorusunun cevabı hiçbir yerde
   * yoktu: feed kaç kez koptu, çapraz kontrol çağrıldı mı, kuyruk ne zaman
   * doldu — hepsi ekranda akıp gidiyordu. Sinyaller `data/opportunities-*`e
   * yazılıyor ama sinyal ÜRETİLMEYEN bir koşu hiçbir iz bırakmıyordu, ki
   * teşhis için asıl ilginç durum tam olarak odur.
   *
   * Panelin yerine geçmez, yanında durur: dosya düz metindir (ANSI yok).
   */
  const runLogPath = process.env['RUN_LOG'];
  const runLog = (satir: string): void => {
    if (!runLogPath) return;
    try {
      appendFileSync(runLogPath, `${new Date().toISOString()} ${satir}
`);
    } catch {
      /* günlük yazılamıyorsa bot durmaz — teşhis aracı, bağımlılık değil */
    }
  };

  const log = (msg: string): void => {
    logs.push(`${new Date().toLocaleTimeString('tr-TR')} ${msg}`);
    if (logs.length > 50) logs.shift();
    if (!cfg.ui.enabled) console.log(msg);
    runLog(msg);
  };

  // Günlük yolunu BAŞLANGIÇTA doğrula ve yazdır.
  //
  // ÖLÇÜLEN HATA: yol `cmd`'nin `set RUN_LOG=... &&` biçiminden SONDA BOŞLUKLA
  // geldi; dosya o adla açıldı ve izleyen taraf boşluksuz adı beklediği için
  // "hiç yazılmıyor" sandı. Teşhis aracının kendisi sessizce yanlış yere
  // yazıyordu — bu botta en pahalı hata sınıfının aracın içinde tekrarı.
  if (runLogPath) {
    try {
      appendFileSync(runLogPath, '');
      log(`koşu günlüğü: "${runLogPath}"`);
    } catch (e) {
      log(`⚠ koşu günlüğü yazılamıyor ("${runLogPath}"): ${(e as Error).message}`);
    }
  }

  const venues: CexId[] = CEX_IDS.filter((v) => cfg.exchanges[v].enabled);
  if (venues.length < 2) {
    throw new Error('Arbitraj için en az iki borsa etkin olmalı (config/exchanges.json)');
  }

  // --- Sembol keşfi -------------------------------------------------------
  if (!cfg.ui.enabled) console.log('Sembol listeleri çekiliyor...');
  const registry = await SymbolRegistry.build({
    venues,
    quotesByVenue: Object.fromEntries(venues.map((v) => [v, cfg.exchanges[v].quotes])),
    minVenues: 2,
    excludeBases: EXCLUDED_BASES,
    // Kullanıcının "kesinlikle taransın" dediği coinler yukarıdaki üç elemeden
    // ve minVenues şartından muaf (bkz. config/izleme-listesi.json).
    zorunlu: cfg.izleme.kapsam,
    // Kraken'in USDT piyasası dar (1410 sembolün 1365'i USDT dışı quote'ta);
    // USDT çifti olmayan coinlerde USD çifti USDT yerine sayılır. Bedeli
    // USDT/USD bazı ve o bacağı taşıyan fırsat uyarı taşır (bkz. scanner).
    usdVekilBorsalari: ['kraken'],
  });

  for (const [venue, err] of registry.failedVenues) {
    log(`⚠ ${venue}: sembol listesi alınamadı — ${err}`);
  }
  if (registry.pairCount === 0) {
    throw new Error('Taranacak çift bulunamadı — borsa bağlantılarını kontrol et');
  }
  log(`kayıt defteri: ${registry.summary()}`);

  // Vekil eşleme SESSİZ kalmamalı: bu çiftlerin kârı USDT/USD bazını içeriyor
  // ve kullanıcı hangi coinlerin bu durumda olduğunu bilmeden sinyale bakamaz.
  const vekilli = [...registry.stats.usdVekilli.keys()].sort();
  if (vekilli.length > 0) {
    log(
      `USD→USDT vekili: ${vekilli.length} coin (kraken'de USDT çifti yok) — ` +
        `sinyalleri USDT/USD bazı uyarısı taşır`,
    );
    log(`  ${vekilli.slice(0, 25).join(' ')}${vekilli.length > 25 ? ` +${vekilli.length - 25}` : ''}`);
  }

  // --- Transfer bilgisi ---------------------------------------------------
  const transfers = new TransferInfoProvider({
    credentials: cfg.apiKeys,
    tradeSizeQuote: cfg.scan.tradeSizeQuote,
  });
  await transfers.refresh();
  if (transfers.lastRefreshError) {
    log(`⚠ transfer bilgisi kısmi: ${transfers.lastRefreshError}`);
  }
  // Anahtarı girilmiş ama çalışmayan borsayı ayrıca öne çıkar: kullanıcı bu
  // borsayı doğrulanmış sanıyor, oysa sinyalleri hâlâ "?" taşıyacak.
  for (const [venue, err] of transfers.credentialErrors) {
    log(`⚠ ${venue}: API anahtarı tanımlı ama transfer bilgisi alınamadı — ${err}`);
  }
  // Saat kayması büyükse imzalı istekler reddedilirdi; düzeltiyoruz ama
  // kullanıcının lokal saatinin bozuk olduğunu bilmesi gerekir.
  const skews = [...clockSkews().values()];
  if (skews.length > 0) {
    const worst = Math.max(...skews.map(Math.abs));
    if (worst > 1500) {
      log(
        `⚠ lokal saat borsa saatinden ~${(worst / 1000).toFixed(1)} sn sapmış — ` +
          `imzalı istekler için düzeltiliyor, ama sistem saatini senkronlaman önerilir`,
      );
    }
  }

  const unverified = transfers.unverifiedVenues;
  log(
    `transfer tablosu: ${transfers.coinsKnown} coin · doğrulanan borsalar: ` +
      `${transfers.verifiedVenues.join(', ')}` +
      (unverified.length > 0 ? ` · doğrulanamayan: ${unverified.join(', ')}` : ' · tamamı doğrulandı'),
  );
  // Tablo zamanla bayatlar (yeni listelemeler, kapanan ağlar).
  //
  // Yoklama aralığı tazeleme eşiğinden (DEFAULT_REFRESH_MS, 15 dk) KISA olmak
  // zorunda: ikisi eşit olduğunda yoklama eşiğin hemen öncesine denk gelirse
  // tazeleme bir tur daha ötelenir ve gerçek yaş iki katına çıkar.
  const transferTimer = setInterval(() => void transfers.refreshIfStale(), 5 * 60 * 1000);

  // --- Fiyat altyapısı ----------------------------------------------------
  // DEX venue'ları da PriceStore'a baştan dahil edilmeli: store sabit boyutlu
  // bir matris olduğu için sonradan sütun eklenemiyor.
  // Liste `DEX_IDS`'ten geliyor, elle yazılmıyor: matris sonradan
  // büyütülemediği için burada eksik kalan bir venue'nun slotu HİÇ olmaz ve
  // feed sessizce boş çalışır (`resolveSlot` −1 döner, token atlanır).
  const allVenues: VenueId[] = [...venues, ...DEX_IDS];

  const store = new PriceStore(registry.pairs, allVenues);
  const depth = new DepthCache();

  const feeds: Feed[] = [];
  for (const venue of venues) {
    const markets = registry.symbolsFor(venue);
    if (markets.length === 0) {
      // Sessiz atlama bu botun hata sınıfı: feed kurulmayınca panelde satırı
      // bile olmuyor. Sebep (liste hatası / hepsi elendi) başlangıçta görünsün.
      const sebep = registry.failedVenues.get(venue);
      log(`⚠ ${venue}: taranacak sembol yok, feed kurulmadı${sebep ? ` — ${sebep}` : ''}`);
      continue;
    }
    feeds.push(createFeed(venue, store, markets));
  }

  // --- DEX feed'leri ------------------------------------------------------
  const knownPairs = new Set(registry.pairs);
  const dexSetups = createDexFeeds(cfg, store, knownPairs);
  const activeDexVenues: DexId[] = [];
  for (const setup of dexSetups) {
    if (setup.feed) {
      feeds.push(setup.feed);
      activeDexVenues.push(setup.venue);
      log(`dex ${setup.venue}: ${setup.tokenCount} token`);
    } else {
      log(`dex ${setup.venue}: devre dışı — ${setup.skipReason}`);
    }
  }

  // --- Zorunlu izleme listesi --------------------------------------------
  // Muafiyet vermek yetmez: girdinin gerçekten işe yarayıp yaramadığı
  // görünmek zorunda. "Ekledim, izleniyordur" varsayımı bu botun en pahalı
  // hata sınıfının ta kendisi — çift oluşmazsa hiçbir yerde hata görünmez.
  if (cfg.izleme.girdiler.length > 0) {
    const dexPairler = new Set<PairKey>();
    for (const setup of dexSetups) {
      if (!setup.feed) continue;
      for (const { pair } of dexTokensFor(cfg, DEX_CHAIN[setup.venue], knownPairs)) {
        dexPairler.add(pair);
      }
    }

    const ozet = registry.zorunluOzet(dexPairler);
    const calisan = ozet.filter((s) => s.sonuc === 'taraniyor');
    log(`izleme listesi: ${ozet.length} girdi · ${calisan.length} taranıyor`);
    for (const s of ozet) {
      if (s.sonuc === 'taraniyor') log(`  ✓ ${s.sembol} ${s.aciklama}`);
      else log(`  ⚠ ${s.sembol}: ${s.aciklama}`);
    }
  }

  // Ağ tablosunun statik kısmı — kurulumda bir kez. Canlı durum render
  // sırasında feed sağlığından türetiliyor.
  const chainRows: ChainStatus[] = CHAIN_IDS.map((chain) => {
    const setups = dexSetups.filter((s) => DEX_CHAIN[s.venue] === chain);
    // Satır yalnızca KURULMUŞ venue'ları anlatmalı. Kurulmayan venue'yu
    // listelemek panelin en pahalı yalanı olurdu: `cow-base` failed iken satır
    // "aerodrome,uniswap-v3,cow" diyor ve TOKEN sütununa onun 79'unu da
    // ekliyordu — yani kapalı bir bacak, çalışan kapsam gibi görünüyordu.
    const aktif = setups.filter((s) => s.feed !== null);
    return {
      chain,
      enabled: cfg.chains[chain].enabled,
      rpcHost: rpcHost(cfg.chains[chain].rpcUrl),
      gasCostUsd: cfg.chains[chain].gasCostUsd,
      venues: aktif.map((s) => s.venue),
      tokenCount: aktif.reduce((n, s) => n + s.tokenCount, 0),
      skipReason:
        aktif.length > 0 ? null : (setups.find((s) => s.skipReason)?.skipReason ?? null),
    };
  });

  // --- Motor --------------------------------------------------------------
  // Tarayıcı yalnızca gerçekten veri akan venue'ları görmeli; devre dışı
  // kalan DEX'ler taramaya girip boş satır üretmesin.
  // DEX bacağı doğrulayıcısı: Solana geniş taraması orta fiyat verip miktarı
  // 0 bıraktığı için, gerçekleşecek miktarı ancak quote söyler. Bu bağlantı
  // olmadan her Solana bacağı "derinlik yok" diye eleniyordu.
  //
  // Venue BAŞINA ayrı doğrulayıcı: `jupiter` bacağını Jupiter'e, `raydium`
  // bacağını Raydium'a sormak zorundayız. Tek bir zincir doğrulayıcısı
  // kullanmak, Raydium'da ölçülen fiyatı Jupiter rotasıyla doğrulamak olurdu —
  // yani uygulanamayacak bir rotayı kâr hesabına sokmak.
  const solanaQuoters = new Map<DexId, DexLegQuoter>();
  const jupiterLeg = new JupiterLegQuoter(
    cfg.tokens,
    new DexQuoter({ apiKey: process.env['JUPITER_API_KEY'] ?? null, tier: cfg.jupiterTier }),
  );
  const raydiumLeg = new RaydiumLegQuoter(cfg.tokens, new RaydiumQuoter());
  if (jupiterLeg.ready) solanaQuoters.set('jupiter', jupiterLeg);
  if (raydiumLeg.ready) solanaQuoters.set('raydium', raydiumLeg);
  const legQuoter = new VenueLegQuoter(solanaQuoters);

  // Kurulmuş venue'nun doğrulayıcısı YOKSA bu sessiz bir felçtir: Aşama 1
  // fiyat yazmaya devam eder, panel "live" der, ama o venue'nun her bacağı
  // "derinlik yok" ile elenir. Bu yüzden ikisi de ayrı ayrı loglanıyor.
  for (const v of activeDexVenues) {
    if (DEX_CHAIN[v] !== 'solana') continue;
    log(
      solanaQuoters.has(v)
        ? `dex doğrulama: ${v} quote bağlı`
        : `⚠ ${v} doğrulaması kapalı — solana USDC girdisi tokens.json'da yok`,
    );
  }

  // --- DEX bacağının ikinci görüşü (CoW) ----------------------------------
  //
  // CoW venue OLARAK kapalı (bkz. DEVRE_DISI): geniş tarama kovasına sığmıyor.
  // Buradaki kullanımı farklı — istek turla değil SİNYALLE ölçekleniyor, yani
  // kapatma gerekçesi burada geçerli değil. Kazancı somut: Base'de rotayı biz
  // seçiyoruz (havuz, tier, kaç adım) ve ölçülmüş bozuk rotalar var; CoW
  // rotayı solver'a kurdurduğu için bizim seçimimizden bağımsız bir görüş.
  //
  // Zincir başına bir örnek: CoW'un quote yolu (`base`, `arbitrum_one`) ve
  // token tablosu zincire özgü. Liste `COW_CHAINS`'ten geliyor, elle
  // yazılmıyor — kopya bir dizi tutmak, yeni zincir eklendiğinde kontrolün
  // sessizce kapalı kalması demekti (bu botun `dexVenues` ile yaşadığı hata).
  const caprazKaynaklar = COW_CHAINS.filter((c) =>
    activeDexVenues.some((v) => DEX_CHAIN[v] === c),
  ).map((c) => ({ chain: c, kontrol: new CowCaprazKontrol(c, cfg.tokens, new HttpCowQuoter(c)) }));

  for (const { chain, kontrol } of caprazKaynaklar) {
    log(
      kontrol.ready
        ? `dex çapraz kontrol: ${chain} bacakları cow ile karşılaştırılacak`
        : `⚠ ${chain} çapraz kontrolü kapalı — ${chain} USDC girdisi tokens.json'da yok`,
    );
  }
  const capraz = new CaprazKontrolSeti(
    caprazKaynaklar.filter((k) => k.kontrol.ready).map((k) => k.kontrol),
  );

  const scanner = new Scanner(
    cfg,
    store,
    registry,
    depth,
    transfers,
    [...venues, ...activeDexVenues],
    {},
    solanaQuoters.size > 0 ? legQuoter : null,
    capraz.ready ? capraz : null,
  );
  const risk = new RiskManager({
    ...DEFAULT_LIMITS,
    // Pozisyon limitini taradığımız işlem büyüklüğüyle hizala, yoksa her
    // fırsat "sermaye limiti aşıldı" diye işaretlenir.
    maxPositionQuote: cfg.scan.tradeSizeQuote,
    maxDexSignalAgeMs: cfg.scan.maxDexPriceAgeMs,
    allowUnverified: cfg.scan.allowUnverifiedTransfer,
  });

  /**
   * Log ve disk kaydı için tekrar filtresi.
   *
   * Telegram kendi filtresini kullanıyor (farklı cooldown). Bu ayrı olan ise
   * kalibrasyon verisini korur: canlı testte tek bir coin 75 saniyede 210
   * özdeş kayıt üretip veri setini işe yaramaz hale getirmişti.
   */
  const recordGate = new Deduper({
    cooldownMs: 30_000,
    improveDeltaPct: 0.002,
  });
  // Executor arayüzü üzerinden tutuluyor: v2'de LiveExecutor'a geçmek için
  // burada tek satır değişecek, çağıran kod aynı kalacak.
  const executor: Executor = new NotifyOnlyExecutor();

  const persist = cfg.persist.enabled ? new NdjsonWriter(cfg.persist.dir) : null;
  persist?.start();

  let telegram: TelegramNotifier | null = null;
  if (cfg.telegram.enabled && cfg.telegram.token && cfg.telegram.chatIds.length > 0) {
    telegram = new TelegramNotifier({
      token: cfg.telegram.token,
      chatIds: cfg.telegram.chatIds,
      cooldownMs: cfg.telegram.cooldownMs,
      resendDeltaPct: cfg.telegram.resendDeltaPct,
    });
    const check = await telegram.verify();
    log(
      check.ok
        ? `telegram bağlı: ${check.detail} · ${cfg.telegram.chatIds.length} alıcı`
        : `⚠ telegram hatası: ${check.detail}`,
    );
    if (!check.ok) telegram = null;
  } else {
    log('telegram kapalı (.env içinde TELEGRAM_ENABLED=1 ile aç)');
  }

  // Sesli uyarı: ekrana bakılmadığında fırsatın kaçmasını önler.
  const sound = new SoundAlert({
    enabled: cfg.sound.enabled,
    cooldownMs: cfg.sound.cooldownMs,
    device: cfg.sound.device,
    volumePct: cfg.sound.volumePct,
  });
  log(
    cfg.sound.enabled
      ? `sesli uyarı açık (en sık ${(cfg.sound.cooldownMs / 1000).toFixed(0)} sn'de bir)`
      : 'sesli uyarı kapalı (.env → SOUND_ENABLED=1)',
  );
  // Cihaz eşleşmezse ses varsayılana düşmez, hiç çalmaz — bunu ilk fırsatta
  // değil başlangıçta görmek gerek.
  if (cfg.sound.enabled && cfg.sound.device !== null && process.platform === 'win32') {
    const hedef = cfg.sound.device;
    const cihazlar = await sesCihazlari();
    const bulunan = cihazlar.find((c) => c.toLowerCase().includes(hedef.toLowerCase()));
    log(
      bulunan
        ? `ses çıkışı: ${bulunan} (varsayılandan bağımsız)`
        : `UYARI: SOUND_DEVICE="${hedef}" hiçbir çıkışla eşleşmedi, ses ÇALMAYACAK — mevcut: ${cihazlar.join(' | ')}`,
    );
  }

  // Son fırsatlar — UI için, net kâra göre sıralı tutulur.
  const recent: Opportunity[] = [];

  scanner.onOpportunity((opp) => {
    const fresh = recordGate.shouldEmit(opp.id, opp.netPct);

    // Ses yalnızca YENİ (ya da belirgin iyileşmiş) fırsatta çalar: aynı fırsat
    // 50 ms'de bir yeniden üretilir, her tekrarda çalmak sesi bilgi taşımayan
    // bir uğultuya çevirirdi. Kendi cooldown'ı ayrıca farklı coinlerin aynı
    // anda eşiği geçtiği durumu sınırlıyor.
    // Eşik coin bazında ezilebilir (`config/coin-esikleri.json`) — tek bir
    // coinin kanalı boğmasını genel eşiği yükseltmeden kesmek için.
    const bildirimEsigiGecti =
      opp.netPct * 100 >= bildirimEsigi(opp.coin, cfg.coinBildirimEsikleri, YESIL_PCT);
    if (fresh && bildirimEsigiGecti) sound.alert();

    // Risk kararı v1'de UYGULANMAZ, yalnızca kaydedilir. Amaç, otomasyona
    // geçmeden önce limitlerin gerçek veriyle kalibre edilebilmesi.
    const verdict = risk.check(opp);
    if (!verdict.allowed && fresh) {
      log(`risk notu ${opp.coin}: ${verdict.reasons.join('; ')}`);
    }

    const buySymbol = registry.venuesFor(opp.buy.pair).get(opp.buy.venue as CexId) ?? opp.coin;
    const sellSymbol = registry.venuesFor(opp.sell.pair).get(opp.sell.venue as CexId) ?? opp.coin;
    void executor.execute(buildPlan(opp, buySymbol, sellSymbol), opp);

    // Diske yalnızca yeni/iyileşmiş kayıtlar gider — kalibrasyon veri setinin
    // aynı fırsatın kopyalarıyla dolmasını önler.
    if (fresh) persist?.write(opp);

    if (bildirimEsigiGecti && telegram?.notify(opp)) {
      log(`📤 ${opp.coin} %${(opp.netPct * 100).toFixed(2)} → telegram`);
    }

    // UI listesi: aynı fırsatın eski kaydını değiştir, sonra kâra göre sırala.
    const idx = recent.findIndex((o) => o.id === opp.id);
    if (idx >= 0) recent[idx] = opp;
    else recent.push(opp);
    recent.sort((a, b) => b.netPct - a.netPct);
    if (recent.length > 60) recent.length = 60;
  });

  // Bayatlayan fırsatları listeden düşür — ekranda ölü sinyal durmasın.
  const pruneTimer = setInterval(() => {
    const cutoff = Date.now() - 60_000;
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i]!.detectedAt < cutoff) recent.splice(i, 1);
    }
    recordGate.prune(30 * 60_000);
  }, 5000);

  // --- Başlat -------------------------------------------------------------
  log(`${feeds.length} feed başlatılıyor...`);
  await Promise.all(
    feeds.map((f) =>
      f.start().catch((e: Error) => log(`✗ ${f.venue} başlatılamadı: ${e.message}`)),
    ),
  );
  scanner.start();

  let renderer: Renderer | null = null;
  if (cfg.ui.enabled) {
    const state = (): RenderState => ({
      feeds: feeds.map((f) => f.health()),
      chains: chainRows,
      opportunities: recent,
      logs,
      scanner: scanner.stats,
      capraz: capraz.ready ? capraz.stats : null,
      telegram: telegram
        ? {
            sent: telegram.stats.sent,
            suppressed: telegram.stats.suppressed,
            failed: telegram.stats.failed,
            lastError: telegram.stats.lastError,
          }
        : null,
      pairCount: registry.pairCount,
      startedAt,
    });
    renderer = new Renderer(state, cfg.ui.refreshHz, cfg.ui.maxRows);
    renderer.start();
  }

  log(
    `tarama aktif · eşik %${(cfg.scan.minNetPct * 100).toFixed(2)} · ` +
      `işlem büyüklüğü ${cfg.scan.tradeSizeQuote} · ön-filtre %${(cfg.scan.prefilterPct * 100).toFixed(2)}`,
  );
  // Coin bazında ezilen bildirim eşikleri başlangıçta GÖRÜNMELİ — "ekledim,
  // artık susmuştur" varsayımını doğrulamanın tek yeri burası.
  if (cfg.coinBildirimEsikleri.size > 0) {
    log(
      `coin bildirim eşikleri (genel %${YESIL_PCT}): ` +
        [...cfg.coinBildirimEsikleri].map(([c, p]) => `${c} %${p}`).join(' · '),
    );
  }

  // Dakikada bir tek satırlık durum fotoğrafı. Sayaçlar KÜMÜLATİF: iki satırın
  // farkı o dakikada ne olduğunu verir, tek satır ise koşunun o ana kadarki
  // toplamını. Feed durumları yalnızca 'live' DEĞİLKEN yazılıyor — her dakika
  // 13 feed'in "live" olduğunu tekrarlamak günlüğü okunmaz yapardı ve tam da
  // görülmesi gereken satırı gizlerdi.
  const runLogTimer = runLogPath
    ? setInterval(() => {
        const s = scanner.stats;
        const c = capraz.ready ? capraz.stats : null;
        const bozuk = feeds
          .map((f) => f.health())
          .filter((h) => h.state !== 'live')
          .map((h) => `${h.venue}:${h.state}`);
        const dexNotlari = (): string => {
          const notlar = feeds
            .map((f) => f.health())
            .filter((h) => isDex(h.venue) && h.lastError)
            .map((h) => `${h.venue}: ${h.lastError!.slice(0, 120)}`);
          return notlar.length > 0 ? ` DEX_NOT[${notlar.join(' | ')}]` : '';
        };
        runLog(
          `DURUM tur=${s.evalCount} aday=${s.candidateCount} sinyal=${s.opportunityCount} ` +
            `netHesaplanan=${s.netHesaplanan} ` +
            `enIyiNet=${
              Number.isFinite(s.enIyiNetPct) ? `%${(s.enIyiNetPct * 100).toFixed(3)}` : 'yok'
            } ` +
            `kuyruk=${s.queueDepth} atılan=${s.droppedCount} ` +
            // Hafıza yüzünden kuyruğa ALINMAYAN (ertelenen) adaylar — eleme
            // değil; `elenen[transfer=]` düşüşünün sebebi burada görünür.
            `hafiza[transfer=${s.transferHafizasiAtlanan} karsiz=${s.karsizHafizaAtlanan}] ` +
            `elenen[derinlik=${s.rejectedByDepth} defterCekilemedi=${s.rejectedByDepthFetch} ` +
            `transfer=${s.rejectedByTransfer} ` +
            `adres=${s.rejectedByAddress} bayat=${s.rejectedByStale} ` +
            `makulDegil=${s.makulDegilAday} inceHavuz=${s.rejectedByImpact}/${s.inceHavuzOnceliksiz}] ` +
            `dexQuote[${s.dexQuoteOk}/${s.dexQuoteTried} hata=${s.dexQuoteError}] ` +
            `capraz[${c ? `${c.basarili}/${c.denendi} rotasiz=${c.rotasiz} hata=${c.hata}` : 'kapalı'}]` +
            // Hata SAYISI tek başına teşhis etmiyor: canlı koşuda `hata=117`
            // görüldü ve sebebi (Raydium WAF bloğu) ancak dışarıdan ayrı bir
            // ölçümle bulunabildi. Sayacın yanına mesajı da koymak o adımı
            // gereksiz kılıyor.
            (s.sonInceHavuz ? ` sonInceHavuz="${s.sonInceHavuz}"` : '') +
            (s.dexQuoteError > 0 && s.lastDexQuoteError
              ? ` sonDexHata="${s.lastDexQuoteError.slice(0, 90)}"`
              : '') +
            (telegram && telegram.stats.failed > 0
              ? ` TELEGRAM_HATA=${telegram.stats.failed}` +
                (telegram.stats.lastError ? ` "${telegram.stats.lastError.slice(0, 80)}"` : '')
              : '') +
            (bozuk.length > 0 ? ` FEED_SORUN=${bozuk.join(',')}` : '') +
            (s.rejectedByDepthFetch > 0 && s.lastDepthFetchError
              ? ` sonDefterHata="${s.lastDepthFetchError.slice(0, 60)}"`
              : '') +
            // DEX feed'leri 'live' iken de teşhis taşıyor (tur süresi bütçeyi
            // aşıyor, ince havuz…) — bunlar yalnızca panelde görünüyordu.
            dexNotlari() +
            // Hangi venue'nun okumaları bayat düşüyor — `bayat=` toplamının dökümü.
            ` bayatOran[${s.venueBayatOrani
              .filter((b) => b.toplam > 0)
              .map((b) => `${b.venue}=%${(b.oran * 100).toFixed(0)}`)
              .join(' ')}]`,
        );
        // Doğrulama bütçesini kimin yaktığı — "0 sinyal" teşhisinin ikinci
        // yarısı. Toplam sayı nereye gittiğini söylemiyor, bu döküm söylüyor.
        if (s.netKayit.length > 0) {
          runLog(
            `NET_DOKUM ${s.netKayit
              .map((k) => `${k.anahtar}×${k.adet}@%${(k.enIyi * 100).toFixed(2)}`)
              .join(' · ')}`,
          );
        }
      }, 60_000)
    : null;

  // --- Temiz kapanış ------------------------------------------------------
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    renderer?.stop();
    console.log(`\n${signal} alındı, kapatılıyor...`);

    clearInterval(transferTimer);
    clearInterval(pruneTimer);
    if (runLogTimer) clearInterval(runLogTimer);
    scanner.stop();
    await Promise.all(feeds.map((f) => f.stop()));
    // Son tamponun diske inmesi beklenir; `process.exit` bekleyen yazımı keser.
    await persist?.stop();

    const s = scanner.stats;
    console.log(
      `\nözet: ${s.evalCount} tarama turu · ${s.candidateCount} aday · ` +
        `${s.opportunityCount} fırsat` +
        (telegram ? ` · ${telegram.stats.sent} telegram mesajı` : ''),
    );
    runLog(
      `KAPANIŞ ${s.evalCount} tur · ${s.candidateCount} aday · ${s.opportunityCount} fırsat`,
    );
    if (persist) {
      console.log(`kayıtlar: ${cfg.persist.dir} (${persist.stats.written} satır)`);
      console.log('kalibrasyon için: npm run calibrate');
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e: Error) => {
  console.error(`\nBAŞLATMA HATASI: ${e.message}`);
  if (process.env['DEBUG']) console.error(e.stack);
  process.exit(1);
});
