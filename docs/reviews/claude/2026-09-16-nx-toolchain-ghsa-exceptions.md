# Nx araç zinciri GHSA istisnaları — 2026-09-16

> Kaynak: main push'u üzerinde `CI - Affected` → `security-audit` işinin düşmesi
> (run 35063804309, merge commit'i 47edf05e9d). Üretim bacakları temiz; kırılan
> yalnızca `root-full` (geliştirme araç zinciri) bacağı.

## SUPPLY-HIGH-011: GHSA-7w5x-hrqm-74c2 — nx araç zinciri (14 paket + nx + smol-toml)

`npm audit --audit-level=high` (root-full) 15 paketi bu advisory ile işaretliyor:
`@nx/eslint`, `@nx/eslint-plugin`, `@nx/jest`, `@nx/js`, `@nx/module-federation`,
`@nx/nest`, `@nx/node`, `@nx/react`, `@nx/rollup`, `@nx/vite`, `@nx/vitest`,
`@nx/web`, `@nx/workspace`, `nx`, `smol-toml`.

npm'ın önerisi `@nx/*@22.6.4` / `nx@22.6.4` — **her paket için SemVer-major
(breaking)**. `@nx/web` için tek başına breaking-olmayan bir sürüm görünse de
@nx/\* paketleri nx çalışma alanına sürüm-kilitlidir; tek paket bump'ı araç
senkronunu bozar. Bu nedenle düzeltme, çalışma alanı genelinin 22.6.4'e
planlı taşınmasıdır; o çalışma yapılana kadar tarihli, sahipli, kayıt
referanslı istisna tutuldu (`scripts/ci/npm-audit-exceptions.json`, süre
2026-10-16'ya kadar — o gün kapı yeniden kapanır ve argüman tazelenmek zorundadır).

## SUPPLY-HIGH-012: GHSA-vwc7-r8mq-g2x9 — @nx/react ve @nx/module-federation

Aynı denetim koşusunda `@nx/react` ve `@nx/module-federation` bu ikinci
advisory'yi de taşıyor; npm önerisi `@nx/react@20.1.4` (breaking). 011 ile
aynı gerekçe ve aynı son kullanma tarihiyle istisnaya alındı; asıl düzeltme
aynı planlı nx yükseltmesidir.

## İzlenecek yol

1. `nx`/`@nx/*` 22.6.4'e (veya advisory'yi kapatan en yakın sürüme) çalışma alanı
   genelinde yükseltilmeli; `npx nx migrate` akışı kullanılabilir.
2. Yükseltme merge edilince `npm-audit-exceptions.json` girdileri (ve gerekirse
   bu iki bulgu) kapatılmalı; kapı istisnasız yeşil kalmalı.
