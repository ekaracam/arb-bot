# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Kod, yorumlar ve kullanıcıya görünen tüm metinler **Türkçe**. Yeni kod da öyle olmalı.

## Komutlar

```bash
npm run dev                # botu çalıştır (tsx, derleme yok)
npm run check              # tsc --noEmit — tek tip kontrolü, CI yerine geçer
npm test                   # node:test, tüm testler
npm run build              # esbuild → dist/main.js (yalnızca dağıtım için)

npm run feeds              # 6 borsaya bağlan, 30 sn dinle, gecikme + sembol raporu
npm run feeds -- okx 60    # tek borsa, 60 saniye
npm run dex                # Solana mint adresleri + Jupiter quote doğrulaması
npm run verify-contracts   # EVM kontrat/token adreslerini ZİNCİRDEN doğrula
npm run verify-keys        # .env'deki salt-okunur anahtarları borsalarda dene
npm run discover-tokens    # borsalardan token adreslerini bul (yalnızca rapor)
npm run discover-tokens -- --yaz          # bulunanları config/tokens.json'a yaz
npm run discover-tokens -- base --yaz     # tek zincir
npm run calibrate          # data/ üzerinden sinyal kalitesi raporu
npm run calibrate -- 2026-08-03

npm run izle               # zorunlu izleme listesi + her girdiyi DENETLE
npm run izle -- ekle PEPE  # coini zorla taramaya sok, sonra denetle
npm run izle -- cikar PEPE

npm run fiyatlar           # 90 sn dinle → coin × venue fiyat tablosu (CSV)
npm run fiyatlar -- 120    # dinleme süresini uzat (yavaş DEX turları için)
npm run fiyatlar -- 60 BTC # yalnızca sembolü eşleşenleri ekrana bas

npm run kapsam             # bot ŞU ANDA neyi izliyor — eleme hunisiyle
npm run kapsam -- PEPE     # tek coin: izleniyor mu, izlenmiyorsa NEDEN
npm run kapsam -- --tumu   # taranan tüm çiftleri listele
npm run kapsam -- --yaz    # raporu data/kapsam-<tarih>.txt'ye de yaz
```

`fiyatlar` ile `kapsam` farklı soruları cevaplar ve ikisi de gerekli: `kapsam`
"bu çift TARANIYOR mu" der, `fiyatlar` "o venue GERÇEKTEN fiyat yazdı mı" der.
Aradaki boşluk bu botun klasik sessiz hatası — çift izleniyor görünürken feed
hiç veri yazmıyor olabilir. Ölçülen doluluk (90 sn): CEX %82–100, ama
**aerodrome %23 (18/79), uniswap-v3-base %33 (26/79), camelot %42, uniswap-v3
%74** — yani DEX tablosundaki tokenların çoğu izleniyor ama fiyatlanmıyor.

Doluluk paydası `symbolsFor(venue)`/`tokenCount` olmak ZORUNDA. `resolveSlot()`
her (çift, venue) için slot döndürür — matris tam ayrılır — dolayısıyla onu
payda saymak her venue'ya 1213 yazar ve abone olduğu 407 sembolün 384'ünü
yazmış binance'i "%33" gibi gösterir.

Tablonun yan ürünü **ticker çakışması teşhisi**: aynı çiftte venue'lar arası
sapma ölçülüyor ve 1091 karşılaştırılabilir çiftin **21'inde %100'ün, 10'unda
%1000'in üstünde** fark var (`TROLL` mexc 1.7e-9 ↔ jupiter 0.043, `LUNA`
kraken 4.9e-5 ↔ okx 0.0418). Bunlar fırsat değil aynı ticker'ın farklı
varlıkları; `pickChain`'in adres çapraz kontrolü rotayı Aşama 2'de eliyor ama
çift taranmaya ve kuyruk kapasitesi yakmaya devam ediyor.

`kapsam` hiçbir feed başlatmaz (yalnızca public sembol listelerini çeker), bot
çalışırken de güvenle çalıştırılabilir. `fiyatlar` ise gerçek feed açar —
bot çalışırken çalıştırmak abonelik ve RPC kotasını ikiye katlar. Varlık sebebi: bu botta kapsam kaybı
**sessizdir** — taranmayan çift hata üretmez, yalnızca yoktur. Panel yalnızca
AKAN veriyi gösterir; akmayan verinin görüneceği tek yer bu rapordur (ölçülmüş
üç örnek: JUP'ın kaldıraçlı sanılması, Gate'in `chains[]` yerine varsayılan
zincirinin okunması, DEX bacağının quote'a hiç bağlanmamış olması).

Eleme sebepleri keşif ANINDA toplanır (`SymbolRegistry.stats`) — elenen kayıt
hiçbir yerde durmadığı için sonradan geriye doğru hesaplanamaz. DEX listesi
`dexTokensFor()` ile botun kendi filtresinden geçer; script'te kopya filtre
tutmak, iki tarafın ayrışıp raporun yalan söylemesi demekti.

Aynı sebeple **venue listesi de `DEX_IDS`'ten okunur, elle yazılmaz.** Kopya bir
dizi tutulduğu için `cow-base` ve `uniswap-v3-base` eklendikten sonra rapor Base
için hâlâ "venue: aerodrome" diyordu — yani kapsam kaybını gösterecek olan araç
kendi kapsam kaybını yaşadı. Aynı düzeltme `main.ts`'te de yapıldı; orada bedeli
daha ağır olurdu, çünkü listede eksik kalan venue için `PriceStore` sütunu hiç
ayrılmaz ve feed sessizce boş çalışır.

`calibrate` yalnızca `opportunities-YYYY-MM-DD.ndjson` kalıbına **tam** uyan dosyaları
okur. Arşivlediklerini (`...anahtar-oncesi.ndjson` gibi) dizinde tutabilirsin; rapora
karışmaz, atlananlar başlıkta listelenir. Kalıbı gevşetme: farklı dönemlerin verisi tek
raporda toplanınca rapor yanlış öncelik önerir (anahtar öncesi/sonrası karışınca
"%96 doğrulanmamış" deyip zaten yapılmış işi öneriyordu).

Tek test dosyası / tek test:

```bash
node --test --experimental-transform-types test/scanner.test.ts
node --test --experimental-transform-types --test-name-pattern="kısmi" "test/*.test.ts"
```

Node ≥ 22.7 gerekir (`process.loadEnvFile`, `--experimental-transform-types`).

### Windows'ta çalıştırma

PowerShell'de `npm ...` **çalışmayabilir**. `C:\Program Files\nodejs\` içinde hem
`npm.cmd` hem `npm.ps1` var; PowerShell `.ps1` sürümünü tercih eder ve Windows'un
varsayılan ExecutionPolicy'si (`Restricted`) onu çalıştırmaz:

```
npm : File C:\Program Files\nodejs\npm.ps1 cannot be loaded because running scripts is disabled
```

Bu bir kurulum hatası değil; `npm.cmd -v` aynı anda sorunsuz çalışır. Sistem güvenlik
ayarını değiştirmek gerekmez — [baslat.cmd](baslat.cmd) botu `cmd.exe` üzerinden
başlatır (ExecutionPolicy'ye tabi değil) ve PATH'i kendi içinde tazeler, yani Node
kurulmadan önce açılmış bir oturumdan da çalışır. Çift tıklamak yeterli.

Ayrı bir tuzak: Node kurulduktan sonra **zaten açık olan** terminaller eski PATH
kopyasıyla çalışmaya devam eder ve `npm is not recognized` der. Terminali (uygulama
içindeyse uygulamanın tamamını) kapatıp açmak gerekir.

**Botu kapattığını sanıp kapatmamak — ÖLÇÜLDÜ ve ölçümü bozdu.** `npm run dev`
üç süreç açıyor (`npx` → `tsx` → `node --require`). Kabuk süreci öldürülünce
alt süreçler HAYATTA KALABİLİYOR: art arda üç ölçüm koşusunun dokuz süreci de
aynı anda çalışır bulundu, yani ikinci koşu birincinin, üçüncü ikisinin
üstüne bindi. Bedeli doğrudan ölçüme yansıdı — Base RPC'ye 2–3 kat istek
(takılma epizotları) ve Jupiter'in ücretsiz kotasının 2–3 kat hızlı tükenmesi.
Panelde hiçbir iz yok, çünkü her örnek kendi açısından sağlıklı.
Ölçüm yapmadan önce doğrula:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select ProcessId,CommandLine
```

Normal kullanımda (`baslat.cmd` penceresinde Ctrl+C) sorun yok; tuzak, botu
bir sarmalayıcı üzerinden başlatıp sarmalayıcıyı öldürmekte.

**`--experimental-strip-types` kullanma.** Strip-only mod TypeScript'in
parametre özelliklerini (`constructor(private readonly cfg: AppConfig)`)
desteklemiyor ve bu kodda neredeyse her sınıf onu kullanıyor. Strip modunda
yalnızca `vwap.ts` gibi saf fonksiyon modülleri import edilebiliyor; `Scanner`,
`PriceStore`, `Deduper` dahil hiçbir sınıf yüklenemiyor
(`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). `transform-types` bu sözdizimini
derliyor ve ek bağımlılık gerektirmiyor.

## Testler

`test/*.test.ts` — tamamı ağa çıkmadan, deterministik çalışır.

[test/helpers.ts](test/helpers.ts) Scanner'ın dört bağımlılığı için sahte üretir:
`makeConfig`, `fakeRegistry`, `fakeDepth`, `fakeTransfers`. Yeni tarayıcı testi
yazarken bunları kullan — testte tek değişken **fiyat matrisi** olmalı, borsaların o
anki durumu değil. DEX bacağı için `scanner.test.ts` içindeki `fakeLegQuoter` var;
`DexLegQuoter` arayüzü dar tutulduğu için testler Jupiter'e HTTP atmadan çalışır.

`AppConfig`'e alan eklerken `makeConfig`'i güncellemek zorunludur — aksi halde tüm
tarayıcı testleri tek bir tip hatasıyla düşer.

Aşama 1 (`evaluate()`) private; testler zamanlayıcı beklemek yerine `ScannerInternals`
cast'iyle doğrudan çağırıp `settle()` ile Aşama 2'nin async kuyruğunu boşaltır.

**DEX feed testlerinin konusu quote matematiği değil TEŞHİS.**
[test/evm-feed.test.ts](test/evm-feed.test.ts) ve
[test/cow-feed.test.ts](test/cow-feed.test.ts) aynı disiplini iki ayrı feed'de
kuruyor: "havuz/rota yok" (veri) ile "uç nokta bozuk" (arıza) ayrı teşhis
üretmeli, tek kötü tur paneli kızartmamalı, ve arıza sırasında token'lar
haksızca rotasız ilan edilmemeli. Bunu mümkün kılan şey dar arayüzler —
`MulticallClient` ve `CowQuoter` — testler ağa çıkmadan tur sonuçlarını taklit
edebiliyor. Yeni bir DEX kaynağı eklerken aynı daraltmayı yap; aksi halde durum
makinesi yalnızca canlıda, yani ölçmesi en pahalı yerde doğrulanabilir.

Kâr hesabı testleri beklenen değeri **sabit sayı** olarak taşır; formülü testin içinde
tekrar yazmak kendini doğrulayan test olurdu. `costs` dökümünün `netQuote`'a oturması
ayrıca test edilir — bu ilişki sessizce bozulmaya çok müsait.

## Mimarinin çekirdek fikri: iki aşamalı tarama

Ham spread bir fırsat değildir. [scanner.ts](src/engine/scanner.ts) bunu iki aşamaya ayırır:

- **Aşama 1** (`evaluate()`, ~50 ms, allocation'sız): yalnızca `PriceStore.flushDirty()`
  ile dönen, fiyatı değişmiş çiftler taranır. L1 üzerinden kaba `rawPct` hesaplanır,
  `PREFILTER_PCT` eşiğini geçen adaylar kuyruğa girer.
- **Aşama 2** (`verify()`, seyrek, async): L2 defteri çekilir ([depth-cache.ts](src/book/depth-cache.ts)),
  gerçek VWAP hesaplanır ([vwap.ts](src/engine/vwap.ts)), komisyon + çekim ücreti + gas
  düşülür, transfer yolu seçilir (`pickChain`). `MIN_NET_PCT`'i geçen çıktıya `Opportunity` denir.

**`PREFILTER_PCT`, `MIN_NET_PCT`'in hemen altında olmalı.** Ham fark her zaman net
kârdan büyüktür — komisyon, çekim ücreti, gas ve kayma yalnızca eksiltir — dolayısıyla
ham farkı `MIN_NET_PCT`'in altındaki bir aday matematiksel olarak sinyal ÜRETEMEZ.
0.15 iken saniyede ~960 aday üretiliyor, kuyruk sürekli doluyor ve adayların çoğu hiç
doğrulanmadan atılıyordu; 0.3'e çıkarınca kuyruk boşalır hale geldi. Aradaki küçük pay
yalnızca iki aşama arasında fiyatın lehe hareket etmesi ihtimali içindir.

**Çift başına doğrulama soğuması** (`VERIFY_COOLDOWN_MS`, 2 sn): `verifying` seti
yalnızca uçuştaki aynı adayı engelliyordu, doğrulama biter bitmez aynı çift yeniden
kuyruğa giriyordu. Bu tekrarların bilgi değeri yok — derinlik önbelleği 2 sn TTL'li,
yani aynı defteri okuyup aynı sonuca varıyorlar. Soğuma süresi bu yüzden önbellek
TTL'ine bağlı; düşürmek kotayı boşa harcar.

Bu ayrımı bozmak (ör. Aşama 1'e async iş koymak, ya da Aşama 2'yi atlamak) botun tüm
değerini yok eder.

**DEX bacağı Aşama 2'de quote ile doğrulanır.** Solana geniş taraması orta fiyat verip
miktarı 0 bırakır; [feeds/dex/leg-quoter.ts](src/feeds/dex/leg-quoter.ts) gerçekleşecek
miktarı `swap/v1/quote` ile alır. Bu bağlantı uzun süre EKSİKTİ: `DexQuoter` yazılmıştı
ama hiçbir yerden çağrılmıyordu ve scanner her Solana bacağını `rejectedByDepth` ile
eliyordu — CEX↔DEX fırsatı yapısal olarak üretilemiyordu. EVM feed'leri (Aerodrome,
Camelot) bu yola girmez: onlar zaten belirli bir işlem büyüklüğü için quoter çağırıp
gerçek miktarı yazıyor. Scanner arayüzü dar (`DexLegQuoter`) — mint adreslerini
ve decimals'ı bilmez, testler sahte quoter enjekte eder.

**`DexLegQuoter`'ın anahtarı VENUE'dur, zincir değil.** Bir dönem `chain`
alıyordu ve o imza aynı zincirde ikinci bir venue'yu yapısal olarak imkânsız
kılıyordu: `jupiter` de `raydium` da 'solana' der, dolayısıyla Raydium'da
ölçülen fiyat Jupiter rotasıyla doğrulanırdı. Sayı makul görünür, sadece o rota
UYGULANAMAZ — kimlik kuralının venue tarafındaki karşılığı. Yönlendirmeyi
`VenueLegQuoter` yapıyor; tarayıcı hangi bacağın hangi uca gittiğini bilmez.
Tanımadığı venue'ya `null` döner (sessizce yanlış cevap vermez) ve o bacak
`rejectedByDepth`'e düşer.

Kuyruk sınırlıdır (`maxQueueDepth`, 40) ve taşınca **en düşük kârlı** aday atılır; drain
sırası da kâra göredir — rate-limit'e takılırsak kaybettiğimiz her zaman en değersiz
adaydır. Kuyruğun **sürekli dolu** olması bir ayar hatasının göstergesidir: ön filtre
doğrulama kapasitesinin üstünde aday üretiyor demektir (bkz. `PREFILTER_PCT` ve
`VERIFY_COOLDOWN_MS`). Sağlıklı çalışmada kuyruk dalgalanır, tavana yapışmaz.

**Bugün tavana yapışmış durumda ve ölçüsü panelde.** 5 dakikada 10734 adayın
**8465'i (%79)** doğrulanmadan atıldı; kuyruk karelerin çoğunda 40/40. Sayaç
`tarama:` satırında `atılan N` olarak görünüyor (uzun süre toplanıp hiç
basılmıyordu). Bu haliyle **güvenli ama kapasiteye takılı**: atılan her zaman
en zayıf aday olduğu için gerçek bir fırsat düşmez, ama Aşama 2 doyuma ulaşmış
demektir.

## Aday kalitesi: ölçülen en pahalı darboğaz

**"0 sinyal" tek başına hiçbir şey teşhis etmiyor** — eşiğin az mı çok mu
altında kaldığımızı, hatta kâr hesabına ulaşılıp ulaşılmadığını bile
söylemiyor. Üç sayaç eklendi (panelde ve koşu günlüğünde):
`netHesaplanan` (boru hattının sonuna kaç aday vardı), `enIyiNetPct` (oraya
varanların gördüğü en iyi oran) ve `netKayit` (o bütçeyi hangi çiftler yaktı).

Bunlar olmadan eşik ayarı körlemesine yapılıyordu. İlk ölçüm (5 dk):
**39901 adayın 117'si** kâr hesabına ulaşabildi ve görülen en iyi net
**%-17.6** idi — yani eşiğin biraz altında değil, yapısal olarak zararda.
Döküm sebebi tek satırda gösterdi: kâr hesabına ulaşan 12 çiftin **12'si de**
bozuk bir DEX fiyatından geliyordu (`FIGHT|jupiter->raydium ×53 @ %-87.71`,
`ANTFUN|raydium->kucoin ×22 @ %-99.95`).

Mekanizma: kuyruk **ham farka göre** sıralı ve bozuk fiyatın ham farkı her
zaman gerçek fırsatınkinden büyük — dolayısıyla tepeyi HER ZAMAN o işgal
ediyor. CLAUDE.md'de "test edilmemiş varsayım" olarak duran madde böylece
ölçüldü ve YANLIŞ çıktı.

Üç katman eklendi, her biri ölçülerek:

| katman | ne yapar | eşik nereden geldi |
|---|---|---|
| makul olmayan ham fark | %20 üstü ham farkın kuyruk önceliğini dibe çeker | net karşılığıyla (`IMPLAUSIBLE_NET_PCT`) aynı |
| referans fiyat filtresi | Raydium orta fiyatı Jupiter'den >%20 saparsa store'a YAZILMAZ | 108 mint'te %6–26 bandı BOŞ çıktı |
| fiyat etkisi kontrolü | Aşama 2 quote'unda etki >%5 ise bacak elenir | ZEUS'ta ölçülen etki %250 — eşiğin yeri tartışmalı değil |

Ölçülen etki: **en iyi net %-17.65 → %-0.194**, ve döküm gerçek çiftlerle
doldu (`DOOD|jupiter->okx %-0.19`, `BERT|gate->raydium %-0.38`).

**ELEME DEĞİL ÖNCELİK DÜŞÜRME — ve bu ayrım bir kez ihlal edildi.** İlk sürüm
makul olmayan adayı kuyruğa hiç almıyordu; o sürüm `IMPLAUSIBLE_NET_PCT`
uyarısını ULAŞILAMAZ yaptı (var olan bir test yakaladı). O uyarı kasten eleme
değil: sebebi bilinmeyen bir sinyal görünür kalmalı. Sorun zaten adayın
doğrulanması değil, DİĞERLERİNİ AÇ BIRAKMASIYDI.

**İnce havuz, rotasızlıktan AYRI teşhistir.** Ölçülen örnek `ZEUS`: orta
fiyatı Jupiter'le %2.5 uyumlu (referans filtresi haklı olarak geçiriyor) ama
$500'lük quote birim fiyatı **3.5 katına** çıkıyor — havuz doğru fiyatlı,
sadece o büyüklüğü taşımıyor. İkisini aynı kovaya koymak kullanıcıyı token
silmeye yöneltirdi; oysa token sağlam. Değer zaten elimizdeydi: iki Solana
quoter'ı da fiyat etkisini döndürüyor ve **Jupiter'inki ayrıştırılıp
atılıyordu**.

**İnce havuz HATIRLANIR** (`INCE_HAVUZ_TTL_MS`, 10 dk). Ölçüldü: 7 dakikada
440 ince-havuz elemesi, ama sorunlu token sayısı ~56 — aynı gerçeği defalarca
öğreniyorduk. Hafıza slot indeksli bir `Float64Array` (Aşama 1 hot path'inde
Map araması yok) ve TTL SONLU: likidite geri gelebilir.

**Token evreninin likiditesi ölçüldü** ($500, Raydium, 137 token):

| <%1 etki | %1–5 | %5–10 | %10–50 | >%50 | rota yok |
|---|---|---|---|---|---|
| 65 | 16 | 6 | 11 | 21 | 18 |

Yani **81 token (%59)** $500'ü %5'ten az etkiyle taşıyor. Uçtaki 21 token
kuyruğu kirleten sınıf. Bu tablo, "coin seçiminde hacim hiç kullanılmıyor"
boşluğunun doğrudan faturası: eleme Aşama 2'de, yani en pahalı yerde yapılıyor.

## Hot path kuralı

[price-store.ts](src/book/price-store.ts) sabit boyutlu bir `Float64Array` matrisidir:
`slot = pairIndex * venueCount + venueIndex`, her slot `FIELDS` (6) alan kaplar.

- Tick işleme yolunda **object allocate edilmez**. Feed'ler kurulumda `resolveSlot()`
  ile slot numaralarını alır ve sonrasında yalnızca sayı indeksleriyle yazar.
- Matris sonradan büyütülemez. Bu yüzden [main.ts](src/main.ts) `PriceStore`'u kurarken
  DEX venue'larının **tamamını** — `DEX_IDS`'ten, elle yazmadan; `DEVRE_DISI`
  olanlar da dahil — `allVenues`'a katıyor. Kapalı venue için sütun ayırmak
  bedava, ayırmamak ise geri açıldığında `resolveSlot` −1 döndürüp feed'i
  sessizce boş çalıştırmak demek.
- `Scanner`'a ise yalnızca **gerçekten veri akan** venue'lar verilir (`activeDexVenues`),
  aksi halde boş satırlar taranır.
- **Panelin zincir satırı da yalnızca KURULMUŞ venue'ları saymalı.** Eskiden
  tüm `dexSetups` sayılıyordu: `cow-base` failed iken satır
  "aerodrome,uniswap-v3,cow" diyor ve TOKEN sütununa onun 79'unu da ekliyordu
  (237). Yani kapalı bir bacak, çalışan kapsam gibi görünüyordu. Şimdi 158.

## Yeni bir CEX eklemek (7 dokunuş)

1. `CEX_IDS` — [core/types.ts](src/core/types.ts)
2. `BaseCexFeed` alt sınıfı — [feeds/cex/base-feed.ts](src/feeds/cex/base-feed.ts):
   yalnızca `endpoint()`, `subscribeMessages()`, `handleMessage()` doldurulur.
   Bağlantı ömrü, backoff+jitter, watchdog, saat kayması düzeltmesi taban sınıfta.
3. `REGISTRY` — [feeds/cex/index.ts](src/feeds/cex/index.ts)
4. Sembol listesi fetcher'ı — [normalize/symbol-registry.ts](src/normalize/symbol-registry.ts)
5. L2 derinlik fetcher'ı — [book/depth-cache.ts](src/book/depth-cache.ts) `FETCHERS`
6. Host rate-limit kovası — [core/http.ts](src/core/http.ts) `LIMITS`
7. `config/exchanges.json`'a komisyon/quote girdisi

Komisyonu bilerek **yüksek** yaz: olduğundan düşük komisyon doğrudan sahte
sinyal üretir, yüksek komisyon yalnızca fırsat kaçırır. Kraken en düşük hacim
kademesiyle girildi (taker %0.40).

Bağlantı başına abonelik sınırı olan borsalar (MEXC 30, KuCoin ~200) `FeedPool` +
`chunk()` kullanır — [feeds/cex/pool.ts](src/feeds/cex/pool.ts). Sınır aşımı **sessizdir**:
bağlantı açık kalır, fazla semboller hiç veri almaz.

### Kraken eklenirken ölçülen iki tuzak

İkisi de sessiz başarısızlık üretirdi, ikisi de [feeds/cex/kraken.ts](src/feeds/cex/kraken.ts)
başında belgeli:

- **`event_trigger` varsayılanı `trades`.** Ticker yalnızca işlem gerçekleştiğinde
  güncelleniyor. Bayatlık kontrolü de kurtarmaz (mesaj akıyor, sadece seyrek) —
  motor eski fiyatla hesap yapardı. `bbo` ile 3 sembolde 2.9 sn'de 10 güncelleme
  geldi; varsayılanla aynı sürede yalnızca snapshot vardı.
- **v2 sembol adı `AssetPairs`'inkinden farklı.** `wsname` v1 içindir ve v2 onu
  REDDEDİYOR (`XBT/USDT` → "Currency pair not supported"). v2 yaygın adları
  istiyor: `BTC/USDT`, `DOGE/USDT`. Eşleme `KRAKEN_V2_ALIASES`'te; yalnızca bu
  iki kod farklı (ETH/LTC/XMR/XRP'nin `base`'i X önekli ama `wsname` temiz).

Ayrıca: snapshot mesajının `timestamp`'i son İŞLEM anıdır, defter anı değil —
store'a 0 yazılır ki bayatlık `recvTs`'e düşsün. Update'lerde zaman damgası taze
(~70 ms) ve gecikme ölçümüne yalnızca onlar girer.

Kraken sembolü **hem WebSocket hem REST Depth** tarafından kabul ediliyor
(`Depth?pair=BTC/USDT` çalışıyor), bu yüzden ikinci bir ad eşlemesi yok.
`api.kraken.com` kovası dar (3/1): Kraken'in public REST limiti diğer
borsalardan belirgin şekilde sıkı.

### Kraken'de USD → USDT vekili

Kraken'in USDT piyasası dar: 1410 sembolün **1365'i USDT dışı** quote'ta.
`pairKey` quote'u içerdiği için `KTA/USD` ile `KTA/USDT` AYRI çiftlerdir ve
karşılaştırılmazlar — yani Kraken'de listeli bir coin başka borsada USDT'de
listeliyken çift hiç oluşmuyordu. Ölçülen bedel:

| | |
|---|---|
| Kraken USD çifti | 641 |
| ikinci borsada AYNI quote'ta karşılığı var | 218 |
| yalnızca Kraken/USD | **423** |
| bunlardan başka borsada USDT'de listeli olan | 341 |
| bu yüzden **hiç taranmayan** coin | **54** (KTA, MSOL, JITOSOL, WBT, BGB…) |

Çözüm `usdVekiliUygula`: bir base'in o borsada USDT çifti **YOKSA** USD çifti
USDT yerine sayılır. Ölçülen etki: çift sayısı **1159 → 1213**, Kraken'in
taranan sembolü **37 → 558**.

- **`venueSymbol` DEĞİŞMEZ.** Borsaya hâlâ `KTA/USD` diye abone oluyoruz ve
  REST derinliği de o adla çekiliyor. Değiştirmek sessiz bir abonelik hatası
  üretirdi — bağlantı açık kalır, çift hiç veri almaz.
- **Yalnızca USDT çifti yoksa.** Gerçek bir USDT çifti varken doğru
  karşılaştırma odur; ikisini birden almak aynı coini, biri baz riski taşıyan
  iki ayrı fiyatla taramak olurdu.
- **Bedeli USDT/USD bazıdır ve GİZLENMİYOR.** USD ile USDT farklı varlıklar;
  ölçüm anında Kraken `USDT/USD` = 0.9991, yani **%-0.09** — `MIN_NET_PCT`
  (%0.4) eşiğinin dörtte biri, depeg anlarında %'lerce. Bu yüzden vekil
  kullanılan base'ler kaydediliyor (`stats.usdVekilli`, bugün 521 coin),
  başlangıçta loglanıyor, ve o bacağı taşıyan fırsat `warnings` içinde
  "USDT/USD bazı kâra dahil değil" uyarısı taşıyor. Uyarı **borsa bazlı**:
  vekil hangi borsada kullanıldıysa yalnızca o bacaklı fırsat işaretlenir,
  yoksa mexc↔binance fırsatına Kraken kaynaklı uyarı iliştirilirdi.
- **Huni toplamak zorunda.** Vekiller `ham`'a dahil değil (borsa onları
  döndürmedi, biz ürettik) ama eleme aşamalarından geçiyorlar; ayrı bir
  `vekil` sütunu olmasaydı `quoteDisi + elenenBase + kaldiracli + kabul` ham'ı
  aşar ve rapor kendi içinde çelişirdi. Bugün: `1410 + 603 = 2013 = 1365 + 6 +
  1 + 641` ✓

