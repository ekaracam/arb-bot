/**
 * CowFeed durum makinesi ve fiyat yazımı.
 *
 * CoW, botun ilk TOPLAYICI kaynağı: zincirde quoter kontratı yok, fiyat HTTP
 * quote uçtasından geliyor ve çok adımlı rotayı solver kuruyor. Bu yüzden
 * `EvmDexFeed`'in testleriyle aynı soruları burada TEKRAR sormak gerekiyor —
 * paylaşılan kod yok, yalnızca paylaşılan disiplin var:
 *
 *   - gidiş-dönüş spread'i eşiği aşarsa store'a HİÇ yazılmamalı
 *   - "rota yok" (veri) ile "API arızası" (arıza) ayrı teşhis üretmeli
 *   - başarısızlık serisi yalnızca API cevap verirken artmalı, yoksa tek
 *     kesinti tüm tabloyu haksızca rotasız ilan eder
 *
 * `CowQuoter` arayüzü dar tutulduğu için buradaki hiçbir test ağa çıkmıyor.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CowFeed, cowHatasiMi, type CowQuoter, type CowToken } from '../src/feeds/dex/cow.ts';
import { PriceStore } from '../src/book/price-store.ts';
import { pairKey, type PairKey, type VenueId } from '../src/core/types.ts';

const USDC = '0x0000000000000000000000000000000000000001';
const VENUE: VenueId = 'cow-base';
const SEMBOLLER = ['AAA', 'BBB', 'CCC'] as const;

/** $1000 işlem, 6 haneli quote token. */
const TRADE = 1000;
const AMOUNT_IN = 1_000_000_000n;

/** Bir quote çağrısının kaydı — testler yönü ayırt edebilsin. */
interface Cagri {
  sell: string;
  buy: string;
  amount: bigint;
}

interface Rig {
  feed: CowFeed;
  store: PriceStore;
  slot(sembol: string): number;
  /** `null` döndürmek "rota yok", istisna atmak "API arızası" demektir. */
  setQuote(f: (c: Cagri) => bigint | null): void;
  cagrilar(): readonly Cagri[];
  tur(): Promise<void>;
  /** Geri çekilme penceresini kapatır — testte 15 dk beklenemez. */
  geriCekilmeyiBitir(): void;
  saglik(): ReturnType<CowFeed['health']>;
}

function rig(sembolSayisi = 2): Rig {
  const pairs: PairKey[] = SEMBOLLER.slice(0, sembolSayisi).map((s) => pairKey(s, 'USDT'));
  const store = new PriceStore(pairs, [VENUE]);

  const tokens: CowToken[] = pairs.map((p, i) => ({
    symbol: SEMBOLLER[i]!,
    address: `0x${String(i + 2).padStart(40, '0')}`,
    decimals: 18,
    pair: p,
    slot: store.resolveSlot(p, VENUE),
  }));

  let uretici: (c: Cagri) => bigint | null = () => null;
  const kayit: Cagri[] = [];

  const quoter: CowQuoter = {
    quote(sell, buy, amount) {
      const c = { sell, buy, amount };
      kayit.push(c);
      // Üretici istisna atarsa reject'e çeviriyoruz: feed'in "arıza" dalı
      // gerçek HttpCowQuoter'da da böyle tetikleniyor (5xx/timeout).
      try {
        return Promise.resolve(uretici(c));
      } catch (e) {
        return Promise.reject(e as Error);
      }
    },
  };

  const feed = new CowFeed(store, {
    venue: 'cow-base',
    chain: 'base',
    quoteToken: { address: USDC, decimals: 6 },
    tokens,
    tradeSize: TRADE,
    quoter,
  });

  return {
    feed,
    store,
    slot: (s) => store.resolveSlot(pairKey(s, 'USDT'), VENUE),
    setQuote: (f) => {
      uretici = f;
    },
    cagrilar: () => kayit,
    // `start()` zamanlayıcı da kurardı; testte yalnızca turu istiyoruz
    // (evm-feed.test.ts ile aynı yaklaşım).
    tur: () => (feed as unknown as { poll(): Promise<void> }).poll(),
    geriCekilmeyiBitir: () => {
      (feed as unknown as { geriCekilmeSonu: number }).geriCekilmeSonu = 0;
    },
    saglik: () => feed.health(),
  };
}

