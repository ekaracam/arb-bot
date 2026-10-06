/**
 * Solana geniş tarama feed'i — venue BAŞINA bir örnek.
 *
 * DEX'lerde WebSocket push yok, o yüzden burası pull tabanlı. Sınıf tek bir
 * venue'ya bağlı DEĞİL: `jupiter` (toplayıcı) ve `raydium` (tek AMM) aynı
 * kodu, farklı `SolanaPriceSource` ile kullanıyor. Ayrı ayrı yazılsalardı
 * periyot türetme, bayatlık ve sağlık raporlaması iki yerde yaşar ve biri
 * güncellenip diğeri unutulurdu.
 *
 * Kaynak ne olursa olsun buradan çıkan fiyat bir ORTA fiyattır: bid=ask
 * yazılır ve MİKTARLAR 0 BIRAKILIR. Tarayıcı bunu "L1 derinliği yok, doğrula"
 * olarak okuyup Aşama 2'ye gider — yani geniş taramanın fiyatı hiçbir zaman
 * kâr hesabına girmez. Venue'ya göre doğrulayıcı seçimi
 * [leg-quoter.ts](leg-quoter.ts) içinde.
 */

import type { PriceStore } from '../../book/price-store.ts';
import type {
  ChainId,
  DexId,
  Feed,
  FeedHealth,
  FeedState,
  PairKey,
} from '../../core/types.ts';
import { RateCounter } from '../../core/metrics.ts';
import {
  guvenliAralik,
  periyotButceUyarisi,
  type SolanaPriceSource,
} from './solana-price.ts';

/**
 * Referanstan azami sapma — ÖLÇÜLEREK seçildi, tahmin değil.
 *
 * 108 mint'te Raydium `mint/price` ile Jupiter `price/v3` karşılaştırıldı:
 *
 *   <%5: 98 token · %5–10: 1 · **%10–25: 0** · >%25: 9
 *
 * Sağlıklı küme ile bozuk küme arasında %6–%26 bandı BOŞ, yani eşik seçimi
 * keyfi değil: bu bandın içindeki her değer bugün aynı sonucu verir. Ortası
 * seçildi; %25 çok yakın olurdu, çünkü bozuk kümenin en alt üyesi %26.0
 * (MET) ve ölçüm gürültüsüyle eşiğin altına düşebilirdi.
 *
 * Elenen 9 token, kuyruğu kirlettiği ölçülen tokenların ta kendisi:
 * FIGHT %2630, GORK %547, W %255, ARX, ANTFUN, WLFI, LAYER, BNSOL, MET.
 */
const MAX_REFERANS_SAPMASI = 0.20;

export interface SolanaFeedOptions {
  readonly venue: DexId;
  /** Aşama 1'in fiyat kaynağı — venue'yu belirleyen şey budur. */
  readonly priceSource: SolanaPriceSource;
  /** Geniş tarama periyodu (ms). Kaynağın limiti gerektirirse uzatılır. */
  readonly pollIntervalMs?: number;
  /**
   * Fiyatın karşılaştırılacağı REFERANS venue (aynı zincirde).
   *
   * Tek havuzun orta fiyatını yazan bir kaynak (Raydium `mint/price`) bozuk
   * fiyat üretebiliyor; toplayıcı (Jupiter) rotayı tüm havuzlardan kurduğu
   * için aynı hataya düşmüyor. Referans verilmezse kontrol yapılmaz —
   * Jupiter'in kendisi referans olmadan çalışır.
   */
  readonly referansVenue?: DexId;
  /** Referanstan bu orandan çok sapan fiyat store'a YAZILMAZ (0.20 = %20). */
  readonly maxReferansSapmasi?: number;
  /** Referans fiyatın azami yaşı (ms) — bayat referansla karar verilmez. */
  readonly maxReferansYasiMs?: number;
  /**
   * DEX bayatlık bütçesi (`MAX_DEX_PRICE_AGE_MS`). Türetilen tarama periyodu
   * bunu aşarsa kurulumda yapısal uyarı basılır. Verilmezse 30 sn (config
   * varsayılanı).
   */
  readonly maxPriceAgeMs?: number;
}

export interface SolanaToken {
  readonly symbol: string;
  readonly mint: string;
  readonly decimals: number;
  readonly pair: PairKey;
  /** PriceStore satırı. */
  readonly slot: number;
}

