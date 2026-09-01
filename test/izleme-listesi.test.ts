/**
 * Zorunlu izleme listesi.
 *
 * İki ayrı hata sınıfı test ediliyor ve ikisi de SESSİZ olma potansiyeli
 * taşıdığı için buradalar:
 *
 * 1. Dosyanın yanlış yazılması. `"symbol"` yazıp `"sembol"` sanmak, girdinin
 *    yok sayılması demek — kullanıcı coini eklediğini sanırken hiçbir şey
 *    değişmez. Bu yüzden bilinmeyen alan hata veriyor, ve bunu test ediyoruz.
 *
 * 2. Muafiyetin yorumlanması. `zorunluOzet` "bu girdi işe yaradı mı" sorusunu
 *    cevaplıyor ve tek taraflı kalmış bir çifti "taranıyor" göstermesi, raporun
 *    tam olarak engellemek için var olduğu yalanı söylemesi olurdu.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import {
  IZLEME_DOSYASI,
  bosIzlemeListesi,
  loadIzlemeListesi,
  yazIzlemeListesi,
} from '../src/core/izleme-listesi.ts';
import { zorunluOzet, type ZorunluDurum } from '../src/normalize/symbol-registry.ts';
import type { CexId, PairKey } from '../src/core/types.ts';

// ---------------------------------------------------------------------------
// Dosya okuma
// ---------------------------------------------------------------------------

/** Geçici bir repo kökü kurup içine izleme listesi yazar. */
function kok(icerik: string | null): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'izleme-'));
  mkdirSync(resolve(dir, 'config'), { recursive: true });
  if (icerik !== null) writeFileSync(resolve(dir, IZLEME_DOSYASI), icerik, 'utf8');
  return dir;
}

test('dosya yoksa boş liste döner — özellik opsiyonel', () => {
  const liste = loadIzlemeListesi(kok(null));
  assert.equal(liste.girdiler.length, 0);
  assert.equal(liste.kapsam.bases.size, 0);
});

test('sembol büyük harfe normalize edilir ve kapsama girer', () => {
  const liste = loadIzlemeListesi(kok('{"coinler":[{"sembol":"pepe"}]}'));
  assert.equal(liste.girdiler[0]?.sembol, 'PEPE');
  assert.equal(liste.kapsam.bases.has('PEPE'), true);
  assert.equal(liste.girdi('pepe')?.sembol, 'PEPE');
});

test('bilinmeyen alan HATA verir — sessizce yok sayılmaz', () => {
  // "symbol" yazan kullanıcı coini eklediğini sanırdı; listenin var olma
  // sebebi tam olarak bu sessizliği önlemek.
  assert.throws(
    () => loadIzlemeListesi(kok('{"coinler":[{"symbol":"PEPE"}]}')),
    /bilinmeyen alan "symbol"/,
  );
});

test('bozuk JSON ve eksik "coinler" alanı hata verir', () => {
  assert.throws(() => loadIzlemeListesi(kok('{ bozuk')), /geçerli JSON değil/);
  assert.throws(() => loadIzlemeListesi(kok('{}')), /"coinler" alanı yok/);
});

test('aynı sembol iki kez tanımlanamaz', () => {
  assert.throws(
    () => loadIzlemeListesi(kok('{"coinler":[{"sembol":"PEPE"},{"sembol":"pepe"}]}')),
    /"PEPE" iki kez/,
  );
});

test('geçersiz zincir adresi reddedilir — hata hangi dosya olduğunu söyler', () => {
  assert.throws(
    () =>
      loadIzlemeListesi(
        kok('{"coinler":[{"sembol":"X","dex":[{"zincir":"solana","adres":"0xabc","decimals":6}]}]}'),
      ),
    /izleme-listesi\.json.*geçersiz Solana mint/s,
  );
  assert.throws(
    () =>
      loadIzlemeListesi(
        kok('{"coinler":[{"sembol":"X","dex":[{"zincir":"base","adres":"0xzz","decimals":6}]}]}'),
      ),
    /geçersiz EVM adresi/,
  );
});

