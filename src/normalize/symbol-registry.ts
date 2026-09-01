/**
 * Sembol keşfi ve kanonik eşleme.
 *
 * Bu modül botun en hata üretmeye müsait yeridir. Aynı çift her borsada farklı
 * yazılır (BTCUSDT / BTC-USDT / BTC_USDT) ve daha kötüsü, aynı TICKER farklı
 * TOKEN'lara ait olabilir — birden fazla "MOON", "APE", "SUN" vardır. Ticker
 * eşleştirmesiyle arbitraj yapmak, iki ayrı varlığı aynı sanıp para göndermek
 * demektir.
 *
 * Kural:
 *  - CEX↔CEX eşleşmesi ticker üzerinden yapılır ANCAK yalnızca transfer edilecek
 *    zincir + kontrat adresi her iki tarafta da doğrulanabiliyorsa fırsat
 *    "verified" sayılır. Doğrulanamıyorsa uyarı bayrağıyla işaretlenir.
 *  - CEX↔DEX ve DEX↔DEX eşleşmesi YALNIZCA kontrat/mint adresi üzerinden yapılır.
 *    Adres eşleşmesi yoksa çift taramaya hiç alınmaz.
 */

import { httpJson } from '../core/http.ts';
import type { ZorunluKapsam } from '../core/izleme-listesi.ts';
import { pairKey, type CexId, type PairKey } from '../core/types.ts';

export interface VenueMarket {
  readonly venueSymbol: string;
  readonly base: string;
  readonly quote: string;
  readonly pair: PairKey;
}

type Fetcher = () => Promise<VenueMarket[]>;

/**
 * Kraken'in eski varlık kodları → WebSocket v2 adları.
 *
 * ÖLÇÜLDÜ: `AssetPairs`'in verdiği `wsname` v1 içindir ve v2 onu REDDEDİYOR
 * ("Currency pair not supported XBT/USDT"). v2 yaygın adları istiyor.
 * Eşlemeyi atlamak BTC ve DOGE'yi sessizce kapsam dışı bırakırdı — abonelik
 * reddedilir, bağlantı açık kalır, o iki çift hiç veri almaz.
 *
 * Yalnızca bu iki kod farklı: ETH/LTC/XMR/XRP'nin `base` alanı X önekli
 * (XETH, XLTC…) ama `wsname` zaten temiz veriyor.
 */
const KRAKEN_V2_ALIASES: Record<string, string> = {
  XBT: 'BTC',
  XDG: 'DOGE',
};

function mk(venueSymbol: string, base: string, quote: string): VenueMarket {
  const b = base.toUpperCase();
  const q = quote.toUpperCase();
  return { venueSymbol, base: b, quote: q, pair: pairKey(b, q) };
}

/**
 * Bir borsanın USD çiftini, o base'in USDT çifti YOKSA, USDT yerine sayar.
 *
 * NEDEN GEREKLİ: `pairKey` quote'u içerdiği için `KTA/USD` ile `KTA/USDT` ayrı
 * çiftlerdir ve karşılaştırılmazlar. Kraken'in USDT piyasası dar (1410
 * sembolün 1365'i USDT dışı quote'ta), dolayısıyla Kraken'de listeli bir coin
 * başka borsada USDT'de listeliyken çift OLUŞMUYORDU. Ölçüldü: Kraken'in 641
 * USD çiftinin 423'ünün ikinci bir borsada aynı quote'ta karşılığı yok;
 * bunların 341'i başka borsalarda USDT'de listeli ve 54'ü bu yüzden HİÇ
 * taranmıyordu (KTA, MSOL, JITOSOL, WBT, BGB…).
 *
 * NEDEN "YALNIZCA USDT YOKSA": borsada gerçek bir USDT çifti varsa doğru
 * karşılaştırma odur. USD'yi de eklemek aynı coini iki kez, biri baz riski
 * taşıyan iki ayrı fiyatla taramak olurdu.
 *
 * BEDELİ — ve bu bedel gizlenmemeli: USD ile USDT farklı varlıklar. Aradaki
 * baz (ölçüm: Kraken `USDT/USD` = 0.9991, yani %-0.09) doğrudan kâr hesabına
 * karışır ve `MIN_NET_PCT` %0.4 iken bu eşiğin dörtte biri kadardır; depeg
 * anlarında %'lerce olur. Bu yüzden vekil kullanılan çiftler kayıt altına
 * alınıyor (`usdVekili`) ve o bacağı taşıyan fırsat uyarı taşıyor.
 *
 * `venueSymbol` DEĞİŞMEZ: borsaya hâlâ `KTA/USD` diye abone oluyoruz ve REST
 * derinliği de o adla çekiliyor. Değiştirmek sessiz bir abonelik hatası
 * üretirdi — bağlantı açık kalır, o çift hiç veri almaz.
 */
