/**
 * EvmDexFeed durum makinesi.
 *
 * Testlerin konusu quote matematiği değil, TEŞHİS: "failed" tek etiketinin
 * altında üç ayrı sebep vardı (RPC arızası / havuz yok / tek yönlü likidite)
 * ve panelde ayırt edilemiyordu. Ölçüm şunu gösterdi: `mainnet.base.org` aynı
 * multicall'a arka arkaya farklı cevap veriyor (10 turun 7'sinde sıfır token),
 * Arbitrum'un RPC'si ise sorunsuz — oradaki tek eksik `MAGIC` için doğrudan
 * USDC havuzu olmaması. İki sorunun çözümü tamamen farklı, dolayısıyla
 * durumun ikisini ayırt etmesi şart.
 *
 * `MulticallClient` arayüzü dar tutulduğu için buradaki hiçbir test ağa
 * çıkmıyor.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EvmDexFeed, type MulticallClient, type EvmToken } from '../src/feeds/dex/evm.ts';
import { PriceStore } from '../src/book/price-store.ts';
import { pairKey, type PairKey, type VenueId } from '../src/core/types.ts';
import { ContractFunctionRevertedError, HttpRequestError } from 'viem';

const USDC = '0x0000000000000000000000000000000000000001' as const;
const SEMBOLLER = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'] as const;
/** Varsayılan rig boyutu — çoğu test iki token ile yeterince şey anlatıyor. */
const VARSAYILAN = 2;

type Tur = { status: 'success' | 'failure'; result?: unknown; error?: unknown };

/** `getAmountsOut` (Aerodrome) biçiminde başarılı sonuç — SON eleman miktar. */
const ok = (miktar: bigint): Tur => ({ status: 'success', result: [0n, miktar] });

/**
 * UniV3 QuoterV2 biçiminde başarılı sonuç:
 * `(amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate)`.
 *
 * Son eleman gas tahmini ve o da bigint — sahteyi gerçeğe birebir uydurmak
 * şart, çünkü feed bir dönem miktar yerine tam olarak o alanı okuyordu ve
 * `[0n, miktar]` biçimindeki bir sahte bunu HİÇ yakalayamazdı.
 */
const okUni = (miktar: bigint): Tur => ({
  status: 'success',
  result: [miktar, 0n, 0, 120_000n],
});
const revert = (): Tur => ({ status: 'failure' });

interface Rig {
  feed: EvmDexFeed;
  /** Sıradaki turda dönecek sonuçlar; `null` verilirse istisna atılır. */
  setSonuc(f: (contracts: unknown[]) => Tur[] | null): void;
  cagriSayisi(): number;
  tur(): Promise<void>;
  saglik(): ReturnType<EvmDexFeed['health']>;
}

function rig(sembolSayisi: number = VARSAYILAN): Rig {
  const pairs: PairKey[] = SEMBOLLER.slice(0, sembolSayisi).map((s) => pairKey(s, 'USDT'));
  const venues: VenueId[] = ['aerodrome'];
  const store = new PriceStore(pairs, venues);

  const tokens: EvmToken[] = pairs.map((p, i) => ({
    symbol: SEMBOLLER[i]!,
    address: `0x${String(i + 2).padStart(40, '0')}` as `0x${string}`,
    decimals: 18,
    pair: p,
    slot: store.resolveSlot(p, 'aerodrome'),
  }));

  let uretici: (contracts: unknown[]) => Tur[] | null = () => [];
  let cagri = 0;

  const client: MulticallClient = {
    multicall({ contracts }) {
      cagri++;
      const r = uretici(contracts as unknown[]);
      if (r === null) return Promise.reject(new Error('connection refused'));
      return Promise.resolve(r);
    },
  };

  const feed = new EvmDexFeed(store, {
    venue: 'aerodrome',
    chain: 'base',
    rpcUrl: 'http://test.invalid',
    client,
    quoteToken: { address: USDC, decimals: 6 },
    tokens,
    tradeSize: 1000,
    aerodrome: { router: USDC, factory: USDC },
  });

  return {
    feed,
    setSonuc: (f) => {
      uretici = f;
    },
    cagriSayisi: () => cagri,
    // `start()` bir tur çalıştırıp zamanlayıcı kurardı; testte yalnızca turu
    // istiyoruz. private poll'u çağırmak, scanner testlerindeki
    // `ScannerInternals` yaklaşımının aynısı.
    tur: () => (feed as unknown as { poll(): Promise<void> }).poll(),
    saglik: () => feed.health(),
  };
}

