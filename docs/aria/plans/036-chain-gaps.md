<!-- ARIA-HISTORICAL: Historical plan document.
Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# ARIA Plan 036 — Plan 034 sonrası zincirde kalan açıklar

> **Durum:** 2026-09-26 onaylandı (okan). Bulgular ARIA-HIGH-205…213:
> `docs/reviews/claude/2026-09-26-aria-chain-gaps.md`. Kaynak: dört salt-okur denetim (M1/O1b, O1,
> O3/O4/O2, uçtan uca zincir).

## Neden

Plan 034'ün operatör adımları yazıldığı gibi uygulansa bile ARIA kendi PR'ını merge edemezdi. Ana
engel şu: `pr_merge` yalnız `autonomous` profilde açılıyor, gece döngüsü ise profili en fazla
`strict`'e yazıyor.

Kullanıcı kararları:

1. Merge yetkisi global profilden ayrı, operatör onaylı, lane'e bağlı ve geri alınabilir bir grant
   olacak.
2. Code-owner kilitlenmesi CODEOWNERS'a ikinci sahip eklenerek çözülecek.

## Birimler

| Birim | Bulgu         | Değişiklik                                                                                             |
| ----- | ------------- | ------------------------------------------------------------------------------------------------------ |
| A1    | ARIA-HIGH-205 | `merge_lane_grant`: beyanlı ledger, `merge-lane grant/revoke` CLI; merge authority ve runner bunu okur |
| A2    | ARIA-HIGH-206 | merge runner `CI - Affected` tamamlanınca ve saatlik yeniden değerlendirir                             |
| A3    | ARIA-HIGH-207 | ölçülmemiş `bypass_actors` kanıtı geçersiz kılar                                                       |
| A4    | ARIA-HIGH-208 | merge token'ı checks/statuses/issues okur; ARIA PR'ı App token ile açılır                              |
| A5    | ARIA-HIGH-209 | promote onay referansı çözülür ve kaydedilir; `readiness adapter` görünümü                             |
| A6    | ARIA-HIGH-210 | `readiness probe-branch-protection` CLI                                                                |
| A7    | ARIA-HIGH-211 | yolları L1 dışında kalan bulgu için plan basılmaz; `risk-policy.json` hizalanır                        |
| A8    | ARIA-HIGH-212 | doc-staleness precision ≥0,85 (FP sınıfları, kurallar, fixture)                                        |
| A9    | ARIA-HIGH-213 | runbook'lar koda göre yeniden yazılır                                                                  |

## Düzeltilmiş operatör adımları (sırasıyla)

0. #1673 merge edilir (Claude).
1. CODEOWNERS'a ikinci sahip veya takım eklenir.
2. Runner `[self-hosted, linux, claude]` çevrimiçi olmalı: `claude` OAuth, bwrap/AppArmor ve
   `openssh-client` kurulu, `vars.ARIA_MOCK_KILL_SWITCH` boş veya `false`.
3. O1 — App izinleri: Contents RW, Pull requests RW, Administration R, Metadata R, Checks R, Commit
   statuses R, Issues R. İzinler installation'da kabul edilir. Üç App secret'ın tam PEM içerdiği
   doğrulanır.
4. M1 — `aria-kernel readiness probe-branch-protection` (A6). O gelene kadar `gh api …/protection`,
   `…/rules/branches/main` ve `…/rulesets/<id>`; `bypass_actors` `[]` olmalı, `null` değil.
5. O1b — classic protection:
   - 4 zorunlu check GitHub Actions'a sabitlenir, `strict` açık;
   - imzalı commit;
   - 0 onay + Code Owners;
   - conversation resolution;
   - `enforce_admins`;
   - force-push ve silme kapalı.

   Ayrıca en az bir aktif ruleset (`bypass_actors: []`), zorunlu merge queue yok, yalnız squash.

6. O4 — `aria-auto-cycle` `mode=burn-in-observe mock=false`. Eşik ≥30 `observe_success`; ikinci
   koşu gerekirse 72 saat içinde yapılır.
7. O3 — `aria/state` checkout'unda `tool promote … --target-status SHADOW`. A8 bittiğinde ≥5
   kararlı SHADOW koşusu ve ≥5 anchor yargısı gerekir; ardından `--target-status ACTIVE
--operator-approval-ref gov:<id>`.
8. O2 — `profile set --profile standard --scheduler-ceiling strict --operator-approval-ref gov:<id>`.
9. A1'den sonra — `merge-lane grant --expires-at <tarih> --operator-approval-ref gov:<id>`.

## Doğrulama

- Her birim için testler önce yazılır; ilgili modüller origin/main'e karşı çalıştırılır; banned
  gate'ler ve authority hash kontrol edilir.
- Mock E2E: kaydedilmiş `strict` profil + L1 grant ile tam sıra `merged` biter; grant geri alınınca
  aynı sıra `dry_run` olur.
