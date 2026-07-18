# Droplet kapasite kapısı — deploy blokajı bulgu kaydı

Kaynak: PR #1002 merge sonrası main izleme (2026-07-17). `Deploy Capacity
Maintenance` (ve dolayısıyla production deploy preflight kapısı) kırmızı:
`free_bytes=34.9GB < hard=37.6GB` ve `projected=13.4GB < reserve=21.5GB`.
Kırmızı, merge'den ÖNCE de vardı (ccce6222) — PR #1002 ile ilgisiz.

## Durum makinesi

`OPEN → IN-PROGRESS → RESOLVED` (merge edilen commit `Closes:` taşır).

## Bulgular

<!-- prettier-ignore -->
| ID | Özet | Durum |
|---|---|---|
| INFRA-MEDIUM-057 | Kapasite tanılaması kör: ilk sürüm iç içe kapsamlarla 12 dakikalık SSH sınırını tüketti; tek-kök takip düzeltmesi işi 2:13'e indirdi ancak kök yürüyüşü 120 saniyede timeout olup hiçbir dizin boyutu üretmedi. Çakışmayan kapsamlar tek global deadline altında sınırlı paralellikle taranmalı; tamamlanan alt ağaç kanıtı diğer bir scope timeout olsa da korunmalı. | IN-PROGRESS |
| INFRA-MEDIUM-058 | Safe image GC'de açık-uçlu etiket sınıfı: IMAGE_PREFIX altındaki, keep-allowlist'e (latest/staging/buildcache-*/güncel SHA) girmeyen, 40-hex OLMAYAN ve rollback-* OLMAYAN etiketler (örn. `incident-clean-e8a67919b`, 1.87GB) HİÇBİR GC dalına girmiyor ve ölümsüzleşiyor — default-deny yok | RESOLVED |
| INFRA-MEDIUM-076 | Host-artifact bakımı için sabit allowlist ve etkinlik/mount/swap/deploy-path predicate'leri yok. Cleanup adlı 6 GiB aday aktif swap ve 5.14 GiB'ı kullanımda; mevcut durumda silinmesi değil reddedilmesi gerekir. | IN-PROGRESS |
| INFRA-HIGH-079 | 8 GiB production host 7.28 GiB swap kullanıyor; production, entegrasyon ve agent iş yükleri aynı node'da. İkinci swap dosyasını kapatmak mevcut bellek kanıtıyla OOM riski taşır. | IN-PROGRESS |

Not: Asıl disk baskısının kaynağı (165GB'ın ~90GB'ı docker dışı) INFRA-MEDIUM-057
kapanıp deep rapor alınmadan kesin atfedilemez; hedefli temizlik takip işi bu
raporun çıktısına göre açılır.

### INFRA-MEDIUM-057 yeniden üretim kanıtı

- Scheduled `Deploy Capacity Maintenance` koşusu
  [29607246883](https://github.com/Okan-wqm/aquaculture_platform/actions/runs/29607246883),
  `appleboy/ssh-action` adımında tam 12 dakikalık `command_timeout` sınırına
  ulaştı; canonical kapasite kararı tamamlanmadan workflow kırmızı oldu.
- O koşudaki kod Docker/containerd'yi dışlıyordu, fakat deep tanılama aynı
  filesystem'i kökten başlayarak iç içe sekiz kapsam için tekrar yürüyordu.
  Dolayısıyla sorun tek bir yavaş `du` değil, `CAPACITY_DU_TIMEOUT_SECONDS`
  bütçesinin kapsam sayısıyla çarpılmasıdır.
- İlk takip düzeltmesinin merge edildiği SHA `05d10f997d5cb9e2179b4db0035c940e6f60a90c`
  için manual `report` koşusu
  [29616400853](https://github.com/Okan-wqm/aquaculture_platform/actions/runs/29616400853)
  2 dakika 13 saniyede yeşil tamamlandı ve `free_bytes=47256621056` ölçtü;
  buna rağmen tek kök `du` tam 120 saniyede `exit_status=124` verdi ve hiçbir
  `bytes/path` satırı üretmedi. Süre sınırı düzeldi, körlük kapanmadı.
- Kabul sözleşmesi: her `report`/`gate` işlemi en fazla bir global deep bütçe kullanır;
  Docker/containerd hariç kapsamlar çakışmayan bir frontier oluşturur; en çok
  dört worker keşif dahil aynı 120 saniyelik deadline'ı paylaşır; keşfin tamamı
  en fazla 20 saniye ve 64 çağrı, her scope en fazla 15 saniye, her dizin 128
  çocuk, toplam frontier 512 scope, worker çıktısı 8 KiB ve unavailable ledger
  64 kayıtla sınırlıdır; `/tmp`,
  `/var/aqua-saas` ve `/var/suderra-os` çocukları ayrı summary scope olarak
  ölçülür; tamamlanan scope sonuçları başka bir scope timeout olsa da raporlanır;
  `safe-image-gc` ucuz pre-state raporundan sonra yalnız bir post-GC deep gate
  çalıştırır; `du` timeout'u 1–120 saniye ile sınırlıdır; sınır dışı değerler
  `du`yu başlatmadan açık `disk_usage_unavailable` kanıtı üretir ve önceden
  hesaplanmış kapasite kararını değiştirmez.

### 2026-07-18 canlı takip — 057 neden hâlâ açık

- `origin/main@4ae24e97` üzerinde exact-SHA manual report
  [29619814634](https://github.com/Okan-wqm/aquaculture_platform/actions/runs/29619814634)
  42 saniyede tamamlandı; `free_bytes=46878023680`, 323 discovered scope, 322
  tamamlanmış record ve üç unavailable scope üretti. Bu, önceki sıfır-satır
  körlüğünü kapattı.
- Ancak log yalnız en büyük 40 scope'u yayımlıyor. `/tmp` discovery'si 128-child
  sınırında partial iken tamamlanan küçük çocukların parent toplamı ve coverage
  durumu yok; dağıtık kütle yine ilk 40'ın altında gizlenebilir. 057 ancak her
  hotspot için bounded `completed_bytes_lower_bound`, completed/unavailable
  scope sayısı ve `complete|partial` coverage kanıtı canlıda görüldüğünde
  kapanacak.
- Exact-SHA `safe-image-gc` koşusu
  [29627236805](https://github.com/Okan-wqm/aquaculture_platform/actions/runs/29627236805)
  53 protected image referansının tamamını korudu, `removed_*=0` ile bitti ve
  final gate'i geçti. Default-deny kodu merge edilmiş olduğundan
  INFRA-MEDIUM-058 registry CLI ile `4e9490055...` commitine kapatıldı.

### INFRA-MEDIUM-076 — aktif swap adayı için fail-closed host-artifact yetkisi

- Run 29619814634 `/swapfile-cleanup-20260610` için 6,442,463,232 allocated byte
  raporladı. Salt-okunur `swapon --bytes` ölçümü dosyanın 6,442,446,848 byte
  boyutunda ve 5,137,809,408 byte kullanımda olduğunu doğruladı.
- Dosya cleanup adlı olsa da stale veya reclaimable değildir. `swapoff`, unlink,
  process sonlandırma ya da resize bu bulgunun verdiği bir yetki değildir.
- Kabul: workflow keyfi path alamaz; kod-içi exact allowlist adayı root-owned
  regular/single-link olmalı, boyut/yaş, realpath, mount/source, active swap,
  open handle, stable inode ve deploy/database/container path ayrıklığı iki kez
  kanıtlanmalıdır. Tek belirsizlik `blocked` ve sıfır unlink üretir.

### INFRA-HIGH-079 — bellek/swap lifecycle kapasitesi

- Salt-okunur host ölçümü: RAM total 8,326,946,816; available 3,567,439,872;
  swap used 7,275,569,152 / 8,589,926,400 byte. Birincil `/swapfile` neredeyse
  tamamen, cleanup adlı ikinci swap ise 5.14 GiB kullanılıyor.
- Container envanteri production stack yanında yaklaşık 42 saattir çalışan üç
  `aqua-walg-it-*` entegrasyon container'ı gösterdi; agent oturumları da aynı
  hostu paylaşıyor. Bu kanıt hangi iş yükünün sonlandırılabileceğine tek başına
  yetki vermez.
- Kapanış, production dışı iş yüklerinin sahiplik/lifecycle sınıflandırmasını,
  bellek headroom ve swap-in kanıtını ve gerekiyorsa ücretli resize kararını
  ayrı, denetlenebilir bir operasyonla gerektirir.
