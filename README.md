# arb-bot

Merkezi borsalar (CEX) ve merkeziyetsiz borsalar (DEX) arasındaki arbitraj fırsatlarını gerçek zamanlı tespit edip bildiren, TypeScript ile yazılmış bir terminal uygulaması.

- **Kapsam:** 7 merkezi borsa (Binance, Bybit, OKX, Gate.io, MEXC, KuCoin, Kraken) WebSocket üzerinden; Solana, Base ve Arbitrum zincirlerindeki DEX'ler (Jupiter, Raydium, Aerodrome, Camelot, Uniswap V3, CoW Protocol).
- **İki aşamalı tarama:** bellekte, `Float64Array` üzerinde çalışan ucuz bir ön filtre; yalnızca aday çıkan çiftler için L2 emir defteri ve VWAP ile doğrulama.
- **Net kâr hesabı:** işlem komisyonu, çekim ücreti ve gas düşüldükten sonra kalan kâr bildirilir; çekim/yatırma durumu ve "kapanmayan fark" ayrıca denetlenir.
- **Az bağımlılık, çok test:** yalnızca üç çalışma zamanı paketi (`ws`, `viem`, `protobufjs`); Node'un yerleşik `node:test` modülüyle ağa çıkmadan çalışan 328 test.
- **Yalnızca bildirim:** bot hiçbir emir göndermez; emir katmanı ayrı bir arayüz arkasında pasif durur.

> Bu proje yatırım tavsiyesi değildir ve bot alım satım yapmaz; yalnızca tespit edip bildirir.

---

## Ne yapar

Borsalardan gelen fiyatları sürekli izler, aynı coinin iki piyasa arasındaki fiyat farkını hesaplar ve tüm maliyetler düşüldükten sonra eşiği geçen fırsatları terminal arayüzünde gösterir. İsteğe bağlı olarak Telegram mesajı ve sesli uyarı gönderir, her fırsatı daha sonra analiz edilmek üzere diske kaydeder.

İzlenen piyasalar:

| Tür | Kaynaklar |
|---|---|
| Merkezi borsalar | Binance, Bybit, OKX, Gate.io, MEXC, KuCoin, Kraken |
| Solana | Jupiter, Raydium |
| Base | Aerodrome, Uniswap V3, CoW Protocol |
| Arbitrum | Camelot, Uniswap V3 |

Base ve Arbitrum bacakları yayınlanmadan önce **CoW Protocol** ile çapraz kontrol edilir. Rotayı bot kendisi seçtiği için rota hatası da ona ait olabilir; CoW ise rotayı kendi çözücüsüne (solver) kurdurur ve böylece bağımsız ikinci bir görüş sağlar. İki kaynak ayrışırsa sinyal elenmez, sapma sinyalin üzerinde uyarı olarak gösterilir.

---

## Nasıl çalışır

### Temel ilke: ham fiyat farkı fırsat değildir

En iyi satış fiyatında yalnızca birkaç adet coin varken 1000 USDT'lik alım yapmak isteniyorsa, ekranda görünen yüzde 5'lik fark gerçek değildir. Bu yüzden tarama iki aşamalıdır:

| Aşama | Ne yapar | Sıklık |
|---|---|---|
| **1. Ön filtre** | Yalnızca fiyatı değişmiş çiftleri en iyi alış/satış (L1) fiyatları üzerinden tarar. Tamamen bellekte çalışır, tick başına nesne oluşturmaz. | ~50 ms (`EVAL_INTERVAL_MS`) |
| **2. Doğrulama** | Eşiği geçen adaylar için L2 emir defterini çeker, gerçek VWAP'ı hesaplar, komisyon, çekim ücreti ve gas'ı düşer, transfer yolunu kontrol eder. | Yalnızca aday çıktığında |

Yalnızca ikinci aşamadan geçen fırsatlar bildirilir.

### Sıcak yol (hot path)