**Kapsamadığı durum:** Kraken'de USD, karşı borsada EUR gibi ikisi de USDT
olmayan durumlar. Vekil yalnızca USD→USDT yönünde çalışıyor; genel çözüm
quote ailesi + canlı baz modellemesi olurdu ve bu ayrı bir iş.

## Zorunlu izleme listesi (`config/izleme-listesi.json`)

Otomatik keşif muhafazakârdır ve bunun bir bedeli var: dört eleme
(`EXCLUDED_BASES`, kaldıraçlı kalıp, quote listesi, "en az iki borsa") toplu
keşifte doğru, tekil coinlerde yanılabilir. Bu dosya o kararı **coin bazında**
geri alır — `npm run izle` ile yönetilir, elle de düzenlenebilir.

Muafiyetler `SymbolRegistry.build({ zorunlu })` üzerinden veriliyor; kayıt
defteri dosyayı hiç bilmez, yalnızca "şu base'ler muaf, şu quote'lar da kabul"
yapısını alır ([core/izleme-listesi.ts](src/core/izleme-listesi.ts)).

**Asıl kazanç `minVenues` muafiyeti.** Bir coin tek CEX + bir DEX'te listeliyse
bu geçerli bir CEX↔DEX arbitrajıdır, ama çift `minVenues` satırında siliniyordu
ve `dexTokensFor` `knownPairs` istediği için DEX bacağı da hiç kurulmuyordu —
yani tokens.json'da adresi olan token boşuna duruyordu. Ölçülen örnek:
**BNSOL** (yalnızca Binance, Solana mint'i tabloda var) muafiyetle
`BNSOL/USDT: binance +jupiter` oluyor. Aynı sınıfta `SNS` de var.

**Ek quote da ölçülen bir kazanç:** `BTC --quote USD` denendiğinde `BTC/USD`
çiftinin **binance, bybit, okx, kraken** dördünde birden listeli olduğu
görüldü — varsayılan config'in hiç dokunmadığı taranabilir bir çift. Not:
`pairKey` quote'u içerdiği için `BTC/USD` ve `BTC/USDT` AYRI çiftlerdir ve
birbirleriyle karşılaştırılmazlar; ek quote ancak o quote'ta **iki venue**
varsa iş görür.

**Muafiyet vermek yetmez, işe yaradığı GÖRÜNMELİ.** Bu botta "ekledim, artık
izleniyordur" varsayımı en pahalı hata sınıfının ta kendisi: çift oluşmazsa
hiçbir yerde hata görünmez. `zorunluOzet()` her girdiyi dört sonuçtan birine
oturtur ve üçü de başlangıç logunda, `kapsam` raporunda ve `izle` çıktısında
görünür:

| sonuç | anlamı |
|---|---|
| `taraniyor` | en az iki taraf var (CEX+CEX ya da CEX+DEX) |
| `tekTarafli` | çift oluştu ama karşı taraf yok — sinyal üretemez |
| `quoteDisi` | ticker borsalarda var, yalnızca taranmayan quote'ta → `quotes` alanına ekle |
| `listelenmemis` | hiçbir borsanın listesinde yok — girdi hiçbir şey yapmıyor |

Son iki satırın ayrılabilmesi için keşif, zorunlu sembollerin görüldüğü TÜM
quote'ları eleme ANINDA kaydeder (`gorulenQuotes`); sonradan geriye doğru
hesaplanamaz. `RegistryOptions.gozlem` aynı izi **muafiyet vermeden** tutar —
`kapsam -- COIN` bunu kullanıyor.

**Tek coin teşhisi İLK sebepte durmamalı.** Ölçülen hata: `KTA/USDT` yalnızca
MEXC'te olduğu için rapor "ikinci bir borsada listelenirse otomatik girer"
diyordu — oysa KTA Kraken'de `KTA/USD` ve `KTA/EUR` olarak ZATEN listeli.
İfade teknik olarak doğru ama kullanıcıyı yanlış sonuca götürüyordu: doğru
teşhis "borsa yok" değil "quote farklı". Sebepler artık birikimli basılıyor.
(Bu, Kraken'in dar USDT piyasasının genel bir sonucu: 1410 sembolün 1365'i
USDT dışı quote'ta. KTA artık USD vekiliyle taranıyor — bkz. "Kraken'de USD →
USDT vekili" — ama teşhisin birikimli basılması kuralı aynen geçerli.) `tekTarafli`/`taraniyor` ayrımında DEX bacağı iyimser
varsayılmaz: `zorunluOzet` DEX çiftlerini bilmeden çağrılırsa tek CEX'li çift
dürüstçe tek taraflı sayılır.

**Elle girilen DEX adresi iki koruma katmanından geçer.** `dex[]` girdileri
`config/tokens.json` tablosuna karışır (`kaynak: 'izleme-listesi'`), yani
`discover-tokens`'ın çoğunluk kuralından ve ±%25 sapma filtresinden GEÇMEMİŞ
demektir:
1. **Başlangıçta**: aynı zincirde aynı sembol için tokens.json başka bir adres
   diyorsa bot BAŞLAMAZ; aynı adres başka bir ticker'a kayıtlıysa da öyle.
   Adresin zaten tabloda olması hata değil, girdi yalnızca gereksizdir.
2. **`izle` çıktısında**: adres, borsaların bildirdiğiyle karşılaştırılır
   (`transfers.lookup(...).address`). Ölçülen örnek — DEGEN/base için okx,
   gate, mexc, kucoin dördü de aynı adresi bildiriyor. Çalışma anında `pickChain`
   bunu zaten yapıyor ama SESSİZCE: uyuşmazlık rotayı eler, kullanıcı sebebini
   göremez.

**Doğrulama yazma yolunun İÇİNDE.** Ölçüldü: `ekle` önce diske yazıp sonra
doğruladığında geçersiz bir adres dosyaya girdi ve bot o andan itibaren hiç
başlamadı — hata mesajı doğruydu ama iş işten geçmişti. Artık `yazIzlemeListesi`
gövdeyi okuma yolundan (`izlemeListesiOku`) geçirmeden yazmıyor ve `ekle`
tokens.json çakışmasını `tokenCakismasiniDene()` ile diske dokunmadan sınıyor.

**Bilinmeyen alan hatadır.** `"symbol"` yazıp `"sembol"` sanmak girdinin
sessizce yok sayılması demek — listenin var olma sebebi tam olarak bu
sessizliği önlemek olduğuna göre kendi dosyasında sessiz kalmak en kötüsü
olurdu. Davranış [test/izleme-listesi.test.ts](test/izleme-listesi.test.ts)
ile sabit.

**Kapsamadığı durum:** hiçbir CEX'te listeli olmayan coin. Muafiyet çifti
`minVenues`'tan kurtarır ama var olmayan çifti yaratmaz; böyle bir girdi
`listelenmemis` olarak raporlanır. Saf DEX↔DEX (iki zincirde aynı token, hiç
CEX yok) bilinçli olarak açılmadı — o rota köprü modellemesi ister.

## Yeni bir DEX token'ı eklemek

`config/tokens.json`'a girdi ekle → `npm run verify-contracts` (veya Solana için
`npm run dex`) ile doğrula.

**Elle eklenen token keşif filtrelerinden GEÇMEMİŞTİR ve bu bilinerek yapılır.**
Ölçülmüş örnek `KTA/base` (`0xc063…8973`, zincirde doğrulandı: symbol `KTA`,
name "Keeta", 18 decimals): Aerodrome'da havuz yok, Uniswap V3'te yalnızca
`fee=3000` havuzu var ve o da toz — $1000 gidiş-dönüş spread'i **%3946**
(birim fiyat $0.021 çıkıyor, gerçek fiyat $0.093). Yani token tabloda duruyor
ama DEX bacağı bugün fiyat ÜRETMİYOR. Zararlı değil: `MAX_ROUNDTRIP_SPREAD`
bunu store'a hiç yazmıyor ve 20 tur sonra token sorgudan düşüyor — yani sahte
sinyal riski yok, maliyeti birkaç tur RPC. CoW rota bulabilir ama bugün
bloklu (bkz. "Base'de üç venue"). KTA'nın gerçekten taranmasını sağlayan şey
DEX değil, Kraken USD vekili: `KTA/USDT` = mexc + kraken. Token yalnızca şu koşulda taranır: `<SYMBOL>/USDT` çifti
CEX tarafında da listelenmiş olmalı (`knownPairs` kontrolü,
[feeds/dex/index.ts](src/feeds/dex/index.ts)). Hiçbir borsada olmayan bir token'ı
taramak boşuna RPC harcar.

Bugünkü tablo: **138 Solana, 82 Base, 22 Arbitrum** girdi; `knownPairs`
filtresinden sonra fiilen izlenen: **134 / 79 / 19**. Base'in 11'den 75'e
çıkmasının sebebi yeni adres kaynağı DEĞİL, yeni ROTA: aynı adaylar zaten
vardı ve doğrudan-USDC havuzunda düşüyordu (bkz. "Base'de üç venue").
Arbitrum'da aynı hamle yapılmadı, o yüzden 10'da duruyor.

**"İzleniyor" = SORULUYOR demektir, FİYATLANIYOR değil** — ve aradaki fark
büyük. `npm run fiyatlar` ile ölçüldü (90 sn, doluluk = fiyat yazılan / abone
olunan):

| venue | doluluk | | venue | doluluk |
|---|---|---|---|---|
| bybit, okx, mexc, kraken | %100 | | jupiter | 133/134 · %99 |
| binance | 384/407 · %94 | | uniswap-v3 | 14/19 · %74 |
| kucoin | 686/817 · %84 | | camelot | 8/19 · %42 |
| gate | 886/1085 · %82 | | **uniswap-v3-base** | 26/79 · %33 |
| | | | **aerodrome** | 18/79 · %23 |

Yani Base'de tabloda 79 token var, fiilen fiyat akan 18–26. `kapsam` bunu
göremez (orada hepsi "izleniyor"), panel de göremez (yalnızca akan veriyi
gösterir) — bu boşluğun görüleceği tek yer `fiyatlar`.

Bu iş elle yapılmıyor: `npm run discover-tokens` **adres veren her borsadan**
kontrat/mint adresi toplar. Ölçülen kapsam: **MEXC 2145** girdi, Gate 627
(public), KuCoin 311 (public), OKX 111, Binance 108. Bybit ve Kraken listede
YOK çünkü ikisi de kontrat adresini hiç vermiyor (ölçüldü) — kaynak listesine
koymak "başarısız" gibi görünen boş bir satır üretirdi. Kaynak seçimi kimlik
kuralının
doğrudan sonucudur — bir varlığın adresini bilen otoriter yer, onu o zincirde
gerçekten gönderip alan borsadır. Jupiter/token listelerinde isme göre arama
yapmak tam olarak kaçındığımız hatayı üretir.

**Gate uzun süre kaynak DEĞİLDİ ve sebebi bir okuma hatasıydı**: adres üst
seviyedeki `chain` alanında değil `chains[].addr` içinde duruyor, o alan hiç
okunmuyordu ve Gate "adres vermiyor" sanılıyordu. Eklenince tablo **135 → 161**
girdiye çıktı (26 yeni token; 21'i Solana, hepsi Gate kaynaklı).

**Referans fiyat kaynağı, adres kaynağıyla aynı genişlikte olmalı.** Sapma
kontrolü fiyatı yalnızca Binance ve KuCoin'den alıyordu; Gate'e özgü tokenlar
"CEX fiyatı yok" ile **kontrolsüz** tabloya giriyordu. Ölçülen bedeli tek koşuda
görüldü: `SUPERFORM` kontrolsüz eklenecekti, Gate fiyatı eklenince **%89 sapmayla
elendi**. Aynı değişiklik 13 Solana girdisini "kontrolsüz"den "sapma %0.03–2.92"
bandına taşıdı. Yeni bir adres kaynağı eklerken `cexFiyatlari()`'ye de eklenmeli.

(`SUPERFORM` sonradan ikinci bir sebeple de elendi — zincirdeki sembolü `UP`.
Aynı tokenın iki ayrı filtreye takılması tesadüf değil: ticker çakışmaları
genelde hem fiyat hem kimlik tarafında iz bırakır. Bkz. "Kimlik kuralı".)

**Birden fazla kaynağın asıl değeri kapsam değil çapraz kontroldür**: iki borsa
aynı ticker için farklı adres veriyorsa bu, ticker çakışmasının kanıtıdır.
Gate'siz ölçümde 409 girdide sıfır çelişki çıkmıştı; Gate ve MEXC eklenince
Solana'da tek başına **8 çakışma** yakalandı (`DEFAI, VOID, NYAN, AUTISM, TAKI,
ZERO, PRISM, SNAI`). Kaynak eklemek kapsamı büyüttüğü kadar bu ağı da sıklaştırır.

**Çakışma çözümü ÇOĞUNLUK kuralıdır, "hiç yazma" değil.** Eski kural tek bir
ayrık kaynağın gerçek bir tokeni bloke etmesine yol açıyordu: `ARB`'ı dört
kaynak aynı adresle veriyor, MEXC ise Arbitrum satırına Ethereum kontratını
yazıyor (bilinen veri kusuru) — ve ARB tabloya hiç giremiyordu. Çoğunluğu
yazmak güvenli, çünkü **asıl koruma çalışma anında**: `pickChain` her borsanın
kendi bildirdiği adresi tokens.json'dakiyle karşılaştırıp uyuşmayan borsanın o
rotasını eler. Yani ayrık kaynağın bacakları zaten kapanır; tabloyu boş
bırakmanın tek etkisi DİĞER borsaları da kaybetmekti. Beraberlikte (2-2)
hâlâ yazılmaz — orada hangi tarafın doğru olduğunu söyleyecek dayanak yok.
Çakışmalar raporda **ayrı bölümde** listelenir; "elendi" kovasına konsalardı
tabloda duran ama bir borsası ayrık olan tokenlar (ARB gibi) yanlışlıkla
"elenmiş" görünürdü.

**Keşif doğrulaması botun yeteneğiyle AYNI olmak zorunda.** Arbitrum'da bot artık
Camelot + Uniswap V3 soruyor; keşif yalnızca Camelot soruyordu, yani botun
fiyatlayabildiği tokenlar tabloya hiç girmiyordu. Camelot sıfır dönerse tüm UniV3
fee tier'ları denenip **en iyi çıktı** alınır (ilk çalışanı seçmek ince havuza
düşer, fiyatı düşük gösterir ve token sapma filtresine takılıp haksızca elenir).
Eklenen 4 Arbitrum tokenının **dördü de** UniV3'ten fiyatlandı — Camelot hiçbirini
veremiyordu. ABI'ler `evm.ts`'ten import ediliyor; kopyalanırsa keşif ile bot
zamanla farklı şeyi sorar.

Eleme sebepleri raporlanır: **ölçekli ticker** (`1MBABYDOGE` borsada 10⁶ adedi
fiyatlar, DEX tek adedi — fark arbitraj değil birim uyuşmazlığıdır),
`EXCLUDED_BASES` stablecoin'leri, kaldıraçlı token'lar, ve DEX fiyatı CEX'ten
%25'ten fazla sapan adresler. Bu son filtre iş görüyor: `XLAB` %269, `ZRO` %100,
`XAI` %98, `HOOLI` %92 sapmayla elendi.

### DEX kapsamı denetlendi: Solana %90, EVM'de duvar rotada

"Bir borsada Solana'da listeli olan her coin Jupiter'de de olmalı; yoksa
yöntem yanlıştır" iddiası ölçüldü. Borsaların Solana bildirdiği **147** coin:

| | | |
|---|---|---|
| tabloda, izleniyor | **132** | %90 |
| kuralla elendi (ölçekli ticker `9BIT`) | 1 | |
| hiçbir borsa ADRES vermiyor | 7 | VIRTUAL, ZAMA, XAUT, MNT, ES, BLEND, COMMON |
| adres var, **Jupiter rota vermiyor** | 4 | ASP, XTER, CYS, STAR |
| adres var, Jupiter fiyatlıyor, tabloda YOK | 3 | NEIRO, BABYSHARK, XLAB |

Son satır kasıtlı: üçü de ±%25 sapma filtresine takıldı (NEIRO %100,
BABYSHARK %100, XLAB %318) — yani Solana'daki token, borsadaki aynı adlı
tokenla aynı fiyatta değil, muhtemelen farklı bir varlık. Yöntem hatası değil,
kimlik kuralının çalışması.

Dördüncü satır iddiayı doğrudan çürütüyor: **bir coin Solana'da transfer
edilebilir olup DEX'te fiyatlanamayabilir.** Borsanın "SOL ağı açık" demesi
tokenin zincirde var olduğunu söyler, AMM havuzu olduğunu değil; hacmin
tamamı CEX'te olan coinlerde havuz gerçekten yoktur.

Üçüncü satır ise kimlik kuralının bedeli: borsa ağı destekliyor ama adres
alanını boş bırakıyor. Adresi başka yerden (token listesi, isimle arama)
tamamlamak tam olarak kaçındığımız hatadır.

EVM'de tablo bambaşka ve darboğaz adres DEĞİL. Aşağıdaki ölçüm **CoW
eklenmeden ÖNCEsine** aittir ve teşhisin doğruluğunu göstermek için duruyor:

| zincir | zincirde | tabloda | adres yok | adres VAR, tabloda yok |
|---|---|---|---|---|
| base | 90 | 11 | 3 | **76** |
| arbitrum | 41 | 9 | 3 | **29** |

O 76 + 29 girdinin hepsi denendi ve doğrudan-USDC havuzunda düştü (Base'de
38 × "havuz yok", 23 × toz havuz). Yani EVM'de adres kaynağı eklemek kapsamı
AÇMAZ — tek çare çok adımlı rota.

**Teşhis doğrulandı: Base'de aynı adaylar rota açılınca tabloya girdi** (11 →
75+ izlenen). Rota iki ayrı yoldan açıldı — toplayıcıya sorarak (CoW) VE
zincirde 2 adımlı rotayı kendimiz sorarak (bkz. "2 adımlı rota"). İkincisi
canlı feed'de de çalışıyor; CoW'un ücretsiz uçtası canlı feed hızını
kaldırmıyor, ayrıntısı aşağıda. Arbitrum'da 2 adımlı rota da açık (feed ve
keşif, Camelot + UniV3); CoW ise orada hiç denenmedi (`CHAIN_PATH` →
`arbitrum_one` hazır).

### 2 adımlı rota (token ↔ WETH ↔ USDC)

Uzun süre "bilinen boşluk" olarak duran madde; **açıldı ve ölçüldü.**

Sebep: Base'de likidite ağırlıklı olarak WETH ile eşleşiyor, doğrudan
token↔USDC havuzu ya hiç yok ya toz. `EvmDexFeed` yalnızca doğrudan rotayı
sorduğu için bu tokenlar ya "havuz yok" ya "%100 sapma" ile eleniyordu.
Ölçülen tek örnek yeterince açık — `KTA/base`:

| rota | $1000 karşılığı | birim fiyat |
|---|---|---|
| doğrudan `USDC→KTA` | 0.0109 KTA | fiilen bozuk |
| **`USDC→WETH→KTA`** | **10522 KTA** | **$0.0950** |

CEX referansı $0.0932 (mexc) / $0.0940 (kraken), gidiş-dönüş spread **%1.36**.
Yani 2 adımlı rota yalnızca kapsam açmıyor, **doğru fiyatı veren rota o**.

Canlı ölçümde uniswap-v3-base'de daha önce hiç fiyatlanamayan tokenlar geldi:
`BRETT` $0.00416 · `AIXBT` $0.0181 · `KAITO` $0.917 · `ZORA` $0.00526 ·
`MORPHO` $1.917 — hepsi CEX fiyatıyla uyumlu.

**Keşif tarafındaki etkisi Arbitrum'da daha büyük oldu: 13 → 22 girdi.**
Gelen tokenlar tam olarak "yalnızca 2 adımlı rota kurtarır" diye işaretlenmiş
sınıf: `STG` ve `LPT` (`univ3:3000+weth`), `APE` (`camelot:weth`), `ETHFI`,
`RAIN` (`univ3:100+weth`). Base 78 → 82; oradaki `LINGO` da
`univ3:3000+weth` ile geldi. Keşif ile feed aynı rotayı sormak zorunda —
biri 2 adım sorup diğeri sormasaydı tablo ile taranan küme ayrışırdı.

**Rota indeksi ikiye bölünür**: ilk yarı doğrudan (UniV3'te tier başına bir),
ikinci yarı ara token üzerinden. Ayrım indeksle yapıldığı için **alış ve satış
bacağı AYNI rotadan** sorulabiliyor — bir rotadan alıp başkasından satmak
gerçekleştirilemeyecek bir işlemi fiyatlardı. Aday rota sayısı bu yüzden
ikiye katlanıyor ve `MAX_CALLS_PER_BATCH` bütçesine giriyor; ölçülen tur
süresi Base'de aerodrome 4.3 sn, uniswap-v3-base 11.3 sn — 30 sn'lik bayatlık
bütçesinin içinde.

Çağrı biçimi venue'ya göre değişiyor:

| venue | fonksiyon | yol |
|---|---|---|
| Aerodrome | `getAmountsOut` (aynı) | `Route[]` iki girdi — çağrı tarafı bedava |
| Uniswap V3 | `quoteExactInput(bytes,uint256)` | `tokenIn+fee+WETH+fee+tokenOut` |
| Camelot (Algebra) | `quoteExactInput(bytes,uint256)` | `tokenIn+WETH+tokenOut` (fee yok) |

**Modelleme endişesi neden ortadan kalktı:** eski not "kâr hesabına ikinci
havuz komisyonu + kayma girer, yanlış modellenirse sahte sinyal üretir"
diyordu. Quoter zaten HER İKİ havuzun komisyonu ve kayması dahil nihai çıktıyı
döndürüyor — biz hiçbir şey modellemiyoruz. Gidiş-dönüş spread kontrolü de
aynen uygulanıyor, yani bozuk 2 adımlı rota da doğrudan rota gibi eleniyor.

**İzlenmesi gereken: gas bütçesi.** `MAX_CALLS_PER_BATCH = 4` tek adımlı
quote'larla ölçülmüştü; 2 adımlı çağrı iki havuz dolaştığı için daha çok gas
yakıyor ve multicall'ın ORTAK bütçesi bu yüzden daha erken dolabilir. Bugünkü
ölçümde sorun görünmüyor (KTA hem aerodrome hem uniswap-v3-base'de doğru
fiyatlandı), ama bu hata sınıfı sessiz: bütçe dolunca çağrılar revert eder ve
"rota yok" gibi görünür. Batch'i büyütmeden önce ölç; küçültmek gerekirse
`n=3`'e inmek doğru yön.

**Base'de istek hacmi ÇARPIMSAL büyüyor — en büyük kaldıraç burada.**
Token başına sorulan rota: `aerodrome` 1 doğrudan + 1 iki-adımlı = **2**,
`uniswap-v3-base` 4 fee tier × 2 = **8**. Her tur iki dalga (önce tüm alış
rotaları, sonra alışı geçenler için satış) ve gruplar 4'erli, sıralı. 79
tokenle: aerodrome ~80 istek/tur, uniswap-v3-base **~316 istek/tur**.
`rotasiz()` sayesinde kararlı durumda daralıyor (ölçülen fiyatlanabilir token:
aerodrome 18/79, uniswap-v3-base 26/79 → ~18 ve ~104 istek/tur), ama **her
100. turda hepsi yeniden sorulur** ve o turda istek 4–5 katına fırlar.

Karşılaştırma, Solana'nın neden ucuz olduğunu gösteriyor: Jupiter `price/v3`
40 mint'i tek istekte fiyatlıyor, yani **134 token = 4 istek/tur**. Toplayıcı
rotayı bizim yerimize buluyor; Base'de her token × her tier × her rota × her
bacak ayrı bir zincir çağrısı. Pratik sonuç: Base'de bir fee tier eklemek
istek sayısını %25, bir venue eklemek ikiye katlıyor. Kapsamı büyütmeden önce
tur süresinin bayatlık bütçesine sığdığını doğrula — sığmazsa venue sessizce
taranamaz hale gelir. Bugün en ucuz kazanç, Base'de 4 tier'ı 2'ye indirmek
(500 + 3000).

**Ara bacağın tier'ı sabit** (`hopQuoteFee = 500`): WETH/USDC her zincirde en
likit havuz ve tier'ı bilinir; onu da taramak quote sayısını tier² yapardı.
Ara token `config/tokens.json`'daki WETH girdisinden çözülüyor — bulunamazsa
2 adımlı rota sessizce kapanır ve feed eski davranışına döner. Adres uydurmak
yerine yeteneği kapatmak doğru olan.

### Base'de üç venue: aerodrome, uniswap-v3-base, cow-base

**Bugünkü durum — bu üç satır okunmadan aşağısı yanlış anlaşılır:**

| venue | durum | tur süresi |
|---|---|---|
| `aerodrome` | canlı, sağlıklı | ~0.6–7 sn |
| `uniswap-v3-base` | canlı, sağlıklı | ~10–14 sn |
| `cow-base` | **ELLE KAPATILDI** (`DEVRE_DISI`) | — |

**`cow-base` VENUE olarak kurulmuyor, ama CoW artık boşta değil:** Base
bacaklarının çapraz kontrolünü o yapıyor (bkz. "DEX bacağının ikinci görüşü").
Aradaki fark bütçe: venue olarak istek TUR başına, çapraz kontrolde SİNYAL
başına atılıyor. Kod duruyor, `DEX_IDS`'te duruyor (PriceStore sütunu
ayrılmaya devam etsin diye), ama `DEVRE_DISI` listesinde —
[feeds/dex/index.ts](src/feeds/dex/index.ts). Geri açmak o diziden çıkarmakla
olur. Kapatma gerekçesi ölçüldü:

- **Erişim o gün kapalıydı.** 10 dakikalık koşuda `connecting → failed`,
  5 yeniden deneme, **0 başarılı tur**; doğrudan curl ile de `HTTP 403 + HTML`
  (CloudFront). (2026-08-27 ölçümünde erişim AÇIK: 3/3 × HTTP 200, ~200 ms.
  Yani bu madde artık geçerli değil — kapalı tutan sebep aşağıdaki bütçe.)
- **Blok kalksa bile bütçeye sığmıyor** — aşağıdaki ~94 sn'lik periyot.
- **Kapatmanın ölçülen maliyeti yok:** 2 adımlı WETH rotası açıldığından beri
  aerodrome + uniswap-v3-base aynı tokenları zaten fiyatlıyor.
- **Kazancı somut:** ölü venue panelde kırmızı satır olmayı ve — renderer'daki
  teşhis sırası yüzünden — CANLI venue'ların uyarısını gizlemeyi bıraktı.

Aşağıdaki CoW ölçümleri, kapatma kararının dayanağı olduğu için duruyor.
**CoW'un kazancı TABLOYA yansımıştı, AKAN VERİYE değil**:
`config/tokens.json` 78 Base girdisine çıktı çünkü keşif script'i CoW'a
soruyor (tur başına değil token başına bir kez), ama canlı fiyat hâlâ
Aerodrome + Uniswap V3'ün doğrudan-USDC havuzu bulabildikleriyle sınırlı.

**CoW bir AMM değil, niyet (intent) tabanlı toplu açık artırma protokolü** —
zincirde sorgulanacak quoter kontratı YOK, fiyat HTTP quote uçtasından geliyor.
Bu yüzden `EvmDexFeed`'in multicall yoluna girmiyor, ayrı bir feed
([feeds/dex/cow.ts](src/feeds/dex/cow.ts)) ve EVM döngüsünün DIŞINDA kuruluyor:
CoW'un RPC'ye ihtiyacı yok, `rpcUrl` yokluğu onu devre dışı bırakmamalı.

Asıl kazanç fiyat değil **rota**: çok adımlı yolu solver kuruyor, yani "bilinen
boşluk" olarak duran 2 adımlı WETH rotasını biz modellemeden veriyor. Ölçüm
($1000 gidiş-dönüş, aynı tokenlar, Aerodrome rakamları yukarıdaki tablodan):

| token | Aerodrome (doğrudan USDC) | CoW | token | Aerodrome | CoW |
|---|---|---|---|---|---|
| AERO | %0.62 | **%0.25** | DEGEN | %158 | **%1.12** |
| PLAY | %13.1 | **%0.62** | ZEN | %455 | **%0.45** |
| OFC | %16.8 | **%1.91** | BRETT | %3389 | **%0.76** |

**İkinci fark: CoW quote'u GERÇEKLEŞECEK miktarı döndürür** (ücret dahil), orta
fiyat değil. Yani Jupiter'in aksine ayrı bir Aşama 2 doğrulayıcısına
(`DexLegQuoter`) ihtiyacı yok — `EvmDexFeed` gibi store'a gerçek miktarlı
bid/ask yazıyor. Miktarı 0 bırakmak, tarayıcının bacağı "derinlik yok" diye
elemesi demek olurdu.

**Uniswap V3 kendi başına da hak ediyor:** keşifte `PROMPT` (univ3:3000),
`SOSO` (univ3:100) ve `GOCHU` (univ3:500) yalnızca UniV3'ten fiyatlandı —
Aerodrome da CoW da veremedi. Arbitrum'daki Camelot/UniV3 ikilisinin Base
karşılığı; likidite tek venue'da toplanmıyor.

**Venue kimliği zincir soneki taşıyor** (`uniswap-v3-base`, `cow-base`) çünkü
`DEX_CHAIN` birebir eşleme: aynı protokol iki zincirde ayrı kimlik ister.
Arbitrum'daki `uniswap-v3` tarihsel sebeple soneksiz kaldı — yeniden
adlandırmak `data/opportunities-*.ndjson` içindeki venue adlarını geçmişe
dönük tutarsız yapar ve `calibrate` eski koşuları okuyamaz hale gelirdi.

**Periyot bayatlık bütçesini aşarsa venue SESSİZCE ölür.** Tur maliyeti token
başına 2 istek ve kova sabit, yani periyot token sayısıyla büyüyor;
`MAX_DEX_PRICE_AGE_MS` ise sabit 30 sn. Liste yeterince büyüdüğünde fiyatlar
yazıldıkları anda bayat sayılır ve Base CEX↔DEX fırsatı YAPISAL olarak
üretilemez hale gelir — panel "live" derken. Tek bayatlık eşiği kullanılırken
bir kez yaşanmış hata sınıfının aynısı. Bu yüzden `CowFeed` kurulumda periyodu
bütçeyle karşılaştırıp uyarıyı teşhisin BAŞINA yazıyor; `EvmDexFeed` de aynısını
ÖLÇÜLEN tur süresiyle yapıyor (orada yapılandırılmış periyot yanıltıcı — `poll`
üst üste binmeyi engellediği için gerçek periyot tur süresine eşitlenir).

**CoW'un rate limit'i 429 ile GELMİYOR — kısa ölçüm bu yüzden yanılttı.**
20 sn sürekli yükte 2/sn, 5/sn ve 10/sn kademelerinin üçü de 0×429 verdi ve
"limit yok" gibi göründü. Gerçek sınır CoW'un önündeki CloudFront: sürekli
yükten bir süre SONRA IP'yi **403 + HTML** ile blokluyor. Ölçülen: 75 token ×
2 bacak / 19 sn ≈ 8 istek/sn'lik yük birkaç dakikada blok yedi. Bu,
geckoterminal dersinin başka bir biçimi — tek atışlık test rate-limit
davranışını göstermez, ve limit her zaman 429 ile ifade edilmez.

**Bunun ürettiği ikinci hata daha tehlikeliydi:** quoter her 4xx'i "rota yok"
sayıyordu, dolayısıyla blok anında 75 tokenın 75'i için `null` dönüyor ve panel
"hiçbirine rota yok" diyordu — altyapı bloğu likidite yokluğu gibi
raporlanıyordu. Kullanıcı tokenları silmeye çalışırdı; sorun tokenlarda
değildi. Ayırt edici işaret HTTP kodu DEĞİL, gövdenin JSON olması: CoW gerçek
"rota yok" cevabını `errorType` alanlı JSON ile verir (`cowHatasiMi`), gövde
HTML ise konuştuğumuz şey CoW değil önündeki CDN'dir ve bu bir ARIZADIR.

**Üçüncü hata: bloklu uca yüklenmeye devam etmek bloğu UZATIYOR.** Feed
başarısız turdan sonra zamanlayıcı aynı hızda tetiklendiği için saniyede 2
istek atmayı sürdürüyordu; CloudFront kararını süregelen yüke göre verdiğinden
bu, kendi kendini besleyen bir tuzak. Diğer feed'lerde bu sorun yok — RPC bizi
bloklamıyor, yalnızca hata döndürüyor — o yüzden `EvmDexFeed`'de karşılığı da
yok. `CowFeed` artık tolerans aşılınca üstel geri çekiliyor (30 sn → 15 dk
tavan) ve panelde kalan süreyi yazıyor. **Tavanın sonlu olması şart:** blok
geçici ve feed'in insan müdahalesi olmadan geri dönebilmesi gerekiyor.

**Sonuç — ölçek sınırı:** kova 2/sn'ye çekildi, o hızda 75 tokenlık tur ~94 sn
sürüyor, yani **CoW bu ölçekte geniş tarama kaynağı olarak kullanılamaz**.
Bugünkü kovayla bütçeye sığan sınır **~24 token** (`guvenliAralik(n×2, 120,
5000, 0.8) < 30 sn`). İki çıkış yolu var:

- **hızlı**: Base token listesini ~24'e indir — CoW bugün çalışır.
- **doğrusu**: CoW'u Aşama 2'ye taşı. Mimari bunu zaten tarif ediyor (Solana'da
  `DexQuoter`'ın yaptığı iş): o düzende geniş taramayı zincirden okuyan ucuz
  bir kaynak yapar ve istek sayısı turla değil ADAY sayısıyla ölçeklenir.
  Gerektirdiği şey Base'e ayrı bir ucuz geniş tarama kaynağı — bu yüzden
  ayrı bir iş.

Kovayı değiştirirken `COW_PER_MINUTE` de değişmeli.

**`RPC_GEREKTIRMEYEN` iki yerde birden bilinmek zorunda.** CoW zincire hiç
bağlanmadığı için `BASE_RPC_URL` tanımsızken de çalışır; `createDexFeeds` bu
yüzden CoW kurulumunu EVM döngüsünün dışında tutuyor ve `kapsam` da zinciri
"RPC yok → devre dışı" diye raporlamıyor. Ayrı ayrı yazılsalardı rapor çalışan
bir venue'yu kapalı gösterirdi.

`EXCLUDED_BASES` [core/types.ts](src/core/types.ts)'te tek yerde durur. İki bağımsız
yerde uygulanıyor — `main.ts` sembol keşfini, keşif script'i ise tokens.json yazımını
bununla filtreliyor. Ayrı tanımlansalardı biri güncellenip diğeri unutulduğunda
tabloda hiç taranmayan ölü satırlar kalırdı. Ölçekli ticker kalıbı dar tutuldu: "rakamla
başlıyor" demek `1INCH` ve `2Z` gibi gerçek ticker'ları da elerdi.

**`mainnet.base.org` KULLANILAMAZ — ölçüldü, tartışmaya kapalı.** Aynı token için
koşudan koşuya farklı cevap veriyor (VIRTUAL bir koşuda "havuz yok", diğerinde
$0.559; AIXBT 4. denemede okunabildi). Feed'in gerçek periyoduyla ölçüm: **10 turun
7'sinde hiçbir token fiyatlanamadı** (`8 0 0 0 4 0 0 4 0 0`). Ücretsiz ve kayıt
istemeyen alternatifler 25 tur / 75 sn kesintisiz yükte denendi:

| Uç nokta | 75 sn sürekli | Gecikme |
|---|---|---|
| **base-rpc.publicnode.com** | 0 başarısız | 86 ms |
| base.drpc.org | 0 başarısız | 80 ms |
| 1rpc.io/base | 6 turun 1'i eksik | — |
| mainnet.base.org | 6 turun 4'ü SIFIR | — |
| base.llamarpc.com, base.meowrpc.com | 6 turun 6'sı SIFIR | — |

Varsayılan bu yüzden `config/chains.json`'da publicnode.

**Arbitrum'da AYNI ders ikinci kez öğrenildi.** Bir dönem burada
"`arb1.arbitrum.io/rpc` ölçümde sorunsuzdu (10/10 tur), değiştirmeye gerek yok"
yazıyordu. O ölçüm Arbitrum'da TEK venue (camelot) ve tek adımlı rota varken
yapılmıştı; UniV3 ve 2 adımlı WETH rotası eklendiğinden beri istek sayısı
katlandı ve uç nokta 429 vermeye başladı — `camelot` canlı koşuda `failed`
sonra `idle` durumuna düştü, yani Arbitrum bacağı sessizce öldü. Yeniden
ölçüm (40 istek, ~5/sn):

| uç nokta | ok | medyan |
|---|---|---|
| **arbitrum-one-rpc.publicnode.com** | **40/40** | **53 ms** |
| arb-pokt.nodies.app | 40/40 | 56 ms |
| arbitrum.drpc.org | 40/40 | 77 ms |
| 1rpc.io/arb | 39/40 | 173 ms |
| arb1.arbitrum.io/rpc | 35/40 (5×429) | 162 ms |
| arbitrum.llamarpc.com | 0/40 | timeout |

Ders şu: **RPC ölçümü kapsam değiştiğinde geçersizleşir.** Bir venue ya da rota
eklemek istek sayısını çarpımsal büyütüyor (bkz. "Base'de istek hacmi
ÇARPIMSAL büyüyor"), dolayısıyla "bu uç nokta yeterliydi" cümlesinin ömrü, o
zincirin kapsamı sabit kaldığı sürecedir. `arbitrum.drpc.org` da not düşmeye
değer: önceki ölçümde ÖLÜ görünüyordu, bugün 40/40.

**Multicall'ı bölmek ZORUNLU.** Multicall3'ün `aggregate3`'ü bütün çağrıları tek
`eth_call` ve **tek gas bütçesiyle** çalıştırır; havuzu olmayan bir token'ın quoter
çağrısı revert ederken bütçeyi tüketince kendisiyle alakasız çağrılar da düşer.
`allowFailure: true` buna çare DEĞİL. Ölçüm (Arbitrum/Camelot, aynı liste):
`n=4 → 4/4`, `n=5 → 4/5` (yalnızca havuzsuz MAGIC düştü, doğru davranış),
`n=6 → 0/6`, `n=8 → viem 7+1 böldü, 7'lik grup toptan düştü`. Sınır token sayısına
değil gruptaki toplam gas'a bağlı; `MAX_CALLS_PER_BATCH = 4` ölçülen güvenli değer.
Aynı ders `discover-tokens`'ta zaten vardı (`MC_CHUNK = 60`), feed'e uygulanmamıştı.

**`failed` tek etiket değil, dört ayrı teşhis.** Eskiden `written > 0 ? 'live' :
'failed'` idi ve sıfır yazımın sebebi panelde görünmüyordu. Artık ayrılıyor: RPC
çağrısı patladı (uç nokta sorunu) · multicall döndü hepsi revert (rota/kontrat) ·
alış geçti satış geçmedi (tek yönlü likidite) · ikisi de geçti ama spread devasa
(havuz işlem büyüklüğünü taşımıyor). Durum ancak `FAILURE_TOLERANCE = 3` tur üst
üste kötü giderse `failed` olur — tek hıçkırık paneli kızartmamalı, DEX bayatlık
eşiği (30 sn) zaten üç turu soğuruyor. Feed'in `lastError`'ı uzun süre HİÇBİR YERDE
basılmıyordu; artık zincir tablosunun ayrıntı sütununda görünüyor.

**Teknik başarı ≠ ekonomik kullanılabilirlik.** `getAmountsOut` başarıyla dönerken
fiyat anlamsız olabilir. Ölçüm (Base/Aerodrome, doğrudan USDC, $1000 gidiş-dönüş):
AERO %0.62 · PLAY %13.1 · OFC %16.8 · **DEGEN %158 · ZEN %455 · BRETT %3389**. Son
üçü fiyat değil havuzun devrilmesi; `MAX_ROUNDTRIP_SPREAD = 0.25` üstü store'a hiç
yazılmaz. Eşik kasıtlı geniş: bu fiyatlar tarayıcı için zaten güvenli yönde hatalı
(şişmiş ask DEX'i en ucuz alış yeri yapmaz), tek maliyet boşa giden RPC yuvası —
daraltmak gerçek fırsatı eleyebilir. Tur BAŞARILIYKEN 20 kez üst üste
fiyatlanamayan token sorgudan çıkarılır ve 100 turda bir yeniden denenir; sayaç
yalnızca turun kendisi başarılıyken artar, aksi halde bir RPC kesintisi tüm tabloyu
haksızca "rotasız" ilan ederdi.

EVM tarafında bir de yapısal sınır var: `EvmDexFeed` yalnızca **doğrudan
token↔USDC** rotası soruyor. Base'de likidite ağırlıklı olarak WETH ile eşleşir,
bu yüzden token'ların bir kısmı gerçekten fiyatlanamaz. Keşif script'i botun bu
yeteneğiyle aynı rotayı deniyor — kasıtlı: tabloya, botun fiyatlayamayacağı token
yazmak boşuna RPC harcar.

Kontrat adresleri dokümantasyondan kopyalanmaz, zincirden doğrulanır. `verify-contracts`
üç kademelidir: adreste kontrat var mı → ERC20 symbol/decimals tabloyla eşleşiyor mu →
quoter makul fiyat veriyor mu. Üçüncüsü şart, çünkü yanlış bir quoter sessizce anlamsız
fiyat döndürür.

## Kimlik kuralı (en pahalı hata sınıfı)

Bir varlığın kimliği ticker DEĞİLDİR — birden fazla "MOON", "APE", "SUN" vardır.

- CEX↔CEX eşleşmesi ticker üzerinden yapılır, ama transfer zinciri doğrulanamıyorsa
  fırsat `transferVerified: false` ile işaretlenir.
- CEX↔DEX ve DEX↔DEX eşleşmesi **yalnızca kontrat/mint adresi** üzerinden yapılır.

**Kuralın TERSİ de geçerli ve bir kez ihlal edildi: aynı adres, iki ticker.**
Keşif script'inde doğrulama sonucu haritası yalnızca ADRESE göre anahtarlıydı,
oysa doğrulama (sembol, adres) çiftine aittir. Base'de `0x5b2193fd…`
kontratının zincirdeki sembolü `UP`, adı "Superform"; KuCoin onu `UP`,
Gate/MEXC `SUPERFORM` olarak listeliyor. `UP` zincirden sembol kontrolünü geçip
haritaya yazıyor, `SUPERFORM` kontrolde DÜŞÜYOR ama `sonuc.get(adres)` dolu
geldiği için doğrulanmış sayılıp tabloya giriyordu. İki bedeli var: aynı token
iki ayrı ticker'la tabloda durur (hangi CEX çiftine eşleneceği belirsiz), ve
`loadConfig()` yinelenen adresi gördüğü an **bot hiç başlamaz**. Anahtar artık
`dogrulamaAnahtari(sembol, adres)`; ayrıca yazma yolunun İÇİNDE ikinci bir
kontrol var — Solana tarafında zincirden sembol okunmadığı için (Jupiter mint'e
göre fiyat veriyor) aynı sınıf oradan gelebilir. Doğrulamanın yazmadan ÖNCE
olması izleme listesinde ölçülmüş bir ders: sonra doğrulamak "dosya yazıldı,
bot artık açılmıyor" demekti.

**CEX↔CEX adres çapraz kontrolü UYGULANDI.** Bu, daha önce "ölçüldü, karşılığı
yok" diye reddedilmiş bir fikirdi; ret **ölçümün kapsam hatasından** kaynaklanıyordu.

Eski ölçüm 746 kombinasyonda tek uyuşmazlık bulmuştu ve "Gate bu alanı hiç
vermiyor" varsayımıyla Gate'i dışarıda bırakmıştı. Gate **veriyor** — üst
seviyedeki `chain` alanında değil, `chains[].addr` içinde. Ölçüm Gate dahil
tekrarlandığında tablo tersine döndü:

| | eski ölçüm (Gate'siz) | yeni ölçüm (Gate dahil) |
|---|---|---|
| karşılaştırılabilir (coin\|zincir) | 746 | 330 |
| çatışan | 1 | **4** |

Çatışmalar: `DEFAI/solana` (kucoin `hwfh2kn2…` ↔ gate `8zx6ecj3…`),
`RDNT/arbitrum`, `ROOST/base`, ve bilinen MEXC `ARB` veri kusuru. **Üçü de
Gate'i içeriyor** — eski ölçümün neden boş çıktığı tam olarak bu.

`DEFAI/solana` kritik olan: aynı ticker, **aynı zincir**, farklı mint. Zincir
kesişimi kontrolü bunu yakalamaz; tek dayanak adrestir.

Kural `pickChain` içinde, zincir seçiminin en başında uygulanıyor:
- Karar yalnızca **İKİ TARAF DA** adres bildirdiğinde verilir. `null` "bilinmiyor"
  demektir, "çakışıyor" değil — Bybit bu alanı hiç vermiyor ve null'ı çakışma
  saymak Bybit'in tüm rotalarını sessizce yok ederdi.
- Bir zincirde çakışma varsa yalnızca **o zincir** elenir; başka zincirde
  adresler uyuşuyorsa fırsat oradan geçer.
- Sayaç ayrı (`rejectedByAddress`), `rejectedByTransfer`'a katılmaz: "çekim
  kapalı" yarın değişebilecek operasyonel bir durum, "farklı token" kalıcı bir
  veri gerçeği. Aynı kovaya konsalardı ticker çakışmasının varlığı panelde hiç
  görünmezdi.
- EVM adresleri küçültülür, base58 (Solana) mint'leri **küçültülmez** —
  base58'de harf düzeni anlamlıdır.

DEX tarafının adresi `config/tokens.json`'dan geliyor, yani aynı kural CEX↔DEX
ve DEX↔DEX için de tek fonksiyondan (`venueAddress`) uygulanıyor.

**Bu kuralın gerçek maliyeti bir yanlış pozitif:** MEXC `ARB`'ın Arbitrum
satırına Ethereum kontratını yazıyor, dolayısıyla mexc↔X yönünde ARB rotaları
eleniyor. Bilinçli tercih — bir fırsatı kaçırmak, iki farklı token'ı aynı sanıp
transfer etmekten ucuz.

## Tokenlaştırılmış hisse senetleri (xStocks) ek kesinti taşır

`config/tokens.json`'da 13 xStock var (`AAPLX, TSLAX, NVDAX, COINX, GOOGLX,
METAX, AMZNX, SPYX, HOODX, CRCLX, MCDX, SLX, SPCXX`) ve hepsi FİİLEN taranıyor
— `AAPLX/USDT` bybit + gate + mexc'te listeli, üstüne jupiter/raydium bacağı
var. Yani bunlar teorik bir kenar durum değil, aktif sinyal kaynağı.

**Borsanın taker tarifesi bu maliyeti İÇERMİYOR — ölçüldü:**

| borsa | normal çiftler | 13 hisse tokeni |
|---|---|---|
| gate (`/spot/currency_pairs`, çift başına `fee`) | %0.2 (2075 çiftin hepsi) | **%0.2** |
| mexc (`exchangeInfo`, sembol başına komisyon) | %0.05 | **%0.05** |

Yani `config/exchanges.json`'daki oranlar bu iki borsa için doğru ve ek
kesinti işlem komisyonu DEĞİL. Ölçülen kayıp transfer tarafında: Bybit'e
Solana üzerinden yapılan yatırmada **~%1.5**. Bybit'in public belgelerinde
buna karşılık gelen bir yatırma ücreti yok; üçüncü taraf analizler xStocks
tarafında ~%1 spread + ~%0.5 işlem ücreti bildiriyor ve ikisi ölçülen değere
oturuyor.

**Mekanizma belirsiz, BÜYÜKLÜK ölçülü** — ve bu botta doğru davranış maliyeti
yüksek yazmaktır: olduğundan düşük komisyon doğrudan sahte sinyal üretir,
yüksek komisyon yalnızca fırsat kaçırır. Bu yüzden kesinti `takerFee()` içinde
CEX bacağı başına ekleniyor (`HISSE_TOKEN_EK_PCT`, bugün %1.5).

- **DEX bacağına uygulanmaz**: quoter zaten gerçekleşecek miktarı döndürüyor,
  havuz ücreti fiyatın içinde.
- **Uygulandığında sinyal UYARI taşır.** Borsanın yayınlamadığı bir maliyeti
  sessizce kâra katmak, modeli doğrulanamaz yapardı — kullanıcı rakamın neden
  düşük olduğunu görebilmeli.
- **Liste ELLE tutulur** (`config/hisse-tokenlari.json`), kalıpla türetilmez.
  Sondaki "X" harfine bakan bir kural `SPX`, `ARX`, `MPLX`, `NATIX` ve `GMX`'i
  de hisse sanardı — kimlik kuralının aynısı: bir varlığın kimliği ticker'ın
  ŞEKLİ değildir.

Pratik sonucu: %1.5 × 2 bacak, `MIN_NET_PCT`'in (%0.4) yedi katı. Yani
CEX↔CEX hisse fırsatı fiilen üretilemez hale gelir; CEX↔DEX'te tek bacak
kesinti taşır. Ölçüm düzeltilirse (ör. Bybit'e özgü olduğu kanıtlanırsa)
doğru yer venue bazlı bir override olur — bugün öyle yazılmadı, çünkü elimizde
tek bir borsadan tek bir ölçüm var ve onu tüm sınıfa genellemek, dar yazıp
yanılmaktan güvenli.

## Transfer bilgisi

[engine/transfer-info.ts](src/engine/transfer-info.ts) üç kademeli çalışır:

1. **Gate.io ve KuCoin** — public API, anahtar gerekmez, her zaman `verified: true`.
   Gate'te **`chains[]` dizisi okunur, üst seviyedeki `chain` alanı DEĞİL.** O alan
   coin'in yalnızca VARSAYILAN zinciridir. Bir dönem o okunuyordu ve iki yönlü
   hata üretiyordu: (a) varsayılanı ETH olup Base'de de listeli bir coin tabloda
   Base satırı taşımıyordu — "suskunluk da bilgidir" kuralı yüzünden bu, gerçek
   fırsatın SESSİZCE elenmesi demekti; (b) `chains[].addr` (kontrat adresi) hiç
   okunmadığı için kimlik çapraz kontrolü "Gate kapsanamaz" diye ölçüm dışı
   kalmıştı. Düzeltmenin ölçülen etkisi: bilinen coin **643 → 679**.
2. **Binance, Bybit, OKX, MEXC** — `.env`'de salt-okunur API anahtarı varsa imzalı
   endpoint'ten çekilir ve `verified: true` olur.
3. Anahtar yoksa (veya istek başarısızsa) zincir varlığı 1. kademeden devralınır,
   durum iyimser varsayılır, `verified: false` işaretlenir ve bildirim uyarı taşır.

Anahtar tanımlı ama istek başarısızsa borsa **doğrulanmış sayılmaz** — yarım veriyle
"doğrulandı" demek hiç doğrulamamaktan tehlikelidir. Sebep başlangıçta loglanır
(`credentialErrors`).

Private tablo yüklendiyse **suskunluk da bilgidir**: coin/zincir listede yoksa o borsa
o zincirde transferi desteklemiyor demektir (`withdrawEnabled: false`). Burada iyimser
davranmak doğrulama eklemenin amacını boşa çıkarır.

### Durum bilgisi TAZE olmak zorunda (ölçüldü — sahte alarmın sebebi)

Yatırma kontrolü kodda hep vardı (`pickChain` → `to.depositEnabled`) ama iki ayrı
yoldan **bayat veriye** bakıyordu; ikisi de "yatırması kapalı coinin alarmı uzun
süre çaldı" şikâyetini tek başına üretebilir.

**1. Tazeleme aralığı 6 SAAT'ti.** Çekim/yatırma yapısal değil OPERASYONEL bir
bilgidir: borsa ağ bakımına girince dakikalar içinde kapanır. `main.ts` 15 dakikada
bir `refreshIfStale()` çağırıyordu ama eşik 6 saat olduğu için çağrıların çoğu hiçbir
şey yapmıyordu. Hata sınıfı kendini besliyor: yatırması kapanan coinin fiyatı **tam
o yüzden** ayrışır, yani tablo bayatken üretilen sinyal hem yanlış hem ısrarcıdır —
45 sn'lik "kapanmayan fark" uyarısı bile onu durduramaz, çünkü uyarı sinyali
engellemez. `DEFAULT_REFRESH_MS` artık **15 dk**; maliyeti tazeleme başına ~7 istek
(kucoin + gate + gate ücret + anahtarlı borsa başına 1). Yoklama aralığı eşikten
kısa olmak zorunda (5 dk) — eşitken yoklama eşiğin hemen öncesine denk gelirse
gerçek yaş iki katına çıkar. Tazeleme üst üste başarısız olursa (`refreshIfStale`
hatayı yutar, doğru olan bu) sinyal artık `transfer tablosu N dk'dır tazelenemedi`
uyarısı taşır — `TRANSFER_TABLE_STALE_MS`, üç pencere.

**2. Gate'in ÖLÜ listeleme kayıtları canlı kaydı EZİYORDU.** Gate delisting'de
kaydı silmiyor, `_OLD` / `_OLD2` / `_1` sonekiyle saklıyor ve o kayıtların durum
bayrakları eski (genelde "açık") kalıyor. Taban coin adı ilk alt çizgiye kadar
alındığı için `OX_OLD1` kaydı `OX` satırının üstüne yazıyordu. Ölçüm (5487 kayıt):
624 coin|zincir satırının 6'sı iki kayıttan geliyordu ve **5'i çelişiyordu** —
beşinde de ölü kayıt "yatırma açık", canlı kayıt "yatırma KAPALI" diyordu
(`OX/arbitrum`, `CATCH/arbitrum`, `GOB/arbitrum`, `ROOST/base`, `RDNT/arbitrum`).
Düzeltmeden sonra beşi de canlı kaydın değerini alıyor.

Ölü kayıtlar elenince **yalnızca onlardan gelen 10 satır da düşüyor**
(`NEIRO/solana`, `CYS/solana`, `BABYSHARK/solana`…) ve düşmesi doğru: Gate'in canlı
kaydı o zinciri saymıyorsa orada iş yapamayız — üstelik bunlar tam olarak kimlik
çakışması sınıfı, aynı ticker'ın eski token'ı. `_ETH` / `_BSC` gibi zincire özel
kayıtlar ELENMEZ; onlar canlıdır ve taban coin altında birleşirler. Birleşim
**kötümserdir** (AND): `byChain.set` ile üstüne yazmak doğruluğu liste sırasına
emanet ederdi. Çelişen adres `null`'a düşer — "bilinmiyor", çakışma değil.

Ayrıştırma ağdan ayrıldı (`gateTablosunuKur`) ki test gerçek cevap biçimini ağa
çıkmadan zorlayabilsin ([test/transfer-info.test.ts](test/transfer-info.test.ts)).
KuCoin'de aynı sınıf ölçüldü ve **yok** (318 coin|zincir, 0 yinelenen).

Ölçülen ama BULUNMAYAN üçüncü aday: `withdraw_delayed`. Gate bu bayrağı veriyor ve
gecikmeli çekim arbitrajı bozar, ama izlediğimiz üç zincirdeki 630 satırın
**0'ında** işaretli — kod eklemek için dayanak yok.

Çekim ücreti bilinmiyorsa (Gate bu endpoint'te vermiyor, doğrulanmamış borsalarda hiç
veri yok) `assumedFee()` tahmin eder: `assumedFeePctOfTrade × tradeSizeQuote / fiyat`.
İşlem büyüklüğü `main.ts`'ten `cfg.scan.tradeSizeQuote` olarak geçirilir; sabitlemek
`TRADE_SIZE_QUOTE` değiştiğinde tahmini yanlış ölçekte bırakır.

**Saat kayması imzalı istekleri kırar.** Borsalar gelecekteki zaman damgasını
`recvWindow`'dan bağımsız ~1 sn toleransla reddeder (Binance `-1021`, Bybit `10002`).
`syncClock()` her borsanın sunucu saatini ölçüp offset tutar; `venueNow()` imzalarda
bunu kullanır ve ayrıca 500 ms geri alır (ileri sapmak reddedilir, geri sapmayı
recvWindow soğurur — asimetrik risk). Bu ölçülmüş bir hatadır, teorik değil.

**Gate anahtarı diğerlerinden farklı yerde durur.** Gate'in durumu ve adresi
zaten public uçtan doğrulanıyor; `GATE_API_KEY`'in eklediği TEK şey gerçek
**çekim ücreti** (`/wallet/withdraw_status`, public uç bu alanı vermiyor).
Bu yüzden gate `PRIVATE_FETCHERS`'a konmadı — oradaki sözleşme "tablo gelirse
borsa doğrulanır", oysa gate zaten doğrulanmış ve ücret çekimi başarısız olsa
bile doğrulanmış KALMALI. Ücret tablosu ayrı gelir, mevcut satırların üstüne
yalnızca ücret yazılır; başarısızlık `credentialErrors`'ta görünür ve ücret
`assumedFee()`'ye geri düşer. Ücret tahmininin sapması küçük değil — ölçüm:
RWA için tahmin 769 coin, KuCoin'in aynı coin için gerçek ücreti 450.
Gate imzası da ayrı: **HMAC-SHA512**, imzalanan metin gövdenin SHA512 özetini
içerir ve zaman damgası **saniye** (ms verilirse imza reddedilir).

**Kraken'in public API'si transfer bilgisi HİÇ vermiyor** (ölçüldü:
`/0/public/Assets` yalnızca `status`, `decimals`, `altname` döndürüyor — zincir
listesi yok, çekim durumu yok, kontrat adresi yok). Bu yüzden `KRAKEN_API_KEY`
olmadan Kraken bacakları zincir varlığını başka borsalardan devralıp iyimser
davranmak zorunda; yani "ortak zincir yok" durumu tespit EDİLEMEZ ve RWA
hatasının sınıfı Kraken tarafında açık kalır.

Anahtarla `/0/private/WithdrawMethods` çekiliyor. Kapsamadığı iki şey var:
**çekim ücreti** (Kraken genel tablo vermiyor; `/0/private/WithdrawInfo`
önceden kaydedilmiş çekim adresi anahtarı istiyor, tablo kurmaya elverişsiz)
ve **kontrat adresi** (hiç vermiyor → Kraken kimlik çapraz kontrolüne giremez,
Bybit ile aynı durumda).

**Yatırma durumu TALEP ÜZERİNE, coin bazında çekilir** (`DepositMethods`).
Eskiden çekimden VARSAYILIYORDU ve gerekçesi şuydu: uç varlık başına çağrı
istiyor, Kraken'in kovası 1 istek/sn, 557 taranan sembol ≈ 9 dakika. Gerekçe
doğruydu ama yanlış soruyu cevaplıyordu — tam tabloyu ÖNDEN kurmak gerekmiyor.
Yatırma durumu bir **Aşama 2 bilgisidir**: yalnızca `pickChain`'e gelen bir
avuç coin için gerekli, tıpkı L2 derinliği gibi. Artık `lookup()` ıskaladığında
coin sıraya giriyor, tek akışta çekiliyor, 30 dk TTL ile önbellekleniyor.

Varsayımın bedeli ÖLÇÜLDÜ. BONK `WithdrawMethods`'ta Solana ağıyla listeli
(çekim açık) ama `DepositMethods` BONK için **boş dizi** döndürüyor — Kraken'e
BONK yatırılamıyor. 5 dakikalık koşuda **9 BONK sinyali** üretildi ve
**dokuzunda da satış tarafı kraken**'di; hepsi gerçekleştirilemez. Düzeltmeden
sonra aynı koşu 0 üretti, `SOL/JUP/USDC-base` ise doğru şekilde açık kaldı.

Üç kural bu düzeltmenin içinde:

- **Bilinmiyor = KAPALI.** Henüz sormadığımız coin sinyal üretmez. Ters yön
  tam olarak BONK hatasıdır; bu yön yalnızca birkaç saniye sinyal geciktirir.
- **Boş cevap hata DEĞİL.** `result: []` geçerli bir "hiçbir ağda yatırılamaz"
  cevabı. Hatayla aynı kovaya konsaydı geçici arıza kalıcı "kapalı" gibi
  görünür, ya da tersi, BONK sonsuza kadar yeniden sorgulanırdı.
- **Sarmalanmış varyant reddedilir.** Yöntem adı `"<VARYANT> - <AĞ> (...)"`
  biçiminde gelebiliyor ve `USDC.e - Optimism`, `kBTC - Ink` gibi kayıtlar
  AYNI ticker altında FARKLI varlığı anlatıyor. Ayraçtan önceki kısım ticker'la
  birebir eşleşmezse kayıt sayılmaz — kimlik kuralının bu uçtaki karşılığı.

Uç nokta hiç çalışmazsa (anahtarda izin yok vb.) başlangıçtaki yoklama bunu
yakalar, eski iyimser davranışa dönülür ve **kayıtlar `verified:false` taşır**;
sebep `credentialErrors`'ta görünür. Tüm Kraken satış rotalarını sessizce yok
etmek, kullanıcının sebebini göremediği bir yarı-felç olurdu.

**Kraken nonce'u artık MONOTONİK sayaç.** Düz `Date.now()` tek private istek
varken yeterliydi; yatırma sorgusu geldiğinden beri aynı milisaniyede iki
istek çıkabiliyor ve ikisi de aynı nonce'u alırsa Kraken o andan SONRAKİ tüm
istekleri "Invalid nonce" ile reddeder — anahtar geçerliyken.

**Kraken nonce'u `venueNow()` ile ÜRETİLMEZ.** Diğer borsalarda zaman damgası
sunucu saatine göre doğrulanır ve kaymayı düzeltmek şarttır; Kraken'de nonce'un
sunucu saatiyle ilgisi yok, tek şartı her istekte ARTMASI. Saat düzeltmesi
uygulamak tam ters etki yapar: iki tazeleme arasında ölçülen offset küçülürse
nonce geriye gider ve Kraken o andan sonra tüm istekleri "Invalid nonce" ile
reddeder — anahtar geçerliyken.

**Sağlayıcısı olmayan borsaya anahtar girilirse artık sessiz kalınmıyor.**
`loadConfig()` anahtarları `CEX_IDS` üzerinden geziyor, yani yeni bir borsa
eklendiği an `<BORSA>_API_KEY` kabul edilmeye başlıyor — ama `PRIVATE_FETCHERS`
girdisi yoksa anahtar hiçbir işe yaramadan yok sayılırdı ve kullanıcı borsayı
doğrulanmış sanırdı. Bu durum `credentialErrors`'a "anahtar KULLANILMIYOR"
olarak yazılıyor (bugün yalnızca kucoin bu durumda; durumu zaten public uçtan
doğrulanıyor).

Yeni borsa eklemek: `PRIVATE_FETCHERS` ve `CLOCK_ENDPOINTS` tablolarına birer girdi.
Scanner, feed ve store katmanları değişmez — scanner yalnızca `lookup().verified` okur.

## v1 kapsamı: tespit ve bildirim, emir yok

- [exec/executor.ts](src/exec/executor.ts) — `buildPlan()` her fırsat için 3 bacaklı
  (al → çek → sat) idempotent bir plan üretir, `NotifyOnlyExecutor` hiçbir şey göndermez.
  v2'de tek değişiklik `main.ts`'te `Executor` implementasyonunu değiştirmek.
- [risk/limits.ts](src/risk/limits.ts) — `RiskManager.check()` çağrılır ama **uygulanmaz**,
  yalnızca loglanır. Amaç limitleri gerçek veriyle kalibre edebilmek.
- Bu iki katmanı "pasif" tutmak kasıtlıdır; sinyal üretimini engelleyecek şekilde
  bağlanmamalıdır.

## Sahte sinyal savunmaları (canlı testte ölçülmüş)

Bunlar süs değil, gözlenen hata modlarına verilmiş yanıtlar — kaldırmadan önce nedenini oku:

- **Kapanmayan fark**: `SUSPICIOUS_PERSISTENCE_MS = 45s`. Bir fırsat rakamı hiç
  değişmeden 75 sn durduysa kârlı olduğu için değil ULAŞILAMAZ olduğu için oradadır.
- **Yaş EPİZOT bazında ölçülür** (`episodeGapMs`). `firstSeen` bir kez yazılıp hiç
  sıfırlanmıyordu, yani yaş "şu anki fark ne kadardır açık" değil "bu fırsat ilk kez
  ne zaman görüldü" demekti — sabah 10 sn açılıp kapanan bir fark akşam yeniden
  açıldığında "8 saattir kapanmıyor" diye işaretleniyordu. 20 saatlik kalibrasyonda
  bu uyarı **en baskın kategoriydi (%37.5)**; yani kalite metriğimizi bozan şeyin
  kendisi bir ölçüm hatasıydı. Boşluk `max(5 × VERIFY_COOLDOWN_MS, 15 sn)` olarak
  türetilir: açık duran bir fırsat `verifyCooldownMs`'den sık görülemez, beş pencere
  üst üste ıskalandıysa fark gerçekten kapanmıştır. Alt sınırı düşürmek gerçek
  uyarıyı kaçırır, yükseltmek düzeltilen hatayı geri getirir.
  Ayrıca `prune` ölçüsü son YAYIN değil **son GÖRÜLME** anıdır — cooldown'lı bir
  tüketicide kesintisiz açık duran fırsat yayınlanmadığı için silinir, silinince de
  yaşı sıfırlanırdı.
- **Dedup**: aynı fırsat 50 ms'de bir yeniden üretilir; filtresiz 75 sn'de 210 kayıt
  oluşur. [notify/dedup.ts](src/notify/dedup.ts) üç ayrı yerde farklı ayarla kullanılır —
  Telegram (cooldown), disk kaydı (`recordGate`, 30 sn), scanner (`tracker`, cooldown 0 —
  yalnızca yaş ölçer, yayın kararı vermez). Scanner'ın `tracker`'ı uzun süre hiç
  budanmıyordu (`main.ts` yalnızca `recordGate`'i buduyor); artık `evaluate()` içinde
  dakikada bir kendi tablosunu buduyor.
- **DEX quote sayaçları üç kovadır**: `tried / ok / empty / error`. Tek kova
  ("elendi") "likidite yok" ile "boru hattı bozuk" arasında ayrım yapmadığı için
  `DexQuoter`'ın hiç çağrılmadığı dönem panelde **hiçbir iz bırakmadı**. `tried = 0`
  bağlantı hiç kurulmadı demektir ve panel bunu sıfırken de sarı satırla yazar —
  sessizliğin kendisi görünür olmalı.
- **Saat kayması**: raporlanan gecikme, gözlenen minimum `recvTs - exchangeTs` farkı
  düşülerek hesaplanır. Ham fark gecikme değildir (lokal saat kayması içerir).
- **Sessiz ölüm watchdog**: bağlantı açıkken veri akışının durması, kopmuş bağlantıdan
  daha tehlikelidir — sağlık paneli "live" derken motor bayat fiyatla fırsat hesaplar.
- **Kaldıraçlı token kalıbı sona bakmaz**: `isLeveragedTicker` öndeki tabanın en
  az üç karakter olmasını arar. Yalnızca soneke bakan sürüm **JUP**'ı ("UP" ile
  biter) kaldıraçlı sayıp altı borsada listeli bir coini hiç taramıyordu. Bu hata
  sınıfı sessizdir: eksik çift hata üretmez, sadece yoktur — bu yüzden davranış
  [test/symbol-registry.test.ts](test/symbol-registry.test.ts) ile sabitlendi.
- **Sesli uyarı da dedup'lu**: [notify/sound.ts](src/notify/sound.ts) yalnızca
  `recordGate` "yeni/iyileşmiş" dediğinde çalar ve üstüne kendi cooldown'ı vardır
  (`SOUND_COOLDOWN_MS`). Her tetiklenmede çalmak sesi bilgi taşımayan bir uğultuya
  çevirir — bu, Telegram'daki 210-kayıt hatasının sesli karşılığı olurdu. Çalma
  başarısız olsa bile cooldown saati ilerler: ses cihazı olmayan makinede her
  fırsat için yeni bir süreç başlatan sessiz bir döngü oluşmasın.
- **Asgari çekim tutarı**: `pickChain` komisyon sonrası çekilecek miktarı `withdrawMin`
  ile karşılaştırır ve karşılamayan zinciri eler. Borsa o miktarın altını hiç göndermez;
  kontrol edilmezse gerçekleştirilemeyecek transfer fırsat olarak yayınlanır. Asgarisi
  karşılanmayan ucuz zincir yerine karşılanan pahalı zincir seçilir.
- **Bayatlık eşiği venue TÜRÜNE göre ayrı**: `MAX_PRICE_AGE_MS` (CEX, 3 sn) ve
  `MAX_DEX_PRICE_AGE_MS` (DEX, 30 sn). CEX fiyatı WebSocket'ten push edilir, DEX
  fiyatı HTTP ile çekilir ve periyodu kaynağın limiti belirler. Tek eşik
  kullanılırken **her DEX okuması bayat sayılıyor ve CEX↔DEX fırsatı yapısal
  olarak üretilemiyordu** — hiçbir yerde hata görünmeden, DEX bacağı ölü ağırlıktı.
  Eşikler `Scanner` kurulumunda venue başına bir `Float64Array`'e yazılır; hot
  path'te tek indeksli okuma, dallanma yok. Gevşetmek güvenli çünkü Aşama 1
  fiyatı kâr hesabına girmez, yalnızca doğrulanacak çifti seçer.

  **İKİ AŞAMA DA aynı tablodan okumak zorunda** (`maxAgeFor`). Düzeltme uzun
  süre yalnızca Aşama 1'e uygulanmıştı: `verify()` düz `maxPriceAgeMs`'i (3 sn)
  iki bacağa birden dayatıyordu, yani Aşama 1'in kabul ettiği DEX adayı bir
  aşama ötede sessizce eleniyordu — aynı hata sınıfı, yeni yerde. Jupiter
  periyodu kaynağın limitinden türetiliyor ve ölçülen değer anahtarsız
  **~11.4 sn** (133 token / 40'lık chunk = 4 istek, 60/dk limitin %35'i
  taramaya; anahtarla bile taban 5 sn). CEX tick'iyle dirty olan bir Solana
  çiftinde DEX bacağı 3 sn'yi çoktan aşmış oluyordu, dolayısıyla CEX↔DEX
  fırsatı yalnızca DEX yazımının ilk 3 saniyesinde doğrulanabiliyordu:
  pencerenin **~%26'sı**. Eleme `rejectedByStale`'e yazıldığı için panelde
  gerçek CEX bayatlığından da ayırt edilemiyordu. Uyarı eşiği (`fiyat yaşı`)
  aynı sebeple bacak başına ölçülür — düz `maxPriceAgeMs / 2` her CEX↔DEX
  sinyaline uyarı iliştirip uyarıyı bilgi taşımaz hale getiriyordu. Davranış
  [test/scanner.test.ts](test/scanner.test.ts)'te üç testle sabit; eski test
  zinciri hatayı göremiyordu çünkü `candidateCount`'ta kesiliyordu, yani tam
  olarak hatanın başladığı yerde.
- **Tur süresi bayatlık bütçesini aşarsa YAPISAL uyarı basılır.** Bayatlık
  eşiğini venue türüne göre ayırmak (üstteki madde) sorunu yarısına kadar
  çözüyor: eşik doğru olsa bile feed'in TUR SÜRESİ eşiği aşarsa fiyat
  yazıldığı anda bayat olur ve o venue hiç taranamaz — panel "live" derken.
  Ölçüldü: Base token sayısı 11 → 75'e çıkınca aerodrome turu 57 sn,
  uniswap-v3-base 61 sn, cow-base 94 sn oldu (bütçe 30 sn). Yani **kapsamı
  büyütmek sinyal üretimini öldürebiliyor** ve bunun hiçbir doğal işareti yok.
  `CowFeed` periyodu kurulumda (limitten türetildiği için önceden bilinir),
  `EvmDexFeed` ise ÖLÇÜLEN tur süresiyle karşılaştırır — orada yapılandırılmış
  periyot yanıltıcıdır, çünkü `poll` üst üste binmeyi engellediğinden gerçek
  periyot tur süresine eşitlenir. Ölçü son tur değil son turların EN İYİSİ: tek
  bir yavaş tur (RPC hıçkırığı) uyarı üretmemeli.

  **Pencere KAYMAK zorunda ve bu bir kez ihlal edildi.** `enIyiTurMs` minimumu
  koşunun TAMAMI üzerinden alıyordu (`Math.min(enIyiTurMs, sureMs)`, hiç
  sıfırlanmıyor). Ölçülen bedeli: ilk dakikadaki 6.1 sn'lik aerodrome turu,
  sonraki 10 dakika boyunca her tur 59–64 sn sürerken uyarıyı KALICI olarak
  susturdu — yani bozulmayı gösterecek araç, sonradan başlayan bozulmaya karşı
  kördü. Artık son `TUR_PENCERESI` (5) turun minimumu; uyarı kurulabildiği gibi
  KALKABİLİYOR da, çünkü bozulma geçici olabilir ve kalıcı bir uyarı bir
  sonraki gerçek bozulmayı görünmez yapardı. Dört testle sabit
  ([test/evm-feed.test.ts](test/evm-feed.test.ts)); kritik olanı "SONRADAN
  başlayan bozulma da uyarı üretir".
- **Tek bir takılan RPC çağrısı turu 60 sn dondurabiliyordu.** Uç nokta yavaş
  değil: `base-rpc.publicnode.com`, 300 istek sürekli yük → medyan 47–52 ms,
  sağlıklı penceredeki en yavaş 200 ms, sıfır hata. Ama o 300 isteğin BİRİ
  **60185 ms** sürdü. Sebep ayardaydı: `timeout: 15_000` + viem'in varsayılan
  `retryCount: 3` = 4 × 15 sn ≈ 60 sn, ve çağrı sonunda BAŞARILI olduğu için
  hiçbir yere hata yazılmıyordu. `multicallChunked` grupları sırayla
  beklediğinden bir takılma turun tamamını donduruyor; Base'de tur başına ~400
  grup olduğu için neredeyse her tur bir takılmaya denk geliyordu (aerodrome
  ilk dakika 6.1 sn, sonrası 59–64 sn). Şimdi `RPC_TIMEOUT_MS = 3_000`
  (medyanın ~60 katı — bunu aşan çağrı yavaş değil TAKILMIŞTIR) ve
  `RPC_RETRY_COUNT = 2`, yani tavan ~9 sn. Düşürürken dikkat: sağlıklı kuyruk
  gecikmesi de gerçek, 1 sn'ye inmek geçici yavaşlamayı takılma sayar.
- **Panel zincir başına TEK teşhis basıyordu ve ölü venue canlıları gizliyordu.**
  `cow-base` 10 dakika boyunca `failed` kaldığı için Base ayrıntı sütununu
  kalıcı işgal etti; aynı anda aerodrome + uniswap-v3-base turları 60–74 sn'ye
  çıkarken o uyarı HİÇ görünmedi. Artık tüm venue'ların teşhisi basılıyor —
  arızalılar önce, her biri venue adıyla — ve kırpma `…` ile GÖRÜNÜR, çünkü
  yan yana dizilmiş teşhislerde sessiz kesme, son venue'yu hiç görmemek demek.
- **`droppedCount` toplanıyordu ama hiçbir yerde basılmıyordu.** Yani kuyruk
  taşarken "kaçırdık mı?" sorusunun cevabı panelde yoktu. Ölçüldü: 5 dakikada
  **10734 adayın 8465'i (%79) doğrulanmadan atıldı.** Atılan aday ile elenen
  aday aynı şey değil — elenen doğrulandı ve kârsız çıktı, atılan hiç
  doğrulanmadı. Sayı artık `tarama:` satırında `atılan N` olarak görünüyor ve
  ön filtrenin doğrulama kapasitesinin üstünde aday ürettiğinin tek ölçüsü.
  Yumuşatan şey [scanner.ts:427](src/engine/scanner.ts#L427): atılan her zaman
  en düşük HAM farklı aday, yani kuyruk daima en iyi 40'ı tutuyor. **Test
  EDİLMEMİŞ varsayım:** kuyruğun tepesinin, asla sinyale dönüşemeyecek ticker
  çakışmalarıyla (bkz. `npm run fiyatlar`, 21 çift %100+ sapmalı) dolu
  olmadığı.
- **Altyapı bloğu ile likidite yokluğu AYRI teşhistir.** CoW quoter'ı her 4xx'i
  "rota yok" sayıyordu; CloudFront IP'yi 403 + HTML ile bloklayınca 75 tokenın
  75'i için `null` döndü ve panel "hiçbirine rota yok" dedi. Kullanıcı
  tokenları silmeye çalışırdı — sorun tokenlarda değildi. Ayırt edici işaret
  HTTP kodu DEĞİL, gövdenin sağlayıcının kendi hata biçiminde olması
  (`cowHatasiMi`: `errorType` alanlı JSON). Gövde HTML ise konuştuğumuz şey
  API değil önündeki CDN'dir. Yeni bir HTTP kaynağı eklerken aynı ayrımı kur:
  "veri" ile "bize ulaşamıyoruz"u aynı kovaya koymak, teşhisi yanlış tarafa
  yönlendirir.

  **Aynı kural JUPITER'de İHLAL EDİLMİŞ durumda — açık madde.**
  [jupiter.ts:273](src/feeds/dex/jupiter.ts#L273) `catch { return null }` yapıp
  `null`'ı önbelleğe de yazıyor, sayaç da onu `empty` kovasına koyuyor. Panel
  `665 denendi │ 16 başarılı │ 643 rota yok` diyordu; ölçüldüğünde o 643'ün
  neredeyse tamamı **HTTP 429**'du. Yani kota tükenmesi likidite yokluğu olarak
  raporlanıyor ve bakan kişi tokenları silmeye yönelirdi. CoW'daki ayırt edici
  test buraya KOPYALANAMAZ: CoW `errorType` alanlı JSON döndürüyordu, Jupiter
  ise düz metin (`Rate limit exceeded, please try again later.`) — burada
  bakılacak şey HTTP 429'un kendisi. Ayrıca 429'da `null` önbelleğe yazmak
  tokenı gereksiz yere daha uzun kör bırakıyor.
- **Bloklu uca yüklenmeye devam etmek bloğu UZATIR.** Başarısız tur
  zamanlayıcıyı durdurmadığı için `CowFeed` bloklu uca saniyede 2 istek atmayı
  sürdürüyordu; CloudFront kararını süregelen yüke göre verdiğinden bu kendi
  kendini besleyen bir tuzak. Artık tolerans aşılınca üstel geri çekilme var
  (30 sn → 15 dk tavan, panelde kalan süre yazılı). Tavan sonlu olmak zorunda:
  blok geçici ve feed insan müdahalesi olmadan geri dönebilmeli. `EvmDexFeed`'de
  karşılığı YOK ve gerekmiyor — RPC bizi bloklamıyor, yalnızca hata döndürüyor.
- **Makul olmayan kâr uyarısı**: `IMPLAUSIBLE_NET_PCT = 0.20`. Kalibrasyon
  raporu bunu 20 saatlik veride zaten ölçüyordu ("net %20 üzeri — neredeyse her
  zaman veri hatası") ama ölçüm YALNIZCA rapor zamanındaydı; motor tarafında
  hiçbir karşılığı yoktu. Sonuç: bot `RWA` için **net %77.8** hesaplayıp bunu
  hiçbir şüphe işareti taşımadan Telegram'a gönderdi. Eşik `calibrate.ts`'teki
  değerle aynı olmalı — rapor "veri hatası" dediğini motor sessizce onaylıyorsa
  iki katman çelişir. Eleme DEĞİL uyarıdır: bilinen sebepler (kimlik çakışması,
  ölü defter) artık ayrıca eleniyor, bu son çare ağıdır ve bilinmeyen bir
  sebeple eşiği geçen sinyal görünür kalmalıdır.
- **Bayatlık iki sayaçla ölçülür**: `rejectedByStale` çiftin bayatlık yüzünden
  DEĞERLENDİRİLEMEDİĞİ durumları sayar (taze borsa sayısı 2'nin altına düştü, yani
  arbitrajın iki tarafı kalmadı); `staleVenueSkips` atlanan okuma sayısını verir.
  Tek sayaçken bir borsa bayatlayıp diğeri tazeyken sayaç sıfır kalıyordu — eleme
  doğru yapılıyor ama panelde hiç iz bırakmıyordu.

`Opportunity.costs` dökümü `grossQuote`'a birebir oturur (`gross − costs = netQuote`).
Bunu korumak için alış komisyonu **satış** VWAP'ıyla değerlenir: komisyon base cinsinden
kesilir ve kesilen coin satış fiyatından elden çıkar. Alış fiyatıyla çevirmek dökümü
`kesilen coin × spread` kadar şişirir.

## Solana'da iki venue: jupiter ve raydium

`jupiter` bir TOPLAYICI — rotayı o kuruyor, fiyatı tüm havuzların en iyisinden
veriyor. `raydium` tek bir AMM — kendi havuzunda ne varsa onu söylüyor. İkisi
ayrı mekân olduğu için tarayıcı `raydium↔jupiter` çiftini de görüyor; aynı
zincirde oldukları için `pickChain`in DEX→DEX dalı transfer maliyeti çıkarmaz.

Raydium **yedek değil**: Jupiter 429 verdiğinde devreye giren bir yol değil,
kendi fiyatı ve kendi doğrulaması olan bağımsız bir venue. İki feed tek sınıfı
paylaşıyor ([feeds/dex/solana-feed.ts](src/feeds/dex/solana-feed.ts),
`SolanaMidFeed`) — periyot türetme, bayatlık ve sağlık raporlaması iki yerde
yaşasaydı biri güncellenip diğeri unutulurdu.

**Asıl mimari kazanç: Raydium İKİ AYRI HOST kullanıyor.**

| aşama | jupiter | raydium |
|---|---|---|
| 1 — geniş tarama | `lite-api.jup.ag/price/v3` | `api-v3.raydium.io/mint/price` |
| 2 — doğrulama | `lite-api.jup.ag/swap/v1/quote` | `transaction-v1.raydium.io/compute/swap-base-in` |

Jupiter'de iki aşama AYNI kovayı paylaşıyor ve ölçülen sonuç, taramanın
doğrulamayı aç bırakmasıydı (`taramaPayi` bu yüzden 0.35). Raydium'da böyle bir
çekişme yok, `taramaPayi` 0.8.

**Ölçüm (2026-08-27, 138 mint):**

| | jupiter | raydium |
|---|---|---|
| Aşama 1 kapsamı | 137/138 | **108/138**, 989 ms |
| Aşama 1 sapması | — | medyan %0.24, p90 %25, **max %2577** |
| Aşama 2 | 40 istekte önce 5/5 × 429, sonra 200 | 40 istek 2/sn → **39 ok, 0×429** |
| canlı birim fiyat | SOL $107.51 · JUP $0.2301 | SOL $107.66 · JUP $0.2331 |

**Aşama 1 fiyatı GÜVENİLMEZ, Aşama 2 quote'u güvenilir** ve bu ayrım Raydium'da
Jupiter'dekinden keskin: `mint/price` toplayıcı rotası değil TEK HAVUZUN orta
fiyatı, o yüzden p90 %25 ve max %2577 gibi aykırılar var. Mimarinin zaten kabul
ettiği bir durum — Aşama 1 fiyatı kâr hesabına hiç girmez, yalnızca hangi çiftin
doğrulanacağını seçer — ama bedeli sıfır değil: bozuk fiyat kuyruk kapasitesi
yakar. `compute/swap-base-in` gerçek çıktı miktarını ve fiyat etkisini
döndürdüğü için bozuk havuz Aşama 2'de elenir.

**`SOLANA_PRICE_SOURCE` yalnızca jupiter venue'sünü etkiler.** Raydium
venue'sünün Aşama 1 kaynağı tanımı gereği Raydium'dur; ikisini tek ayara
bağlamak "raydium venue'sü geckoterminal fiyatı yazıyor" gibi kendi kimliğine
aykırı bir duruma yol açardı.

**Kova ölçülen hızın ALTINDA** (`core/http.ts`, 2/sn): Raydium belgelenmiş bir
limit yayınlamıyor ve geckoterminal dersi hâlâ geçerli — limit belgede
yazmıyorsa ve tek atışlık ölçümde görünmüyorsa, yine de vardır.

## DEX bacağının ikinci görüşü: CoW çapraz kontrolü

Base'de fiyatı **biz kuruyoruz**: hangi havuz, hangi fee tier, kaç adım — hepsi
bizim seçimimiz. Dolayısıyla hata da bizim olabilir ve ölçülmüş örnekleri var
(Aerodrome doğrudan-USDC: DEGEN %158, ZEN %455, BRETT %3389 gidiş-dönüş).
[feeds/dex/capraz.ts](src/feeds/dex/capraz.ts) yayınlanmak üzere olan sinyalin
DEX bacağını CoW'a soruyor: CoW bir AMM değil, rotayı SOLVER kuruyor — yani
bizim rota seçimimizden tamamen bağımsız bir görüş.

**Venue olarak kapalı, çapraz kontrol olarak açık — çelişki değil.** Kapatma
gerekçesi bütçeydi: geniş taramada istek TUR başına atılıyor (75 token × 2 bacak,
kova 2/sn → ~94 sn periyot, bayatlık bütçesi 30 sn). Burada istek SİNYAL başına
atılıyor — yalnızca `MIN_NET_PCT` eşiğini geçmiş bir fırsat için, ve 15 sn TTL'li
önbellekle. Aynı ayrımın Solana'daki karşılığı `DexQuoter`; CLAUDE.md'nin
"CoW'un yeri Aşama 2" dediği iş budur.

Kurallar:

- **ELEME DEĞİL UYARI.** İki kaynağın ayrışması "fırsat sahte" demek değil, "bu
  iki rotadan biri yanlış" demek — hangisi olduğunu söyleyecek üçüncü bir
  dayanak yok. Sinyal yayınlanır, sapma üstünde yazar.
- **Eşik `minNetPct`e bağlı, sabit değil.** İkinci kaynak kârın TAMAMI kadar
  ayrışıyorsa sinyalin dayanağı kalmamıştır. Sabit bir yüzde, eşik
  değiştiğinde ya her sinyale uyarı iliştirir ya da hiç uyarmazdı.
- **Yalnızca BİZ İYİMSERKEN uyarı.** Ters yön (CoW daha çok veriyor) sinyali
  güvenilmez yapmaz, muhafazakâr yapar.
- **Uyuşma da yayınlanır** (`Opportunity.capraz`, Telegram'da `🔍 Çapraz`
  satırı). "Kontrol edildi ve uydu" ile "hiç kontrol edilmedi" farklı şeylerdir;
  ikisi de sessizlikle temsil edilirse kullanıcı, kontrolün çalışmadığı bir
  gecede sinyale fazladan güvenir. Aynı sebeple panelde `çapraz kontrol` satırı
  SIFIRKEN de basılıyor.
- **`cow-base` kendisiyle doğrulanmaz.** Kendi kendini doğrulayan bir kontrol,
  hiç kontrol etmemekten kötüdür — doğrulanmış GÖRÜNÜR.
- **Arıza sinyali öldürmez ve önbelleğe yazılmaz.** CoW'un önündeki CDN bloğu
  ölçülmüş bir gerçek; blok anında tüm Base sinyallerinin susması kontrolün
  faydasından büyük bir zarar olurdu. "Rota yok" (veri, önbelleğe yazılır) ile
  "ulaşamıyoruz" (arıza, yazılmaz) ayrımı `HttpCowQuoter`'daki `cowHatasiMi`
  ile aynı ders.

**İKİ ZİNCİRDE de açık: base ve arbitrum.** CoW'un quote yolu ve token tablosu
zincire özgü olduğu için zincir başına bir `CowCaprazKontrol` var;
`CaprazKontrolSeti` bunları tek arayüzde birleştirip venue'yu KENDİ zincirinin
kontrolüne yolluyor (`DexLegQuoter` tarafındaki `VenueLegQuoter` ile aynı
desen). Hepsini denemek, aynı ticker'ın başka zincirdeki farklı tokenıyla
karşılaştırma yapmak olurdu — kimlik kuralının ihlali.

Zincir listesi `COW_CHAINS` ile **`CHAIN_PATH`'ten türetiliyor**, elle
yazılmıyor: kopya bir dizi, yeni zincir eklendiğinde kontrolün sessizce kapalı
kalması demekti (bu botta aynı hata `dexVenues` ile bir kez yaşandı). Sayaçlar
panelde TOPLANIYOR — zincir başına ayrı satır, "hiç çağrılmadı" uyarısını
tekrarlayan bir gürültü üretirdi.

**Erişim ölçüldü (2026-08-27):**

| zincir | uç | sonuç |
|---|---|---|
| base | `api.cow.fi/base/api/v1/quote` | 3/3 × HTTP 200, ~200 ms · AERO, BRETT, DEGEN 3/3 |
| arbitrum | `api.cow.fi/arbitrum_one/api/v1/quote` | **6/6 başarılı**, 150–650 ms · ARB, GMX, PENDLE, WBTC, CRV, GRT |

Arbitrum ölçümünde dikkat çeken: **GRT** $0.0181 ile fiyatlandı. Bu tam olarak
"Camelot'ta revert, UniV3'te toz havuz" sınıfındaki token (bkz. "Bilinen
boşluklar") — yani çapraz kontrol, bizim rota seçimimizin en zayıf olduğu
yerde ikinci görüş veriyor. `LINK`/`UNI` ise `tokens.json`'da arbitrum girdisi
olmadığı için istek bile ATILMADAN null döndü (doğru davranış: bilmediğimiz
tokena rastgele adres uydurmuyoruz).

Kapatma kararının dayanağı olan 403 bloğu kalkmış — ama ölçek gerekçesi
durduğu için venue olarak açılmadı.

## Solana fiyat kaynağı iki aşamada AYRI olabilir

[feeds/dex/solana-price.ts](src/feeds/dex/solana-price.ts) — `SOLANA_PRICE_SOURCE`
yalnızca **Aşama 1'i** (geniş tarama) etkiler; Aşama 2 doğrulaması (`DexQuoter`,
`swap/v1/quote`) her zaman Jupiter'dir ve değiştirilemez.

Bu ayrım güvenlidir çünkü geniş taramadan gelen fiyat **kâr hesabına hiç girmez**,
yalnızca hangi çiftin doğrulanacağını seçer. Aynı sapmayla Aşama 2'yi beslemek
doğrudan yanlış kâr demek olurdu.

**Varsayılan `jupiter`'dir ve öyle kalmalı.** Alternatifler ölçüldü:

| Kaynak | Kapsam (113 mint) | Jupiter'e sapma | Sürekli kullanımda |
|---|---|---|---|
| jupiter | 113/113 | — | sorunsuz |
| geckoterminal | 113/113 | medyan %0.10, p90 %0.57 | **~24 istek/dk'da 6 turun 6'sı da 429** |
| dexscreener | 62/113 | medyan %0.17 | elendi (toplu uç nokta istek başına 30 HAVUZ döndürüyor) |

GeckoTerminal'in ilk ölçümü yanılttı: tek seferlik soğuk seri tam kapsam ve düşük
sapma gösterdi, ama gerçek periyotla sürekli çalıştırınca hepsi 429 aldı.
`perMinute` bu yüzden belgelenen 30 değil **ölçülen 10** yazılıdır. Yeni kaynak
eklerken bu tuzağa dikkat: tek atışlık test rate-limit davranışını göstermez.

**Tarama periyodu sabit değil, kaynağın limitinden türetilir** (`guvenliAralik`).
Sabit periyot, token listesi büyüdüğünde sessizce 429 yemek demektir: feed açık
kalır, panel "live" gösterir, fiyatlar bayatlar. Yeni kaynak eklerken `perMinute`,
`chunkSize` ve `taramaPayi` doğru doldurulmalı.

`taramaPayi`, limitin ne kadarının geniş taramaya ayrılacağıdır. Jupiter'de **0.35**:
Aşama 2 doğrulaması `swap/v1/quote` ile AYNI host kovasını kullanıyor ve doğrulama
kârı belirleyen aşama — tarama uğruna aç bırakılamaz. Kendi host'unu kullanan
kaynakta pay yüksek tutulur.

## Config ve .env

- `config/*.json` yapısal (borsa/zincir/token/kontrat/izleme listesi), `.env`
  operasyonel eşikler.
- `.env`'deki yüzde değerleri **yüzde olarak** yazılır ve `loadConfig()` içinde 100'e
  bölünür (`MIN_NET_PCT=0.4` → `0.004`).
- `loadConfig()` yanlış config'le sessizce devam etmez: `PREFILTER_PCT > MIN_NET_PCT`,
  `MAX_DEX_PRICE_AGE_MS < MAX_PRICE_AGE_MS`, tanınmayan `SOLANA_PRICE_SOURCE`,
  yinelenen token adresi, geçersiz Solana/EVM adres formatı, eksik borsa girdisi →
  başlangıçta hata. Buradaki ortak fikir: yanlış yazılmış bir değerin **sessizce
  varsayılana düşmesi**, hatanın hiç görünmemesi demektir.
- **RPC adresleri**: `SOLANA_RPC_URL` / `BASE_RPC_URL` / `ARBITRUM_RPC_URL` `.env`'de
  tanımlıysa `config/chains.json`'daki değeri **ezer** ([core/config.ts](src/core/config.ts)
  `loadConfig()`). `config/chains.json`'daki varsayılanlar public uç noktalardır —
  çalışırlar ama rate-limit'leri düşüktür; ciddi kullanımda kendi RPC'ni tanımla.
  Adres `http(s)://` veya `ws(s)://` ile başlamıyorsa başlangıçta hata verilir ve
  hata değerin dosyadan mı `.env`'den mi geldiğini söyler.
  (Jupiter etkilenmez — `JUPITER_API_KEY`'i `process.env`'den doğrudan okur.)
- **`SOLANA_RPC_URL` şu an hiçbir çağrıda kullanılmıyor.** Solana fiyatı da quote'u da
  Jupiter'in HTTP API'sinden geliyor; RPC adresi yalnızca `loadConfig()` içinde okunup
  terminal panelinde gösteriliyor. Panelde host görünmesi kullanıldığı anlamına gelmez —
  Solana RPC sağlayıcısına (Helius vb.) para harcamadan önce bunu bil. RPC ancak
  havuzları doğrudan zincirden okumaya ya da Jupiter API'sini self-host etmeye
  geçilirse anlam kazanır. `BASE_RPC_URL` / `ARBITRUM_RPC_URL` ise **gerçekten**
  kullanılıyor ve public uç noktalar yetersiz.

### Operasyonel eşiklerin bugünkü değerleri

| Değişken | Değer | Neden |
|---|---|---|
| `MIN_NET_PCT` | 0.4 | bildirim eşiği (net) |
| `PREFILTER_PCT` | 0.3 | `MIN_NET_PCT`'in hemen altı — altındaki aday sinyal üretemez |
| `VERIFY_COOLDOWN_MS` | 2000 | derinlik önbelleği TTL'i ile aynı |
| `MAX_PRICE_AGE_MS` | 3000 | CEX (WebSocket push) |
| `MAX_DEX_PRICE_AGE_MS` | 30000 | DEX (HTTP çekme, periyot kaynağın limitinden) |
| `SOLANA_PRICE_SOURCE` | jupiter | geckoterminal sürekli kullanımda 429 veriyor |
| `SOUND_ENABLED` / `SOUND_COOLDOWN_MS` | 1 / 15000 | sesli fırsat uyarısı |

## TypeScript kısıtları

- ESM + `allowImportingTsExtensions`: göreli importlar **`.ts` uzantısıyla** yazılır
  (`'./core/config.ts'`).
- `verbatimModuleSyntax`: tip importları `import type` olmak zorunda.
- `noUncheckedIndexedAccess`: dizi/Map erişimlerinde `!` veya explicit kontrol gerekir —
  mevcut kod hot path'te `!` kullanır, bunu koruyun.
- `noEmit: true` — `npm run dev` tsx ile doğrudan çalışır, ayrı derleme adımı yok.

## Bağımlılık politikası

Üç production paketi var: `ws`, `viem`, `protobufjs` (MEXC WebSocket protobuf'a taşındı).
Telegram SDK'sı, terminal UI kütüphanesi, ses kütüphanesi ve test framework'ü kasıtlı
olarak yok (sırasıyla tek `sendMessage` çağrısı, ~150 satır ANSI, tek satırlık
PowerShell `[Console]::Beep`, `node:test`). Yeni bağımlılık eklemeden önce bu tercihi
gerekçelendir.

## Bilinen boşluklar

Bunlar "yapılmadı" değil, **ölçülüp önceliklendirilmiş** eksikler:

- **EVM kapsamı ÖLÇÜLDÜ — sorun RPC değil, ROTA.** Keşif yeni RPC ile yeniden
  çalıştırıldı: Base 9 → **13 girdi** (RWA, VIRTUAL, AWE, SCOR), Arbitrum
  **0 yeni**. Arbitrum'da 30 adayın 26'sı "quote 3 denemede de hata verdi" ile
  elenmişti ve bu bir RPC arızası sanılıyordu. Değil:

  | uç nokta | ok | sıfır | hata |
  |---|---|---|---|
  | arb1.arbitrum.io | 12/30 | 6 | 12 |
  | arbitrum-one-rpc.publicnode.com | 12/30 | 6 | 12 |
  | arb-pokt.nodies.app | 12/30 | 6 | 12 |
  | arbitrum.drpc.org | 0/30 | 0 | 30 (uç nokta ölü) |

  Üç bağımsız uç nokta **birebir aynı** sonucu veriyor, yani sonuç deterministik
  ve gerçek: o token'ların Camelot'ta USDC karşılığı havuzu yok.
  `arb1.arbitrum.io/rpc` değiştirilmesine gerek yok.

  Token bazında iki AYRI sebep ölçüldü:
  - **LINK**: doğrudan USDC sıfır döndürüyor ama **WETH ilk adımı çalışıyor** →
    2 adımlı rota bunu kurtarır.
  - **GRT, UNI**: Camelot'ta iki rotada da revert → bu tokenlar Arbitrum'da
    **Uniswap V3'te**. `uniswap-v3` zaten `DEX_IDS`'te tanımlı ve `evm.ts`
    destekliyor, ama `main.ts`'in `dexVenues` listesinde YOK — hiç denenmemiş
    bir yetenek.

    **Düzeltme (keşif UniV3'e açıldıktan sonra ölçüldü): GRT'yi UniV3 de
    kurtarmıyor.** Dört tier'ın hepsi sorulduğunda GRT/USDC %100 sapmayla
    (fiilen sıfır fiyat) dönüyor — havuz VAR ama toz halinde; gerçek GRT
    likiditesi WETH karşısında. Aynı desen `ZRO, STG, LPT, JOE, SPA, EYWA`
    için de ölçüldü. Yani UniV3'ün açılması GMX/PENDLE/WBTC/CRV/CHIP/ESP/CARV
    sınıfını kazandırdı, GRT sınıfını değil — o sınıfın tek çaresi 2 adımlı
    WETH rotasıydı ve o rota artık açık (bkz. "2 adımlı rota"). Doğrudan-USDC
    modelinin sınırı buydu.

  **Uniswap V3 artık açık** ve Arbitrum'da Camelot'un fiyatlayamadığı GMX,
  PENDLE, WBTC dahil 9 slot fiyatlıyor (Camelot 5). (Açılış o zaman `main.ts`'e
  elle yazılan `dexVenues` dizisiyle yapılmıştı; o dizi sonradan kaldırıldı —
  venue listesi artık `DEX_IDS`'ten geliyor, bkz. "Komutlar".)
  Açarken iki hata ölçüldü ve düzeltildi — ikisi de sessizdi:

  **1. `extractAmount` dönüş şeklini TAHMİN ediyordu.** "Dizinin son elemanı
  bigint ise miktardır" kuralı Aerodrome için doğru, ama UniV3 QuoterV2
  `(amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate)`
  döndürüyor ve son eleman `gasEstimate` — o da bigint. Yani feed miktar yerine
  **gas tahminini** fiyat sanıyordu; quote "başarılı" görünüyor, sayı makul
  büyüklükte, sadece tamamen alakasız. Camelot'un çalışması ŞANSTI: Algebra
  `(uint256 amountOut, uint16 fee)` döndürüyor ve viem `uint16`'yı `number`
  yaptığı için heuristik tesadüfen doğru dala düşüyordu. Artık seçim
  venue'ya göre yapılıyor, şekle bakarak değil.

  **2. "En iyi çıktıyı seç" kuralı, alış bacağında EN BOZUK havuzu seçer.**
  Alışta "en iyi çıktı" = en çok token, ve boş/bozuk bir havuz tam olarak
  bunu verir. Canlı testte 8/8 token bu yüzden "havuz taşımıyor" diye elendi.
  Doğru kural: her tier **kendi içinde** gidiş-dönüş değerlendirilir (aynı
  havuzda al, aynı havuzda sat), spread eşiğini geçemeyenler elenir, kalanlar
  arasından en ucuz ask seçilir. Sıra kritik: önce ele, sonra en iyisini seç —
  ters sırada bozuk havuz her zaman kazanır, çünkü ask'i her zaman en düşüktür.

  Tier başına ayrı quote, quote sayısını üçe katlıyor (`MAX_CALLS_PER_BATCH`
  bütçesine giriyor). Ölçülen fiyat farkı bunu hak ediyor: UNI için
  `fee=500` havuzu 0.2973, `fee=3000` havuzu 3.9384 döndürdü (gerçek ~4).

  **2 adımlı WETH rotası artık AÇIK — bu maddenin kalan yarısı da kapandı.**
  `GRT/ZRO/STG/LPT/JOE/SPA/EYWA` ve `LINK` sınıflarının tek çaresi buydu ve
  hem feed hem keşif artık o rotayı soruyor (bkz. "2 adımlı rota"). Eski not
  "zor kısmı modelleme" diyordu; quoter iki havuzun komisyonu + kayması dahil
  nihai çıktıyı döndürdüğü için modelleme diye bir iş çıkmadı.
- **CoW Aşama 2'ye TAŞINDI — bu madde kapandı.** Bugün Base bacaklarının
  çapraz kontrolünü yapıyor ve istek sayısı turla değil sinyalle ölçekleniyor
  (bkz. "DEX bacağının ikinci görüşü"). Aşağıdaki eski teşhis, kararın
  gerekçesi olduğu için duruyor.
- ~~**CoW Aşama 1'de duruyor, oysa yeri Aşama 2.**~~ Bugün geniş tarama yapıyor ve
  maliyeti token başına 2 istek/tur; ücretsiz uçta 75 token bunu kaldırmıyor
  (CloudFront bloğu, ~94 sn periyot). Aşama 2'ye taşındığında istek sayısı
  turla değil ADAY sayısıyla ölçeklenir — Solana'da `DexQuoter` tam olarak bu
  sebeple ayrıldı. Bunun için Base'e ucuz bir geniş tarama kaynağı gerekiyor
  (zincirden havuz okuma ya da 2 adımlı WETH quote'u); yani "bilinen boşluk"
  kapanmadı, YER DEĞİŞTİRDİ: artık kapsam sorunu değil, tarama kaynağı sorunu.
- **Doğrulama hâlâ ücretsiz kotayla sınırlı — ve bugün fiilen KAPALI.**
  `JUPITER_API_KEY` (1/sn → 10/sn) ilk anlamlı yatırımdır; Solana RPC değil
  (yukarıya bak). Ölçüldü ve iki ucun AYRI kotası olduğu görüldü:

  | uç | işi | durum |
  |---|---|---|
  | `/price/v3` | Aşama 1 geniş tarama | **HTTP 200**, 133/134 token akıyor |
  | `/swap/v1/quote` | Aşama 2 doğrulama | **HTTP 429**, 40/40 istek |

  429 anlık hız sınırı DEĞİL: bot kapalıyken, saniyede bir ve dakikada on
  istekle de, 45 sn arayla 4 dakika boyunca da hep 429. Gün içinde seyir %40 →
  %2 → %0 olarak izlendi, yani daha uzun pencereli bir kota tükenmiş.
  Sonucu ağır: **Aşama 2 olmadan her Solana bacağı eleniyor, CEX↔DEX Solana
  fırsatı yapısal olarak üretilemiyor** — panel jupiter'i `live` gösterirken
  (Aşama 1 çalışıyor, bu doğru).
- **Coin seçiminde HACİM hiç kullanılmıyor** ve bunun ölçülen bir bedeli var.
  Tüm kod tabanında `hacim|volume|turnover` araması iki yorum satırı dışında
  boş. Likidite ölçülüyor ama hacimle değil: Aşama 2'de gerçek işlem
  büyüklüğünde L2 defteri (VWAP) ve DEX'te `MAX_ROUNDTRIP_SPREAD`. Bu daha
  doğru ölçü — hacim geçmişe, defter şu ana bakar — ama yalnızca ADAY BAŞINA
  ve Aşama 2'de yapıldığı için likit olmayan coin taramaya ve kuyruğa girmeye
  devam ediyor. Ölçüldü (5 dk): doğrulanan ~2269 adayın **1787'si (%79)
  derinlikten düştü**; `dexQuoteTried` o koşuda 109 olduğuna göre en fazla
  109'u Jupiter kaynaklı, kalan ~1678'i (%94) gerçekten $1000'i taşımayan CEX
  defteri. Yani doğrulama bütçesinin dörtte üçü baştan elenebilecek coinlere
  gidiyor, bu sırada adayların %79'u sıraya bile giremiyor.
  **Eşik koymadan ÖNCE ölç:** hacmi rapora bir sütun olarak ekle, derinlikten
  elenenlerin hacim dağılımına bak, eşiği ona göre seç. Hacim ≠ derinlik —
  yüksek 24s hacimli bir coinin defteri şu anda ince olabilir — dolayısıyla
  hacim ancak KABA ÖN FİLTRE olabilir, VWAP kontrolünün yerine asla geçemez.
  Maliyeti düşük: sembol listeleri `exchangeInfo` tipi uçlardan geliyor ve
  hacim vermiyor, ama her borsanın 24s ticker ucu tek istekte tüm sembolleri
  döndürüyor (başlangıçta borsa başına 1 ek istek).
- **Otomasyona geçmeden `npm run calibrate` temiz görünmeli.** v1 kasıtlı olarak emir
  göndermiyor; kalibrasyon raporu sahte sinyal oranını göstermeden v2'ye geçilmemeli.