/** Alış turu tüm tokenlar için başarılı, satış turu da öyle. */
function hepsiBasarili(contracts: unknown[]): Tur[] {
  return contracts.map(() => ok(10n ** 18n));
}

// ---------------------------------------------------------------------------
// Sağlıklı tur
// ---------------------------------------------------------------------------

test('tüm quoteler geçerse durum live ve teşhis boş', async () => {
  const r = rig();
  r.setSonuc(hepsiBasarili);
  await r.tur();

  const h = r.saglik();
  assert.equal(h.state, 'live');
  assert.equal(h.lastError, null);
  assert.equal(h.subscribedCount, 2, 'quote token sayıya dahil edilmemeli');
});

// ---------------------------------------------------------------------------
// Üç ayrı başarısızlık sebebi
// ---------------------------------------------------------------------------

test('RPC patlarsa teşhis "RPC" der ve havuz yokluğuyla karışmaz', async () => {
  const r = rig();
  r.setSonuc(() => null);
  await r.tur();

  const h = r.saglik();
  assert.match(h.lastError ?? '', /^RPC:/);
  assert.ok(!/havuz/.test(h.lastError ?? ''), 'havuz teşhisiyle karışmamalı');
});

test('hepsi revert ederse teşhis rota/kontrat sorununu işaret eder', async () => {
  const r = rig();
  r.setSonuc((c) => c.map(() => revert()));
  await r.tur();

  const h = r.saglik();
  assert.match(h.lastError ?? '', /havuz yok/);
  assert.match(h.lastError ?? '', /RPC değil/, 'RPC ile karıştırılmamalı');
});

test('alış geçip satış geçmezse tek yönlü likidite olarak raporlanır', async () => {
  const r = rig();
  let n = 0;
  r.setSonuc((c) => {
    n++;
    return n === 1 ? c.map(() => ok(10n ** 18n)) : c.map(() => revert());
  });
  await r.tur();

  assert.match(r.saglik().lastError ?? '', /satış tarafı/);
});

// ---------------------------------------------------------------------------
// Tolerans
// ---------------------------------------------------------------------------

test('tek kötü tur durumu failed yapmaz — panel hıçkırıkla kızarmamalı', async () => {
  const r = rig();
  r.setSonuc(hepsiBasarili);
  await r.tur();
  assert.equal(r.saglik().state, 'live');

  r.setSonuc(() => null);
  await r.tur();

  const h = r.saglik();
  assert.equal(h.state, 'live', 'ilk kötü turda hâlâ live olmalı');
  assert.match(h.lastError ?? '', /1\/3 tur/, 'ama sebep görünmeli');
});

test('art arda üç kötü tur sonunda failed', async () => {
  const r = rig();
  r.setSonuc(hepsiBasarili);
  await r.tur();

  r.setSonuc(() => null);
  await r.tur();
  await r.tur();
  assert.equal(r.saglik().state, 'live');
  await r.tur();
  assert.equal(r.saglik().state, 'failed');
});

test('araya giren iyi tur seriyi sıfırlar', async () => {
  const r = rig();
  r.setSonuc(() => null);
  await r.tur();
  await r.tur();

  r.setSonuc(hepsiBasarili);
  await r.tur();
  assert.equal(r.saglik().state, 'live');

  r.setSonuc(() => null);
  await r.tur();
  assert.equal(r.saglik().state, 'live', 'seri sıfırlandığı için tolerans yeniden başlamalı');
});

