/**
 * TransferInfoProvider — ağa çıkmayan kısımlar.
 *
 * Zincir adı normalizasyonu, botun en sinsi hata kaynaklarından biri: OKX
 * "Arbitrum One", Bybit "ARBI", KuCoin "arbitrum" der. Eşleşmeyen bir ad
 * sessizce "bu coin o zincirde yok" anlamına gelir ve fırsat kaybedilir.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TransferInfoProvider,
  gateTablosunuKur,
  krakenDepositChain,
  normalizeChain,
} from '../src/engine/transfer-info.ts';
import { CEX_IDS } from '../src/core/types.ts';

// ---------------------------------------------------------------------------
// Zincir adı normalizasyonu
// ---------------------------------------------------------------------------

test('normalizeChain: borsaların farklı yazımları aynı zincire iner', () => {
  for (const s of ['SOL', 'sol', 'Solana', 'SPL', 'solana']) {
    assert.equal(normalizeChain(s), 'solana', s);
  }
  for (const s of ['ARB', 'ARBI', 'Arbitrum One', 'arbitrum-one', 'ARB_EVM', 'ArbitrumEVM']) {
    assert.equal(normalizeChain(s), 'arbitrum', s);
  }
  for (const s of ['BASE', 'Base', 'Base Mainnet', 'base_evm']) {
    assert.equal(normalizeChain(s), 'base', s);
  }
});

test('normalizeChain: boşluk, tire, alt çizgi ve parantez yok sayılır', () => {
  assert.equal(normalizeChain('Arbitrum (One)'), 'arbitrum');
  assert.equal(normalizeChain('  base  '), 'base');
});

test('normalizeChain: tanınmayan zincir null döner (sessizce eşleşmez)', () => {
  assert.equal(normalizeChain('ETH'), null);
  assert.equal(normalizeChain('BSC'), null);
  assert.equal(normalizeChain('TRX'), null);
  assert.equal(normalizeChain(''), null);
  assert.equal(normalizeChain(null), null);
  assert.equal(normalizeChain(undefined), null);
});

// ---------------------------------------------------------------------------
// Kraken yatırma yöntemi ayrıştırması
//
// ÖLÇÜLEN HATA: Kraken'in toplu ucu (`WithdrawMethods`) yatırma bilgisi
// vermiyor ve kod yatırmayı ÇEKİMDEN varsayıyordu. BONK `WithdrawMethods`'ta
// Solana ile listeli ama `DepositMethods` BONK için BOŞ dizi döndürüyor —
// yani Kraken'e BONK yatırılamıyor. 5 dakikalık koşuda 9 BONK sinyali üretildi
// ve dokuzunda da satış tarafı kraken'di; hepsi gerçekleştirilemez.
// ---------------------------------------------------------------------------

test('kraken yatırma: düz ağ adı zincire iner', () => {
  assert.equal(krakenDepositChain('Solana', 'SOL'), 'solana');
  assert.equal(krakenDepositChain('Arbitrum One', 'ARB'), 'arbitrum');
});

test('kraken yatırma: "<TICKER> - <AĞ> (...)" biçimi çözülür', () => {
  assert.equal(krakenDepositChain('USDC - Base (Unified)', 'USDC'), 'base');
  assert.equal(krakenDepositChain('USDC - Arbitrum One (Unified)', 'USDC'), 'arbitrum');
});

test('kraken yatırma: SARMALANMIŞ varyant kabul EDİLMEZ', () => {
  // Kimlik kuralı: ticker aynı, varlık değil. `USDC.e` köprülenmiş bir token,
  // `kBTC` sarmalanmış BTC — bunları "USDC/BTC şu ağda yatırılabilir" saymak
  // tam olarak yasakladığımız hata olurdu.
  assert.equal(krakenDepositChain('USDC.e - Optimism (Unified)', 'USDC'), null);
  assert.equal(krakenDepositChain('kBTC - Ink (Unified)', 'BTC'), null);
  // Aynı kural taradığımız bir zincirde de geçerli olmalı.
  assert.equal(krakenDepositChain('USDC.e - Arbitrum One (Unified)', 'USDC'), null);
});

test('kraken yatırma: taranmayan ağlar sessizce elenir', () => {
  assert.equal(krakenDepositChain('Bitcoin', 'BTC'), null);
  assert.equal(krakenDepositChain('Bitcoin Lightning', 'BTC'), null);
  assert.equal(krakenDepositChain('USDC - Ethereum (Unified)', 'USDC'), null);
  assert.equal(krakenDepositChain(undefined, 'USDC'), null);
});

test('kraken yatırma: BİLİNMİYOR kapalı sayılır (BONK regresyonu)', () => {
  // Sorgulanmamış bir coin AÇIK varsayılamaz — bu, düzeltilen hatanın ta
  // kendisi. Sağlayıcı refresh edilmemişken de, edilmişken de yön aynı:
  // bilmediğimiz yatırma yayınlanmaz.
  const p = new TransferInfoProvider({ credentials: {} });
  const info = p.lookup('kraken', 'BONK', 'solana', 0.000018);
  assert.equal(info.depositEnabled, false, 'sorulmamış yatırma açık sayılmamalı');
});

// ---------------------------------------------------------------------------
// refresh() öncesi davranış — fail-safe olmalı
// ---------------------------------------------------------------------------

test('refresh edilmemiş sağlayıcı hiçbir transferi açık göstermez', () => {
  const p = new TransferInfoProvider();
  const info = p.lookup('binance', 'BTC', 'solana', 100);

  assert.equal(info.withdrawEnabled, false, 'veri yokken iyimser davranılmamalı');
  assert.equal(info.depositEnabled, false);
  assert.equal(info.verified, false);
});

test('refresh edilmemiş sağlayıcıda hiçbir borsa doğrulanmış sayılmaz', () => {
  const p = new TransferInfoProvider();
  assert.deepEqual(p.verifiedVenues, []);
  // Sabit sayı yazmıyoruz: testin iddiası "HİÇBİRİ doğrulanmış değil",
  // "altı borsa var" değil. Sabit yazılınca yeni borsa eklemek bu testi
  // ilgisiz bir yerden kırıyordu.
  assert.equal(p.unverifiedVenues.length, CEX_IDS.length);
  assert.equal(p.coinsKnown, 0);
  assert.deepEqual(p.chainsFor('BTC'), []);
});

test('sağlayıcısı olmayan borsaya anahtar girilirse SESSİZ kalınmaz', async () => {
  // `loadConfig()` anahtarları CEX_IDS üzerinden geziyor, yani HER borsa için
  // `<BORSA>_API_KEY` kabul ediliyor — ama transfer sağlayıcısı olmayan bir
  // borsada o anahtar hiçbir işe yaramaz. Sessizce yok saymak, kullanıcının
  // borsayı doğrulanmış sanmasına yol açardı.
  //
  // Özne olarak kucoin seçildi: durumu zaten PUBLIC uçtan doğrulanıyor,
  // dolayısıyla anahtarın gerçekten eklediği bir şey yok. (gate ayrı tutuluyor
  // çünkü onun anahtarı çekim ücretleri için KULLANILIYOR.)
  const p = new TransferInfoProvider({
    credentials: { kucoin: { key: 'k', secret: 's', passphrase: null } },
  });
  await p.refresh().catch(() => {
    /* ağ yoksa da uyarı kurulmuş olmalı */
  });

  const err = p.credentialErrors.get('kucoin');
  assert.ok(err, 'anahtar yok sayıldı ama hiçbir yerde iz bırakmadı');
  assert.match(err, /KULLANILMIYOR/);
});