export interface JupiterOptions {
  readonly apiKey?: string | null;
  /** Geniş tarama periyodu (ms). Kaynağın limiti gerektirirse uzatılır. */
  readonly pollIntervalMs?: number;
  /**
   * Aşama 1'in fiyat kaynağı. Verilmezse Jupiter kullanılır.
   * Aşama 2 (DexQuoter) HER ZAMAN Jupiter'dir — bkz. solana-price.ts.
   */
  readonly priceSource?: SolanaPriceSource;
}

/** Art arda bu kadar kötü tur sonra durum `failed` olur (EVM/CoW ile aynı). */
const KOTU_TUR_TOLERANSI = 3;

export class SolanaMidFeed implements Feed {
  readonly venue: DexId;
  readonly chain: ChainId = 'solana';

  private timer: NodeJS.Timeout | null = null;
  private state: FeedState = 'idle';
  private lastTickTs = 0;
  private lastError: string | null = null;
  private errorCount = 0;
  private readonly rate = new RateCounter();

  private readonly source: SolanaPriceSource;
  /** token indeksi → referans venue'daki slot (-1 = referans yok). */
  private readonly referansSlot: Int32Array;
  private readonly sapmaEsigi: number;
  private readonly referansMaxYas: number;

  constructor(
    private readonly store: PriceStore,
    private readonly tokens: readonly SolanaToken[],
    private readonly opts: SolanaFeedOptions,
  ) {
    this.venue = opts.venue;
    this.source = opts.priceSource;
    this.sapmaEsigi = opts.maxReferansSapmasi ?? MAX_REFERANS_SAPMASI;
    this.referansMaxYas = opts.maxReferansYasiMs ?? 30_000;

    // Slotlar KURULUMDA çözülüyor: tick yolunda Map araması ya da string
    // birleştirme yapılmaz (hot path kuralı). `resolveSlot` her (çift, venue)
    // için sabit bir indeks döndürüyor, matris tam ayrıldığı için sonradan
    // değişmez.
    this.referansSlot = new Int32Array(tokens.length).fill(-1);
    if (opts.referansVenue) {
      for (let i = 0; i < tokens.length; i++) {
        this.referansSlot[i] = store.resolveSlot(tokens[i]!.pair, opts.referansVenue);
      }
    }
  }

  /** Aşama 1'i besleyen kaynağın adı — sağlık panelinde gösterilir. */
  get priceSourceName(): string {
    return this.source.ad;
  }

  async start(): Promise<void> {
    if (this.tokens.length === 0) {
      this.state = 'idle';
      this.lastError = 'taranacak Solana token yok (config/tokens.json)';
      return;
    }

    this.state = 'connecting';
    await this.poll();

    // Periyot kaynağın limitinden TÜRETİLİYOR, sabit değil: token listesi
    // büyüdükçe tur başına istek sayısı artıyor ve sabit periyot sessizce 429
    // yemeye başlıyor (feed açık kalır, fiyat bayatlar, panel "live" der).
    // DEX fiyatları blok hızında (~400 ms) değişse de daha sık çekmenin
    // pratik faydası sınırlı, o yüzden taban 5 sn.
    const chunks = Math.ceil(this.tokens.length / this.source.chunkSize);
    const interval = guvenliAralik(
      chunks,
      this.source.perMinute,
      this.opts.pollIntervalMs ?? 5000,
      this.source.taramaPayi,
    );
    this.timer = setInterval(() => void this.poll(), interval);

    // Periyot bayatlık bütçesini aşarsa her fiyat yazıldığı anda bayattır ve
    // venue yapısal olarak taranamaz — panel "live" derken. Jupiter anahtarsız
    // (30/dk, pay 0.35) 134 token'da ~23 sn: bütçenin (30 sn) içinde ama dar.
    this.periyotUyarisi = periyotButceUyarisi(interval, this.opts.maxPriceAgeMs ?? 30_000);
  }