// ---------------------------------------------------------------------------
// Multicall bölme
//
// `aggregate3` tüm çağrıları TEK eth_call ve TEK gas bütçesiyle çalıştırır.
// Ölçüldü (Arbitrum/Camelot): n=4 → 4/4, n=5 → 4/5 (yalnızca havuzsuz token
// düştü), n=6 → 0/6 — yani revert eden bir çağrı ortak bütçeyi tüketip
// alakasız çağrıları da düşürüyor. `allowFailure: true` buna çare değil.
// ---------------------------------------------------------------------------

test('quoteler gruplara bölünür — tek istekte gas bütçesi taşmasın', async () => {
  const r = rig(6);
  const boyutlar: number[] = [];
  r.setSonuc((c) => {
    boyutlar.push(c.length);
    return c.map(() => ok(10n ** 18n));
  });
  await r.tur();

  assert.ok(boyutlar.length > 1, '6 quote tek istekte gönderilmemeliydi');
  assert.ok(
    boyutlar.every((n) => n <= 4),
    `grup boyutu 4'ü aşmamalı, görülen: ${boyutlar.join(',')}`,
  );
});

test('bölünmüş sonuçlar girdi sırasında birleşir', async () => {
  // İndeks eşlemesi bozulursa fiyatlar YANLIŞ token'a yazılır — sessiz ve
  // en pahalı hata sınıfı. Her token'a farklı miktar verip ayırt ediyoruz.
  const r = rig(6);
  let cagri = 0;
  r.setSonuc((c) => {
    cagri++;
    // Alış turları önce gelir (6 quote → 2 grup), sonra satış turları.
    return c.map((sozlesme) => {
      // Sözleşmenin hedef adresi son argümandaki token; sırayı ondan doğrula.
      const args = (sozlesme as { args: unknown[] }).args;
      void args;
      return ok(10n ** 18n);
    });
  });
  await r.tur();

  assert.equal(cagri, 4, '6 alış (2 grup) + 6 satış (2 grup)');
  assert.equal(r.saglik().state, 'live');
  assert.equal(r.saglik().lastError, null, 'hiçbir token kaybolmamalı');
});

// ---------------------------------------------------------------------------
// Rotasız token eleme
// ---------------------------------------------------------------------------

test('hep başarısız token rotasız ilan edilir ve sorgudan çıkar', async () => {
  const r = rig();
  // İlk token hep revert, ikincisi hep başarılı.
  r.setSonuc((c) => c.map((_, i) => (i === 0 && c.length === 2 ? revert() : ok(10n ** 18n))));

  for (let i = 0; i < 20; i++) await r.tur();

  const h = r.saglik();
  assert.equal(h.state, 'live', 'diğer token fiyatlandığı için feed sağlıklı');
  assert.match(h.lastError ?? '', /havuz yok: AAA/, 'kısmi başarı gizlenmemeli');

  // Artık yalnızca tek token sorgulanmalı.
  let sonBoyut = -1;
  r.setSonuc((c) => {
    sonBoyut = c.length;
    return c.map(() => ok(10n ** 18n));
  });
  await r.tur();
  assert.equal(sonBoyut, 1, 'rotasız token sorgudan çıkarılmalıydı');
});

test('RPC arızası tokenları rotasız ilan ETMEZ', async () => {
  // En kritik özellik: Base ölçümünde 10 turun 7'si sıfır döndü. Seri RPC
  // hatasında da artsaydı, sağlam bir uç noktaya geçtiğimizde bütün tablo
  // rotasız işaretlenmiş olurdu.
  const r = rig();
  r.setSonuc(() => null);
  for (let i = 0; i < 30; i++) await r.tur();

  r.setSonuc((c) => {
    assert.equal(c.length, 2, 'RPC düzelince tüm tokenlar yeniden sorgulanmalı');
    return c.map(() => ok(10n ** 18n));
  });
  await r.tur();

  const h = r.saglik();
  assert.equal(h.state, 'live');
  assert.equal(h.lastError, null, 'hiçbir token rotasız sayılmamalıydı');
});