/** Alışta 1e18 birim verir, satışta girdinin `oran` katını USDC döndürür. */
function saglikliQuoter(oran = 1) {
  return (c: Cagri): bigint => {
    // USDC → token: $1000 karşılığı 1 token (18 hane)
    if (c.sell === USDC) return 10n ** 18n;
    // token → USDC: alınan miktarın karşılığı, `oran` kadar kayıpla
    return BigInt(Math.round(TRADE * 1e6 * oran));
  };
}

// ---------------------------------------------------------------------------
// Sağlıklı tur
// ---------------------------------------------------------------------------

test('sağlıklı turda durum live olur ve teşhis boş kalır', async () => {
  const r = rig();
  r.setQuote(saglikliQuoter());
  await r.tur();

  const h = r.saglik();
  assert.equal(h.state, 'live');
  assert.equal(h.lastError, null);
  assert.equal(h.subscribedCount, 2);
});

test('store gerçek MİKTARLI bid/ask alır — CoW quote orta fiyat değil', async () => {
  const r = rig(1);
  r.setQuote(saglikliQuoter());
  await r.tur();

  const slot = r.slot('AAA');
  // 1 token için $1000 ödendi → ask 1000; geri satışta $1000 alındı → bid 1000.
  assert.equal(r.store.ask(slot), TRADE);
  assert.equal(r.store.bid(slot), TRADE);
  // Miktarların SIFIR OLMAMASI kritik: Jupiter geniş taraması 0 yazıyor ve
  // tarayıcı onu "derinlik yok, doğrula" diye okuyor. CoW'un ayrı bir Aşama 2
  // doğrulayıcısı yok, dolayısıyla miktar buradan gelmek zorunda.
  assert.equal(r.store.askQty(slot), 1);
  assert.equal(r.store.bidQty(slot), 1);
});

test('satış bacağının girdisi alış bacağının ÇIKTISI olmalı', async () => {
  const r = rig(1);
  r.setQuote(saglikliQuoter());
  await r.tur();

  const [alis, satis] = r.cagrilar();
  assert.equal(alis!.sell, USDC);
  assert.equal(alis!.amount, AMOUNT_IN);
  // Sabit bir miktarla sormak farklı bir işlem büyüklüğünü fiyatlar ve
  // gidiş-dönüş spread'ini anlamsızlaştırırdı.
  assert.equal(satis!.buy, USDC);
  assert.equal(satis!.amount, 10n ** 18n);
});

// ---------------------------------------------------------------------------
// Spread eşiği
// ---------------------------------------------------------------------------

test('gidiş-dönüş spread eşiği aşılırsa store HİÇ yazılmaz', async () => {
  const r = rig(1);
  // Geri dönüşte %60 kayıp → spread eşiğin (%25) çok üstünde.
  r.setQuote(saglikliQuoter(0.4));
  await r.tur();

  assert.equal(r.store.hasData(r.slot('AAA')), false);
  const h = r.saglik();
  assert.match(h.lastError ?? '', /taşımıyor/);
});

test('eşiğin hemen altındaki spread yazılır — eşik geniş tutuldu', async () => {
  const r = rig(1);
  // %10 kayıp: DEX için normal, elenmemeli.
  r.setQuote(saglikliQuoter(0.9));
  await r.tur();

  assert.equal(r.store.hasData(r.slot('AAA')), true);
  assert.equal(r.saglik().state, 'live');
});

// ---------------------------------------------------------------------------
// "Rota yok" (veri) ile "API arızası" (arıza) ayrımı
// ---------------------------------------------------------------------------

