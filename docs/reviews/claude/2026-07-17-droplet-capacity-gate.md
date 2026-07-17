# Droplet kapasite kapısı — deploy blokajı bulgu kaydı

Kaynak: PR #1002 merge sonrası main izleme (2026-07-17). `Deploy Capacity
Maintenance` (ve dolayısıyla production deploy preflight kapısı) kırmızı:
`free_bytes=34.9GB < hard=37.6GB` ve `projected=13.4GB < reserve=21.5GB`.
Kırmızı, merge'den ÖNCE de vardı (ccce6222) — PR #1002 ile ilgisiz.

## Durum makinesi
`OPEN → IN-PROGRESS → RESOLVED` (merge edilen commit `Closes:` taşır).

## Bulgular

| ID | Özet | Durum |
|---|---|---|
| INFRA-MEDIUM-057 | Kapasite tanılaması kör: `du -x -d1 /` docker overlay ağacını da tarayıp 60 sn'de timeout'a düşüyor (`disk_usage_unavailable exit_status=124`) — disk baskısı olayında docker-DIŞI ~90GB'ın NEREDE olduğu raporlanamıyor. Docker byte'ları zaten `docker system df`'ten geliyor; du yürüyüşü docker/containerd alt ağaçlarını dışlamalı + maintenance yüzeyi deep modda koşmalı | IN-PROGRESS |
| INFRA-MEDIUM-058 | Safe image GC'de açık-uçlu etiket sınıfı: IMAGE_PREFIX altındaki, keep-allowlist'e (latest/staging/buildcache-*/güncel SHA) girmeyen, 40-hex OLMAYAN ve rollback-* OLMAYAN etiketler (örn. `incident-clean-e8a67919b`, 1.87GB) HİÇBİR GC dalına girmiyor ve ölümsüzleşiyor — default-deny yok | IN-PROGRESS |

Not: Asıl disk baskısının kaynağı (165GB'ın ~90GB'ı docker dışı) INFRA-MEDIUM-057
kapanıp deep rapor alınmadan kesin atfedilemez; hedefli temizlik takip işi bu
raporun çıktısına göre açılır.
