# arb-bot

Borsalar arası arbitraj fırsatlarını tespit eden, terminal tabanlı bildirim botu.

**6 CEX** — Binance, Bybit, OKX, Gate.io, MEXC, KuCoin
**3 zincir** — Solana (Jupiter), Base (Aerodrome), Arbitrum (Camelot + Uniswap V3)

v1 yalnızca **tespit ve bildirim** yapar; hiçbir emir göndermez. Otomasyon
katmanının arayüzleri baştan yazıldı, v2'de motor kodu değişmeden devreye girer.

---

## Temel ilke: ham spread bir fırsat değildir

Best ask 100 USDT'de **3 adet** coin gösteriyorsa ve sen 1000 USDT'lik almak
istiyorsan, o %5'lik "fark" gerçek değildir. Bu bot iki aşamalı çalışır:

| Aşama | Ne yapar | Sıklık |
|---|---|---|
| **1 — ön filtre** | Yalnızca fiyatı değişmiş çiftleri L1 üzerinden tarar. Tamamen bellekte, allocation'sız. | ~50 ms |
| **2 — doğrulama** | Eşiği geçen adaylar için L2 defteri çeker, gerçek VWAP'ı hesaplar, komisyon + çekim ücreti + gas düşer, transfer yolunu kontrol eder. | yalnızca aday çıkınca |

Yalnızca 2. aşamadan geçen şey bildirilir.

Bu ayrımın ölçülen değeri: canlı testte L1'e bakan bir bot ortalama **%14** kâr
görürdü; VWAP ve ücretlerle gerçek değer **%11.5** çıktı.

---

## Kurulum

```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env
```

`.env` içinde en az şunu ayarla:

```ini
MIN_NET_PCT=0.4           # bildirim eşiği (net, tüm maliyetler düşülmüş)
TRADE_SIZE_QUOTE=1000     # fırsat hesabındaki işlem büyüklüğü (USDT)
```

Telegram istersen:

```ini
TELEGRAM_ENABLED=1
TELEGRAM_BOT_TOKEN=...    # @BotFather'dan al
TELEGRAM_CHAT_ID=...      # @userinfobot'a yazarak öğren
```

EVM DEX'leri (Aerodrome, Camelot) için RPC gerekli — **public RPC yetersizdir**,
Alchemy/QuickNode ücretsiz kademesi başlangıç için yeterli:

```ini
BASE_RPC_URL=wss://base-mainnet.g.alchemy.com/v2/KEY
ARBITRUM_RPC_URL=wss://arb-mainnet.g.alchemy.com/v2/KEY
```

`wss://` tercih et: blok event'iyle tetiklenmek yoklama yapmaktan hem hızlı hem
kotaya daha nazik. RPC tanımlı değilse o DEX sessizce atlanmaz — başlangıçta
açıkça "devre dışı" olarak raporlanır.

---

## Çalıştırma

```bash
npm run dev               # botu başlat (terminal arayüzüyle)
```

### Doğrulama komutları

Bunları bota güvenmeden önce çalıştır:

```bash
npm run feeds             # 6 borsaya bağlan, 30 sn dinle, gecikme + sembol raporu
npm run feeds -- okx 60   # tek borsa, 60 saniye
npm run dex               # Solana mint adreslerini ve Jupiter quote'larını doğrula
npm run verify-contracts  # EVM kontrat + token adreslerini ZİNCİRDEN doğrula
npm test                  # VWAP mantığının birim testleri
```

`verify-contracts` üç kademe uygular: adreste kontrat var mı → ERC20
symbol/decimals tabloyla eşleşiyor mu → quoter gerçekten makul fiyat veriyor mu.
Bir kontratın var olması doğru kontrat olduğunu göstermez, o yüzden üçüncü adım
şart.

### Kalibrasyon — otomasyona geçmeden önce

```bash
npm run calibrate         # biriken sinyallerin kalite raporu
```

Bot her fırsatı `data/opportunities-YYYY-MM-DD.ndjson` dosyasına yazar. Rapor
şunları söyler: sinyaller hangi coinlerde yoğunlaşıyor, kaçı "kapanmayan fark"
uyarısı taşıyor, kaçı doğrulanmamış transfer bilgisine dayanıyor, kayma ne kadar
kâr yiyor.

**v2'ye bu rapor temiz görünmeden geçme.** Aksi halde otomasyon gerçek parayla
aynı sahte sinyalleri kovalar.

---

## Bilinen sınırlar

### 1. Dört borsada çekim durumu doğrulanamıyor

