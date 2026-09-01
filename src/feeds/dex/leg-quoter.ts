/**
 * DEX bacağı doğrulayıcısı — Aşama 2'nin DEX karşılığı.
 *
 * NEDEN VAR: Solana geniş taraması (price/v3) bir ORTA fiyat verir ve miktar
 * alanlarını 0 bırakır. Tarayıcı bu 0'ı "L1 derinliği yok" olarak okuyup
 * doğrulamaya gitmesi gerekiyordu — ama o bağlantı hiç kurulmamıştı ve
 * scanner her DEX bacağını `rejectedByDepth` ile eliyordu. Sonuç: CEX↔DEX
 * fırsatı yapısal olarak üretilemiyordu.
 *
 * EVM feed'leri (Aerodrome/Camelot) bu arayüze ihtiyaç duymaz: onlar zaten
 * belirli bir işlem büyüklüğü için quoter çağırıp gerçek miktarı yazıyor.
 * Burası yalnızca Solana boşluğunu kapatır.
 *
 * Arayüz dar tutuldu (`DexLegQuoter`): tarayıcı Jupiter'i, mint adreslerini ya
 * da decimals'ı bilmez. Testler sahte bir quoter enjekte edebiliyor — birim
 * testinin ağa çıkması gerekmiyor.
 */

import { DEX_CHAIN, type ChainId, type DexId } from '../../core/types.ts';
import type { TokenEntry } from '../../core/config.ts';
import type { DexQuote } from './jupiter.ts';
import type { RaydiumQuote } from './raydium.ts';

/**
 * Quote sağlayıcılarının DAR arayüzü.
 *
 * Somut sınıflar (`DexQuoter`, `RaydiumQuoter`) bunları yapısal olarak
 * karşılıyor; burada tipi daraltmanın sebebi test: sahte bir quoter
 * enjekte edebilmek için sınıfın private alanlarını taklit etmek gerekmemeli
 * (`MulticallClient` ve `CowQuoter` ile aynı disiplin).
 */
export interface JupiterQuoteSource {
  quote(
    inputMint: string,
    outputMint: string,
    amount: bigint,
    inDecimals: number,
    outDecimals: number,
  ): Promise<DexQuote | null>;
}

export interface RaydiumQuoteSource {
  quote(inputMint: string, outputMint: string, amount: bigint): Promise<RaydiumQuote | null>;
}

/**
 * Aşama 2'nin DEX bacağından ihtiyaç duyduğu tek şey: gerçekleşen miktar.
 *
 * Anahtar VENUE, zincir değil. Bir dönem `chain` alıyordu ve o imza aynı
 * zincirde ikinci bir venue'yu (raydium) yapısal olarak imkânsız kılıyordu:
 * `jupiter` bacağı da `raydium` bacağı da 'solana' diyor, dolayısıyla
 * tarayıcı Raydium'da bulduğu adayı Jupiter'e doğrulatırdı. Bu, ölçtüğümüz
 * fiyatı UYGULANAMAYACAK bir rotayla karıştırmak demek — kimlik kuralının
 * venue tarafındaki karşılığı.
 */
/**
 * Aşama 2'nin DEX bacağından dönen sonuç.
 *
 * `etkiPct` neden var: miktar tek başına "bu havuz işlemi taşıyor mu"
 * sorusunu cevaplamıyor. Ölçülen örnek ZEUS — orta fiyatı Jupiter'le %2.5
 * uyumlu (yani fiyat kaynağı sağlam) ama $500'lük quote birim fiyatı 3.5
 * KATINA çıkarıyor: havuz doğru fiyatlı, sadece o büyüklüğü taşımıyor.
 * Kâr hesabı bunu zaten yakalıyor (net %-99 çıkıyor ve aday eleniyor), ama
 * eleme sebebi "derinlik yok" kovasına düşüyor ve panelde ince havuz ile
 * rotasızlık ayırt edilemiyordu.
 *
 * Değer zaten elimizdeydi: iki quoter da fiyat etkisini döndürüyor,
 * Jupiter'inki ayrıştırılıp ATILIYORDU.
 */
export interface DexLegSonuc {
  /** Gerçekleşen miktar (alışta base, satışta quote). */
  readonly miktar: number;
  /** Fiyat etkisi oran olarak (0.01 = %1); kaynak vermezse null. */
  readonly etkiPct: number | null;
}

export interface DexLegQuoter {
  /**
   * Quote parasıyla base alım.
   * @returns alınabilen base miktarı, rota yoksa null
   */
  buy(venue: DexId, symbol: string, quoteAmount: number): Promise<DexLegSonuc | null>;
  /**
   * Base satışı.
   * @returns elde edilen quote tutarı, rota yoksa null
   */
  sell(venue: DexId, symbol: string, baseAmount: number): Promise<DexLegSonuc | null>;
}

/**
 * Venue'ya göre doğru doğrulayıcıya yönlendirir.
 *
 * Tarayıcı tek bir `DexLegQuoter` tutuyor (kurulum sırası ve test enjeksiyonu
 * bu yüzden basit kalıyor); hangi venue'nun hangi uca gittiği bilgisi
 * tarayıcının değil bu katmanın işi.
 */
export class VenueLegQuoter implements DexLegQuoter {
  constructor(private readonly byVenue: ReadonlyMap<DexId, DexLegQuoter>) {}