test('kraken anahtarı artık gerçekten kullanılıyor (sessiz yoksayma yok)', async () => {
  // Kraken PRIVATE_FETCHERS'a eklendi. Anahtar geçersiz olduğu için istek
  // başarısız olacak — beklenen de bu: uyarı "sağlayıcı yok" DEĞİL, gerçek
  // bir API hatası olmalı. İkisini ayırt etmek önemli, çünkü çözümleri farklı
  // (kod eksikliği vs. anahtar/izin sorunu).
  const p = new TransferInfoProvider({
    credentials: { kraken: { key: 'gecersiz', secret: 'Z2VjZXJzaXo=', passphrase: null } },
  });
  await p.refresh().catch(() => {});

  const err = p.credentialErrors.get('kraken');
  assert.ok(err, 'başarısız çekim credentialErrors\'a yazılmalı');
  assert.ok(
    !/KULLANILMIYOR/.test(err),
    'kraken artık bağlı — "sağlayıcı yok" uyarısı vermemeli',
  );
  assert.ok(
    !p.verifiedVenues.includes('kraken'),
    'başarısız çekimden sonra doğrulanmış sayılmamalı',
  );
});

test('coin adı büyük/küçük harfe duyarsız aranır', () => {
  const p = new TransferInfoProvider();
  assert.deepEqual(p.chainsFor('btc'), p.chainsFor('BTC'));
  assert.equal(p.lookup('binance', 'btc', 'solana', 100).coin, 'BTC');
});

// ---------------------------------------------------------------------------
// Tahmini çekim ücreti
// ---------------------------------------------------------------------------

test('tahmini çekim ücreti coin fiyatıyla ters orantılı', () => {
  const p = new TransferInfoProvider({ assumedFeePctOfTrade: 0.001 });
  // Ücret coin cinsinden: pahalı coinde daha az adet, ucuz coinde daha çok.
  const ucuz = p.lookup('binance', 'X', 'solana', 0.5).withdrawFee;
  const pahali = p.lookup('binance', 'X', 'solana', 50_000).withdrawFee;

  assert.ok(ucuz > pahali);
  // Her ikisi de USD cinsinden aynı tutara denk gelmeli.
  assert.ok(Math.abs(ucuz * 0.5 - pahali * 50_000) < 1e-9);
});