Bir arbitrajın gerçek olması için coin'in alış borsasından **çekilebiliyor** ve
satış borsasına **yatırılabiliyor** olması gerekir. Çekimi kapalı bir coinde
görünen %5 fark fırsat değil, tuzaktır — piyasa zaten o yüzden ayrışmıştır.

| Borsa | Kaynak |
|---|---|
| Gate.io, KuCoin | ✅ public API — gerçek veri |
| Binance, Bybit, OKX, MEXC | ⚠️ yalnızca private endpoint'te |

İkinci gruptaki fırsatlar `?` işareti ve açık uyarı ile bildirilir. Salt-okunur
API anahtarı eklendiğinde çözülür: `src/engine/transfer-info.ts` içine bir
provider eklemek yeterli, motor kodu değişmez.

### 2. "Kapanmayan fark" filtresi

Canlı testte bir coin (PYBOBO) 75 saniye boyunca **rakamı hiç değişmeden** %11
net kâr gösterdi. Gerçek arbitraj bu kadar yaşamaz; kapanmıyorsa kârlı olduğu
için değil **ulaşılamaz** olduğu için oradadır. Bot 45 saniyeden uzun süren
farkları bu gerekçeyle işaretler.

### 3. DEX↔DEX yalnızca aynı zincirde

Farklı zincirler arası fırsatlar köprü maliyeti ve gecikmesi modellenmeden
güvenilir olmadığı için v1'de üretilmez.

### 4. Sistem saati

Gecikme ölçümü lokal saatin kaymasına karşı düzeltilir (gözlenen minimum fark
saat kayması sayılıp düşülür). Yine de raporlarda büyük bir kayma görürsen:

```powershell
w32tm /resync     # yönetici PowerShell
```

---

## Mimari

```
src/
  core/        types · config · http (rate limit) · metrics
  book/        price-store (Float64Array) · depth-cache
  feeds/
    cex/       base-feed · binance · bybit · okx · gate · mexc · kucoin · pool
    dex/       jupiter · evm (Aerodrome/Camelot/UniV3)
  normalize/   symbol-registry
  engine/      scanner · vwap · transfer-info
  notify/      telegram · dedup · format
  ui/          renderer (ham ANSI)
  persist/     ndjson
  risk/        limits          ← v1'de pasif, kararı loglar
  exec/        executor        ← v2 giriş noktası
```

### Neden bu kadar az bağımlılık

Toplam üç production paketi: `ws`, `viem`, `protobufjs`.

- **Telegram SDK yok** — tek `sendMessage` çağrısı için telegraf'ın yüzlerce
  transitive bağımlılığını taşımaya değmez.
- **Terminal UI kütüphanesi yok** — `ink` React çeker, `blessed` bakımsız.
  Gereken şey ekranı temizleyip birkaç satır basmak: ~150 satır.
- **Test framework'ü yok** — Node'un yerleşik `node:test`'i yeterli.
- **`protobufjs` zorunlu istisna** — MEXC WebSocket'i protobuf'a taşıdı.

### Hot path

Fiyatlar `Float64Array` düzleminde tutulur (`pairIndex × venueCount`). Tick
işlemek birkaç indeksli yazmaya iner — tick başına object yaratılmaz, GC
duraklaması olmaz. Feed'ler kurulumda slot numaralarını alır, sonrasında
string→index araması bile yapılmaz.

---

## Canlı test bulguları

Geliştirme sırasında ölçülenler — kod yorumlarında da referans veriliyor:

| Bulgu | Sonuç |
|---|---|
| Binance `!bookTicker` (tüm piyasa) artık veri vermiyor | Sembol bazlı aboneliğe geçildi |
| KuCoin ~280 sembolde tıkanıp 509 dönüyor | Bağlantı havuzu (200 sembol/bağlantı) |
| MEXC bağlantı başına 30 abonelik | Aynı havuz yapısı |
| Altı borsada da ~2480 ms "gecikme" | Ağ değil, lokal saat kayması — ölçüm düzeltildi |
| Tek fırsat 75 sn'de 210 özdeş kayıt | Dedup katmanı eklendi |

Ölçülen gecikmeler (saat kayması düşülmüş): p50 **0–7 ms**, p99 **2–20 ms**.

---

## Yol haritası (v2)

`src/exec/executor.ts` ve `src/risk/limits.ts` bugün yazılı ama pasif:

- `Opportunity` → `ExecutionPlan` dönüşümü (al → transfer → sat)
- Leg state machine + idempotent client-order-id
- `RiskManager`: pozisyon limiti, günlük kayıp limiti, kill-switch

v2'de yapılacak tek şey `Executor` arayüzüne bir `LiveExecutor` eklemek —
`main.ts` içinde tek satır değişir.