test('RPC taşıma hatası `failure` GİRDİSİ olarak gelse de arıza sayılır (viem allowFailure)', async () => {
  // viem `allowFailure: true` ile ağ hatasını FIRLATMAZ; her çağrıyı
  // `{status:'failure', error}` yapar. Üstteki testin sahtesi `reject` ettiği
  // için gerçeği temsil etmiyordu: canlıda RPC çökünce tokenlar rotasız ilan
  // ediliyor, venue `idle`'a düşüyor ve RPC düzelse bile 100 tur kör kalıyordu
  // (127.0.0.1:9 ile ölçüldü, 22 turda hepsi idle).
  const r = rig();
  const agHatasi = (): Tur =>
    ({
      status: 'failure',
      error: new HttpRequestError({ url: 'http://test.invalid', details: 'connection refused' }),
    }) as Tur;
  r.setSonuc((c) => c.map(agHatasi));
  for (let i = 0; i < 30; i++) await r.tur();

  const bozuk = r.saglik();
  assert.equal(bozuk.state, 'failed');
  assert.match(bozuk.lastError ?? '', /RPC:/, 'teşhis RPC demeli, "havuz yok" değil');

  r.setSonuc((c) => {
    assert.equal(c.length, 2, 'RPC düzelince tüm tokenlar yeniden sorgulanmalı');
    return c.map(() => ok(10n ** 18n));
  });
  await r.tur();
  const h = r.saglik();
  assert.equal(h.state, 'live');
  assert.equal(h.lastError, null, 'hiçbir token rotasız sayılmamalıydı');
});

test('kontrat revert\'i veri sayılır, arıza değil (failure + revert hatası)', async () => {
  // Ters yön de sabit: viem revert'i de `failure` girdisi yapar ama o VERİDİR
  // (havuz yok). Taşıma arızası sayılsaydı havuzsuz tek token tüm turu
  // düşürürdü.
  const r = rig(1);
  const revertHatasi = (): Tur =>
    ({
      status: 'failure',
      error: new ContractFunctionRevertedError({ abi: [], functionName: 'getAmountsOut' }),
    }) as Tur;
  r.setSonuc((c) => c.map(revertHatasi));
  for (let i = 0; i < 3; i++) await r.tur();
  const h = r.saglik();
  assert.equal(h.state, 'failed');
  assert.match(h.lastError ?? '', /havuz yok/, 'revert veri: havuz yok');
  assert.doesNotMatch(h.lastError ?? '', /RPC:/, 'revert RPC arızası gibi raporlanmamalı');
});

// ---------------------------------------------------------------------------
// İnce havuz — teknik başarı ≠ ekonomik kullanılabilirlik
// ---------------------------------------------------------------------------

/**
 * Alış turunda her token 1000 birim veriyor; satış turunda dönen quote
 * miktarını token bazında seçiyoruz. ask = 1000/1000 = 1 olduğu için
 * spread doğrudan satış miktarından çıkıyor:
 *   990 → %1 (sağlıklı) · 10 → %9900 (havuz devrilmiş)
 */
function satisIle(...quotePerToken: bigint[]) {
  let cagri = 0;
  return (c: unknown[]): Tur[] => {
    cagri++;
    if (cagri % 2 === 1) return c.map(() => ok(1000n * 10n ** 18n));
    return c.map((_, i) => ok((quotePerToken[i] ?? 990n) * 10n ** 6n));
  };
}

test("taşınamayacak spread store'a YAZILMAZ", async () => {
  // Ölçüldü (Base/Aerodrome, $1000): BRETT gidiş-dönüş %3389. `getAmountsOut`
  // başarıyla dönüyor, ama bu bir fiyat değil, havuzun devrilmesi.
  const r = rig(1);
  r.setSonuc(satisIle(10n));
  await r.tur();

  const h = r.saglik();
  assert.match(h.lastError ?? '', /taşımıyor/);
  assert.match(h.lastError ?? '', /WETH/, 'çözümün yönü teşhiste olmalı');
  assert.ok(
    !/satış tarafı/.test(h.lastError ?? ''),
    'satış BAŞARILI oldu, sonucu biz reddettik — karıştırılmamalı',
  );
});

