/**
 * Terminal arayüzü — ham ANSI.
 *
 * Kütüphane kullanmama sebebi: `ink` React ve reconciler çeker (bir fiyat
 * tablosu için absürt), `blessed` bakımsız. İhtiyacımız olan şey ekranı
 * temizleyip birkaç satır basmak — bu ~150 satır.
 *
 * Kritik kural: RENDER ASLA FİYAT İŞLEMEYİ BLOKLAMAZ. Terminale yazmak
 * senkron ve yavaş bir I/O'dur; bu yüzden saniyede 4 kez, tek seferde ve
 * tek bir write çağrısıyla basıyoruz.
 */

import {
  isDex,
  type ChainId,
  type DexId,
  type FeedHealth,
  type Opportunity,
} from '../core/types.ts';
import { formatRow } from '../notify/format.ts';

const ESC = '\x1b[';
const CLEAR = `${ESC}2J${ESC}H`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;

const C = {
  reset: `${ESC}0m`,
  dim: `${ESC}2m`,
  bold: `${ESC}1m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  blue: `${ESC}34m`,
  cyan: `${ESC}36m`,
  gray: `${ESC}90m`,
};

/**
 * Bir zincirin tarama durumu. Statik kısmı (config + hangi DEX'in ayağa
 * kalktığı) kurulumda bir kez hesaplanır; canlı kısım (durum, tazelik) her
 * render'da `feeds` sağlığından türetilir — böylece renderer'ın ayrı bir
 * güncelleme yoluna ihtiyacı olmaz.
 */
export interface ChainStatus {
  readonly chain: ChainId;
  readonly enabled: boolean;
  /** Yalnızca host — RPC URL'inde API anahtarı olabilir, ekrana basmıyoruz. */
  readonly rpcHost: string | null;
  readonly gasCostUsd: number;
  /** Bu zincirde kurulumu denenen DEX'ler (devre dışı kalanlar dahil). */
  readonly venues: readonly DexId[];
  /** Gerçekten taranan token sayısı. */
  readonly tokenCount: number;
  /** Hiçbir DEX ayağa kalkmadıysa sebebi. */
  readonly skipReason: string | null;
}

export interface RenderState {
  readonly feeds: readonly FeedHealth[];
  readonly chains: readonly ChainStatus[];
  readonly opportunities: readonly Opportunity[];
  readonly logs: readonly string[];
  readonly scanner: {
    evalCount: number;
    candidateCount: number;
    opportunityCount: number;
    rejectedByDepth: number;
    rejectedByTransfer: number;
    makulDegilAday: number;
    rejectedByImpact: number;
    inceHavuzOnceliksiz: number;
    sonInceHavuz: string | null;
    rejectedByAddress: number;
    rejectedByStale: number;
    staleVenueSkips: number;
    persistentCount: number;
    droppedCount: number;
    lastEvalDurationUs: number;
    queueDepth: number;
    netHesaplanan: number;
    enIyiNetPct: number;
    dexQuoteTried: number;
    dexQuoteOk: number;
    dexQuoteEmpty: number;
    dexQuoteError: number;
    lastDexQuoteError: string | null;
  };
  /**
   * DEX bacağının ikinci kaynakla karşılaştırılması (CoW). `null` = kontrol
   * kurulmadı. Sıfırken de basılıyor: "hiç çağrılmadı" bir bulgudur — bu
   * projede kontrolün hiç çalışmaması, kontrolün başarısız olmasından daha
   * sık görülen hata sınıfı.
   */
  readonly capraz: {
    denendi: number;
    basarili: number;
    rotasiz: number;
    hata: number;
    sonHata: string | null;
  } | null;
  readonly telegram: { sent: number; suppressed: number; failed: number } | null;
  readonly pairCount: number;
  readonly startedAt: number;
}

export class Renderer {
  private timer: NodeJS.Timeout | null = null;
  private readonly maxRows: number;

  constructor(
    private readonly getState: () => RenderState,
    private readonly refreshHz = 4,
    maxRows = 15,
  ) {
    this.maxRows = maxRows;
  }

  start(): void {
    if (this.timer) return;
    process.stdout.write(HIDE_CURSOR);
    this.timer = setInterval(() => this.render(), 1000 / this.refreshHz);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    process.stdout.write(SHOW_CURSOR + '\n');
  }

  private render(): void {
    const s = this.getState();
    const width = Math.max(80, process.stdout.columns ?? 100);
    const out: string[] = [CLEAR];

    const uptime = Math.floor((Date.now() - s.startedAt) / 1000);
    out.push(
      `${C.bold}${C.cyan}arb-bot${C.reset} ${C.dim}│${C.reset} ` +
        `${s.pairCount} çift ${C.dim}│${C.reset} ` +
        `çalışma ${fmtDuration(uptime)} ${C.dim}│${C.reset} ` +
        `${C.dim}${new Date().toLocaleTimeString('tr-TR')}${C.reset}`,
    );
    out.push(C.gray + '─'.repeat(width) + C.reset);

    // --- Feed sağlığı -----------------------------------------------------
    out.push(
      `${C.bold}BORSA             DURUM         SEMBOL    MSG/S   GECİKME  SON TICK  YENİDEN${C.reset}`,
    );
    for (const h of s.feeds) {
      // DEX'ler push değil yoklama tabanlı (blok hızında güncelleniyor), bu
      // yüzden CEX'lerle aynı tazelik eşiğiyle ölçmek onları haksızca sarı
      // gösteriyor.
      const staleAfter = isDex(h.venue) ? 15_000 : 5_000;
      const col =
        h.state === 'live'
          ? h.lastTickAgeMs >= 0 && h.lastTickAgeMs < staleAfter
            ? C.green
            : C.yellow
          : C.red;
      const mark = h.state === 'live' ? '●' : h.state === 'reconnecting' ? '◐' : '○';
      out.push(
        col +
          // 18: en uzun venue adı ("uniswap-v3-base") + işaret + boşluk sığmalı.
          `${mark} ${h.venue}`.padEnd(18) +
          h.state.padEnd(14) +
          String(h.subscribedCount).padStart(6) +
          h.msgsPerSec.toFixed(0).padStart(9) +
          `${h.latencyP50.toFixed(0)}ms`.padStart(10) +
          (h.lastTickAgeMs < 0 ? '—' : `${h.lastTickAgeMs}ms`).padStart(10) +
          String(h.reconnects).padStart(9) +
          C.reset,
      );
    }

    // --- Ağ (zincir) sağlığı ----------------------------------------------
    // Borsa tablosu venue bazlıdır; burada aynı bilgiyi ZİNCİR bazında
    // topluyoruz, çünkü bir DEX'in sessiz kalmasının sebebi çoğu zaman
    // venue'ya değil zincire ait: RPC tanımsız, zincir kapalı, token yok.
    if (s.chains.length > 0) {
      const byVenue = new Map(s.feeds.map((h) => [h.venue, h]));
      const detailWidth = Math.max(12, width - 76);

      out.push('');
      out.push(
        C.bold +
          'AĞ'.padEnd(12) +
          'DURUM'.padEnd(14) +
          // 26: bir zincirde üç venue olabiliyor (base: aerodrome, uniswap-v3,
          // cow). Dar bırakmak satırı kaydırıp tüm tabloyu bozardı.
          'DEX'.padEnd(26) +
          'TOKEN'.padStart(6) +
          'SON QUOTE'.padStart(11) +
          'GAS$'.padStart(7) +
          '  AYRINTI' +
          C.reset,
      );

      for (const c of s.chains) {
        const healths = c.venues
          .map((v) => byVenue.get(v))
          .filter((h): h is FeedHealth => h !== undefined);
        const liveCount = healths.filter((h) => h.state === 'live').length;
        const ages = healths.map((h) => h.lastTickAgeMs).filter((a) => a >= 0);
        const age = ages.length > 0 ? Math.min(...ages) : -1;

        let label: string;
        let col: string;
        let mark: string;
        if (!c.enabled) {
          [label, col, mark] = ['kapalı', C.gray, '○'];
        } else if (!c.rpcHost) {
          [label, col, mark] = ['RPC yok', C.yellow, '○'];
        } else if (healths.length === 0) {
          [label, col, mark] = ['devre dışı', C.gray, '○'];
        } else if (liveCount === healths.length) {
          // DEX'ler yoklama tabanlı: tazelik eşiği borsa tablosundakiyle aynı
          // sebeple 15 sn (blok hızı, WebSocket tick hızı değil).
          [label, col, mark] = ['live', age >= 0 && age < 15_000 ? C.green : C.yellow, '●'];
        } else if (liveCount > 0) {
          [label, col, mark] = ['kısmi', C.yellow, '◐'];
        } else {
          [label, col, mark] = [healths[0]!.state, C.red, '○'];
        }

        // Ayrıntı sütununun önceliği: TEŞHİS > RPC host > kurulum sebebi.
        //
        // Feed'in `lastError`'ı uzun süre hiçbir yerde basılmıyordu: panel
        // "failed" diyor ama NEDEN failed olduğunu yalnızca kod okuyan biri
        // bilebiliyordu. Oysa sebep ("havuz yok" mu, "RPC" mi) doğrudan ne
        // yapılacağını söylüyor. Feed live iken de basılıyor, çünkü kısmi
        // başarı ("rota yok: MAGIC") tam da gizlenmemesi gereken bilgi.
        //
        // ARIZALI venue önce gelir. Ölçüldü: Base'de `cow-base` failed iken
        // satırda aerodrome'un "havuz yok: MOVR,GLMR,…" mesajı görünüyordu —
        // yani zincir "kısmi" derken hangi bacağın öldüğü hiçbir yerde
        // yazmıyordu. Kısmi başarı mesajı, tam arızayı gölgelememeli.
        //
        // Ama TEK teşhis basmak da yetmiyor ve bunun bedeli ölçüldü: Base'de
        // `cow-base` 10 dakika boyunca failed kaldığı için sütunu kalıcı
        // olarak işgal etti ve aynı anda aerodrome + uniswap-v3-base turları
        // 60–74 sn'ye çıkarken (bütçe 30 sn) o uyarı HİÇ görünmedi. Yani
        // ölü bir venue, canlı venue'ların teşhisini gizliyordu. Artık
        // hepsi basılıyor — arızalılar önce, her biri venue adıyla.
        const teshisler = [
          ...healths.filter((h) => h.state !== 'live' && h.lastError),
          ...healths.filter((h) => h.state === 'live' && h.lastError),
        ].map((h) =>
          // Zincir soneki satırda zaten belli ("uniswap-v3-base" → "uniswap-v3");
          // tek venue'lu zincirde ad tamamen gereksiz.
          healths.length > 1
            ? `${h.venue.replace(`-${c.chain}`, '')}: ${h.lastError!}`
            : h.lastError!,
        );
        const teshis = teshisler.length > 0 ? teshisler.join(' · ') : null;
        const detail =
          teshis ?? (healths.length > 0 ? c.rpcHost : (c.skipReason ?? c.rpcHost)) ?? '—';

        out.push(
          col +
            `${mark} ${c.chain}`.padEnd(12) +
            label.padEnd(14) +
            // Zincir soneki burada gereksiz: satırın kendisi zaten o zincir.
            // ("uniswap-v3-base" → "uniswap-v3")
            (c.venues.length > 0
              ? c.venues.map((v) => v.replace(`-${c.chain}`, '')).join(',')
              : '—'
            ).padEnd(26) +
            String(c.tokenCount).padStart(6) +
            (age < 0 ? '—' : `${age}ms`).padStart(11) +
            c.gasCostUsd.toFixed(2).padStart(7) +
            C.reset +
            // Kırpma GÖRÜNÜR olmalı: birden çok venue'nun teşhisi yan yana
            // dizildiği için sessiz kesme, okuyanın son venue'yu hiç
            // görmediğini fark etmemesi demek.
            `  ${C.dim}${
              detail.length > detailWidth ? `${detail.slice(0, detailWidth - 1)}…` : detail
            }${C.reset}`,
        );
      }
    }

    // --- Tarayıcı istatistikleri -----------------------------------------
    out.push('');
    const sc = s.scanner;
    // İki ayrı sayı, çünkü iki ayrı soruya cevap veriyorlar:
    //   sinyal = toplam YAYIN sayısı. Açık kalan bir fırsat 50ms'de bir yeniden
    //           üretildiği için bu sayı hızla artar; motorun ne kadar iş yaptığını
    //           gösterir, kaç farklı fırsat bulunduğunu değil.
    //   aktif  = aşağıdaki tabloda duran, id'ye göre tekil fırsat sayısı.
    // Tek sayı göstermek yanıltıcıydı: "sinyal 252" görüp tabloda 2 satır bulan
    // kullanıcı haklı olarak bir şeyin kaybolduğunu sanıyordu.
    out.push(
      `${C.dim}tarama: ${sc.evalCount} tur ${C.reset}${C.dim}│ aday ${sc.candidateCount} ` +
        `│ sinyal ${C.reset}${C.bold}${sc.opportunityCount}${C.reset}${C.dim} ` +
        `│ aktif ${C.reset}${C.bold}${s.opportunities.length}${C.reset}${C.dim} ` +
        `│ elenen: derinlik ${sc.rejectedByDepth} transfer ${sc.rejectedByTransfer} ` +
        // Ham farkı makul olmayan aday KUYRUĞA HİÇ ALINMIYOR — ölçüldü ki
        // doğrulama bütçesinin tamamını bunlar yiyordu. Sessiz eleme bu botta
        // eleme yapmamaktan tehlikeli, o yüzden sayaç panelde.
        (sc.makulDegilAday > 0 ? `makul değil ${sc.makulDegilAday} ` : '') +
        // İnce havuz "rota yok"tan ayrı basılıyor: ilki havuzun işlem
        // büyüklüğünü taşımaması, ikincisi hiç havuz olmaması. Aynı kovaya
        // konsalar, token silmeye yönelten yanlış teşhis üretirdi.
        (sc.rejectedByImpact > 0 ? `ince havuz ${sc.rejectedByImpact} ` : '') +
        // Kimlik çakışması yalnızca gerçekleştiğinde yazılıyor: sıfır olması
        // normal durumdur ve her satırda "kimlik 0" göstermek diğer sayaçları
        // gözden kaçırılır hale getirirdi. Sıfırdan büyükse ayrı renkte,
        // çünkü bu "ayarı gözden geçir" değil "borsalar aynı ticker'ı farklı
        // token'a veriyor" demektir.
        (sc.rejectedByAddress > 0
          ? `${C.reset}${C.yellow}kimlik ${sc.rejectedByAddress}${C.reset}${C.dim} `
          : '') +
        `bayat ${sc.rejectedByStale}` +
        // Atlanan okuma sayısı elenen çift sayısından bağımsız: bir borsa
        // bayatlarken diğeri tazeyse çift elenmez ama okuma yine atlanır.
        // İkisini birlikte göstermek feed sağlığını görünür kılıyor.
        (sc.staleVenueSkips > 0 ? `${C.dim}(${sc.staleVenueSkips} okuma)${C.reset}${C.dim}` : '') +
        ` │ tur süresi ${sc.lastEvalDurationUs.toFixed(0)}µs` +
        (sc.queueDepth > 0 ? ` │ kuyruk ${sc.queueDepth}` : '') +
        // ATILAN aday, elenen adayla aynı şey DEĞİL: elenen doğrulandı ve
        // kârsız çıktı, atılan hiç doğrulanmadı. Sayaç `droppedCount` olarak
        // toplanıyordu ama hiçbir yerde basılmıyordu — yani kuyruk taşarken
        // "acaba kaçırdık mı?" sorusunun cevabı panelde yoktu. Kuyruk tavana
        // yapıştığında sayı hızla büyür ve ön filtrenin doğrulama
        // kapasitesinin üstünde aday ürettiğinin tek ölçüsüdür.
        (sc.droppedCount > 0
          ? `${C.reset}${C.yellow} │ atılan ${sc.droppedCount}${C.reset}`
          : '') +
        // "0 sinyal" tek başına eşiğin az mı çok mu altında kaldığımızı
        // söylemiyor. Kâr hesabına ulaşan aday sayısı ve görülen en iyi net
        // oran, eşiği körlemesine ayarlamayı bitiriyor.
        `${C.dim} │ net hesaplanan ${sc.netHesaplanan}${C.reset}` +
        (Number.isFinite(sc.enIyiNetPct)
          ? `${C.dim} │ en iyi net %${(sc.enIyiNetPct * 100).toFixed(2)}${C.reset}`
          : '') +
        C.reset,
    );
    if (s.capraz) {
      const x = s.capraz;
      out.push(
        x.denendi === 0
          ? `${C.yellow}çapraz kontrol: hiç çağrılmadı — base DEX bacağı ikinci kaynakla ` +
              `karşılaştırılmıyor${C.reset}`
          : `${C.dim}çapraz kontrol (cow): ${x.denendi} denendi │ ` +
              `${C.reset}${C.bold}${x.basarili}${C.reset}${C.dim} karşılaştırıldı │ ` +
              `${x.rotasiz} rota yok${C.reset}` +
              (x.hata > 0
                ? ` ${C.red}│ ${x.hata} hata` +
                  (x.sonHata ? ` (${x.sonHata.slice(0, 40)})` : '') +
                  C.reset
                : ''),
      );
    }
    // DEX quote hattı ayrı satırda ve zincir yapılandırıldığı sürece SIFIRKEN
    // de basılıyor. Sebebi tarihsel: `DexQuoter` hiç çağrılmadığı halde panel
    // sapasağlam görünüyordu, çünkü elenen bacak "derinlik" kovasına düşüyordu.
    // Sessizliğin kendisi görünür olmalı — "hiç çağrılmadı" bir bulgudur.
    if (s.chains.length > 0) {
      const d = s.scanner;
      if (d.dexQuoteTried === 0) {
        out.push(
          `${C.yellow}dex quote: hiç çağrılmadı — CEX↔DEX fırsatı üretilemez${C.reset}`,
        );
      } else {
        const oran = (d.dexQuoteOk / d.dexQuoteTried) * 100;
        out.push(
          `${C.dim}dex quote: ${d.dexQuoteTried} denendi │ ` +
            `${C.reset}${C.bold}${d.dexQuoteOk}${C.reset}${C.dim} başarılı (%${oran.toFixed(0)}) │ ` +
            `${d.dexQuoteEmpty} rota yok${C.reset}` +
            // Hata sayısı sıfırdan büyükse boru hattı bozuk demektir; "rota
            // yok"tan farklı olarak bu düzeltilebilir bir arızadır, bu yüzden
            // ayrı renkte ve son hata mesajıyla birlikte.
            (d.dexQuoteError > 0
              ? ` ${C.red}│ ${d.dexQuoteError} hata` +
                (d.lastDexQuoteError ? ` (${d.lastDexQuoteError.slice(0, 40)})` : '') +
                C.reset
              : ''),
        );
      }
    }
    if (s.telegram) {
      out.push(
        `${C.dim}telegram: ${s.telegram.sent} gönderildi │ ` +
          `${s.telegram.suppressed} bastırıldı (dedup) │ ` +
          `${s.telegram.failed} başarısız${C.reset}`,
      );
    }

    // --- Fırsatlar --------------------------------------------------------
    out.push('');
    out.push(C.gray + '─'.repeat(width) + C.reset);
    out.push(
      `${C.bold} COIN            NET%    KÂR    ROTA              ZİNCİR      YAŞ${C.reset}`,
    );

    if (s.opportunities.length === 0) {
      out.push(`${C.dim} (eşiği geçen fırsat yok — bekleniyor)${C.reset}`);
    } else {
      const rows = s.opportunities.slice(0, this.maxRows);
      for (const o of rows) {
        const pct = o.netPct * 100;
        const col = pct >= 3 ? C.red : pct >= 1 ? C.yellow : C.green;
        out.push(col + formatRow(o, width) + C.reset);
      }
    }

    // --- Log --------------------------------------------------------------
    if (s.logs.length > 0) {
      out.push('');
      out.push(C.gray + '─'.repeat(width) + C.reset);
      for (const l of s.logs.slice(-5)) {
        out.push(`${C.dim}${l.slice(0, width)}${C.reset}`);
      }
    }

    out.push('');
    out.push(`${C.dim}? = çekim durumu doğrulanmadı   ·   Ctrl+C ile çık${C.reset}`);

    // Tek write: ekranın parça parça çizilmesini (flicker) önler.
    process.stdout.write(out.join('\n'));
  }
}

function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}s ${m}dk`;
  if (m > 0) return `${m}dk ${s}sn`;
  return `${s}sn`;
}