test('hiçbir tokene rota yoksa teşhis likiditeyi suçlar, API\'yi değil', async () => {
  const r = rig();
  r.setQuote(() => null);
  await r.tur();

  const h = r.saglik();
  assert.match(h.lastError ?? '', /rota yok/);
  assert.match(h.lastError ?? '', /API'si sağlıklı/);
});

test('API patlarsa teşhis API der ve likidite yokluğuyla karışmaz', async () => {
  const r = rig();
  r.setQuote(() => {
    throw new Error('connection refused');
  });
  await r.tur();

  const h = r.saglik();
  assert.match(h.lastError ?? '', /CoW API/);
  // Karışsalardı kullanıcı yanlış tarafta arardı: biri uç nokta sorunu,
  // diğeri gerçekten likidite yokluğu.
  assert.doesNotMatch(h.lastError ?? '', /rota yok/);
});

test('AZINLIK istek hatası turu düşürmez — diğer tokenlar yazılır', async () => {
  const r = rig(3);
  const bbb = `0x${String(3).padStart(40, '0')}`;
  r.setQuote((c) => {
    if (c.sell === bbb || c.buy === bbb) throw new Error('502 bad gateway');
    return saglikliQuoter()(c);
  });
  await r.tur();

  // CANLI KOŞUDA ÖLÇÜLEN HATA: istisna `Promise.all`'dan sızıp tüm turu
  // düşürüyordu. 75 tokenda tur başına 150 istek var; birinin patlaması
  // neredeyse kesin, dolayısıyla feed kalıcı `failed` kalıyordu.
  assert.equal(r.saglik().state, 'live');
  assert.equal(r.store.hasData(r.slot('AAA')), true);
  assert.equal(r.store.hasData(r.slot('CCC')), true);
  assert.equal(r.store.hasData(r.slot('BBB')), false);
  // Gizlenmemeli de: kalıcı hale gelirse tek işaret bu satır.
  assert.match(r.saglik().lastError ?? '', /1 istek patladı/);
});

test('ÇOĞUNLUK istek hatası turu düşürür', async () => {
  const r = rig(3);
  const aaa = `0x${String(2).padStart(40, '0')}`;
  r.setQuote((c) => {
    if (c.sell === aaa || c.buy === aaa) return saglikliQuoter()(c);
    throw new Error('502 bad gateway');
  });
  await r.tur();
  await r.tur();
  await r.tur();

  // 3 tokenın 2'si patladı → gerçekten API tarafında bir sorun var.
  assert.equal(r.saglik().state, 'failed');
  assert.match(r.saglik().lastError ?? '', /2\/3 istek patladı/);
});

// ---------------------------------------------------------------------------
// "Rota yok" ile "engellendik" ayrımı — ayırt edici işaret HTTP kodu DEĞİL
// ---------------------------------------------------------------------------

test('CoW\'un kendi hata JSON\'u "rota yok" sayılır', () => {
  assert.equal(cowHatasiMi('{"errorType":"NoLiquidity","description":"no route"}'), true);
  assert.equal(cowHatasiMi('{"errorType":"SellAmountDoesNotCoverFee"}'), true);
});

test('CDN\'in HTML 403\'ü "rota yok" SAYILMAZ', () => {
  // ÖLÇÜLEN HATA: her 4xx null (= rota yok) sayılıyordu ve CloudFront bloğu
  // (403 + HTML) 75 tokenın 75'i için "hiçbirine rota yok" olarak
  // raporlanıyordu — altyapı sorunu likidite sorunu gibi görünüyordu.
  assert.equal(cowHatasiMi('<!DOCTYPE HTML><HTML><H1>403 ERROR</H1></HTML>'), false);
  assert.equal(cowHatasiMi(''), false);
  // JSON ama CoW'un hata biçimi değil → yine güvenilmez.
  assert.equal(cowHatasiMi('{"message":"forbidden"}'), false);
});

test('alış geçip satış geçmezse tek yönlü likidite olarak raporlanır', async () => {
  const r = rig();
  r.setQuote((c) => (c.sell === USDC ? 10n ** 18n : null));
  await r.tur();

  assert.match(r.saglik().lastError ?? '', /satış tarafı fiyatlanamadı/);
});

// ---------------------------------------------------------------------------
// Tolerans: tek kötü tur paneli kızartmamalı
// ---------------------------------------------------------------------------

test('durum ancak üç kötü turdan sonra failed olur', async () => {
  const r = rig();
  r.setQuote(() => null);

  await r.tur();
  assert.notEqual(r.saglik().state, 'failed', 'tek hıçkırık arıza değildir');
  await r.tur();
  assert.notEqual(r.saglik().state, 'failed');
  await r.tur();
  assert.equal(r.saglik().state, 'failed');
});

test('art arda hata sonrası geri çekilir — bloklu uca yüklenmeye devam etmez', async () => {
  const r = rig(1);
  r.setQuote(() => {
    throw new Error('CoW erişimi engellendi (HTTP 403, JSON olmayan cevap)');
  });

  // Tolerans (3 tur) dolana kadar normal hızda denenir.
  await r.tur();
  await r.tur();
  await r.tur();
  const cagriToleransSonu = r.cagrilar().length;
  assert.equal(r.saglik().state, 'failed');
  assert.match(r.saglik().lastError ?? '', /sn bekleniyor/);

  // Bundan sonraki tetiklemeler pencere dolana kadar HİÇ istek atmamalı:
  // engellenmiş bir uca sabit hızla yüklenmek bloğu uzatıyor.
  await r.tur();
  await r.tur();
  assert.equal(r.cagrilar().length, cagriToleransSonu, 'geri çekilme penceresinde istek atılmamalı');
});

test('kısmi başarı gizlenmez: bir token fiyatlanamazsa panelde iz bırakır', async () => {
  const r = rig(2);
  // AAA sağlıklı, BBB'ye rota yok. Feed live kalmalı ama sebep görünmeli.
  const bbb = `0x${String(3).padStart(40, '0')}`;
  r.setQuote((c) => {
    if (c.sell === bbb || c.buy === bbb) return null;
    return saglikliQuoter()(c);
  });

  // Eleme listesi ancak NO_ROUTE_ROUNDS (20) tur sonra dolar; o ana kadar
  // token her turda yeniden denenir.
  for (let i = 0; i < 21; i++) await r.tur();

  const h = r.saglik();
  assert.equal(h.state, 'live', 'bir token düşse de feed live kalmalı');
  assert.match(h.lastError ?? '', /rota yok: BBB/);
});

test('rotasız token sorgudan çıkarılır — her tur iki istek yakmasın', async () => {
  const r = rig(2);
  const bbb = `0x${String(3).padStart(40, '0')}`;
  r.setQuote((c) => {
    if (c.sell === bbb || c.buy === bbb) return null;
    return saglikliQuoter()(c);
  });

  for (let i = 0; i < 20; i++) await r.tur();
  const oncesi = r.cagrilar().length;
  await r.tur();
  const sonrasi = r.cagrilar().length;

  // 21. turda yalnızca AAA sorulmalı: 2 istek (alış + satış).
  assert.equal(sonrasi - oncesi, 2);
});

test('API arızası tokenları rotasız ilan ETMEZ', async () => {
  const r = rig(1);
  r.setQuote(() => {
    throw new Error('timeout');
  });
  for (let i = 0; i < 25; i++) await r.tur();

  // Arıza sırasında sayaç artsaydı token kalıcı olarak elenirdi ve API
  // düzeldiğinde bir daha hiç sorulmazdı.
  r.setQuote(saglikliQuoter());
  // Geri çekilme penceresini atla — testte 15 dk beklenemez. Private alana
  // cast'le erişmek `poll()` çağrısıyla aynı yaklaşım (bkz. rig).
  r.geriCekilmeyiBitir();
  await r.tur();
  assert.equal(r.store.hasData(r.slot('AAA')), true);
});

test('geri çekilme sonrası uç düzelirse feed kendi kendine toparlanır', async () => {
  const r = rig(1);
  r.setQuote(() => {
    throw new Error('CoW erişimi engellendi (HTTP 403, JSON olmayan cevap)');
  });
  for (let i = 0; i < 5; i++) await r.tur();
  assert.equal(r.saglik().state, 'failed');

  // Tavanın sonsuz OLMAMASININ sebebi bu: blok geçici ve feed'in insan
  // müdahalesi olmadan geri dönebilmesi gerekir.
  r.setQuote(saglikliQuoter());
  r.geriCekilmeyiBitir();
  await r.tur();
  assert.equal(r.saglik().state, 'live');
  assert.equal(r.store.hasData(r.slot('AAA')), true);
});
