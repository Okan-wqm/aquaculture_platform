---
name: GitHub Actions Build Only
description: Always use GitHub Actions for builds, never local builds
type: feedback
---

Her zaman GitHub Actions CI/CD build kullan, local build YAPMA.

**Why:** Kullanıcı local build'lerin çalışmadığını/sorunlu olduğunu belirtti. GitHub Actions üzerinden build doğrulaması yapılmalı.

**How to apply:** Kod değişikliklerinden sonra `npm run build` veya `nx build` yerine commit + push yapıp GitHub Actions workflow'unun sonucunu kontrol et. `gh run list` ve `gh run watch` ile takip et.