test('ince havuz "havuz yok"tan ayrı raporlanır — çözümleri farklı', async () => {
  // AAA ince, BBB sağlıklı: feed live kalmalı ama AAA iz bırakmalı.
  const r = rig(2);
  r.setSonuc(satisIle(10n, 990n));
  for (let i = 0; i < 20; i++) await r.tur();

  const h = r.saglik();
  assert.equal(h.state, 'live', 'BBB fiyatlandığı için feed sağlıklı');
  assert.match(h.lastError ?? '', /havuz ince: AAA/);
  assert.ok(!/havuz yok/.test(h.lastError ?? ''), 'havuz yokluğuyla karıştırılmamalı');
});

test('makul spread yazılır — eşik gerçek fırsatı elemez', async () => {
  // %11 spread: geniş ama taşınabilir. Ölçümdeki PLAY (%13) ve OFC (%16.7)
  // bu tarafta kalmalı, çünkü bu değerler işlem büyüklüğümüze özgü.
  const r = rig(1);
  r.setSonuc(satisIle(900n));
  await r.tur();

  const h = r.saglik();
  assert.equal(h.state, 'live');
  assert.equal(h.lastError, null);
});

// ---------------------------------------------------------------------------
// Uniswap V3: fee tier başına ayrı quote, en iyi çıktı seçilir
//
// ÖLÇÜLDÜ (Arbitrum, doğrudan USDC): UNI için fee=500 havuzu 0.2973 döndürdü,
// fee=3000 havuzu 3.9384 — gerçek fiyat ~4. Yani 500'lük havuz VAR, çağrı
// revert etmiyor ("başarılı"), ama içi boş. Tek tier'ı sabit seçen eski kod
// (`feeTiers[1]`) bu tokenı sessizce dörtte bir fiyatla fiyatlardı: sahte
// sinyal üretmeye en müsait hata biçimi, çünkü hiçbir yerde hata görünmüyor.
// ---------------------------------------------------------------------------

/** Uniswap V3 yapılandırmalı rig — üç fee tier. */
function univ3Rig(tiers: number[] = [500, 3000, 10000]) {
  const pair = pairKey('AAA', 'USDT');
  const store = new PriceStore([pair], ['uniswap-v3'] as VenueId[]);
  let uretici: (contracts: unknown[]) => Tur[] = () => [];
  const gorulen: unknown[][] = [];

  const client: MulticallClient = {
    multicall({ contracts }) {
      gorulen.push(contracts as unknown[]);
      return Promise.resolve(uretici(contracts as unknown[]));
    },
  };

  const feed = new EvmDexFeed(store, {
    venue: 'uniswap-v3',
    chain: 'arbitrum',
    rpcUrl: 'http://test.invalid',
    client,
    quoteToken: { address: USDC, decimals: 6 },
    tokens: [
      {
        symbol: 'AAA',
        address: '0x0000000000000000000000000000000000000002',
        decimals: 18,
        pair,
        slot: store.resolveSlot(pair, 'uniswap-v3'),
      },
    ],
    tradeSize: 1000,
    uniswapV3: { quoterV2: USDC, feeTiers: tiers },
  });

  return {
    store,
    pair,
    gorulen,
    setSonuc: (f: (c: unknown[]) => Tur[]) => {
      uretici = f;
    },
    tur: () => (feed as unknown as { poll(): Promise<void> }).poll(),
    saglik: () => feed.health(),
  };
}

test('uniswap v3: her fee tier için ayrı quote gönderilir', async () => {
  const r = univ3Rig([500, 3000, 10000]);
  r.setSonuc((c) => c.map(() => okUni(1000n * 10n ** 18n)));
  await r.tur();

  // Tek token, tek yön → üç çağrı. Tier sayısı kadar quote gitmezse
  // "en iyiyi seç" kuralının seçecek bir şeyi kalmaz.
  const toplamAlis = r.gorulen[0]!.length;
  assert.equal(toplamAlis, 3, 'üç tier için üç çağrı bekleniyordu');
});

