/**
 * DEX bacağının İKİNCİ bir kaynakla çapraz kontrolü.
 *
 * NEDEN VAR: Base'de fiyatı biz kendimiz kuruyoruz — Aerodrome ya da Uniswap
 * V3 quoter'ına belirli bir rotayı (doğrudan USDC ya da WETH üzerinden 2
 * adım) soruyoruz. Rota SEÇİMİ bize ait olduğu için hata da bize ait: ince bir
 * havuz, yanlış tier, ya da bozuk bir fee seviyesi "başarılı quote" olarak
 * döner ve sinyal üretir. Ölçülmüş örnekler var — Aerodrome'un doğrudan USDC
 * havuzunda DEGEN %158, ZEN %455, BRETT %3389 gidiş-dönüş spread'i veriyordu.
 *
 * CoW bir AMM değil, niyet tabanlı bir açık artırma: rotayı SOLVER kuruyor ve
 * dönen sayı ücretler dahil GERÇEKLEŞECEK miktar. Yani bizim rota seçimimizden
 * tamamen bağımsız bir ikinci görüş, ve ölçüldü ki bozuk havuzları
 * yakalıyor (aynı tokenlar: DEGEN %1.12, ZEN %0.45, BRETT %0.76).
 *
 * NEDEN VENUE DEĞİL: CoW geniş tarama kaynağı olarak kullanılamıyor — kova
 * 2/sn ve 75 token × 2 bacak bir turu ~94 sn'ye çıkarıyor, oysa DEX bayatlık
 * bütçesi 30 sn (bkz. `DEVRE_DISI`). Burada ise istek TUR başına değil SİNYAL
 * başına atılıyor: yalnızca `MIN_NET_PCT` eşiğini geçmiş, yayınlanmak üzere
 * olan bir fırsat için. Mimarinin "ucuz geniş tarama → pahalı hedefli
 * doğrulama" deseninin aynısı.
 *
 * ELEME DEĞİL UYARI. İki kaynağın ayrışması "fırsat sahte" demek değil, "bu
 * iki rotadan biri yanlış" demek; hangisinin yanlış olduğunu söyleyecek üçüncü
 * bir dayanak yok. Sinyal yayınlanır, sapma sinyalin üstünde yazar.
 */

import type { DexId, ChainId } from '../../core/types.ts';
import type { TokenEntry } from '../../core/config.ts';
import { DEX_CHAIN } from '../../core/types.ts';
import type { CowQuoter } from './cow.ts';

export interface CaprazSonuc {
  readonly kaynak: string;
  /** İkinci kaynağın verdiği çıktı miktarı (bizimkiyle aynı birimde). */
  readonly miktar: number;
  /**
   * Bizim miktarımızın ikinci kaynağa göre sapması. Pozitif = BİZ İYİMSERİZ.
   * 0.01 = %1.
   */
  readonly sapmaPct: number;
}

export interface CaprazIstatistik {
  readonly denendi: number;
  readonly basarili: number;
  readonly rotasiz: number;
  readonly hata: number;
  readonly sonHata: string | null;
}

export interface CaprazKontrol {
  /** Bu venue için ikinci görüş alınabilir mi? */
  destekler(venue: DexId): boolean;
  /**
   * @param yon    'buy' → `girdi` quote tutarı, `bizimCikti` alınan base
   *               'sell' → `girdi` base miktarı, `bizimCikti` elde edilen quote
   * @returns ikinci kaynağın sonucu; rota yoksa null
   */
  kontrol(
    venue: DexId,
    symbol: string,
    yon: 'buy' | 'sell',
    girdi: number,
    bizimCikti: number,
  ): Promise<CaprazSonuc | null>;
}

/** Sayaç yayınlayan çapraz kontrol — panel ve birleştirme bunu ister. */
export interface CaprazKaynak extends CaprazKontrol {
  readonly ready: boolean;
  readonly stats: CaprazIstatistik;
}

const QUOTE_SYMBOL = 'USDC';

/** Önbellek TTL'i — aynı fırsat `VERIFY_COOLDOWN_MS` ile tekrar tekrar gelir. */
const TTL_MS = 15_000;

/**
 * Önbelleğin yeniden kullanılabileceği girdi bandı.
 *
 * Satış bacağının miktarı fırsattan fırsata biraz oynuyor; her oynamada yeni
 * istek atmak, CoW'un dar kovasını sinyal tekrarlarına harcamak olurdu.
 * Saklanan şey miktar değil ORAN (çıktı/girdi) — bu bantta kayma etkisi
 * ihmal edilebilir.
 */
const BANT = 0.05;

export class CowCaprazKontrol implements CaprazKaynak {
  private readonly bySymbol = new Map<string, TokenEntry>();
  private readonly quoteToken: TokenEntry | undefined;
  private readonly cache = new Map<string, { at: number; girdi: number; oran: number | null }>();

  private denendi = 0;
  private basarili = 0;
  private rotasiz = 0;
  private hata = 0;
  private sonHata: string | null = null;

  constructor(
    private readonly chain: ChainId,
    tokens: readonly TokenEntry[],
    private readonly quoter: CowQuoter,
  ) {
    for (const t of tokens) {
      if (t.chain !== chain) continue;
      this.bySymbol.set(t.symbol.toUpperCase(), t);
    }
    this.quoteToken = this.bySymbol.get(QUOTE_SYMBOL);
  }