  /** Kurulumda saptanan yapısal sorun — her turda teşhisin başına eklenir. */
  private periyotUyarisi: string | null = null;

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.state = 'idle';
  }

  /** Bir tur uçuştayken yenisi başlamasın (EVM/CoW feed'leriyle aynı kural). */
  private polling = false;
  /** Art arda kötü tur sayısı — tek hıçkırık paneli kızartmamalı. */
  private badStreak = 0;

  private async poll(): Promise<void> {
    // Jupiter'de bir tur 4 parça × (8 sn timeout × 2 deneme) sürebiliyor ve
    // 11.4 sn'lik periyodu aşıyor. Koruma yokken turlar üst üste biniyor,
    // yavaş gelen ESKİ tur yeni fiyatın üstüne TAZE zaman damgasıyla
    // yazıyordu (ölçüldü: maxInflight 2, son yazılan ask eski turun değeri).
    // Üstüne binen turlar Aşama 2 ile aynı kovada yarışıp doğrulamayı da aç
    // bırakıyordu — `taramaPayi` gerekçesinin tam tersi.
    if (this.polling) return;
    this.polling = true;
    try {
      const fiyatlar = await this.source.fetchPrices(this.tokens.map((t) => t.mint));

      const now = Date.now();
      let written = 0;
      let sapmaElenen = 0;
      const elenenler: string[] = [];

      for (let i = 0; i < this.tokens.length; i++) {
        const t = this.tokens[i]!;
        const price = fiyatlar.get(t.mint);
        if (!price || !(price > 0)) continue;

        // REFERANS KONTROLÜ.
        //
        // Karar yalnızca TAZE bir referans varken veriliyor. Referans yoksa ya
        // da bayatsa fiyat YAZILIR: kontrolü zorunlu kılmak, referans venue'su
        // düştüğünde bu venue'yu de sessizce susturur — yani bir arıza iki
        // venue'yu birden öldürür. "Bilinmiyor" burada "kötü" demek değil.
        const rSlot = this.referansSlot[i]!;
        if (rSlot >= 0 && now - this.store.recvTs(rSlot) <= this.referansMaxYas) {
          const referans = this.store.ask(rSlot);
          if (referans > 0 && Math.abs(price - referans) / referans > this.sapmaEsigi) {
            sapmaElenen++;
            if (elenenler.length < 6) elenenler.push(t.symbol);
            continue;
          }
        }

        // Geniş tarama tek fiyat verir: bid=ask. Gerçek alım/satım farkı
        // yalnızca quote çağrısıyla öğrenilir, bu yüzden buradaki miktarları
        // 0 bırakıyoruz — tarayıcı bunu "L1 derinliği yok, doğrula" olarak
        // okuyup DexQuoter'a gidiyor.
        this.store.write(t.slot, price, 0, price, 0, now, now);
        written++;
      }

      this.rate.tick(now);
      this.lastTickTs = now;
      if (written > 0) {
        this.state = 'live';
        this.badStreak = 0;
      } else if (++this.badStreak >= KOTU_TUR_TOLERANSI) {
        this.state = 'failed';
      }
      // Sıra ÖNEMLİ: eleme sebebi, "kaynak fiyat vermedi" sebebinden ÖNCE
      // kontrol edilir. Ters sırada, tüm tokenlar filtreye takıldığında panel
      // "kaynak hiçbir fiyat döndürmedi" diyordu — oysa kaynak döndürdü, biz
      // eledik. Bu, botun tekrar eden hata sınıfının (veri ile arızayı
      // karıştırmak) teşhis metnindeki karşılığı olurdu.
      if (sapmaElenen > 0) {
        this.lastError =
          `${sapmaElenen} token referanstan >%${(this.sapmaEsigi * 100).toFixed(0)} saptığı ` +
          `için yazılmadı (${elenenler.join(', ')}${sapmaElenen > elenenler.length ? '…' : ''})` +
          (written === 0 ? ' — bu turda hiç fiyat yazılmadı' : '');
      } else if (written === 0) {
        this.lastError = `${this.source.ad}: hiçbir token için fiyat döndürmedi`;
      } else {
        this.lastError = null;
      }
    } catch (e) {
      this.errorCount++;
      this.lastError = (e as Error).message;
      // Tek bir hatalı tur feed'i öldürmez; ama bir kez `live` olan feed'in
      // sonsuza kadar `live` kalması da yanlıştı — `price/v3` sürekli patlasa
      // bile panel "live" diyordu. EVM/CoW ile aynı tolerans.
      if (++this.badStreak >= KOTU_TUR_TOLERANSI) this.state = 'failed';
    } finally {
      this.polling = false;
    }
  }

  health(): FeedHealth {
    const now = Date.now();
    return {
      venue: this.venue,
      state: this.state,
      lastTickAgeMs: this.lastTickTs === 0 ? -1 : now - this.lastTickTs,
      msgsPerSec: this.rate.perSec(now),
      reconnects: this.errorCount,
      latencyP50: 0,
      latencyP99: 0,
      clockSkewMs: 0,
      subscribedCount: this.tokens.length,
      // Yapısal uyarı tur teşhisinin ÖNÜNE geçer (CowFeed ile aynı kural).
      lastError:
        this.periyotUyarisi !== null
          ? `${this.periyotUyarisi}${this.lastError ? ` · ${this.lastError}` : ''}`
          : this.lastError,
    };
  }
}