test('uniswap v3: tier’lar arasından EN İYİ çıktı seçilir', async () => {
  const r = univ3Rig([500, 3000, 10000]);
  // Alış turu: sırasıyla boş havuz / iyi havuz / orta havuz.
  // İyi havuz seçilmezse token miktarı düşük kalır ve ask fiyatı şişer.
  let cagri = 0;
  r.setSonuc((c) => {
    cagri++;
    if (cagri === 1) {
      return [okUni(75n * 10n ** 18n), okUni(1000n * 10n ** 18n), okUni(500n * 10n ** 18n)];
    }
    // Satış turu: her tier KENDİ aldığı miktarı geri satıyor; %1 spread için
    // 990 USDC döndürüyoruz, yani tier'lar arası fark yalnızca alış tarafında.
    return c.map(() => okUni(990n * 10n ** 6n));
  });
  await r.tur();

  const slot = r.store.resolveSlot(r.pair, 'uniswap-v3');
  // 1000 USDC ile 1000 token alındıysa ask = 1. Boş havuz (75 token) seçilseydi
  // ask ≈ 13.3 olurdu.
  assert.equal(r.store.ask(slot), 1, 'en iyi tier seçilmemiş — ask yanlış');
  assert.equal(r.saglik().state, 'live');
});

test('uniswap v3: tier’ların bir kısmı revert etse de sağlam olan kullanılır', async () => {
  const r = univ3Rig([500, 3000, 10000]);
  // GRT sınıfı: yalnızca en yüksek tier'da havuz var.
  let cagri = 0;
  r.setSonuc((c) => {
    cagri++;
    if (cagri === 1) return [revert(), revert(), okUni(1000n * 10n ** 18n)];
    return c.map(() => okUni(990n * 10n ** 6n));
  });
  await r.tur();

  assert.equal(r.saglik().state, 'live', 'tek sağlam tier yeterli olmalıydı');
  assert.equal(r.store.ask(r.store.resolveSlot(r.pair, 'uniswap-v3')), 1);
});

test('rotasız token belirli aralıklarla yeniden denenir', async () => {
  const r = rig();
  r.setSonuc((c) => c.map((_, i) => (i === 0 && c.length === 2 ? revert() : ok(10n ** 18n))));
  for (let i = 0; i < 20; i++) await r.tur();

  // 100. turda hepsi yeniden denenmeli — havuz sonradan açılmış olabilir.
  const boyutlar: number[] = [];
  r.setSonuc((c) => {
    boyutlar.push(c.length);
    return c.map(() => ok(10n ** 18n));
  });
  for (let i = 20; i < 101; i++) await r.tur();

  assert.ok(boyutlar.includes(2), 'yeniden deneme turu hiç gelmedi');
});

// ---------------------------------------------------------------------------
// 2 adımlı rota (ara token = WETH)
// ---------------------------------------------------------------------------
//
// Base'de likidite ağırlıklı olarak WETH ile eşleşiyor; doğrudan token↔USDC
// havuzu ya yok ya toz. ÖLÇÜLDÜ (KTA/Aerodrome): doğrudan rota $1000 karşılığı
// 0.0109 KTA veriyor (fiilen bozuk), WETH üzerinden 10522 KTA — ask $0.0950,
// bid $0.0938, spread %1.36, CEX referansı $0.0932–0.0940. Yani 2 adımlı rota
// yalnızca kapsam açmıyor, DOĞRU fiyatı veren rota o.

const WETH = '0x000000000000000000000000000000000000dead' as const;

function rigHop(): {
  gruplar(): unknown[][];
  tur(): Promise<void>;
  store: PriceStore;
  slot: number;
  setSonuc(f: (contracts: unknown[]) => Tur[]): void;
} {
  const pair = pairKey('AAA', 'USDT');
  const store = new PriceStore([pair], ['aerodrome'] as VenueId[]);
  const gruplar: unknown[][] = [];
  let uretici: (c: unknown[]) => Tur[] = (c) => c.map(() => ok(10n ** 18n));

  const feed = new EvmDexFeed(store, {
    venue: 'aerodrome',
    chain: 'base',
    rpcUrl: 'http://test.invalid',
    client: {
      multicall({ contracts }) {
        gruplar.push(contracts as unknown[]);
        return Promise.resolve(uretici(contracts as unknown[]));
      },
    },
    quoteToken: { address: USDC, decimals: 6 },
    tokens: [
      {
        symbol: 'AAA',
        address: '0x0000000000000000000000000000000000000002',
        decimals: 18,
        pair,
        slot: store.resolveSlot(pair, 'aerodrome'),
      },
    ],
    tradeSize: 1000,
    aerodrome: { router: USDC, factory: USDC },
    hopToken: WETH,
  });

  return {
    gruplar: () => gruplar,
    tur: () => (feed as unknown as { poll(): Promise<void> }).poll(),
    store,
    slot: store.resolveSlot(pair, 'aerodrome'),
    setSonuc: (f) => {
      uretici = f;
    },
  };
}