test('aynı zincir için iki adres tanımlanamaz', () => {
  const a = '0x' + '1'.repeat(40);
  const b = '0x' + '2'.repeat(40);
  assert.throws(
    () =>
      loadIzlemeListesi(
        kok(
          `{"coinler":[{"sembol":"X","dex":[` +
            `{"zincir":"base","adres":"${a}","decimals":18},` +
            `{"zincir":"base","adres":"${b}","decimals":18}]}]}`,
        ),
      ),
    /"base" zinciri iki kez/,
  );
});

test('yazılan dosya geri okunabilir (gidiş-dönüş)', () => {
  const dir = kok(null);
  const adres = '0x' + 'ab'.repeat(20);
  yazIzlemeListesi(dir, [
    { sembol: 'WIF', quotes: ['USD'], dex: [], not: 'kraken USD piyasası' },
    { sembol: 'BONK', quotes: [], dex: [{ zincir: 'base', adres, decimals: 5 }], not: null },
  ]);

  const geri = loadIzlemeListesi(dir);
  // Sıralı yazılır: elle düzenlenen dosyada satır sırası kararlı olmalı.
  assert.deepEqual(
    geri.girdiler.map((g) => g.sembol),
    ['BONK', 'WIF'],
  );
  assert.deepEqual(geri.girdi('WIF')?.quotes, ['USD']);
  assert.equal(geri.girdi('BONK')?.dex[0]?.decimals, 5);
  assert.equal(geri.kapsam.ekQuotes.get('WIF')?.has('USD'), true);
  assert.equal(geri.kapsam.ekQuotes.has('BONK'), false);
});

test('boş liste yardımcısı gerçekten boş', () => {
  const l = bosIzlemeListesi();
  assert.equal(l.girdiler.length, 0);
  assert.equal(l.girdi('PEPE'), null);
});

// ---------------------------------------------------------------------------
// Muafiyetin yorumlanması
// ---------------------------------------------------------------------------

function durum(
  ciftler: Record<string, CexId[]>,
  gorulenQuotes: string[] = ['USDT'],
): ZorunluDurum {
  return {
    ciftler: new Map(Object.entries(ciftler) as [PairKey, CexId[]][]),
    muafiyetler: [],
    gorulenQuotes,
  };
}

test('iki borsalı çift "taranıyor" sayılır', () => {
  const [s] = zorunluOzet(new Map([['PEPE', durum({ 'PEPE/USDT': ['binance', 'okx'] })]]));
  assert.equal(s?.sonuc, 'taraniyor');
});

test('tek borsalı çift DEX bacağı YOKSA tek taraflıdır', () => {
  // İyimser davranmak muafiyetin anlamını boşa çıkarırdı: çift oluşur, satır
  // taranır, ama karşı taraf olmadığı için hiçbir zaman sinyal üretmez.
  const [s] = zorunluOzet(new Map([['PEPE', durum({ 'PEPE/USDT': ['binance'] })]]));
  assert.equal(s?.sonuc, 'tekTarafli');
});

test('tek borsa + DEX bacağı geçerli arbitrajdır', () => {
  // Muafiyetin asıl gerekçesi bu: "en az iki BORSA" kuralı, karşı tarafı DEX
  // olan gerçek bir fırsatı çift daha oluşmadan siliyordu.
  const [s] = zorunluOzet(
    new Map([['PEPE', durum({ 'PEPE/USDT': ['binance'] })]]),
    new Set(['PEPE/USDT'] as PairKey[]),
  );
  assert.equal(s?.sonuc, 'taraniyor');
  assert.match(s?.aciklama ?? '', /\+dex/);
});

test('çift yok ama ticker başka quote’ta görülmüşse çözülebilir sorundur', () => {
  const [s] = zorunluOzet(new Map([['WIF', durum({}, ['USD', 'EUR'])]]));
  assert.equal(s?.sonuc, 'quoteDisi');
  assert.match(s?.aciklama ?? '', /quotes/);
});

test('hiçbir borsada görülmeyen girdi "listelenmemiş" olur', () => {
  // Bu satır raporun asıl anlattığı şey: kullanıcı izlendiğini sanıyor,
  // oysa çift hiç oluşmamış.
  const [s] = zorunluOzet(new Map([['YOKBUNDA', durum({}, [])]]));
  assert.equal(s?.sonuc, 'listelenmemis');
  assert.match(s?.aciklama ?? '', /hiçbir şey yapmıyor/);
});
