# ARIA — Verimlilik Değerlendirmesi (Eksik / Fazla / Öneriler)

> Tarih: 2026-09-16 · Kaynak: aria-kernel (~249 Python modülü / ~132K satır) + operasyonel çevrenin yalnızca **koddan** okunması ve 6 bağımsız denetim ajanının bulguları. Ayrıntılı mimari için bkz. `ARIA-MIMARI-SEMALARI.md` (22 şema).

## Tez

ARIA'nın sorunu eksik özellik değil — **fazla inşa edilmiş, az çalıştırılmış** bir sistem. Kanıt canlı durum denetiminden geliyor: otonom döngü 27 Mayıs 2026'dan beri durmuş (`autonomy_state.jsonl` son fazı `max_cycles_reached`), 5 Ağustos'taki tek "train" döngüsü `failed` olmuş, gateway daemon'u 8 Eylül'de kendini durdurmuş. `findings.jsonl` hiç satır görmemiş, `agent-invocations/` hiç yazılmamış, `dispatch/`, `skill-genesis/`, `enterprise/`, `knowledge-graph/`, `judgment-pipeline/` dizinleri hiç oluşturulmamış, `aria/state` dalı hiç yayımlanmamış. Makine, kendi değer döngüsünü (baskı → plan → işçi → doğrulama → merge) **bir kez bile** uçtan uca kapatmamış.

## Ne fazla

1. **Kendine hizmet eden katman kalabalığı.** 46 döngü fazının önemli kısmı ürün yerine kendini yönetiyor: durum sıkıştırma, bütünlük doğrulama, göç, erişilebilirlik ratchet'leri, öz-denetim adaptörü (`kernel-dead-wire` çekirdeğin kendi ölü kodunu tarıyor). `funnel_health` modülünün varlık sebebi ölçülmüş "597 üretildi / 0 yakınsandı" tortusudur — sistemin kendi teşhisi de aynı şeyi söylüyor.
2. **Güvenlik töreni / üretim oranı dengesi ters.** 17 sert kontrol, üçlü merge kapısı, 3 üyeli paneller, 24 saatlik veto pencereleri, L3 çift-onay — ama autonomous merge için gerekli kanıt zinciri döngü koşmadığı için asla birikemiyor. Kilidi hiç açılmayan bir kapıya beş kilit daha takılıyor.
3. **Yinelenen makineler.** İki adaptör filosu (`tools/aria-poc` Python + `tools/aria-adapters` TS — `agent_harness_security` ikisinde de var), demote edilmiş ama duran V9.6 merge yolu, ana dalda hiçbir şey yazmayan gateway kodu (yalnız birleştirilmemiş `aria-lane-124` şeridinde), ~170 CLI alt komutu. 12 GitHub workflow'u koşmayan bir sistemi çevreliyor.
4. **Yakıtsız kalibrasyon motoru.** Yargıç ağırlıkları, Beta-Binomial posterior'ları, conformal eşikler, altın setler — hepsi **etiket** yakıtına muhtaç; `health.jsonl` "0 yargılanmış örnek, hassasiyet belirsiz" diyor. Boş motor geceleri satır üretiyor, değer üretmiyor.

## Ne eksik

1. **Kapanmış bir döngünün kanıtı.** En küçük scope'ta bile olsa bir tane yeşil uçtan uca koşu yok. Otonomi merdiveni (L1→L3) yalnız koşarak birikir.
2. **Operatör etiketleme alışkanlığı/yüzeyi.** `calibration_bootstrap` ≥10 etiket istiyor; kimse etiketlememiş. Öğrenen tarafın tamamı buna bağlı.
3. **Sürekli çalışma düzeni.** Daemon'lar ölü, gece şeridi yalnız Actions cron'una bağlı, `aria/state` dalı yayımlanmamış (842 MB sıkıştıran bakım workflow'u olmayan dalı sıkıştırıyor).
4. **Maliyet gerçekliği.** `telemetry/` boş — bütçe kapıları hiç test edilmemiş. Model varsayılanı bilinçli olarak en pahalı kademe (fable/max); çalışmayan bir sistemde bu yalnız risk olarak kurulu.

## Öneriler (etki sırasıyla)

1. **Önce bir geceyi yeşile çevir.** Feature dondurma. `strict` profilinde, yalnız `auto_fix_safe` şeridi (docs/test yolları), tek küçük iş: discovery → baskı → yakınsama → işçi → doğrulama → PR. Bir tane. Her şey bunun gerisine bağlı.
2. **Etiketleme operatörün ana etkileşimi olsun.** Günde 10 dakikalık TP/FP rutini, kalibrasyondan altın sete kadar tüm zincire yakıt verir. Etiket yoksa yargı/kalibrasyon fazları etiket varlığına bağlı açılmalı (faz tablosunun `precondition` mekanizması zaten var).
3. **Faz tablosunu paketle.** 46 faz → koş-her-gece çekirdeği (~15) + koşullu eklentiler. Bütünlük doğrulamayı örneklemle/checkpoint'le, tüm zinciri her gece yeniden hash'leme.
4. **İkizleri erit.** Adaptör filolarını tekilleştir (aynı kural iki dilde iki kez yazılmış), V9.6 kalıntısını sil, gateway şeridini ya bitir ya kapat. Her ikiz ek bir bakım yüzeyi demek.
5. **Kapıları kanıtla orantıla.** 17 sert kontrolü L0→L3 şeritlerinde kademeli aç — L0'da docs-only değişiklik için üçlü merge kapısı beklemek throughput'u öldüren şey.
6. **Varsayılan modeli ucuza çek, yükseltmeyi kanıtla.** "Bilinmiyorsa en pahalı" politikası, çalışmayan sistemde sadece parayı yakacak biçimde kurulu.

## Özet

ARIA kendi kendini denetleyen, kusursuz ama hiç tamamlanmamış bir makine. Verimlilik sıçraması yeni bir katmandan değil, **bir gece gerçek koşup kapıları gerçek veriyle orantılamaktan** gelecek.