  get ready(): boolean {
    return this.quoteToken !== undefined;
  }

  get stats(): CaprazIstatistik {
    return {
      denendi: this.denendi,
      basarili: this.basarili,
      rotasiz: this.rotasiz,
      hata: this.hata,
      sonHata: this.sonHata,
    };
  }

  destekler(venue: DexId): boolean {
    // CoW'un KENDİ venue'sü çapraz kontrol edilmez: kendi kendini doğrulayan
    // bir kontrol, hiç kontrol etmemekten kötüdür (doğrulanmış görünür).
    return this.ready && venue !== 'cow-base' && DEX_CHAIN[venue] === this.chain;
  }

  async kontrol(
    venue: DexId,
    symbol: string,
    yon: 'buy' | 'sell',
    girdi: number,
    bizimCikti: number,
  ): Promise<CaprazSonuc | null> {
    if (!this.destekler(venue) || !(girdi > 0) || !(bizimCikti > 0)) return null;

    const token = this.bySymbol.get(symbol.toUpperCase());
    const quote = this.quoteToken;
    if (!token || !quote) return null;

    const anahtar = `${symbol.toUpperCase()}|${yon}`;
    const onbellek = this.cache.get(anahtar);
    let oran: number | null;

    if (
      onbellek &&
      Date.now() - onbellek.at < TTL_MS &&
      Math.abs(girdi - onbellek.girdi) / onbellek.girdi < BANT
    ) {
      oran = onbellek.oran;
    } else {
      const sat = yon === 'buy' ? quote : token;
      const al = yon === 'buy' ? token : quote;
      this.denendi++;
      try {
        const ham = await this.quoter.quote(
          sat.address,
          al.address,
          BigInt(Math.floor(girdi * 10 ** sat.decimals)),
        );
        // `null` = CoW'un kendi "rota yok" cevabı (veri). Fırlatılan hata =
        // bize ulaşılamıyor (arıza). İkisini ayırmak `HttpCowQuoter`'da
        // ölçülmüş bir ders — aynı kovaya konsalar altyapı bloğu "hiçbir
        // tokenda likidite yok" gibi görünürdü.
        oran = ham === null ? null : Number(ham) / 10 ** al.decimals / girdi;
        if (oran === null) this.rotasiz++;
        else this.basarili++;
      } catch (e) {
        this.hata++;
        this.sonHata = (e as Error).message;
        // Arıza sonucu ÖNBELLEĞE YAZILMAZ: geçici bir blok, tokenı kalıcı
        // olarak "kontrol edilemez" yapmamalı.
        return null;
      }
      this.cache.set(anahtar, { at: Date.now(), girdi, oran });
    }

    if (oran === null) return null;
    const onunCikti = oran * girdi;
    if (!(onunCikti > 0)) return null;

    return {
      kaynak: 'cow',
      miktar: onunCikti,
      sapmaPct: (bizimCikti - onunCikti) / onunCikti,
    };
  }
}

/**
 * Zincir başına bir kontrolü tek arayüz altında birleştirir.
 *
 * CoW'un quote yolu zincire özgü (`base`, `arbitrum_one`) ve token tablosu da
 * öyle — dolayısıyla zincir başına bir örnek gerekiyor. Tarayıcı ise tek bir
 * `CaprazKontrol` tutuyor: hangi venue'nun hangi zincire ait olduğu bilgisi
 * tarayıcının değil bu katmanın işi. `DexLegQuoter` tarafındaki
 * `VenueLegQuoter` ile aynı desen.
 *
 * Sayaçlar TOPLANIR: panelde tek satır var ve iki zinciri ayrı ayrı basmak,
 * "hiç çağrılmadı" uyarısını iki kez tekrarlayan bir gürültü üretirdi. Son
 * hata, hangi zincirden geldiyse o.
 */
export class CaprazKontrolSeti implements CaprazKaynak {
  constructor(private readonly kaynaklar: readonly CaprazKaynak[]) {}

  get ready(): boolean {
    return this.kaynaklar.some((k) => k.ready);
  }

  get stats(): CaprazIstatistik {
    let denendi = 0;
    let basarili = 0;
    let rotasiz = 0;
    let hata = 0;
    let sonHata: string | null = null;
    for (const k of this.kaynaklar) {
      const s = k.stats;
      denendi += s.denendi;
      basarili += s.basarili;
      rotasiz += s.rotasiz;
      hata += s.hata;
      if (s.sonHata) sonHata = s.sonHata;
    }
    return { denendi, basarili, rotasiz, hata, sonHata };
  }

  destekler(venue: DexId): boolean {
    return this.kaynaklar.some((k) => k.destekler(venue));
  }

  async kontrol(
    venue: DexId,
    symbol: string,
    yon: 'buy' | 'sell',
    girdi: number,
    bizimCikti: number,
  ): Promise<CaprazSonuc | null> {
    // Bir venue tek bir zincire ait olduğu için ilk destekleyen doğru olandır
    // (`DEX_CHAIN` birebir eşleme). Hepsini denemek, aynı sembolün başka
    // zincirdeki farklı tokenıyla karşılaştırma yapmak demek olurdu — kimlik
    // kuralının ihlali.
    const k = this.kaynaklar.find((x) => x.destekler(venue));
    return k ? k.kontrol(venue, symbol, yon, girdi, bizimCikti) : null;
  }
}