Fiyatlar tek bir `Float64Array` matrisinde tutulur (`çift × piyasa`). Bir fiyat güncellemesini işlemek birkaç indeksli yazmadan ibarettir: güncelleme başına nesne oluşturulmaz, dolayısıyla çöp toplayıcı duraklamaları oluşmaz. Veri akışları (feed) slot numaralarını kurulum sırasında alır; sonrasında metinden indekse arama bile yapılmaz.

### Bildirimden önceki güvenlik kontrolleri

- **Çekim/yatırma durumu.** Fırsatın gerçek olması için coinin alış borsasından çekilebilmesi ve satış borsasına yatırılabilmesi gerekir. Çekimi kapalı bir coindeki büyük fark fırsat değil, tuzaktır. Durum bilgisi 15 dakikada bir tazelenir; tazelenemezse sinyal bunu uyarı olarak taşır.
- **Kapanmayan fark.** Gerçek bir arbitraj farkı uzun yaşamaz. 45 saniyeden uzun süre değişmeden kalan farklar, kârlı oldukları için değil erişilemez oldukları için orada durduklarından işaretlenir.
- **Tekrar bastırma (dedup).** Aynı fırsat her taramada yeniden üretildiği için tekrar eden kayıtlar ve bildirimler süzülür.
- **Saat kayması düzeltmesi.** Gecikme ölçümü, yerel saatin borsa saatinden kaymasına karşı düzeltilir.

### Neden bu kadar az bağımlılık

Çalışma zamanında yalnızca üç paket kullanılır: `ws`, `viem`, `protobufjs`.

- **Telegram SDK'sı yok:** tek bir `sendMessage` çağrısı için büyük bir bağımlılık ağacı taşımaya değmez.
- **Terminal arayüz kütüphanesi yok:** arayüz, ham ANSI kaçış kodlarıyla yazılmış tek bir modüldür (`src/ui/renderer.ts`).
- **Test çatısı yok:** Node'un yerleşik `node:test` modülü yeterlidir.
- **`protobufjs` zorunlu bir istisnadır:** MEXC, WebSocket akışını protobuf biçimine taşıdı.

---

## Kurulum

Node.js 22.7 veya üzeri gerekir (`process.loadEnvFile` ve `--experimental-transform-types` için).

```bash
npm install
cp .env.example .env      # Windows (cmd): copy .env.example .env
```

Windows'ta bot `baslat.cmd` dosyasına çift tıklanarak da başlatılabilir.

---

## Yapılandırma

Tüm ayarlar `.env` dosyasından okunur; her değişkenin açıklaması `.env.example` içinde yer alır. En önemlileri:

```ini
MIN_NET_PCT=0.4           # bildirim eşiği (net, tüm maliyetler düşülmüş, yüzde)
PREFILTER_PCT=0.3         # 1. aşama ön filtre eşiği; MIN_NET_PCT'nin hemen altında tutulmalı
TRADE_SIZE_QUOTE=1000     # fırsat hesabındaki işlem büyüklüğü (USDT)
```

**Telegram (isteğe bağlı):**

```ini
TELEGRAM_ENABLED=1
TELEGRAM_BOT_TOKEN=...    # @BotFather'dan alınır
TELEGRAM_CHAT_ID=...      # birden fazla alıcı için virgülle ayrılır
```

**Sesli uyarı (isteğe bağlı):** Eşiği geçen yeni bir fırsatta bilgisayardan uyarı tonu çalınır. `SOUND_DEVICE` tanımlanırsa ton, Windows'un varsayılan çıkışından bağımsız olarak adı eşleşen cihazdan çalar; böylece varsayılan çıkış değişse de uyarı aynı yerde kalır.

```ini
SOUND_ENABLED=1
SOUND_DEVICE=             # çıkış cihazı adının bir parçası; boş → varsayılan çıkış
SOUND_VOLUME=20           # 1–100; yalnızca SOUND_DEVICE tanımlıyken geçerli
```