export function usdVekiliUygula(
  markets: readonly VenueMarket[],
  vekilEdilen: Set<string>,
  venue: CexId,
  kayit: Map<string, Set<CexId>>,
): VenueMarket[] {
  const usdtVar = new Set<string>();
  for (const m of markets) if (m.quote === 'USDT') usdtVar.add(m.base);

  const out: VenueMarket[] = [];
  for (const m of markets) {
    if (m.quote === 'USD' && !usdtVar.has(m.base)) {
      vekilEdilen.add(m.base);
      let vs = kayit.get(m.base);
      if (!vs) kayit.set(m.base, (vs = new Set()));
      vs.add(venue);
      out.push({ venueSymbol: m.venueSymbol, base: m.base, quote: 'USDT', pair: pairKey(m.base, 'USDT') });
      // Orijinal USD kaydı da kalır: `quotes` listesinde USD varsa o çift ayrıca
      // taranabilir. Bugünkü config'de USD taranmıyor, yani pratikte eleniyor.
    }
    out.push(m);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Borsa başına spot sembol listesi (hepsi public endpoint)
// ---------------------------------------------------------------------------

const fetchers: Record<CexId, Fetcher> = {
  async binance() {
    const r = await httpJson<{
      symbols: { symbol: string; baseAsset: string; quoteAsset: string; status: string }[];
    }>('https://api.binance.com/api/v3/exchangeInfo?permissions=SPOT');
    return r.symbols
      .filter((s) => s.status === 'TRADING')
      .map((s) => mk(s.symbol, s.baseAsset, s.quoteAsset));
  },

  async bybit() {
    const r = await httpJson<{
      result: { list: { symbol: string; baseCoin: string; quoteCoin: string; status: string }[] };
    }>('https://api.bybit.com/v5/market/instruments-info?category=spot');
    return r.result.list
      .filter((s) => s.status === 'Trading')
      .map((s) => mk(s.symbol, s.baseCoin, s.quoteCoin));
  },

  async okx() {
    const r = await httpJson<{
      data: { instId: string; baseCcy: string; quoteCcy: string; state: string }[];
    }>('https://www.okx.com/api/v5/public/instruments?instType=SPOT');
    return r.data
      .filter((s) => s.state === 'live')
      .map((s) => mk(s.instId, s.baseCcy, s.quoteCcy));
  },

  async gate() {
    const r = await httpJson<
      { id: string; base: string; quote: string; trade_status: string }[]
    >('https://api.gateio.ws/api/v4/spot/currency_pairs');
    return r
      .filter((s) => s.trade_status === 'tradable')
      .map((s) => mk(s.id, s.base, s.quote));
  },

  async mexc() {
    const r = await httpJson<{
      symbols: {
        symbol: string;
        baseAsset: string;
        quoteAsset: string;
        status: string;
        isSpotTradingAllowed?: boolean;
      }[];
    }>('https://api.mexc.com/api/v3/exchangeInfo');
    return r.symbols
      .filter((s) => (s.status === '1' || s.status === 'ENABLED') && s.isSpotTradingAllowed !== false)
      .map((s) => mk(s.symbol, s.baseAsset, s.quoteAsset));
  },

  async kraken() {
    const r = await httpJson<{
      result: Record<
        string,
        { wsname?: string; base: string; quote: string; status: string }
      >;
    }>('https://api.kraken.com/0/public/AssetPairs');

    const out: VenueMarket[] = [];
    for (const p of Object.values(r.result ?? {})) {
      if (p.status !== 'online' || !p.wsname) continue;
      // `wsname` "XBT/USDT" biçiminde; taban kısmını alıp v2 adına çeviriyoruz.
      const [wsBase, wsQuote] = p.wsname.split('/');
      if (!wsBase || !wsQuote) continue;
      const base = KRAKEN_V2_ALIASES[wsBase] ?? wsBase;
      // venueSymbol HEM WebSocket v2 HEM REST Depth tarafından kabul ediliyor
      // (ölçüldü: `Depth?pair=BTC/USDT` çalışıyor ve cevabı aynı anahtarla
      // döndürüyor), bu yüzden ikinci bir ad eşlemesi tutmuyoruz.
      out.push(mk(`${base}/${wsQuote}`, base, wsQuote));
    }
    return out;
  },

  async kucoin() {
    const r = await httpJson<{
      data: {
        symbol: string;
        baseCurrency: string;
        quoteCurrency: string;
        enableTrading: boolean;
      }[];
    }>('https://api.kucoin.com/api/v2/symbols');
    return r.data
      .filter((s) => s.enableTrading)
      .map((s) => mk(s.symbol, s.baseCurrency, s.quoteCurrency));
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface RegistryOptions {
  /** Hangi borsalar taranacak. */
  readonly venues: readonly CexId[];
  /** Hangi quote para birimleri (borsa bazlı). */
  readonly quotesByVenue: Readonly<Record<string, readonly string[]>>;
  /** Bir çiftin taranması için gereken minimum venue sayısı. */
  readonly minVenues?: number;
  /** Bu base coin'ler hiç taranmaz (stablecoin, leveraged token vb.). */
  readonly excludeBases?: readonly string[];
  /**
   * Kullanıcının "kesinlikle taransın" dediği coinler — yukarıdaki elemelerden
   * ve `minVenues` şartından muaf tutulurlar (bkz. core/izleme-listesi.ts).
   */
  readonly zorunlu?: ZorunluKapsam;
  /**
   * Bu base'lerin görüldüğü quote'ları kaydet — muafiyet VERME.
   *
   * `kapsam -- KTA` gibi tek coin sorguları için: coin `KTA/USDT`'de tek
   * borsada olabilir ama Kraken'de `KTA/USD` olarak da listeli olabilir.
   * Bu iz olmadan rapor ilk sebepte durup "ikinci bir borsada listelenirse
   * girer" diyordu — coin ikinci borsada ZATEN varken. Ölçülen örnek KTA.
   */
  readonly gozlem?: ReadonlySet<string>;
  /**
   * Bu borsalarda, bir base'in USDT çifti YOKSA USD çifti USDT yerine sayılır
   * (bkz. `usdVekiliUygula`). Bugün yalnızca `kraken` — USDT piyasası dar olan
   * tek borsa o.
   */
  readonly usdVekilBorsalari?: readonly CexId[];
}

/**
 * Kaldıraçlı token'lar (BTC3L, ETHUP...) spot arbitrajı için geçersizdir.
 *
 * Öndeki `.{3,}` şart: kalıp yalnızca sona bakarsa gerçek coinleri de eler.
 * Ölçülen hata — **JUP** "UP" ile bittiği için kaldıraçlı sayılıyor ve altı
 * borsada da listeli olmasına rağmen hiç taranmıyordu. Sessiz bir kapsam
 * kaybıydı: hiçbir yerde hata görünmüyor, çift yalnızca yok.
 *
 * Kaldıraçlı token'ın taban varlığı her zaman en az üç karakterdir (BTC3L,
 * ETHUP, SOLDOWN) — soneki taşıyabilmesi için bir taban varlığa ihtiyacı var.
 * Üç karakter şartı JUP'ı (taban "J") ve SOUP gibi kısa tabanlıları korur.
 */
const LEVERAGED = /^.{3,}(\d+[LS]|UP|DOWN|BULL|BEAR)$/;

/**
 * Bir base ticker kaldıraçlı token mu?
 *
 * Dışa açık: kalıbın kendisi ağa çıkmadan test edilebilsin diye. Kapsam kaybı
 * burada sessiz olduğu için (eksik çift hata üretmez, sadece yoktur) davranışı
 * birim testiyle sabitliyoruz.
 */
export function isLeveragedTicker(base: string): boolean {
  return LEVERAGED.test(base);
}

/** Bir borsanın sembol listesinin eleme dökümü. */
export interface VenueFunnel {
  /** Borsanın döndürdüğü toplam spot market sayısı. */
  ham: number;
  /**
   * USD→USDT vekili olarak TÜRETİLEN kayıt sayısı (bkz. usdVekiliUygula).
   *
   * Ayrı sütun olmasının sebebi huninin toplaması gerektiği: vekiller `ham`'a
   * dahil değil (borsa onları döndürmedi, biz ürettik) ama eleme aşamalarından
   * geçiyorlar. Sayılmasalardı `quoteDisi + elenenBase + kaldiracli + kabul`
   * ham'ı AŞARDI ve rapor kendi içinde çelişirdi — bu botta huninin yalan
   * söylemesi tam olarak engellemeye çalıştığımız şey.
   */
  vekil: number;
  /** Quote para birimi taranmıyor (ör. BTC/EUR). */
  quoteDisi: number;
  /** `EXCLUDED_BASES` — stablecoin vb. */
  elenenBase: number;
  /** Kaldıraçlı token kalıbına takıldı. */
  kaldiracli: number;
  /** Bu borsadan taramaya giren çift sayısı (minVenues elemesinden ÖNCE). */
  kabul: number;
}

/**
 * Keşif sırasında ölçülen eleme istatistikleri.
 *
 * Kapsam kaybı bu botta sessizdir: taranmayan bir çift hata üretmez, yalnızca
 * yoktur. "Neden bu coini görmüyorum?" sorusunun cevabı ancak eleme anında
 * biliniyor — sonradan geriye doğru hesaplanamaz, çünkü elenen kayıt hiçbir
 * yerde durmuyor. Bu yüzden build sırasında toplanıyor.
 */
export interface RegistryStats {
  readonly perVenue: ReadonlyMap<CexId, VenueFunnel>;
  /** `minVenues` şartını geçemeyen çiftler → görüldüğü borsalar. */
  readonly tekBorsada: ReadonlyMap<PairKey, CexId[]>;
  /** İzleme listesindeki her sembolün AKIBETİ — bkz. ZorunluDurum. */
  readonly zorunlu: ReadonlyMap<string, ZorunluDurum>;
  /**
   * `zorunlu` + `gozlem` base'lerinin görüldüğü TÜM quote'lar — taranmayanlar
   * dahil. "Coin hiç listelenmemiş" ile "yanlış quote'ta listelenmiş" ancak
   * burada ayrılır ve ikincisi çözülebilir bir sorundur.
   */
  readonly gorulenQuotes: ReadonlyMap<string, string[]>;
  /**
   * Fiyatı USD çiftinden gelen base'ler (USDT çifti olmadığı için vekil
   * kullanıldı) — yalnızca taramada HAYATTA KALAN çiftler.
   */
  readonly usdVekilli: ReadonlyMap<string, ReadonlySet<CexId>>;
}

/** Zorunlu bir girdinin hangi elemeden muaf tutulduğu. */
export type ZorunluMuafiyet = 'stablecoin' | 'kaldiracli' | 'ekQuote' | 'tekBorsa';

/**
 * İzleme listesindeki bir sembolün keşif sonundaki durumu.
 *
 * Bu yapının varlık sebebi, muafiyetin kendisinin sessiz olmaması: kullanıcı
 * bir coini "kesinlikle taransın" diye ekledikten sonra o coinin gerçekten
 * taranıp taranmadığını bilmek zorunda. Girdinin HİÇBİR işe yaramadığı durum
 * (coin hiçbir borsada listeli değil) tam olarak kullanıcının izlendiğini
 * sandığı ama çiftin hiç oluşmadığı durumdur.
 */
export interface ZorunluDurum {
  /** Taramaya giren çiftler → hangi borsalarda. Boşsa coin taranmıyor. */
  readonly ciftler: ReadonlyMap<PairKey, CexId[]>;
  /** Bu girdi olmasaydı hangi elemelere takılacaktı. */
  readonly muafiyetler: readonly ZorunluMuafiyet[];
  /**
   * Bu ticker'ın herhangi bir borsada görüldüğü TÜM quote birimleri —
   * taranmayanlar dahil. Boşsa ticker hiçbir borsada yok.
   *
   * "quote dışı" ile "hiç listelenmemiş" farkı burada ayrılıyor: ilki
   * `quotes` alanına bir birim eklenerek çözülür, ikincisi çözülemez.
   */
  readonly gorulenQuotes: readonly string[];
}

/** "BTC/USDT" → "BTC" */
function baseOf(pair: PairKey): string {
  const i = pair.indexOf('/');
  return i < 0 ? pair : pair.slice(0, i);
}

export class SymbolRegistry {
  /** pair → venue → venueSymbol */
  private readonly byPair = new Map<PairKey, Map<CexId, string>>();
  private readonly errors = new Map<CexId, string>();
  private readonly funnels = new Map<CexId, VenueFunnel>();
  private readonly dropped = new Map<PairKey, CexId[]>();
  private readonly zorunlu = new Map<string, ZorunluDurum>();
  private readonly gorulen = new Map<string, string[]>();
  private readonly usdVekilli = new Map<string, Set<CexId>>();

  private constructor() {}

  static async build(opts: RegistryOptions): Promise<SymbolRegistry> {
    const reg = new SymbolRegistry();
    const minVenues = opts.minVenues ?? 2;
    const exclude = new Set((opts.excludeBases ?? []).map((s) => s.toUpperCase()));
    const zorunluBases = opts.zorunlu?.bases ?? new Set<string>();
    // Quote izi zorunlu listeden GENİŞ: gözlem altındaki base muaf değildir,
    // yalnızca nerede göründüğü kaydedilir.
    const izlenenBases = new Set([...zorunluBases, ...(opts.gozlem ?? [])]);

    // Muafiyetler ve "bu ticker nerede görüldü" izi yalnızca bu semboller için
    // tutulur — tüm evren için tutmak keşfi gereksiz şişirirdi.
    const muafiyetler = new Map<string, Set<ZorunluMuafiyet>>();
    const gorulenQuotes = new Map<string, Set<string>>();
    /** USD fiyatı USDT yerine sayılan base'ler — sinyal uyarısının kaynağı. */
    const vekilEdilenBases = new Set<string>();
    /** base → vekili KULLANAN borsalar. Uyarı ancak o bacak varsa doğrudur. */
    const vekilKayit = new Map<string, Set<CexId>>();
    const muaf = (base: string, m: ZorunluMuafiyet): void => {
      let s = muafiyetler.get(base);
      if (!s) {
        s = new Set();
        muafiyetler.set(base, s);
      }
      s.add(m);
    };

    // Altı borsayı paralel sorgula — sıralı yapmak kurulumu gereksiz uzatır.
    const results = await Promise.allSettled(
      opts.venues.map(async (v) => ({ venue: v, markets: await fetchers[v]() })),
    );

    for (let i = 0; i < results.length; i++) {
      const venue = opts.venues[i]!;
      const res = results[i]!;

      if (res.status === 'rejected') {
        // Bir borsa sembol listesini vermezse onsuz devam ederiz, ama bu
        // sessizce yutulmaz — sağlık panelinde ve başlangıç özetinde görünür.
        reg.errors.set(venue, (res.reason as Error).message);
        continue;
      }

      const allowedQuotes = new Set(
        (opts.quotesByVenue[venue] ?? ['USDT']).map((q) => q.toUpperCase()),
      );

      // USD vekili quote elemesinden ÖNCE uygulanır: amaç zaten USD çiftini
      // USDT sayıp o elemeden geçirmek. Sonra uygulasaydık kayıt çoktan
      // `quoteDisi` olarak elenmiş olurdu.
      const markets = (opts.usdVekilBorsalari ?? []).includes(venue)
        ? usdVekiliUygula(res.value.markets, vekilEdilenBases, venue, vekilKayit)
        : res.value.markets;

      const funnel: VenueFunnel = {
        ham: res.value.markets.length,
        vekil: markets.length - res.value.markets.length,
        quoteDisi: 0,
        elenenBase: 0,
        kaldiracli: 0,
        kabul: 0,
      };
      reg.funnels.set(venue, funnel);

      for (const m of markets) {
        const zorunluBase = zorunluBases.has(m.base);

        // Quote elemesinden ÖNCE kaydediliyor: "coin var ama yalnızca BTC
        // quote'unda" ile "coin hiçbir borsada yok" farkı ancak burada görülür
        // ve ilki `quotes` alanına bir birim eklenerek çözülebilir bir sorun.
        if (izlenenBases.has(m.base)) {
          let qs = gorulenQuotes.get(m.base);
          if (!qs) {
            qs = new Set();
            gorulenQuotes.set(m.base, qs);
          }
          qs.add(m.quote);
        }

        if (!allowedQuotes.has(m.quote)) {
          const ek = opts.zorunlu?.ekQuotes.get(m.base);
          if (!zorunluBase || !ek?.has(m.quote)) {
            funnel.quoteDisi++;
            continue;
          }
          muaf(m.base, 'ekQuote');
        }
        if (exclude.has(m.base)) {
          if (!zorunluBase) {
            funnel.elenenBase++;
            continue;
          }
          muaf(m.base, 'stablecoin');
        }
        if (isLeveragedTicker(m.base)) {
          if (!zorunluBase) {
            funnel.kaldiracli++;
            continue;
          }
          muaf(m.base, 'kaldiracli');
        }
        funnel.kabul++;

        let entry = reg.byPair.get(m.pair);
        if (!entry) {
          entry = new Map();
          reg.byPair.set(m.pair, entry);
        }
        entry.set(venue, m.venueSymbol);
      }
    }

    // Tek borsada olan çiftleri at: arbitraj için karşı taraf gerekiyor.
    //
    // Zorunlu listedeki coin BURADA da muaf: karşı taraf CEX olmak zorunda
    // değil. Bir coin tek borsada + bir DEX'te listeliyse bu geçerli bir
    // CEX↔DEX arbitrajıdır, ama çift bu satırda silindiği için DEX bacağı da
    // hiç kurulmuyordu (dexTokensFor `knownPairs` istiyor). Muafiyetin
    // karşılığı gerçekten tek taraflı kalırsa raporda "tek borsada" olarak
    // görünür — sessizce ölü satır bırakmıyoruz.
    for (const [pair, venues] of reg.byPair) {
      if (venues.size < minVenues) {
        if (zorunluBases.has(baseOf(pair))) {
          muaf(baseOf(pair), 'tekBorsa');
          continue;
        }
        reg.dropped.set(pair, [...venues.keys()]);
        reg.byPair.delete(pair);
      }
    }

    for (const [b, qs] of gorulenQuotes) reg.gorulen.set(b, [...qs].sort());

    // Vekil YALNIZCA hayatta kalan çiftler için raporlanır. `usdVekiliUygula`
    // Kraken'in tüm USD sembollerini işaretliyor (yüzlerce), ama çoğu
    // `minVenues`'ta zaten eleniyor — hepsini raporlamak kullanıcıya
    // taranmayan coinler için baz uyarısı göstermek olurdu.
    for (const b of vekilEdilenBases) {
      if (reg.byPair.has(pairKey(b, 'USDT'))) reg.usdVekilli.set(b, vekilKayit.get(b) ?? new Set());
    }

    // Zorunlu girdilerin akıbeti — hiç market bulunamayanlar dahil. Listede
    // olup burada boş çıkan bir sembol, kullanıcının izlendiğini sandığı ama
    // hiç oluşmamış bir çifttir; raporun asıl anlattığı şey budur.
    for (const base of zorunluBases) {
      const ciftler = new Map<PairKey, CexId[]>();
      for (const [pair, venues] of reg.byPair) {
        if (baseOf(pair) === base) ciftler.set(pair, [...venues.keys()]);
      }
      reg.zorunlu.set(base, {
        ciftler,
        muafiyetler: [...(muafiyetler.get(base) ?? [])],
        gorulenQuotes: reg.gorulen.get(base) ?? [],
      });
    }

    return reg;
  }

  get pairs(): PairKey[] {
    return [...this.byPair.keys()];
  }

  get pairCount(): number {
    return this.byPair.size;
  }

  /** Bu çiftin işlem gördüğü borsalar. */
  venuesFor(pair: PairKey): ReadonlyMap<CexId, string> {
    return this.byPair.get(pair) ?? new Map();
  }

  /** Bir borsada taranacak tüm sembollerin venue-native gösterimi. */
  symbolsFor(venue: CexId): { pair: PairKey; venueSymbol: string }[] {
    const out: { pair: PairKey; venueSymbol: string }[] = [];
    for (const [pair, venues] of this.byPair) {
      const s = venues.get(venue);
      if (s) out.push({ pair, venueSymbol: s });
    }
    return out;
  }

  /** Sembol listesi alınamayan borsalar. */
  get failedVenues(): ReadonlyMap<CexId, string> {
    return this.errors;
  }

  /** Eleme dökümü — `npm run kapsam` bunu raporluyor. */
  get stats(): RegistryStats {
    return {
      perVenue: this.funnels,
      tekBorsada: this.dropped,
      zorunlu: this.zorunlu,
      gorulenQuotes: this.gorulen,
      usdVekilli: this.usdVekilli,
    };
  }

  /**
   * Bu base'in fiyatı USD çiftinden geliyor (USDT değil) — yani sinyali
   * USDT/USD bazını içerir.
   *
   * Tarayıcı bunu fırsata uyarı olarak iliştiriyor. Sessiz bırakmak, kâr
   * hesabına giren sistematik bir kaymayı gizlemek olurdu.
   */
  usdVekiliMi(base: string, venue: CexId): boolean {
    return this.usdVekilli.get(base.toUpperCase())?.has(venue) ?? false;
  }

  /** İzleme listesindeki sembollerin akıbeti — hazır yorumlanmış hâli. */
  zorunluOzet(dexPairler?: ReadonlySet<PairKey>): ZorunluOzetSatiri[] {
    return zorunluOzet(this.zorunlu, dexPairler);
  }

  summary(): string {
    const counts = new Map<CexId, number>();
    for (const venues of this.byPair.values()) {
      for (const v of venues.keys()) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const parts = [...counts.entries()].map(([v, n]) => `${v}:${n}`);
    return `${this.byPair.size} çift — ${parts.join(' ')}`;
  }
}

// ---------------------------------------------------------------------------
// Zorunlu listenin yorumlanması
// ---------------------------------------------------------------------------

export type ZorunluSonuc =
  /** İki taraf da var — gerçekten taranıyor. */
  | 'taraniyor'
  /** Çift oluştu ama tek tarafı var; şu hâliyle sinyal üretemez. */
  | 'tekTarafli'
  /** Ticker borsalarda var ama yalnızca taranmayan bir quote'ta. */
  | 'quoteDisi'
  /** Hiçbir borsanın sembol listesinde yok — girdi hiçbir işe yaramıyor. */
  | 'listelenmemis';

export interface ZorunluOzetSatiri {
  readonly sembol: string;
  readonly sonuc: ZorunluSonuc;
  /** Kullanıcıya gösterilecek tek satırlık gerekçe. */
  readonly aciklama: string;
  readonly durum: ZorunluDurum;
}

const MUAFIYET_ADI: Record<ZorunluMuafiyet, string> = {
  stablecoin: 'stablecoin elemesi',
  kaldiracli: 'kaldıraçlı kalıbı',
  ekQuote: 'quote elemesi',
  tekBorsa: 'en az iki borsa şartı',
};

/**
 * Ham durumu insan diline çevirir.
 *
 * `dexPairler` verilirse tek CEX'li çiftler DEX bacağıyla birlikte
 * değerlendirilir: 1 CEX + 1 DEX geçerli bir arbitrajdır ve muafiyetin asıl
 * gerekçesi budur. Verilmezse (DEX kurulumunu bilmeyen çağıran) tek CEX'li
 * çift dürüstçe "tek taraflı" sayılır — iyimser davranmak, raporun tam olarak
 * engellemek için var olduğu hatayı üretirdi.
 */
export function zorunluOzet(
  durumlar: ReadonlyMap<string, ZorunluDurum>,
  dexPairler?: ReadonlySet<PairKey>,
): ZorunluOzetSatiri[] {
  const out: ZorunluOzetSatiri[] = [];

  for (const [sembol, durum] of durumlar) {
    const muafMetin =
      durum.muafiyetler.length > 0
        ? ` · muafiyet: ${durum.muafiyetler.map((m) => MUAFIYET_ADI[m]).join(', ')}`
        : '';

    if (durum.ciftler.size === 0) {
      const sonuc: ZorunluSonuc =
        durum.gorulenQuotes.length > 0 ? 'quoteDisi' : 'listelenmemis';
      out.push({
        sembol,
        sonuc,
        durum,
        aciklama:
          sonuc === 'quoteDisi'
            ? `borsalarda yalnızca ${durum.gorulenQuotes.join(', ')} quote'unda listeli — ` +
              `taranması için "quotes" alanına ekle`
            : 'hiçbir borsanın sembol listesinde yok — bu girdi şu an hiçbir şey yapmıyor',
      });
      continue;
    }

    const parcalar: string[] = [];
    let taraniyor = false;
    for (const [pair, venues] of durum.ciftler) {
      const dexVar = dexPairler?.has(pair) ?? false;
      const taraf = venues.length + (dexVar ? 1 : 0);
      if (taraf >= 2) taraniyor = true;
      parcalar.push(`${pair}: ${venues.join(' ')}${dexVar ? ' +dex' : ''}`);
    }

    out.push({
      sembol,
      sonuc: taraniyor ? 'taraniyor' : 'tekTarafli',
      durum,
      aciklama: taraniyor
        ? `${parcalar.join(' · ')}${muafMetin}`
        : `${parcalar.join(' · ')} — tek taraf, karşısında alım/satım yeri yok` +
          ` (ikinci bir borsada listelenirse ya da DEX token'ı eklenirse otomatik girer)${muafMetin}`,
    });
  }

  return out.sort((a, b) => a.sembol.localeCompare(b.sembol, 'en'));
}
