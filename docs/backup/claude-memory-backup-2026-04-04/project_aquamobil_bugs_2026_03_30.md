---
name: AquaMobil Runtime Bugs 2026-03-30
description: 13 bugs found in AquaMobil PWA - 5 critical, 4 medium, 4 low. BUG-01 (HEAD /graphql 503) is root cause for most downstream issues.
type: project
---

AquaMobil PWA runtime bug testi 30 Mart 2026'da yapıldı (app.suderra.com/mobile/).

**Root cause:** BUG-01 — HEAD /graphql → 503. Apollo client health check başarısız, tüm dropdown'lar boş.

**Kritik (5):** HEAD 503, Leave route yanlış, Stock In wizard escape, Write Off wrong component, useWarehouseSummary 400
**Orta (4):** Sync state çelişki, Clock In UI güncellenmez, Messages badge yanlış, Form validation sessiz
**Düşük (4):** AI Insights unavailable, WQ equipment boş, Messages contacts boş, Last synced: Never

**Why:** v11 upgrade sırasında gateway HEAD /graphql middleware eklenmişti ama PWA'nın kullandığı health check pattern'ı ile uyumsuz olabilir.

**How to apply:** BUG-01 en önce çözülmeli — downstream etkisi en yüksek. Sonra routing/component bug'ları, sonra state management.