  get venues(): DexId[] {
    return [...this.byVenue.keys()];
  }

  async buy(venue: DexId, symbol: string, quoteAmount: number): Promise<DexLegSonuc | null> {
    return (await this.byVenue.get(venue)?.buy(venue, symbol, quoteAmount)) ?? null;
  }

  async sell(venue: DexId, symbol: string, baseAmount: number): Promise<DexLegSonuc | null> {
    return (await this.byVenue.get(venue)?.sell(venue, symbol, baseAmount)) ?? null;
  }
}

/** Fiyatlamada referans alınan stablecoin. */
const QUOTE_SYMBOL = 'USDC';

export class JupiterLegQuoter implements DexLegQuoter {
  private readonly bySymbol = new Map<string, TokenEntry>();
  private readonly quoteToken: TokenEntry | undefined;

  constructor(
    tokens: readonly TokenEntry[],
    private readonly quoter: JupiterQuoteSource,
  ) {
    for (const t of tokens) {
      if (t.chain !== 'solana') continue;
      this.bySymbol.set(t.symbol.toUpperCase(), t);
    }
    this.quoteToken = this.bySymbol.get(QUOTE_SYMBOL);
  }

  /** Doğrulanabilir durumda mı — quote token tanımlı değilse anlamsız. */
  get ready(): boolean {
    return this.quoteToken !== undefined;
  }

  async buy(venue: DexId, symbol: string, quoteAmount: number): Promise<DexLegSonuc | null> {
    const token = this.token(venue, symbol);
    if (!token || !this.quoteToken || !(quoteAmount > 0)) return null;

    const q = await this.quoter.quote(
      this.quoteToken.address,
      token.address,
      raw(quoteAmount, this.quoteToken.decimals),
      this.quoteToken.decimals,
      token.decimals,
    );
    return q && q.outAmount > 0 ? { miktar: q.outAmount, etkiPct: q.priceImpact } : null;
  }

  async sell(venue: DexId, symbol: string, baseAmount: number): Promise<DexLegSonuc | null> {
    const token = this.token(venue, symbol);
    if (!token || !this.quoteToken || !(baseAmount > 0)) return null;

    const q = await this.quoter.quote(
      token.address,
      this.quoteToken.address,
      raw(baseAmount, token.decimals),
      token.decimals,
      this.quoteToken.decimals,
    );
    return q && q.outAmount > 0 ? { miktar: q.outAmount, etkiPct: q.priceImpact } : null;
  }

  private token(venue: DexId, symbol: string): TokenEntry | undefined {
    if (venue !== 'jupiter') return undefined;
    return this.bySymbol.get(symbol.toUpperCase());
  }
}

/**
 * Raydium'un Aşama 2 doğrulayıcısı.
 *
 * Jupiter'inkiyle aynı işi yapar ama AYRI HOST'a gider
 * (`transaction-v1.raydium.io`), yani iki venue birbirinin kotasını yemez.
 * Jupiter'in ücretsiz kademesinde ölçülen sorun tam olarak buydu: Aşama 1
 * taraması ile Aşama 2 doğrulaması aynı 1/sn kovayı paylaşıyor.
 */
export class RaydiumLegQuoter implements DexLegQuoter {
  private readonly bySymbol = new Map<string, TokenEntry>();
  private readonly quoteToken: TokenEntry | undefined;

  constructor(
    tokens: readonly TokenEntry[],
    private readonly quoter: RaydiumQuoteSource,
  ) {
    for (const t of tokens) {
      if (t.chain !== 'solana') continue;
      this.bySymbol.set(t.symbol.toUpperCase(), t);
    }
    this.quoteToken = this.bySymbol.get(QUOTE_SYMBOL);
  }

  get ready(): boolean {
    return this.quoteToken !== undefined;
  }

  async buy(venue: DexId, symbol: string, quoteAmount: number): Promise<DexLegSonuc | null> {
    const token = this.token(venue, symbol);
    if (!token || !this.quoteToken || !(quoteAmount > 0)) return null;

    const q = await this.quoter.quote(
      this.quoteToken.address,
      token.address,
      raw(quoteAmount, this.quoteToken.decimals),
    );
    return q === null ? null : { miktar: q.out / 10 ** token.decimals, etkiPct: q.etkiPct };
  }

  async sell(venue: DexId, symbol: string, baseAmount: number): Promise<DexLegSonuc | null> {
    const token = this.token(venue, symbol);
    if (!token || !this.quoteToken || !(baseAmount > 0)) return null;

    const q = await this.quoter.quote(
      token.address,
      this.quoteToken.address,
      raw(baseAmount, token.decimals),
    );
    return q === null ? null : { miktar: q.out / 10 ** this.quoteToken.decimals, etkiPct: q.etkiPct };
  }

  private token(venue: DexId, symbol: string): TokenEntry | undefined {
    if (venue !== 'raydium') return undefined;
    return this.bySymbol.get(symbol.toUpperCase());
  }
}

/**
 * İnsan okunur miktarı zincir birimine çevirir.
 *
 * `Math.floor` şart: kesirli bir bigint dönüşümü çalışma zamanı hatası verir ve
 * bu yol Aşama 2'nin ortasında — tek bir aday yüzünden tarama çökmemeli.
 */
function raw(amount: number, decimals: number): bigint {
  return BigInt(Math.floor(amount * 10 ** decimals));
}
