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
| INFRA-MEDIUM-057 | Kapasite tanılaması kör: ilk düzeltme Docker/containerd'yi dışladı fakat deep modda `/`, `/var`, `/var/lib`, `/var/aqua-saas`, `/tmp` gibi iç içe kapsamları seri taradı. Her kapsama ayrı 120 sn bütçe verildiği için tek tanılama işlemi 12 dakikalık SSH sınırını tüketebiliyor. Tek kök yürüyüşü, yeterli derinlik ve tek toplam timeout bütçesi gerekli. | IN-PROGRESS |
| INFRA-MEDIUM-058 | Safe image GC'de açık-uçlu etiket sınıfı: IMAGE_PREFIX altındaki, keep-allowlist'e (latest/staging/buildcache-*/güncel SHA) girmeyen, 40-hex OLMAYAN ve rollback-* OLMAYAN etiketler (örn. `incident-clean-e8a67919b`, 1.87GB) HİÇBİR GC dalına girmiyor ve ölümsüzleşiyor — default-deny yok | IN-PROGRESS |

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
- Kabul sözleşmesi: her `report`/`gate` işlemi en fazla bir deep yürüyüş yapar;
  `safe-image-gc` ucuz pre-state raporundan sonra yalnız bir post-GC deep gate
  çalıştırır; `du` timeout'u 1–120 saniye ile sınırlıdır; sınır dışı değerler
  `du`yu başlatmadan açık `disk_usage_unavailable` kanıtı üretir ve önceden
  hesaplanmış kapasite kararını değiştirmez.
