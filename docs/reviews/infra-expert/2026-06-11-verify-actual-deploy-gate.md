# post-deploy-verify: gerçek-deployment kapısı (2026-06-11)

## INFRA-MEDIUM-005 — Verify, "deploy workflow'u başarılı"yı "deployment oldu" sanıyor; her docs-only main push'u sahte kırmızı

**Severity:** MEDIUM · **Owner:** infra-expert · **Cycle:** 2026-06-11-production-opening

### Gözlem

`ci-affected.yml`'deki `production-post-deploy-verify` kapısı
`needs.deploy.result == 'success'` idi. Reusable-workflow çağıran job'ın
result'ı yalnız "çağrılan workflow düşmedi" demektir: docs/registry-only
push'larda deploy workflow'unun İÇ `deploy` job'ı tasarım gereği SKIPPED
kalır (imaj build'i yok), workflow yine success biter → verify koşar ve
`deployed/production` tag'i (haklı olarak) hareket etmediği için
"deployed/production does not match target_sha" ile düşer. İlk vaka:
kapanış seremonisi commit'i da5e9d0ac — production dokunulmamış ve
TAM SAĞLIKLIYKEN main koşusu kırmızı. Bu sınıf, registry
union/seremoni commit'lerinin HEPSİNDE tekrarlanacaktı (alert yorgunluğu +
gerçek kırmızıların maskelenmesi).

### Düzeltme (bu PR)

Açık üretim-mutasyonu sözleşmesi:
1. `deploy-digitalocean.yml` iç `deploy` job'ının SON adımı
   `mark_performed` output'u üretir (yalnız droplet mutasyonunun sonuna
   ulaşan koşu `performed=true` der); `workflow_call.outputs.deployed`
   bunu ihraç eder (WHY bloklu).
2. `ci-affected.yml` verify kapısı `&& needs.deploy.outputs.deployed ==
   'true'` kazanır — verify yalnız production GERÇEKTEN mutasyona
   uğradığında koşar.
3. `deploy-ssot-contract.spec.ts` üç ucu da pinler (output deklarasyonu,
   mark adımı, kapı ifadesi).

### Tier sınıfı

Tier-1 (make it impossible): no-op koşuda verify'ın yanlış beklentiyle
koşması yapısal olarak imkânsızlaşır; sözleşme üç noktadan CI-pinli.

### Kanıt

- Seremoni koşusu (da5e9d0ac): `deploy / deploy: skipped` iken
  `production-post-deploy-verify / verify: failure` —
  "deployed_production=6170a6e57, target_sha=da5e9d0ac".
- `.github/workflows/ci-affected.yml` verify kapısı (önce/sonra).