**Zincir RPC'leri:** EVM DEX'leri için RPC adresi gerekir. Herkese açık (public) RPC'ler rate limit ve gecikme nedeniyle yetersizdir; Alchemy veya QuickNode gibi sağlayıcıların ücretsiz kademesi başlangıç için yeterlidir.

```ini
BASE_RPC_URL=wss://base-mainnet.g.alchemy.com/v2/KEY
ARBITRUM_RPC_URL=wss://arb-mainnet.g.alchemy.com/v2/KEY
SOLANA_RPC_URL=
JUPITER_API_KEY=          # boş bırakılırsa anahtarsız uç nokta kullanılır
```

`wss://` tercih edilmelidir: blok olaylarıyla tetiklenmek, periyodik sorgulamadan hem daha hızlıdır hem de kotayı daha az tüketir. RPC tanımlı değilse ilgili DEX sessizce atlanmaz; başlangıçta açıkça "devre dışı" olarak raporlanır.

**Salt okunur borsa API anahtarları (isteğe bağlı):** Gate.io ve KuCoin çekim/yatırma durumunu herkese açık API'den verir. Binance, Bybit, OKX, MEXC ve Kraken için bu bilgi yalnızca kimlik doğrulamalı uç noktalardadır; anahtar girilmezse bu borsaların fırsatları `?` işareti ve "doğrulanmadı" uyarısıyla bildirilir. Anahtarlar yalnızca bu durumu okumak için kullanılır; oluştururken **yalnızca okuma yetkisi** verilmeli, işlem ve çekim yetkisi verilmemelidir. Değişken adları (`BINANCE_API_KEY`, `OKX_API_PASSPHRASE` vb.) `.env.example` içindedir.

---

## Komutlar

```bash
npm run dev                 # botu terminal arayüzüyle başlat
npm run check               # TypeScript tip kontrolü (tsc --noEmit)
npm test                    # birim testleri
npm run build               # esbuild ile dist/main.js üret
npm start                   # derlenmiş sürümü çalıştır
```

### Doğrulama ve teşhis araçları

Bota güvenmeden önce çalıştırılması önerilir:

```bash
npm run feeds               # borsalara bağlan, 30 sn dinle, gecikme ve sembol raporu ver
npm run feeds -- okx 60     # tek borsa, 60 saniye
npm run dex                 # Solana mint adreslerini ve Jupiter fiyat tekliflerini doğrula
npm run verify-contracts    # EVM kontrat ve token adreslerini zincir üzerinden doğrula
npm run verify-keys         # .env'deki salt okunur anahtarları borsalarda dene
npm run discover-tokens     # borsalardan token adreslerini bul (yalnızca rapor)
npm run kapsam              # botun şu anda hangi çiftleri izlediğini ve nedenini raporla
npm run fiyatlar            # 90 sn dinle, coin × piyasa fiyat tablosu üret (CSV)
npm run izle                # zorunlu izleme listesini göster ve denetle
```

`verify-contracts` üç kademeli kontrol yapar: adreste kontrat var mı, ERC20 `symbol`/`decimals` değerleri tabloyla eşleşiyor mu, quoter gerçekten makul bir fiyat döndürüyor mu. Bir adreste kontrat bulunması doğru kontrat olduğunu göstermez; bu yüzden üçüncü adım şarttır.

### Kalibrasyon

```bash
npm run calibrate           # biriken sinyallerin kalite raporu
```

Bot her fırsatı `data/opportunities-YYYY-MM-DD.ndjson` dosyasına yazar. Rapor sinyallerin hangi coinlerde yoğunlaştığını, kaçının "kapanmayan fark" uyarısı taşıdığını, kaçının doğrulanmamış transfer bilgisine dayandığını ve kaymanın kârın ne kadarını yediğini gösterir. Otomasyona geçmeden önce bu raporun temiz görünmesi gerekir; aksi halde otomasyon gerçek parayla aynı sahte sinyallerin peşinden koşar.