test('geçersiz fiyat tahmini ücreti sıfırlar (NaN yayılmasın)', () => {
  const p = new TransferInfoProvider();
  assert.equal(p.lookup('binance', 'X', 'solana', 0).withdrawFee, 0);
  assert.equal(p.lookup('binance', 'X', 'solana', -1).withdrawFee, 0);
  assert.equal(Number.isNaN(p.lookup('binance', 'X', 'solana', Number.NaN).withdrawFee), false);
});

test('tahmini ücret işlem büyüklüğüyle ölçeklenir', () => {
  const kucuk = new TransferInfoProvider({
    assumedFeePctOfTrade: 0.001,
    tradeSizeQuote: 1000,
  });
  const buyuk = new TransferInfoProvider({
    assumedFeePctOfTrade: 0.001,
    tradeSizeQuote: 10_000,
  });

  assert.equal(kucuk.lookup('binance', 'X', 'solana', 2).withdrawFee, (0.001 * 1000) / 2);
  assert.equal(buyuk.lookup('binance', 'X', 'solana', 2).withdrawFee, (0.001 * 10_000) / 2);
});

test('işlem büyüklüğü verilmezse 1000 varsayılır (geriye uyum)', () => {
  const p = new TransferInfoProvider({ assumedFeePctOfTrade: 0.001 });
  assert.equal(p.lookup('binance', 'X', 'solana', 2).withdrawFee, (0.001 * 1000) / 2);
});

// ---------------------------------------------------------------------------
// Gate tablosu — ÖLÜ LİSTELEME KAYITLARI
//
// ÖLÇÜLEN HATA (2026-08-27): Gate delisting'de kaydı silmiyor, `_OLD` sonekiyle
// saklıyor ve o kayıtların durum bayrakları "açık" kalıyor. Taban coin adı ilk
// alt çizgiye kadar alındığı için ölü kayıt canlı kaydın ÜSTÜNE yazıyordu:
// 624 coin|zincir satırının 5'inde ölü kayıt "yatırma açık" derken canlı kayıt
// "yatırma KAPALI" diyordu. Sonucu, yatırması kapalı bir coinin sinyal
// üretmesi — kullanıcının bildirdiği hatanın ta kendisi.
// ---------------------------------------------------------------------------

test('gate: ölü (_OLD) kayıt canlı kaydın durumunu EZEMEZ', () => {
  // Gerçek ölçümdeki OX/arbitrum düzeni: ölü kayıt listede SONRA geliyor.
  const t = gateTablosunuKur([
    {
      currency: 'OX',
      chains: [{ name: 'ARBEVM', addr: '0xAAA0000000000000', deposit_disabled: true }],
    },
    {
      currency: 'OX_OLD1',
      chains: [{ name: 'ARBEVM', addr: '0xBBB0000000000000', deposit_disabled: false }],
    },
  ]);

  assert.equal(t.get('OX')?.get('arbitrum')?.depositEnabled, false);
  // Ölü kaydın adresi de tabloya girmemeli: o, aynı ticker'ın ESKİ token'ı.
  assert.equal(t.get('OX')?.get('arbitrum')?.address, '0xaaa0000000000000');
});

test('gate: yalnızca ölü kayıttan gelen zincir tabloya HİÇ girmez', () => {
  // Canlı NEIRO kaydı Solana'yı saymıyor; yalnızca NEIRO_OLD sayıyor. Suskunluk
  // da bilgidir: Gate orada iş yapmıyor demektir.
  const t = gateTablosunuKur([
    { currency: 'NEIRO', chains: [{ name: 'ETH', addr: '0xcc' }] },
    { currency: 'NEIRO_OLD', chains: [{ name: 'SOL', addr: 'mint111' }] },
  ]);
  assert.equal(t.get('NEIRO')?.get('solana'), undefined);
});

test('gate: zincire özel canlı kayıt (_ETH/_BSC) ELENMEZ', () => {
  const t = gateTablosunuKur([
    { currency: 'FOO_BSC', chains: [{ name: 'BASE', addr: '0xdd00000000000000' }] },
  ]);
  assert.equal(t.get('FOO')?.get('base')?.depositEnabled, true);
});

test('gate: aynı coin/zincir iki kayıttan gelirse birleşim KÖTÜMSER', () => {
  const t = gateTablosunuKur([
    { currency: 'BAR', chains: [{ name: 'BASE', addr: '0x1100000000000000' }] },
    {
      currency: 'BAR_ETH',
      chains: [
        { name: 'BASE', addr: '0x2200000000000000', withdraw_disabled: true },
      ],
    },
  ]);
  const e = t.get('BAR')?.get('base');
  assert.equal(e?.withdrawEnabled, false);
  // Adresler çelişiyor → "bilinmiyor". Rastgele birini seçmek kimlik çapraz
  // kontrolünü kendi kendini doğrular hale getirirdi.
  assert.equal(e?.address, null);
});

test('gate: zincir bayrağı yoksa coin geneline düşülür', () => {
  const t = gateTablosunuKur([
    { currency: 'BAZ', deposit_disabled: true, chains: [{ name: 'SOL', addr: 'mint222' }] },
  ]);
  assert.equal(t.get('BAZ')?.get('solana')?.depositEnabled, false);
});
