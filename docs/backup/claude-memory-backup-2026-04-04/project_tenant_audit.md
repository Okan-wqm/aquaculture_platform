---
name: tenant-panel-enterprise-audit
description: Kullanıcı admin panel audit+fix başarısını tenant panel, sensor, farm, HR, hydroponics modüllerine ve mobil app'e genişletmek istiyor. Enterprise-grade, RBAC, veri akışı, uçtan uca kontrol.
type: project
---

Kullanıcı admin panel audit+fix operasyonunu (57 ajan) referans alarak aynı kalitede tenant panel ve ilişkili modüller için enterprise-grade audit+fix istiyor.

**Why:** Platform production'a yaklaşıyor, tenant-facing modüller admin panel kadar kritik ama hiç audit edilmemiş. Özellikle veri akışı (DB↔API↔frontend), RBAC, user management, mobil app entegrasyonu.

**How to apply:** Aynı dalga-bazlı ajan ordusu pattern'ini kullan. Önce audit spec yaz, uzman review'dan geçir, sonra fix ordusu kur. Modüller: tenant-admin, sensor-module, farm-module, hr-module, hydroponics-module, aquamobil (PWA), ve bunların backend servisleri.