/** Bir çağrının Aerodrome rota dizisindeki adım sayısı. */
function adimSayisi(call: unknown): number {
  const args = (call as { args: [bigint, unknown[]] }).args;
  return args[1].length;
}

test('hopToken verilince hem doğrudan HEM 2 adımlı rota sorulur', async () => {
  const r = rigHop();
  await r.tur();

  const alis = r.gruplar()[0]!;
  assert.equal(alis.length, 2, 'tek token için iki aday rota');
  assert.equal(adimSayisi(alis[0]), 1, 'ilk rota doğrudan');
  assert.equal(adimSayisi(alis[1]), 2, 'ikinci rota ara token üzerinden');
});

test('satış bacağı ALIŞIN YAPILDIĞI rotadan sorulur', async () => {
  const r = rigHop();
  // Yalnızca 2 adımlı rota çalışsın: doğrudan havuz yok (KTA'nın gerçek durumu).
  r.setSonuc((c) => c.map((call) => (adimSayisi(call) === 2 ? ok(10n ** 18n) : revert())));
  await r.tur();

  // İkinci multicall satış bacağı; tek aday kaldığı için tek çağrı olmalı ve
  // o da 2 adımlı. Bir rotadan alıp başkasından satmak gerçekleştirilemeyecek
  // bir işlemi fiyatlar.
  const satis = r.gruplar()[1]!;
  assert.equal(satis.length, 1);
  assert.equal(adimSayisi(satis[0]), 2);
});

test('doğrudan rota BOZUKSA 2 adımlı rota tokenı kurtarır', async () => {
  const r = rigHop();
  // Doğrudan rota absürt az token veriyor (toz havuz) → gidiş-dönüş patlar.
  // 2 adımlı rota sağlıklı: 1000 USDC → 10 token, geri 995 USDC.
  r.setSonuc((c) =>
    c.map((call) => {
      const iki = adimSayisi(call) === 2;
      const args = (call as { args: [bigint, unknown[]] }).args;
      const gelen = args[0];
      // Satış bacağı: girdi token miktarı (18 hane)
      if (gelen > 10n ** 12n) return ok(iki ? 995n * 10n ** 6n : 1n);
      return ok(iki ? 10n * 10n ** 18n : 1n);
    }),
  );
  await r.tur();

  assert.equal(r.store.hasData(r.slot), true, '2 adımlı rota yazılmalı');
  // ask = 1000 / 10 = 100
  assert.equal(Math.round(r.store.ask(r.slot)), 100);
});

// ---------------------------------------------------------------------------
// Tur süresi uyarısı — kayan pencere
//
// Regresyon: uyarı, tur süresinin minimumunu KOŞUNUN TAMAMI üzerinden
// alıyordu ve hiç sıfırlanmıyordu. Ölçülen bedeli şuydu — ilk dakikadaki
// 6.1 sn'lik aerodrome turu, sonraki 10 dakika boyunca her tur 59–64 sn
// sürerken (bütçe 30 sn) uyarıyı KALICI olarak susturdu. Yani bozulmayı
// gösterecek olan araç, sonradan başlayan bozulmaya karşı kördü.
//
// Saat `mock.timers` ile sahte: tur süresi = poll içindeki `Date.now()`
// farkı, o yüzden ilerletmeyi multicall'ın içinden yapıyoruz.
// ---------------------------------------------------------------------------