---

## Testler

```bash
npm test
```

Testler `test/` dizinindedir ve Node'un yerleşik `node:test` modülüyle, ağa çıkmadan ve deterministik olarak çalışır. Kapsadıkları başlıca alanlar: tarayıcı (scanner), VWAP ve fiyat matrisi, Jupiter/Raydium/CoW/EVM veri akışları, çapraz kontrol, tekrar bastırma, bildirim biçimi, HTTP geri çekilme (backoff), risk limitleri ve yapılandırma doğrulaması.

---

## Mimari

```
src/
  core/        types · config · http (rate limit) · metrics
  book/        price-store (Float64Array) · depth-cache
  feeds/
    cex/       base-feed · binance · bybit · okx · gate · mexc · kucoin · kraken · pool
    dex/       solana-feed · solana-price · jupiter · raydium · leg-quoter
               evm (Aerodrome / Camelot / Uniswap V3) · cow · capraz (çapraz kontrol)
  normalize/   symbol-registry
  engine/      scanner · vwap · transfer-info
  notify/      telegram · dedup · format · sound
  ui/          renderer (ham ANSI)
  persist/     ndjson
  risk/        limits     ← şimdilik pasif, kararı yalnızca kaydeder
  exec/        executor   ← emir katmanının giriş noktası, şimdilik yalnızca bildirim
scripts/       doğrulama, teşhis ve kalibrasyon araçları
config/        borsa, zincir, DEX ve token tabloları
test/          birim testleri
```

### Geliştirme sırasında karşılaşılan sorunlar

| Gözlem | Çözüm |
|---|---|
| Binance'in tüm piyasayı kapsayan `!bookTicker` akışı bağlantı kurulduğu halde veri göndermiyordu | Sembol bazlı aboneliğe geçildi |
| KuCoin ~280 sembolden sonra tıkanıp 509 döndürüyordu | Bağlantı havuzu (bağlantı başına 200 sembol) |
| MEXC bağlantı başına en fazla 30 abonelik kabul ediyor | Aynı havuz yapısı |
| Aynı fırsat 75 saniyede 210 özdeş kayıt üretiyordu | Tekrar bastırma (dedup) katmanı eklendi |

---

## Bilinen sınırlar

- **Çekim/yatırma durumu borsaya göre farklı kaynaklardan gelir.** Anahtarsız çalışırken Binance, Bybit, OKX, MEXC ve Kraken bacakları "doğrulanmadı" uyarısı taşır. Kraken anahtarla bile çekim ücretini ve kontrat adresini vermediği için bu alanlar tahmine dayanır.
- **DEX'ler arası fırsatlar yalnızca aynı zincirde aranır.** Zincirler arası fırsatlar, köprü maliyeti ve gecikmesi modellenmeden güvenilir olmayacağı için üretilmez.

---

## Yol haritası

`src/exec/executor.ts` ve `src/risk/limits.ts` bugün yazılı ama pasif durumdadır:

- `Opportunity` → `ExecutionPlan` dönüşümü (al → transfer et → sat)
- Bacak durum makinesi ve idempotent istemci emir kimliği
- `RiskManager`: pozisyon limiti, günlük kayıp limiti, acil durdurma (kill switch)

Otomasyon, `Executor` arayüzüne yeni bir uygulama eklenerek devreye alınacak şekilde tasarlanmıştır; tarayıcı, veri akışları ve fiyat matrisi değişmeden kalır.

---

## Not

Bu proje eğitim ve portföy amaçlıdır. Yatırım tavsiyesi değildir; bot hiçbir emir göndermez ve hiçbir hesapta işlem yapmaz.

---

## Lisans

MIT. Ayrıntılar için [`LICENSE`](LICENSE) dosyasına bakın.