/**
 * Tur süresini denetlenebilir kılan rig — her multicall saati ilerletir.
 *
 * `tick` DIŞARIDAN veriliyor: `t.mock` teste özel bir örnek ve test bitince
 * kendini geri alıyor; modül seviyesindeki global `mock` ile karıştırmak
 * "MockTimers enable edilmedi" hatası veriyordu.
 */
function rigSure(tick: (ms: number) => void): {
  tur(adimMs: number): Promise<void>;
  uyari(): string | null;
} {
  const pairs: PairKey[] = [pairKey('AAA', 'USDT')];
  const store = new PriceStore(pairs, ['aerodrome'] as VenueId[]);
  const tokens: EvmToken[] = [
    {
      symbol: 'AAA',
      address: `0x${'2'.padStart(40, '0')}` as `0x${string}`,
      decimals: 18,
      pair: pairs[0]!,
      slot: store.resolveSlot(pairs[0]!, 'aerodrome'),
    },
  ];

  let adim = 0;
  const client: MulticallClient = {
    multicall({ contracts }) {
      // Turun geçen süresi buradan birikiyor; kaç multicall'a bölündüğü
      // testin konusu değil, bu yüzden çağrı başına eşit pay veriliyor.
      tick(adim);
      return Promise.resolve((contracts as unknown[]).map(() => ok(10n ** 18n)));
    },
  };

  const feed = new EvmDexFeed(store, {
    venue: 'aerodrome',
    chain: 'base',
    rpcUrl: 'http://test.invalid',
    client,
    quoteToken: { address: USDC, decimals: 6 },
    tokens,
    tradeSize: 1000,
    maxPriceAgeMs: 30_000,
    aerodrome: { router: USDC, factory: USDC },
  });

  return {
    tur: (adimMs) => {
      // Tek token → alış ve satış olmak üzere iki multicall.
      adim = Math.floor(adimMs / 2);
      return (feed as unknown as { poll(): Promise<void> }).poll();
    },
    uyari: () => feed.health().lastError,
  };
}

const YAVAS = 40_000; // bütçe 30 sn
const HIZLI = 2_000;

test('sürekli yavaş tur bayatlık uyarısı üretir', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const r = rigSure((ms) => t.mock.timers.tick(ms));
  for (let i = 0; i < 5; i++) await r.tur(YAVAS);

  assert.match(r.uyari() ?? '', /bayatlık eşiği/);
  assert.match(r.uyari() ?? '', /taranamaz/);
});

test('tek yavaş tur uyarı ÜRETMEZ — hıçkırık arıza değildir', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const r = rigSure((ms) => t.mock.timers.tick(ms));
  for (let i = 0; i < 3; i++) await r.tur(HIZLI);
  await r.tur(YAVAS);

  assert.equal(r.uyari(), null);
});

test('SONRADAN başlayan bozulma da uyarı üretir', async (t) => {
  // Asıl regresyon: erken bir hızlı tur, minimumu koşu boyunca tutan eski
  // kodda uyarıyı sonsuza kadar susturuyordu.
  t.mock.timers.enable({ apis: ['Date'] });
  const r = rigSure((ms) => t.mock.timers.tick(ms));
  for (let i = 0; i < 3; i++) await r.tur(HIZLI);
  assert.equal(r.uyari(), null, 'ısınma turları uyarı üretmemeli');

  for (let i = 0; i < 5; i++) await r.tur(YAVAS);
  assert.match(r.uyari() ?? '', /bayatlık eşiği/, 'sonradan bozulma görünmeli');
});

test('bozulma geçince uyarı KALKAR', async (t) => {
  // Uyarı kurulabildiği gibi kalkabilmeli: RPC takılması geçici olabilir ve
  // kalıcı bir uyarı, bir sonraki gerçek bozulmayı görünmez yapar.
  t.mock.timers.enable({ apis: ['Date'] });
  const r = rigSure((ms) => t.mock.timers.tick(ms));
  for (let i = 0; i < 5; i++) await r.tur(YAVAS);
  assert.notEqual(r.uyari(), null);

  for (let i = 0; i < 5; i++) await r.tur(HIZLI);
  assert.equal(r.uyari(), null);
});
