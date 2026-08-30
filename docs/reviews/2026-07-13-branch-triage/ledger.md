# Branch & Worktree Triage Ledger — 2026-07-13

Program planı: /root/.claude/plans/b-r-suru-branch-var-hazy-hearth.md (oturum planı).
Sınıflar: **A** ancestor-merged · **B** patch-eşdeğer (0 unique) · **C** 1–5 unique patch · **D** 6+ unique patch.
Verdict: MERGED / SUPERSEDED / VALUABLE / INCOMPLETE-VALUABLE / WORTHLESS / ACTIVE / PENDING(incelenmedi).
Silinen her ref bu dosyadaki SHA ile geri getirilebilir: `git branch <ad> <sha>`.

Üretim: origin/main = 9ee86a9bc (2026-07-13T07:18:05+02:00)

## Lokal branch'ler (206)

| Ref                                                | SHA       | Sınıf | Unique/Total | Behind/Ahead | Son commit | Verdict | Kanıt / Aksiyon                                     |
| -------------------------------------------------- | --------- | ----- | ------------ | ------------ | ---------- | ------- | --------------------------------------------------- |
| `_fix921`                                          | 541f771d3 | C     | 1/1          | 281/2        | 2026-07-07 | PENDING |                                                     |
| `_fix921b`                                         | 9c17d1f8a | C     | 2/2          | 279/4        | 2026-07-07 | PENDING |                                                     |
| `chore/admin-api-drop-dead-tenant-role`            | 1f2d0d991 | C     | 3/3          | 267/4        | 2026-07-08 | PENDING |                                                     |
| `chore/ai-service-deploy-secret`                   | db56bd97b | B     | 0/1          | 348/1        | 2026-07-06 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `chore/aria-authority-hash-repin`                  | 279b592e0 | B     | 0/1          | 518/1        | 2026-07-02 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `chore/aria-coverage-closeout`                     | 102fc50b1 | B     | 0/1          | 519/1        | 2026-07-02 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `chore/aria-modernization-capstone`                | 5d39e8e67 | B     | 0/1          | 541/1        | 2026-07-01 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `chore/aria-opproof-closeout`                      | 70f8bb133 | B     | 0/1          | 539/1        | 2026-07-02 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `chore/branch-triage-2026-07-13`                   | 9ee86a9bc | A     | 0/0          | 0/0          | 2026-07-13 | MERGED  | ancestor of origin/main                             |
| `chore/e2e-boundary-relocate`                      | 77d0ed17c | B     | 0/1          | 630/2        | 2026-06-28 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `chore/eslint-aquamobil`                           | c915dd198 | C     | 3/3          | 718/5        | 2026-06-23 | PENDING |                                                     |
| `chore/eslint-ci-lint-green`                       | e747f9eb6 | C     | 3/3          | 731/3        | 2026-06-23 | PENDING |                                                     |
| `chore/format-scope-regen-orphan-117`              | 05bfa9f1d | B     | 0/1          | 599/1        | 2026-06-29 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `chore/rbac-close-ceremony`                        | 80a0e5720 | B     | 0/1          | 397/1        | 2026-07-05 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `chore/registry-closeout-schema-drift`             | 969026a56 | C     | 3/3          | 621/3        | 2026-06-29 | PENDING |                                                     |
| `claude/farm-ssot-diagnostics-arch-x5457y`         | ef0221977 | D     | 33/33        | 623/34       | 2026-06-28 | PENDING |                                                     |
| `dep-847-local`                                    | e3e728359 | C     | 2/2          | 185/3        | 2026-07-11 | PENDING |                                                     |
| `dep-889-local`                                    | 9256fdc85 | C     | 2/2          | 185/3        | 2026-07-11 | PENDING |                                                     |
| `docs/orphan-308-auth-audit-rls`                   | 8dfc62eac | B     | 0/1          | 524/1        | 2026-07-02 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `docs/registry-farm112-ci-quarantine`              | 45b7e0075 | C     | 1/1          | 525/2        | 2026-07-02 | PENDING |                                                     |
| `feat/a1-mirror-retirement`                        | 9056f314b | A     | 0/0          | 37/0         | 2026-07-12 | MERGED  | ancestor of origin/main                             |
| `feat/a3-retire-user-permissions`                  | a38338880 | A     | 0/0          | 14/0         | 2026-07-13 | MERGED  | ancestor of origin/main                             |
| `feat/admin-panel-p2-contracts`                    | b268a6614 | A     | 0/0          | 64/0         | 2026-07-12 | MERGED  | ancestor of origin/main                             |
| `feat/ai-conversation-turns-ledger`                | a05577c0f | A     | 0/0          | 3/0          | 2026-07-13 | MERGED  | ancestor of origin/main                             |
| `feat/ai-farm-batch-read`                          | 4d47a528a | B     | 0/1          | 337/1        | 2026-07-07 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `feat/ai-farm-feeding-read`                        | 4f9a3964d | B     | 0/1          | 334/1        | 2026-07-07 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `feat/ai-farm-harvest-read`                        | 30ebc0c2b | B     | 0/1          | 335/1        | 2026-07-07 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `feat/ai-farm-read-tools`                          | be2b90bf4 | B     | 0/1          | 338/1        | 2026-07-06 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `feat/ai-farm-water-quality-read`                  | 848214417 | B     | 0/1          | 336/1        | 2026-07-07 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `feat/ai-msg-phase0-boot`                          | 5e9b46de6 | A     | 0/0          | 423/0        | 2026-07-05 | MERGED  | ancestor of origin/main                             |
| `feat/ai-msg-phase1-byok`                          | 706dc62dc | A     | 0/0          | 422/0        | 2026-07-05 | MERGED  | ancestor of origin/main                             |
| `feat/ai-msg-phase2-bridge`                        | 13b0c4d0b | A     | 0/0          | 417/0        | 2026-07-05 | MERGED  | ancestor of origin/main                             |
| `feat/ai-msg-phase4-mobile`                        | 9aac07f67 | A     | 0/0          | 409/0        | 2026-07-05 | MERGED  | ancestor of origin/main                             |
| `feat/ai-openai-provider`                          | 4dc7469ff | C     | 1/1          | 340/1        | 2026-07-06 | PENDING |                                                     |
| `feat/ai-openai-provider-clean`                    | a305d6b9d | C     | 2/2          | 340/2        | 2026-07-06 | PENDING |                                                     |
| `feat/ai-service-deploy`                           | 74e4aa4c3 | D     | 11/11        | 349/13       | 2026-07-06 | PENDING |                                                     |
| `feat/ai-service-deploy-chain`                     | 72846b946 | B     | 0/1          | 396/1        | 2026-07-06 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `feat/ai-task-create-tool`                         | ee778f1ac | B     | 0/1          | 339/1        | 2026-07-06 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `feat/aria-autonomous-mode`                        | ca4ac02cb | C     | 1/1          | 185/1        | 2026-07-11 | PENDING |                                                     |
| `feat/aria-autonomy-operator-cli`                  | 927fbb838 | C     | 2/2          | 584/2        | 2026-06-30 | PENDING |                                                     |
| `feat/aria-burnin-ladder-bridge`                   | 8c2feafaa | B     | 0/1          | 585/2        | 2026-06-30 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `feat/aria-claude-cli-runtime`                     | d9e657a63 | A     | 0/0          | 616/0        | 2026-06-29 | MERGED  | ancestor of origin/main                             |
| `feat/aria-claude-cli-runtime-cleanup`             | 4232b7e3f | C     | 3/3          | 612/3        | 2026-06-29 | PENDING |                                                     |
| `feat/aria-claude-cli-runtime-core`                | ee0bcd5d4 | C     | 1/1          | 612/1        | 2026-06-29 | PENDING |                                                     |
| `feat/aria-claude-cli-runtime-rewire`              | e57af17df | C     | 2/2          | 612/2        | 2026-06-29 | PENDING |                                                     |
| `feat/aria-completeness-critic`                    | e61feeba8 | D     | 6/6          | 520/6        | 2026-07-02 | PENDING |                                                     |
| `feat/aria-coverage-gap-genesis`                   | 17630611f | B     | 0/1          | 587/1        | 2026-06-30 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `feat/aria-credit-fallback`                        | 1be50c81c | C     | 2/2          | 500/2        | 2026-07-03 | PENDING |                                                     |
| `feat/aria-cycle-live-progress`                    | affeaba38 | B     | 0/1          | 595/1        | 2026-06-30 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `feat/aria-modernization-b1`                       | cd35dcbe5 | C     | 3/3          | 552/3        | 2026-07-01 | PENDING |                                                     |
| `feat/aria-modernization-b2`                       | 9812fead2 | C     | 2/2          | 551/2        | 2026-07-01 | PENDING |                                                     |
| `feat/aria-modernization-b3`                       | f9693c3d0 | C     | 2/2          | 549/2        | 2026-07-01 | PENDING |                                                     |
| `feat/aria-modernization-k1`                       | 834492fe4 | C     | 2/2          | 548/2        | 2026-07-01 | PENDING |                                                     |
| `feat/aria-modernization-k2`                       | af6147303 | C     | 2/2          | 547/2        | 2026-07-01 | PENDING |                                                     |
| `feat/aria-modernization-k3`                       | a790fd447 | C     | 2/2          | 546/2        | 2026-07-01 | PENDING |                                                     |
| `feat/aria-modernization-k4`                       | cc61c2bab | C     | 2/2          | 545/2        | 2026-07-01 | PENDING |                                                     |
| `feat/aria-modernization-k5`                       | d478bda73 | C     | 2/2          | 544/2        | 2026-07-01 | PENDING |                                                     |
| `feat/aria-modernization-k6`                       | 772b0f86c | C     | 2/2          | 543/2        | 2026-07-01 | PENDING |                                                     |
| `feat/aria-modernization-wa`                       | bcd495461 | C     | 2/2          | 550/2        | 2026-07-01 | PENDING |                                                     |
| `feat/aria-modernization-wb`                       | 7276c92bc | C     | 2/2          | 542/2        | 2026-07-01 | PENDING |                                                     |
| `feat/aria-ops-s1`                                 | 9175ba19a | C     | 2/2          | 538/2        | 2026-07-02 | PENDING |                                                     |
| `feat/aria-ops-s4`                                 | 1b59106a3 | C     | 2/2          | 537/2        | 2026-07-02 | PENDING |                                                     |
| `feat/aria-ops-s5`                                 | ff5163985 | C     | 2/2          | 535/2        | 2026-07-02 | PENDING |                                                     |
| `feat/aria-ops-s6`                                 | 32711b3d0 | C     | 2/2          | 536/2        | 2026-07-02 | PENDING |                                                     |
| `feat/aria-per-service-agent-routing`              | dbf2ebd58 | B     | 0/1          | 588/2        | 2026-06-30 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `feat/aria-per-service-cycle-examination`          | 7634ab19c | B     | 0/1          | 591/2        | 2026-06-30 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `feat/aria-per-service-impact-order`               | 6da6eff67 | B     | 0/1          | 593/1        | 2026-06-30 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `feat/aria-per-service-scoped-pressures`           | 294e1d9e1 | B     | 0/1          | 590/1        | 2026-06-30 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `feat/aria-plan-coverage-gate`                     | cf22abbe4 | C     | 3/3          | 522/3        | 2026-07-02 | PENDING |                                                     |
| `feat/auth-security-primitive-specs-audit-009`     | 041758e7e | C     | 1/1          | 328/1        | 2026-07-07 | PENDING |                                                     |
| `feat/auth-tenants-ownership`                      | 7ccb942b1 | A     | 0/0          | 52/0         | 2026-07-12 | MERGED  | ancestor of origin/main                             |
| `feat/auth-token-validation-p99-slo-perf-003`      | 0f4c625b8 | C     | 1/1          | 597/1        | 2026-06-29 | PENDING |                                                     |
| `feat/config-service-wire`                         | b1eef3aff | A     | 0/0          | 28/0         | 2026-07-12 | MERGED  | ancestor of origin/main                             |
| `feat/crypto-shred-step2`                          | 9d4992194 | A     | 0/0          | 79/0         | 2026-07-12 | MERGED  | ancestor of origin/main                             |
| `feat/db-audit-lane`                               | 71230c85c | A     | 0/0          | 93/0         | 2026-07-12 | MERGED  | ancestor of origin/main                             |
| `feat/farm-documents-drop`                         | f784b97a5 | A     | 0/0          | 72/0         | 2026-07-12 | MERGED  | ancestor of origin/main                             |
| `feat/farm-module-shared-rest-client-farm-091`     | 4532513d0 | B     | 0/1          | 596/1        | 2026-06-29 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `feat/farm-realtime-sync-mobile`                   | b8d6dabb0 | B     | 0/1          | 569/3        | 2026-07-01 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `feat/feed-dual-ssot-phase2`                       | 42dfd682d | D     | 9/9          | 928/9        | 2026-07-11 | PENDING |                                                     |
| `feat/graphql-drift-burndown-final`                | cc540233f | C     | 3/3          | 628/5        | 2026-06-28 | PENDING |                                                     |
| `feat/hr-leave-admin-backend`                      | 6d22465f4 | B     | 0/1          | 639/1        | 2026-06-28 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `feat/legacy-config-store-drop`                    | e8f43e1c7 | A     | 0/0          | 85/0         | 2026-07-12 | MERGED  | ancestor of origin/main                             |
| `feat/orphan-320-lockout-owner-channel`            | 848d60c65 | C     | 2/2          | 511/9        | 2026-07-02 | PENDING |                                                     |
| `feat/orphan-324-infra-ledger-rls`                 | cef6dcfad | C     | 2/2          | 333/3        | 2026-07-07 | PENDING |                                                     |
| `feat/panel-ai-assistant-drawer`                   | 14dc0c201 | B     | 0/1          | 342/1        | 2026-07-06 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `feat/panel-ai-settings`                           | d0fd92c4a | C     | 2/2          | 343/2        | 2026-07-06 | PENDING |                                                     |
| `feat/panel-messaging-module`                      | acc3f1027 | D     | 6/6          | 341/6        | 2026-07-06 | PENDING |                                                     |
| `feat/post-faz6-sync`                              | 144d4125a | A     | 0/0          | 338/0        | 2026-07-06 | MERGED  | ancestor of origin/main                             |
| `feat/rbac-messaging-ai-capabilities`              | 3ca2c8950 | A     | 0/0          | 420/0        | 2026-07-05 | MERGED  | ancestor of origin/main                             |
| `feat/rbac-phase7-foundation`                      | 54849f5bc | C     | 1/1          | 425/1        | 2026-07-05 | PENDING |                                                     |
| `feat/rbac-phase7b-storage`                        | 54849f5bc | C     | 1/1          | 425/1        | 2026-07-05 | PENDING |                                                     |
| `feat/registry-completeness-sweep`                 | 364d96bd3 | A     | 0/0          | 90/0         | 2026-07-12 | MERGED  | ancestor of origin/main                             |
| `feat/remediation-base2`                           | aba4826cb | A     | 0/0          | 58/0         | 2026-07-12 | MERGED  | ancestor of origin/main                             |
| `feat/sensor-nav-water-chemistry`                  | 887176fb5 | B     | 0/1          | 559/1        | 2026-07-01 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `feat/tenant-rbac-ssot`                            | eadf7b66c | D     | 6/6          | 268/8        | 2026-07-08 | PENDING |                                                     |
| `feat/vfd-cancel-changeset`                        | 1b2a01ff6 | C     | 1/1          | 635/2        | 2026-06-28 | PENDING |                                                     |
| `feat/water-chemistry-card-canvas`                 | d0a209a11 | B     | 0/1          | 558/1        | 2026-07-01 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `feature/orphan-317-nats-grants`                   | 31ddd7df7 | C     | 1/1          | 515/3        | 2026-07-02 | PENDING |                                                     |
| `fix/a5-pricing-ssot`                              | c92ca1dec | A     | 0/0          | 1/0          | 2026-07-13 | ACTIVE  | A-serisi remediation lane (dokunulmaz)              |
| `fix/a6-usage-metering-ssot`                       | f49525a91 | C     | 2/2          | 0/3          | 2026-07-13 | ACTIVE  | A-serisi remediation lane (dokunulmaz)              |
| `fix/a8-farm-worker-placeholder-pii`               | f94209313 | A     | 0/0          | 24/0         | 2026-07-13 | MERGED  | ancestor of origin/main                             |
| `fix/ai-secret-bootstrap-ordering`                 | 0ad6d03ee | B     | 0/1          | 347/1        | 2026-07-06 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/ai-service-redis-host`                        | 71f6c1f48 | C     | 3/3          | 344/5        | 2026-07-06 | PENDING |                                                     |
| `fix/alert-engine-tsconfig-test-support`           | d098db8f0 | B     | 0/1          | 510/2        | 2026-07-02 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/aquamobil-sw-graphql-passthrough-error`       | 8dd611927 | A     | 0/0          | 281/0        | 2026-07-07 | MERGED  | ancestor of origin/main                             |
| `fix/aria-auto-cycle-deps`                         | 0c9952f29 | C     | 2/2          | 533/2        | 2026-07-02 | PENDING |                                                     |
| `fix/aria-auto-cycle-restore`                      | 6ec5ac7ef | C     | 2/2          | 532/2        | 2026-07-02 | PENDING |                                                     |
| `fix/aria-burnin-clean-tree`                       | 53a4ff9a2 | C     | 2/2          | 528/2        | 2026-07-02 | PENDING |                                                     |
| `fix/aria-burnin-outdir`                           | 97bbdeeb3 | C     | 2/2          | 529/2        | 2026-07-02 | PENDING |                                                     |
| `fix/aria-burnin-toolsdir`                         | bce632e60 | C     | 2/2          | 531/2        | 2026-07-02 | PENDING |                                                     |
| `fix/aria-claude-root-skip-permissions-detectable` | 3203ea3f7 | C     | 2/2          | 597/2        | 2026-06-29 | PENDING |                                                     |
| `fix/aria-cost-attribution-zero`                   | 55f5bc1ae | C     | 2/2          | 521/2        | 2026-07-02 | PENDING |                                                     |
| `fix/aria-crossreview-dispatch-resilience`         | 445cf919c | B     | 0/1          | 482/1        | 2026-07-03 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/aria-debt-index-guard`                        | 35b6329be | C     | 2/2          | 527/2        | 2026-07-02 | PENDING |                                                     |
| `fix/aria-evidence-target-sha`                     | cfc9343b7 | B     | 0/1          | 483/1        | 2026-07-03 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/aria-finding-driven-evidence`                 | 31376d789 | B     | 0/1          | 486/1        | 2026-07-03 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/aria-memory-seed-belief-glob-evidence`        | bcbc2e3f0 | C     | 2/2          | 596/2        | 2026-06-29 | PENDING |                                                     |
| `fix/aria-opproof-pythonpath`                      | f2f9aec26 | B     | 0/1          | 540/1        | 2026-07-01 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/aria-poc-archive-migration-exclusion`         | 6a31becd5 | C     | 1/1          | 599/4        | 2026-06-29 | PENDING |                                                     |
| `fix/audit-writer-system-context`                  | 55565f1fc | B     | 0/1          | 509/1        | 2026-07-02 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/auth-verify-password-responder`               | 697d35ddd | C     | 4/4          | 331/9        | 2026-07-07 | PENDING |                                                     |
| `fix/batch-service-dead-shadow-removal`            | e546cc0f0 | C     | 1/1          | 556/2        | 2026-07-01 | PENDING |                                                     |
| `fix/biomass-ssot-tracking-farm-111`               | b1c47d682 | B     | 0/1          | 555/1        | 2026-07-01 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/boot-crashes-marine-outbox-wiring`            | c63bf11cc | B     | 0/1          | 708/1        | 2026-06-24 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/db-audit-pedagogy-registry`                   | 812f3b529 | A     | 0/0          | 62/0         | 2026-07-12 | MERGED  | ancestor of origin/main                             |
| `fix/deploy-bootsignal-window`                     | 8122ff4ee | B     | 0/1          | 563/1        | 2026-07-01 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/deploy-healthgate-rootcause`                  | 95cfcd337 | C     | 2/2          | 647/5        | 2026-06-27 | PENDING |                                                     |
| `fix/deploy-isolated-checkout`                     | a8df0c85a | B     | 0/1          | 640/1        | 2026-06-28 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/deploy-isolated-checkout-invariant-refresh`   | 3b1489f58 | B     | 0/1          | 626/1        | 2026-06-28 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/deploy-rollback-migration-boundary`           | b37632e44 | A     | 0/0          | 20/0         | 2026-07-13 | MERGED  | ancestor of origin/main                             |
| `fix/farm-broken-contracts`                        | 8c703089e | B     | 0/1          | 612/1        | 2026-06-29 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/farm-canary-masked-rejection`                 | 45aec53ed | B     | 0/1          | 581/1        | 2026-06-30 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/farm-create-enum-coercion`                    | 8afbf9d0e | B     | 0/2          | 593/2        | 2026-06-30 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/farm-equipment-read-boundary`                 | 5cedee5d5 | C     | 2/2          | 591/2        | 2026-06-30 | PENDING |                                                     |
| `fix/farm-feeding-summary-readback`                | a411b86b8 | C     | 1/1          | 572/3        | 2026-06-30 | PENDING |                                                     |
| `fix/farm-graphql-readback-contract`               | f522f0e8b | A     | 0/0          | 580/0        | 2026-06-30 | MERGED  | ancestor of origin/main                             |
| `fix/farm-growth-feeding-readback-contract`        | f522f0e8b | A     | 0/0          | 580/0        | 2026-06-30 | MERGED  | ancestor of origin/main                             |
| `fix/farm-growth-signed-performance-bands`         | 047c21746 | C     | 1/2          | 575/4        | 2026-06-30 | PENDING |                                                     |
| `fix/farm-harvest-di-tankbatch-module`             | c4f1e9d52 | C     | 1/1          | 561/2        | 2026-07-01 | PENDING |                                                     |
| `fix/farm-harvest-spec-typecheck`                  | 920909c99 | B     | 0/1          | 566/1        | 2026-07-01 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/farm-harvest-tankbatch-ssot`                  | 89fd4d609 | B     | 0/1          | 567/1        | 2026-07-01 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/farm-messaging-strict-property-init`          | 34d665691 | C     | 3/3          | 282/5        | 2026-07-07 | PENDING |                                                     |
| `fix/farm-read-boundary-farm-stock`                | 5bd876ce7 | B     | 0/1          | 612/1        | 2026-06-29 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/farm-read-boundary-fish-health`               | 6e88ba243 | B     | 0/1          | 612/1        | 2026-06-29 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/farm-read-boundary-harvest`                   | a2f093377 | B     | 0/1          | 612/1        | 2026-06-29 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/farm-read-boundary-invariant-step2`           | 219dfe9fb | A     | 0/0          | 597/0        | 2026-06-29 | MERGED  | ancestor of origin/main                             |
| `fix/farm-read-boundary-maintenance`               | cd9b02052 | C     | 3/3          | 601/4        | 2026-06-29 | PENDING |                                                     |
| `fix/farm-read-boundary-mobile-dashboard`          | 85dc92d9a | B     | 0/1          | 612/1        | 2026-06-29 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/farm-read-boundary-regulatory`                | e5f6c2e0e | B     | 0/1          | 612/1        | 2026-06-29 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/farm-read-boundary-sentinel`                  | a4e3d5454 | B     | 0/1          | 611/1        | 2026-06-29 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/farm-read-boundary-spare-part`                | 1454236db | B     | 0/1          | 612/1        | 2026-06-29 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/farm-read-boundary-stragglers`                | d1e6514a3 | B     | 0/1          | 580/1        | 2026-06-30 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/farm-read-boundary-task`                      | 9a03e763a | B     | 0/1          | 616/1        | 2026-06-29 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/farm-read-boundary-water-quality`             | 7e4e2a7eb | B     | 0/1          | 612/1        | 2026-06-29 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/farm-read-boundary-weather`                   | f06695060 | B     | 0/1          | 611/1        | 2026-06-29 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/farm-readonly-aux-reads`                      | 9312621d6 | B     | 0/1          | 588/1        | 2026-06-30 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/farm-sentinel-token-cache`                    | 7b7b72454 | C     | 1/1          | 574/2        | 2026-06-30 | PENDING |                                                     |
| `fix/farm-spec-tsc-current-quantity`               | 02a0debd3 | A     | 0/0          | 11/0         | 2026-07-13 | MERGED  | ancestor of origin/main                             |
| `fix/farm-spec-typecheck-regression`               | ed88aaa81 | B     | 0/1          | 599/1        | 2026-06-29 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/farm-stock-movement-outbox`                   | a405f22ff | C     | 2/2          | 578/4        | 2026-06-30 | PENDING |                                                     |
| `fix/farm-stock-snapshot-ssot-only`                | 5388bbef5 | C     | 1/1          | 554/3        | 2026-07-01 | PENDING |                                                     |
| `fix/farm-subequipment-category-orphan`            | 09e32d2b2 | B     | 0/1          | 655/2        | 2026-06-26 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/farm-tankbatch-currentquantity-mirror`        | 112b73d31 | B     | 0/1          | 534/1        | 2026-07-02 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/farm-tankbatch-details-backfill`              | ef914e0f6 | C     | 2/2          | 564/2        | 2026-07-01 | PENDING |                                                     |
| `fix/farm-wq-template-nondestructive`              | def90d40d | C     | 1/1          | 577/2        | 2026-06-30 | PENDING |                                                     |
| `fix/farm-write-boundary-sites-setup`              | 1ec70b19f | B     | 0/1          | 594/1        | 2026-06-30 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/feed-status-enum-default`                     | c8294af08 | B     | 0/1          | 582/1        | 2026-06-30 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/gateway-startup-budget-race`                  | 285fe505e | C     | 1/1          | 629/5        | 2026-06-28 | PENDING |                                                     |
| `fix/graphql-drift-flagged-tail`                   | 55225edbf | B     | 0/1          | 657/2        | 2026-06-26 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/graphql-fe-be-contract-validation-gate`       | 41691fdd4 | C     | 2/2          | 699/2        | 2026-06-24 | PENDING |                                                     |
| `fix/harvest-reversal-createbatch-overdraft`       | daaff08ea | B     | 0/1          | 346/1        | 2026-07-06 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/heal-behind-tenant-qualitygrade`              | 55972b357 | C     | 1/1          | 817/1        | 2026-06-19 | PENDING |                                                     |
| `fix/heal-tenant-qg`                               | 65d09a4fc | C     | 2/2          | 275/2        | 2026-07-07 | PENDING |                                                     |
| `fix/hr-competency-ratings`                        | dee38ab39 | A     | 0/0          | 47/0         | 2026-07-12 | MERGED  | ancestor of origin/main                             |
| `fix/mobile-csp-header-inheritance-sec-052`        | 866a367da | B     | 0/1          | 598/1        | 2026-06-29 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/mobile-messaging-merge`                       | a749e40ba | D     | 17/17        | 330/19       | 2026-07-07 | PENDING |                                                     |
| `fix/orphan-318-lockout-audit`                     | 380978f6d | C     | 1/1          | 514/4        | 2026-07-02 | PENDING |                                                     |
| `fix/orphan-319-client-ip`                         | 2066a9c3b | C     | 1/1          | 513/5        | 2026-07-02 | PENDING |                                                     |
| `fix/orphan-321-outbox-rls`                        | 5e3809e94 | B     | 0/1          | 516/1        | 2026-07-02 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/orphan-322-sink-subjects`                     | c52db4dff | C     | 3/3          | 512/7        | 2026-07-02 | PENDING |                                                     |
| `fix/orphan-336-tank-registry-tenantid`            | ba4cbcceb | C     | 3/3          | 332/5        | 2026-07-07 | PENDING |                                                     |
| `fix/outbox-worker-tenant-integrity-farm-high-083` | 894dee09c | C     | 1/1          | 612/1        | 2026-06-29 | PENDING |                                                     |
| `fix/public-smoke-https-redirect`                  | 631df4468 | B     | 0/1          | 642/1        | 2026-06-27 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/public-user-profile-federation`               | 86a6bd7ec | D     | 6/6          | 269/6        | 2026-07-08 | PENDING |                                                     |
| `fix/reconcile-ledger-correctness`                 | 41468e7d8 | C     | 2/2          | 527/8        | 2026-07-02 | PENDING |                                                     |
| `fix/reconcile-permission-matrix-farm-106`         | c5becdd59 | B     | 0/1          | 554/1        | 2026-07-01 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/release-verification-monitoring-swc`          | 2ea956e8e | B     | 0/1          | 646/1        | 2026-06-27 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/reopen-plat-901`                              | ff68a8e8f | B     | 0/1          | 494/1        | 2026-07-03 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/schema-drift-invariants`                      | e6a1b7f51 | C     | 1/1          | 282/1        | 2026-07-07 | PENDING |                                                     |
| `fix/schema-gate-derive-shared-count`              | 9ee86a9bc | A     | 0/0          | 0/0          | 2026-07-13 | MERGED  | ancestor of origin/main                             |
| `fix/socket-identity-release-orphan-213`           | 7fe0775e1 | C     | 1/1          | 623/1        | 2026-06-28 | PENDING |                                                     |
| `fix/stray-tenant-migration-journal`               | 805462f4c | C     | 2/2          | 0/3          | 2026-07-13 | ACTIVE  | A-serisi remediation lane (dokunulmaz)              |
| `fix/tank-count-ledger-reconcile`                  | 2e68e8589 | B     | 0/1          | 557/1        | 2026-07-01 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/tank-count-single-ssot`                       | 0bbf22a83 | B     | 0/1          | 562/1        | 2026-07-01 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/tank-count-single-writer-invariant`           | 0971b8b19 | B     | 0/1          | 559/1        | 2026-07-01 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/tenant-provisioning-schema-drift`             | 313ccde14 | C     | 1/1          | 623/1        | 2026-06-28 | PENDING |                                                     |
| `fix/tenant-schema-privilege-assertion`            | 05c6c6db0 | A     | 0/0          | 347/0        | 2026-07-06 | MERGED  | ancestor of origin/main                             |
| `fix/untracked-worktree-remediation`               | 3f02bd940 | D     | 14/14        | 518/19       | 2026-07-02 | PENDING |                                                     |
| `fix/user-email-nullable-federation`               | 7327f4888 | C     | 1/1          | 269/1        | 2026-07-07 | PENDING |                                                     |
| `fix/validation-error-logging`                     | e5e8504fa | B     | 0/1          | 583/1        | 2026-06-30 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `fix/water-temperature-bulkhead`                   | 1975c7b94 | C     | 1/1          | 345/2        | 2026-07-06 | PENDING |                                                     |
| `fix/wc-persisted-schema-crash`                    | 9f8141229 | B     | 0/1          | 427/1        | 2026-07-05 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique) |
| `integration/ai-msg-rbac-2026-07-05`               | 224ea0134 | A     | 0/0          | 398/0        | 2026-07-05 | MERGED  | ancestor of origin/main                             |
| `main`                                             | 9ee86a9bc | A     | 0/0          | 0/0          | 2026-07-13 | MERGED  | ancestor of origin/main                             |
| `refactor/aria-fallback-helper`                    | b44ec8d7c | C     | 2/2          | 492/2        | 2026-07-03 | PENDING |                                                     |
| `refactor/messaging-partition-authority-ssot`      | 848b2c770 | C     | 2/2          | 185/3        | 2026-07-11 | PENDING |                                                     |

## Origin branch'leri (92)

| Ref                                                               | SHA       | Sınıf | Unique/Total | Behind/Ahead | Son commit | Verdict | Kanıt / Aksiyon                                        |
| ----------------------------------------------------------------- | --------- | ----- | ------------ | ------------ | ---------- | ------- | ------------------------------------------------------ |
| `origin/chore/admin-api-drop-dead-tenant-role`                    | 1f2d0d991 | C     | 3/3          | 267/4        | 2026-07-08 | PENDING |                                                        |
| `origin/chore/ai-service-deploy-secret`                           | db56bd97b | B     | 0/1          | 348/1        | 2026-07-06 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique)    |
| `origin/chore/rbac-close-ceremony`                                | 80a0e5720 | B     | 0/1          | 397/1        | 2026-07-05 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique)    |
| `origin/claude/beautiful-ptolemy-8l3sip`                          | ccc828347 | C     | 3/3          | 252/3        | 2026-07-10 | PENDING |                                                        |
| `origin/claude/farm-module-integration-8owrtl`                    | 9f4413100 | C     | 1/1          | 439/1        | 2026-07-03 | PENDING |                                                        |
| `origin/claude/finance-hardening-waves`                           | e9d9b507d | D     | 38/38        | 125/40       | 2026-07-12 | PENDING | son 18h içinde commit — silme öncesi aktiflik kontrolü |
| `origin/claude/frontend-admin-panels-enterprise-ygyy5l`           | 3c7f2a4ed | D     | 20/20        | 63/20        | 2026-07-13 | PENDING | son 4h içinde commit — silme öncesi aktiflik kontrolü  |
| `origin/claude/mobile-e2e-testing-plan-6nzom7`                    | 1e0f17634 | D     | 9/9          | 63/9         | 2026-07-13 | PENDING | son 6h içinde commit — silme öncesi aktiflik kontrolü  |
| `origin/claude/mobile-messaging-review-uw1ao4`                    | 5227cc109 | D     | 17/17        | 547/17       | 2026-07-02 | PENDING |                                                        |
| `origin/claude/plc-linux-gateway-setup-ud1t3l`                    | 08d116b52 | C     | 1/1          | 439/1        | 2026-07-04 | PENDING |                                                        |
| `origin/claude/rbac-prod-deployment-8ly9zx`                       | 52fd3af42 | D     | 23/23        | 180/23       | 2026-07-12 | PENDING | son 16h içinde commit — silme öncesi aktiflik kontrolü |
| `origin/claude/sens-api-gateway-review-jecjy2`                    | fb8449d5a | D     | 29/29        | 251/29       | 2026-07-12 | PENDING | son 23h içinde commit — silme öncesi aktiflik kontrolü |
| `origin/claude/sense-sensor-module-arch-oguq01`                   | 8e643e06d | D     | 6/6          | 350/6        | 2026-07-06 | PENDING |                                                        |
| `origin/claude/sensor-vfd-device-audit-zqvycf`                    | 128cdc140 | D     | 9/9          | 425/9        | 2026-07-05 | PENDING |                                                        |
| `origin/claude/serene-allen-8mo9q1`                               | 01837a6d1 | A     | 0/0          | 170/0        | 2026-07-11 | MERGED  | ancestor of origin/main                                |
| `origin/claude/unified-sensor-system-mvxy72`                      | 86911a934 | A     | 0/0          | 126/0        | 2026-07-12 | MERGED  | ancestor of origin/main                                |
| `origin/claude/webassembly-usage-research-ls7l1j`                 | 400fbf234 | C     | 5/5          | 2/6          | 2026-07-13 | PENDING | son 3h içinde commit — silme öncesi aktiflik kontrolü  |
| `origin/dependabot/cargo/cargo-minor-patch-6c7ce3ac5f`            | 3438bb50f | C     | 1/1          | 23/1         | 2026-07-13 | PENDING | son 5h içinde commit — silme öncesi aktiflik kontrolü  |
| `origin/dependabot/github_actions/actions-minor-patch-3d63768d29` | cf3369ede | C     | 2/2          | 2/4          | 2026-07-13 | PENDING | son 3h içinde commit — silme öncesi aktiflik kontrolü  |
| `origin/feat/a1-mirror-retirement`                                | 9056f314b | A     | 0/0          | 37/0         | 2026-07-12 | MERGED  | ancestor of origin/main                                |
| `origin/feat/a3-retire-user-permissions`                          | a38338880 | A     | 0/0          | 14/0         | 2026-07-13 | MERGED  | ancestor of origin/main                                |
| `origin/feat/admin-panel-p2-contracts`                            | b268a6614 | A     | 0/0          | 64/0         | 2026-07-12 | MERGED  | ancestor of origin/main                                |
| `origin/feat/ai-conversation-turns-ledger`                        | a05577c0f | A     | 0/0          | 3/0          | 2026-07-13 | MERGED  | ancestor of origin/main                                |
| `origin/feat/ai-farm-batch-read`                                  | 4d47a528a | B     | 0/1          | 337/1        | 2026-07-07 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique)    |
| `origin/feat/ai-farm-feeding-read`                                | 4f9a3964d | B     | 0/1          | 334/1        | 2026-07-07 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique)    |
| `origin/feat/ai-farm-harvest-read`                                | 30ebc0c2b | B     | 0/1          | 335/1        | 2026-07-07 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique)    |
| `origin/feat/ai-farm-read-tools`                                  | be2b90bf4 | B     | 0/1          | 338/1        | 2026-07-06 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique)    |
| `origin/feat/ai-farm-water-quality-read`                          | 848214417 | B     | 0/1          | 336/1        | 2026-07-07 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique)    |
| `origin/feat/ai-msg-phase0-boot`                                  | 5e9b46de6 | A     | 0/0          | 423/0        | 2026-07-05 | MERGED  | ancestor of origin/main                                |
| `origin/feat/ai-msg-phase1-byok`                                  | 706dc62dc | A     | 0/0          | 422/0        | 2026-07-05 | MERGED  | ancestor of origin/main                                |
| `origin/feat/ai-msg-phase2-bridge`                                | 13b0c4d0b | A     | 0/0          | 417/0        | 2026-07-05 | MERGED  | ancestor of origin/main                                |
| `origin/feat/ai-msg-phase4-mobile`                                | 9aac07f67 | A     | 0/0          | 409/0        | 2026-07-05 | MERGED  | ancestor of origin/main                                |
| `origin/feat/ai-openai-provider`                                  | 4dc7469ff | C     | 1/1          | 340/1        | 2026-07-06 | PENDING |                                                        |
| `origin/feat/ai-openai-provider-clean`                            | a305d6b9d | C     | 2/2          | 340/2        | 2026-07-06 | PENDING |                                                        |
| `origin/feat/ai-service-deploy`                                   | 74e4aa4c3 | D     | 11/11        | 349/13       | 2026-07-06 | PENDING |                                                        |
| `origin/feat/ai-service-deploy-chain`                             | 72846b946 | B     | 0/1          | 396/1        | 2026-07-06 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique)    |
| `origin/feat/ai-task-create-tool`                                 | ee778f1ac | B     | 0/1          | 339/1        | 2026-07-06 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique)    |
| `origin/feat/aria-autonomous-mode`                                | ca4ac02cb | C     | 1/1          | 185/1        | 2026-07-11 | PENDING |                                                        |
| `origin/feat/aria-credit-fallback`                                | 78f808ea8 | C     | 2/2          | 499/3        | 2026-07-03 | PENDING |                                                        |
| `origin/feat/auth-tenants-ownership`                              | 7ccb942b1 | A     | 0/0          | 52/0         | 2026-07-12 | MERGED  | ancestor of origin/main                                |
| `origin/feat/combine-batch-visibility`                            | 35bf9387a | B     | 0/1          | 429/1        | 2026-07-05 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique)    |
| `origin/feat/config-service-wire`                                 | b1eef3aff | A     | 0/0          | 28/0         | 2026-07-12 | MERGED  | ancestor of origin/main                                |
| `origin/feat/crypto-shred-step2`                                  | 9d4992194 | A     | 0/0          | 79/0         | 2026-07-12 | MERGED  | ancestor of origin/main                                |
| `origin/feat/daily-plan-protocol-ssot`                            | a42551d6e | B     | 0/1          | 431/1        | 2026-07-04 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique)    |
| `origin/feat/db-audit-lane`                                       | 71230c85c | A     | 0/0          | 93/0         | 2026-07-12 | MERGED  | ancestor of origin/main                                |
| `origin/feat/farm-documents-drop`                                 | f784b97a5 | A     | 0/0          | 72/0         | 2026-07-12 | MERGED  | ancestor of origin/main                                |
| `origin/feat/feed-dual-ssot-phase2`                               | 42dfd682d | D     | 9/9          | 928/9        | 2026-07-11 | PENDING |                                                        |
| `origin/feat/feeding-growth-mode`                                 | 6b2cce2e7 | B     | 0/1          | 428/1        | 2026-07-05 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique)    |
| `origin/feat/legacy-config-store-drop`                            | e8f43e1c7 | A     | 0/0          | 85/0         | 2026-07-12 | MERGED  | ancestor of origin/main                                |
| `origin/feat/panel-ai-assistant-drawer`                           | 14dc0c201 | B     | 0/1          | 342/1        | 2026-07-06 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique)    |
| `origin/feat/panel-ai-settings`                                   | d0fd92c4a | C     | 2/2          | 343/2        | 2026-07-06 | PENDING |                                                        |
| `origin/feat/panel-messaging-module`                              | acc3f1027 | D     | 6/6          | 341/6        | 2026-07-06 | PENDING |                                                        |
| `origin/feat/protocol-batch-feeding-ssot-v2`                      | 4b5be91f7 | B     | 0/1          | 434/1        | 2026-07-04 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique)    |
| `origin/feat/rbac-messaging-ai-capabilities`                      | 3ca2c8950 | A     | 0/0          | 420/0        | 2026-07-05 | MERGED  | ancestor of origin/main                                |
| `origin/feat/rbac-phase7-foundation`                              | 54849f5bc | C     | 1/1          | 425/1        | 2026-07-05 | PENDING |                                                        |
| `origin/feat/registry-completeness-sweep`                         | 364d96bd3 | A     | 0/0          | 90/0         | 2026-07-12 | MERGED  | ancestor of origin/main                                |
| `origin/feat/remediation-base2`                                   | aba4826cb | A     | 0/0          | 58/0         | 2026-07-12 | MERGED  | ancestor of origin/main                                |
| `origin/feat/sensor-water-temperature`                            | aa711345f | C     | 2/2          | 432/2        | 2026-07-04 | PENDING |                                                        |
| `origin/feat/tenant-rbac-ssot`                                    | eadf7b66c | D     | 6/6          | 268/8        | 2026-07-08 | PENDING |                                                        |
| `origin/feat/water-temperature-feed-rate`                         | 9174775dc | B     | 0/1          | 433/1        | 2026-07-04 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique)    |
| `origin/feature/finance-ci-live`                                  | f35b0dcec | C     | 1/1          | 342/1        | 2026-07-06 | PENDING |                                                        |
| `origin/feature/finance-ci-live-2`                                | b7885ac03 | C     | 1/1          | 341/1        | 2026-07-07 | PENDING |                                                        |
| `origin/feature/finance-tabs-ci`                                  | 1d8973cad | A     | 0/0          | 343/0        | 2026-07-06 | MERGED  | ancestor of origin/main                                |
| `origin/fix/a5-pricing-ssot`                                      | c92ca1dec | A     | 0/0          | 1/0          | 2026-07-13 | ACTIVE  | A-serisi remediation lane (dokunulmaz)                 |
| `origin/fix/a6-usage-metering-ssot`                               | f49525a91 | C     | 2/2          | 0/3          | 2026-07-13 | ACTIVE  | A-serisi remediation lane (dokunulmaz)                 |
| `origin/fix/a8-farm-worker-placeholder-pii`                       | f94209313 | A     | 0/0          | 24/0         | 2026-07-13 | MERGED  | ancestor of origin/main                                |
| `origin/fix/ai-secret-bootstrap-ordering`                         | 0ad6d03ee | B     | 0/1          | 347/1        | 2026-07-06 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique)    |
| `origin/fix/ai-service-redis-host`                                | 71f6c1f48 | C     | 3/3          | 344/5        | 2026-07-06 | PENDING |                                                        |
| `origin/fix/aquamobil-sw-graphql-passthrough-error`               | 8dd611927 | A     | 0/0          | 281/0        | 2026-07-07 | MERGED  | ancestor of origin/main                                |
| `origin/fix/aria-crossreview-dispatch-resilience`                 | 445cf919c | B     | 0/1          | 482/1        | 2026-07-03 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique)    |
| `origin/fix/aria-evidence-target-sha`                             | cfc9343b7 | B     | 0/1          | 483/1        | 2026-07-03 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique)    |
| `origin/fix/aria-finding-driven-evidence`                         | bbf21ae76 | B     | 0/1          | 484/2        | 2026-07-03 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique)    |
| `origin/fix/db-audit-pedagogy-registry`                           | 812f3b529 | A     | 0/0          | 62/0         | 2026-07-12 | MERGED  | ancestor of origin/main                                |
| `origin/fix/deploy-rollback-migration-boundary`                   | b37632e44 | A     | 0/0          | 20/0         | 2026-07-13 | MERGED  | ancestor of origin/main                                |
| `origin/fix/farm-spec-tsc-current-quantity`                       | 02a0debd3 | A     | 0/0          | 11/0         | 2026-07-13 | MERGED  | ancestor of origin/main                                |
| `origin/fix/feeding-tab-swap`                                     | 24c1350b3 | B     | 0/1          | 430/1        | 2026-07-04 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique)    |
| `origin/fix/harvest-reversal-createbatch-overdraft`               | daaff08ea | B     | 0/1          | 346/1        | 2026-07-06 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique)    |
| `origin/fix/heal-tenant-qg`                                       | 1387cd5b0 | C     | 2/2          | 270/3        | 2026-07-08 | PENDING |                                                        |
| `origin/fix/hr-competency-ratings`                                | dee38ab39 | A     | 0/0          | 47/0         | 2026-07-12 | MERGED  | ancestor of origin/main                                |
| `origin/fix/mobile-messaging-merge`                               | a749e40ba | D     | 17/17        | 330/19       | 2026-07-07 | PENDING |                                                        |
| `origin/fix/public-user-profile-federation`                       | 86a6bd7ec | D     | 6/6          | 269/6        | 2026-07-08 | PENDING |                                                        |
| `origin/fix/reopen-plat-901`                                      | ff68a8e8f | B     | 0/1          | 494/1        | 2026-07-03 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique)    |
| `origin/fix/schema-drift-invariants`                              | 9c17d1f8a | C     | 2/2          | 279/4        | 2026-07-07 | PENDING |                                                        |
| `origin/fix/schema-gate-derive-shared-count`                      | 282bc59ca | C     | 1/1          | 0/1          | 2026-07-13 | PENDING | son 0h içinde commit — silme öncesi aktiflik kontrolü  |
| `origin/fix/stray-tenant-migration-journal`                       | 805462f4c | C     | 2/2          | 0/3          | 2026-07-13 | ACTIVE  | A-serisi remediation lane (dokunulmaz)                 |
| `origin/fix/tenant-schema-privilege-ssot`                         | 9ac7818c2 | A     | 0/0          | 181/0        | 2026-07-11 | MERGED  | ancestor of origin/main                                |
| `origin/fix/user-email-nullable-federation`                       | 7327f4888 | C     | 1/1          | 269/1        | 2026-07-07 | PENDING |                                                        |
| `origin/fix/water-temperature-bulkhead`                           | 1975c7b94 | C     | 1/1          | 345/2        | 2026-07-06 | PENDING |                                                        |
| `origin/fix/wc-persisted-schema-crash`                            | 9f8141229 | B     | 0/1          | 427/1        | 2026-07-05 | MERGED  | tüm patch'ler main'de eşdeğer (git cherry 0 unique)    |
| `origin/integration/ai-msg-rbac-2026-07-05`                       | 224ea0134 | A     | 0/0          | 398/0        | 2026-07-05 | MERGED  | ancestor of origin/main                                |
| `origin/refactor/aria-fallback-helper`                            | 68e47c6cc | C     | 2/2          | 491/3        | 2026-07-03 | PENDING |                                                        |
| `origin/refactor/messaging-partition-authority-ssot`              | 848b2c770 | C     | 2/2          | 185/3        | 2026-07-11 | PENDING |                                                        |

## Worktree'ler

```
/var/aqua-saas                                                                                     282bc59ca [fix/schema-gate-derive-shared-count]
/tmp/aqua-324                                                                                      ba05aaf45 (detached HEAD)
/tmp/aria-demo-ws                                                                                  4750479d5 (detached HEAD)
/tmp/aria-ops                                                                                      ca4ac02cb [feat/aria-autonomous-mode]
/tmp/claude-0/-var-aqua-saas/312952bb-2853-46ab-bd18-e16fbffaabed/scratchpad/wt-deploybootstrap    3b1489f58 [fix/deploy-isolated-checkout-invariant-refresh]
/tmp/claude-0/-var-aqua-saas/312952bb-2853-46ab-bd18-e16fbffaabed/scratchpad/wt-deploydir          a8df0c85a [fix/deploy-isolated-checkout]
/tmp/claude-0/-var-aqua-saas/312952bb-2853-46ab-bd18-e16fbffaabed/scratchpad/wt-deployfix          95cfcd337 [fix/deploy-healthgate-rootcause]
/tmp/claude-0/-var-aqua-saas/312952bb-2853-46ab-bd18-e16fbffaabed/scratchpad/wt-drift-final        cc540233f [feat/graphql-drift-burndown-final]
/tmp/claude-0/-var-aqua-saas/312952bb-2853-46ab-bd18-e16fbffaabed/scratchpad/wt-flagged            55225edbf [fix/graphql-drift-flagged-tail]
/tmp/claude-0/-var-aqua-saas/312952bb-2853-46ab-bd18-e16fbffaabed/scratchpad/wt-gwbudget           285fe505e [fix/gateway-startup-budget-race]
/tmp/claude-0/-var-aqua-saas/312952bb-2853-46ab-bd18-e16fbffaabed/scratchpad/wt-leaveadmin         6d22465f4 [feat/hr-leave-admin-backend]
/tmp/claude-0/-var-aqua-saas/312952bb-2853-46ab-bd18-e16fbffaabed/scratchpad/wt-orphan             09e32d2b2 [fix/farm-subequipment-category-orphan]
/tmp/claude-0/-var-aqua-saas/312952bb-2853-46ab-bd18-e16fbffaabed/scratchpad/wt-relverify          2ea956e8e [fix/release-verification-monitoring-swc]
/tmp/claude-0/-var-aqua-saas/312952bb-2853-46ab-bd18-e16fbffaabed/scratchpad/wt-smoke              631df4468 [fix/public-smoke-https-redirect]
/tmp/claude-0/-var-aqua-saas/312952bb-2853-46ab-bd18-e16fbffaabed/scratchpad/wt-vfdcancel          1b2a01ff6 [feat/vfd-cancel-changeset]
/tmp/claude-0/-var-aqua-saas/3e5dfe28-9b1d-4ded-affc-5ae8688bc259/scratchpad/wt-audit-009          041758e7e [feat/auth-security-primitive-specs-audit-009]
/tmp/claude-0/-var-aqua-saas/3e5dfe28-9b1d-4ded-affc-5ae8688bc259/scratchpad/wt-csp-052            866a367da [fix/mobile-csp-header-inheritance-sec-052]
/tmp/claude-0/-var-aqua-saas/3e5dfe28-9b1d-4ded-affc-5ae8688bc259/scratchpad/wt-fmtscope-117       05bfa9f1d [chore/format-scope-regen-orphan-117]
/tmp/claude-0/-var-aqua-saas/3e5dfe28-9b1d-4ded-affc-5ae8688bc259/scratchpad/wt-outbox-083         894dee09c [fix/outbox-worker-tenant-integrity-farm-high-083]
/tmp/claude-0/-var-aqua-saas/3e5dfe28-9b1d-4ded-affc-5ae8688bc259/scratchpad/wt-perf-003           0f4c625b8 [feat/auth-token-validation-p99-slo-perf-003]
/tmp/claude-0/-var-aqua-saas/3e5dfe28-9b1d-4ded-affc-5ae8688bc259/scratchpad/wt-registry-closeout  969026a56 [chore/registry-closeout-schema-drift]
/tmp/claude-0/-var-aqua-saas/3e5dfe28-9b1d-4ded-affc-5ae8688bc259/scratchpad/wt-restclient-091     4532513d0 [feat/farm-module-shared-rest-client-farm-091]
/tmp/claude-0/-var-aqua-saas/3e5dfe28-9b1d-4ded-affc-5ae8688bc259/scratchpad/wt-socket-213         7fe0775e1 [fix/socket-identity-release-orphan-213]
/tmp/claude-0/-var-aqua-saas/78de149b-5d8c-440e-995f-f6f78d8c7057/scratchpad/wt-847                e3e728359 [dep-847-local]
/tmp/claude-0/-var-aqua-saas/78de149b-5d8c-440e-995f-f6f78d8c7057/scratchpad/wt-889                9256fdc85 [dep-889-local]
/tmp/claude-0/-var-aqua-saas/78de149b-5d8c-440e-995f-f6f78d8c7057/scratchpad/wt-934                235fe271d (detached HEAD)
/tmp/claude-0/-var-aqua-saas/78de149b-5d8c-440e-995f-f6f78d8c7057/scratchpad/wt-935                2856b241d (detached HEAD)
/tmp/claude-0/-var-aqua-saas/78de149b-5d8c-440e-995f-f6f78d8c7057/scratchpad/wt-feedp2             42dfd682d [feat/feed-dual-ssot-phase2]
/tmp/claude-0/-var-aqua-saas/78de149b-5d8c-440e-995f-f6f78d8c7057/scratchpad/wt-msgssot            848b2c770 [refactor/messaging-partition-authority-ssot]
/tmp/claude-0/-var-aqua-saas/805b9600-2a7f-431e-a08c-7f0817b33491/scratchpad/wt-triage             9ee86a9bc [chore/branch-triage-2026-07-13]
/tmp/claude-0/-var-aqua-saas/eb5005f2-68d1-4f9d-8ab2-947716b96c3c/scratchpad/email-wt              7327f4888 [fix/user-email-nullable-federation]
/tmp/claude-0/-var-aqua-saas/eb5005f2-68d1-4f9d-8ab2-947716b96c3c/scratchpad/heal-wt               65d09a4fc [fix/heal-tenant-qg]
/tmp/claude-0/-var-aqua-saas/ed662991-9da9-4d47-bef8-394d22a60892/scratchpad/wt-rbac               1f2d0d991 [chore/admin-api-drop-dead-tenant-role]
/var/aqua-saas/.claude/worktrees/agent-a53d0b206fe3eb8f3                                           f49525a91 [fix/a6-usage-metering-ssot]
/var/aqua-saas/.claude/worktrees/agent-a9d2a427c75987522                                           805462f4c [fix/stray-tenant-migration-journal]
/var/aqua-saas/.claude/worktrees/agent-ad56c11dd1cfe1742                                           c92ca1dec [fix/a5-pricing-ssot]
/var/lib/aqua/deploy/checkout                                                                      9ee86a9bc (detached HEAD)
```

Dokunulmaz: `/var/lib/aqua/deploy/checkout`, kilitli `.claude/worktrees/agent-*`, ana checkout.

---

## Faz 1 yürütme kaydı — 2026-07-13

- **106 lokal branch silindi** (Sınıf A+B; her biri silme anında ancestor/`git cherry` 0-unique testiyle YENİDEN doğrulandı; SHA'lar yukarıdaki tabloda). 0 hata.
- **51 origin branch silindi** (origin ref'in KENDİSİ A/B testinden geçti; açık PR head'leri ve aktif lane hariç tutuldu). 0 hata.
- **10 ölü worktree kaldırıldı** (312952bb ve 3e5dfe28 oturum scratchpad'leri; hepsi kaldırma öncesi `git status --porcelain` ile TEMİZ doğrulandı — commit'lenmemiş iş yoktu): wt-deploybootstrap, wt-deploydir, wt-flagged, wt-leaveadmin, wt-orphan, wt-relverify, wt-smoke, wt-csp-052, wt-fmtscope-117, wt-restclient-091.
- Lokal `main` origin/main'e fast-forward edildi.
- Bulgu: origin feeding hattı (`protocol-batch-feeding-ssot-v2`, `daily-plan-protocol-ssot`, `feeding-growth-mode`, `water-temperature-feed-rate`, `feeding-tab-swap`, `combine-batch-visibility`) **B çıktı** — içerik main'de zaten mevcut; Faz 2 tema-7 kapsamı daraldı.
- Skip edilenler (aktif lane, dokunulmadı): `fix/a5-pricing-ssot` (PR #963 bu sabah merge oldu), `fix/a6-usage-metering-ssot`, `fix/stray-tenant-migration-journal`, `fix/schema-gate-derive-shared-count` (yeni açık PR), kilitli `.claude/worktrees/agent-*`.
- Kalan: 100 lokal branch (C/D + aktif lane), 42 origin branch'i.

---

## Faz 2 + Faz 3 yürütme kaydı — 2026-07-13

İnceleme: 6 paralel read-only ajan (tema: ARIA/farm/AI-service/orphan+auth/deploy-CI/tekil) + Sınıf-D 9 gövdenin lead tarafından birinci elden derin denetimi. Her VALUABLE/WORTHLESS ve kritik SUPERSEDED verdikti lead tarafından ayrıca doğrulandı (dosya-bazlı `git diff <branch> origin/main -- <path>` birebir kıyas yöntemi).

### Verdict özeti

- **SUPERSEDED (silindi): 85 lokal + 21 origin ikizi/teki.** Ana kanıt sınıfları: (a) merge edilmiş PR'ların stale ikizleri (ARIA 33/33 — ORPHAN ID'leri main kod yorumlarında birebir; farm 17/17; orphan/auth 9; deploy-CI 10; AI 4); (b) squash-merge nedeniyle patch-id kaymışlar (`fix/untracked-worktree-remediation` → PR #830; `fix/mobile-messaging-merge` → 40/49 dosya bayt-aynı); (c) 13-PR bölünmesinin ana gövdesi (`claude/farm-ssot-diagnostics-arch-x5457y` → backend yüzeyi bayt-aynı, FE semantiği main'de).
- **WORTHLESS (silindi): 5** — `fix/user-email-nullable-federation` (bilinçli reddedilen nullable yaklaşımı; #930 PublicUserProfile split kazandı), `chore/eslint-aquamobil` (718 commit bayat mekanik fix; sinyal ORPHAN-MEDIUM-112'de OPEN duruyor), `chore/registry-closeout-schema-drift` (registry churn), `feature/finance-ci-live{,-2}` (kendinden "[throwaway] Not for merge" etiketli).
- **VALUABLE (tutuldu): 3**
  - `feat/feed-dual-ssot-phase2` — **ARŞİV, MERGE ETME.** ORPHAN-HIGH-114 Phase-B feed-ledger convergence'ının kayıpsız arşivi (stash `phase2-feed-dual-BLOCKED-data-loss`). Migration bilinçli GÜVENSİZ: 5 ön-koşul defekti + migration-timestamp çakışması kayıtlı (db-audit synthesis §77). Origin ikizi de duruyor.
  - `feat/auth-security-primitive-specs-audit-009` — 446 satır test-only spec (jwt-auth.guard, webauthn.service, entity-schema-routing) main'de YOK; taze branch'e port + PR planlandı (bu program içinde).
  - `dep-847-local` — Faz-4 girdisi: dependabot #847 bump'ı + codeql v3→v4 pin-etiket düzeltmesi (dependabot'un yanlış bıraktığı `# v3.28.1` yorumu). #847 merge edilirken bu düzeltme birlikte taşınmalı.
- **Aktif lane (dokunulmadı):** `fix/a5-pricing-ssot` (PR #963 merge oldu), `fix/a6-usage-metering-ssot`, `fix/stray-tenant-migration-journal`, `fix/schema-gate-derive-shared-count`, kilitli agent worktree'leri.
- **PR head'leri (Faz 4'e):** `refactor/messaging-partition-authority-ssot` (#938), `feat/aria-autonomous-mode` (#936), 12 `claude/*` head'i, 2 dependabot.

### Düzeltilen ajan tespiti (lead doğrulaması)

- Orphan+auth ajanı `fix/untracked-worktree-remediation`'ın aquamobil-322 fix'lerini "unmerged" saymıştı; birinci elden kontrol PR #830 squash-merge'ünü buldu (asyncAction helper + 10 unhandled-rejection fix'i main'de; 4 fark dosyasının tümü main'in daha yeni evrimi). Verdict SUPERSEDED olarak düzeltildi.

### Faz 3 gövde kararları (9/9)

| Gövde                                      | Verdict        | Kanıt                                                                                                                     |
| ------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `feat/ai-service-deploy` (11p)             | SUPERSEDED     | main `141c73ff0` konsolide aktivasyon; silmeler + `DropTenantAiSettings` + runbook "complete on main"                     |
| `feat/feed-dual-ssot-phase2` (9p)          | VALUABLE-ARŞİV | ORPHAN-HIGH-114 Phase-B taşıyıcısı; 8/9 commit'in hardening içeriği main'de (#476/#524 hattı + `buildRegulatoryIdentity`) |
| `fix/untracked-worktree-remediation` (14p) | SUPERSEDED     | PR #830 squash `8d1b342ed`                                                                                                |
| `fix/mobile-messaging-merge` (17p)         | SUPERSEDED     | 40/49 bayt-aynı; farklar main'in FARM-HIGH-214 + #930 evrimi                                                              |
| `claude/farm-ssot-diagnostics-arch` (33p)  | SUPERSEDED     | 13-PR bölünmesi; backend bayt-aynı; TanksPage stale-on-error main'de                                                      |
| `feat/panel-messaging-module` (6p)         | SUPERSEDED     | messaging-module dizini + shell remote kaydı + service-catalog main'de                                                    |
| `fix/public-user-profile-federation` (6p)  | SUPERSEDED     | PR #930; `publicUserProfile` query main'de                                                                                |
| `feat/tenant-rbac-ssot` (6p)               | SUPERSEDED     | 2 güvenlik commit'inin tüm dosyaları bayt-aynı; sidebar linki main'de daha yeni haliyle                                   |
| `fix/auth-verify-password-responder` (4p)  | SUPERSEDED     | PR #911; `auth-credential-nats.handler.ts` main'de                                                                        |

### Worktree temizliği (Faz 2/3 kapsamında)

14 ölü worktree daha kaldırıldı (hepsi kaldırma öncesi `git status --porcelain` TEMİZ): wt-889, email-wt, heal-wt, wt-rbac, wt-934, wt-935, wt-deployfix, wt-drift-final, wt-gwbudget, wt-vfdcancel, wt-outbox-083, wt-perf-003, wt-registry-closeout, wt-socket-213.

### Durum: lokal 206→11, origin 92→22, worktree 37→13.

---

## Faz 4 yürütme kaydı — 2026-07-13 (M1 oturumu dilimi)

### Tamamlanan

- **#847 dependabot actions** → MERGED (2026-07-13T10:02Z). 6 action pin'inin SHA'sı gh api ile tag-tag doğrulandı; branch'in güncel head'i codeql v3→v4 pin-etiket düzeltmesini zaten taşıyordu → `dep-847-local` gereksizleşti (silinecek — worktree'si 78de149b oturumunda).
- **#938 messaging-partition SSoT** → CLOSED (kanıtlı): kod içeriği #920 ile bayt-aynı main'de; kalan tek delta (ORPHAN-HIGH-338 kaydı) NNN çakışması nedeniyle **ORPHAN-HIGH-388** olarak yeniden numaralanıp bu PR'a (#967) taşındı. Origin branch silindi; lokal branch + wt-msgssot worktree'si 78de149b oturumu hâlâ aktif olabileceği için (index mtime 2026-07-13 04:55) DOKUNULMADI → Faz 5 devir notu.
- **#968 audit-009 auth spec'leri** (bu programın salvage PR'ı): format-scope repin sonrası CI yeşil; merge-train'de sırada.
- **#969 alert-engine suite realignment** (bu programın salvage PR'ı): #863'ün spec-only commit'i porta alındı — main'de 10 suite/102 test kırmızıydı (canlı doğrulandı), port sonrası 24/24-757/757 yeşil (4 koşu). FARM-HIGH-124 Closes taşıyor. Merge olunca #863 kapatılabilir.
- **#808 mobile-messaging review**: 3 review-of-record dokümanı bu PR'a kurtarıldı; kod içeriği main'de (34/49 bayt-aynı, kalanlar main-ileri). KAPANIŞ ADAYI (kullanıcı onayı bekliyor).

### Verdict verilen, sonraki oturuma sıralanan

- **#936 aria-autonomous-mode** — INCOMPLETE-VALUABLE: gerçek iş (operator-gated Stage D; ADR-041 narrow-lane ile tutarlı, autonomous-merge ihlali yok). 185 geride; tazeleme + ARIA seremonisi (authority-hash regen, registry three-store) ayrı dilim ister.
- **#934 finance-hardening-waves** — INCOMPLETE-VALUABLE: 142 dosya +4104 satır gerçek iş; kendi oturumunu hak ediyor. (İlişkili: beautiful-ptolemy içeriği #933 ile inmişti, silindi.)
- **#871 RBAC adoption master plan** — doc-only 773 satır, main'de yok; açık kalması maliyetsiz. Sonraki oturumda RBAC-SSoT-sonrası güncelliği okunarak karar.
- **#940 / #935 / #900 / #886** — dün/önceki güncellenmiş büyük DRAFT denetim hatları; sıralı derin denetim sonraki oturumlarda (plan M3-M4).
- **#961 WASM / #962 admin-panels / #952 mobile-E2E** — BUGÜN güncellenmiş → muhtemelen canlı oturumların işi; ACTIVE çiti uygulanır, dokunulmaz.
- **#959 dependabot cargo** — SHA'sız sürüm bump'ı; train'de #847 sonrası güncellendi, CI bekleniyor.

---

## M1 oturum kapanışı — 2026-07-13

**Merge edilen (sequential merge-train, her biri CI-yeşil + lokal doğrulama):**

- #847 dependabot actions (6 SHA gh-api-doğrulandı) — 10:02Z
- #959 dependabot cargo
- #968 `test(auth)` audit-009 güvenlik spec'leri (20/20 yeşil, salvage)
- #969 `test(alert-engine)` suite realignment — main'in 102 kırmızı testi yeşile döndü (FARM-HIGH-124 Closes; salvage, kaynak #863)

**Kapatılan:** #938 (kanıt: kod #920'de bayt-aynı; kayıt ORPHAN-HIGH-388 olarak bu PR'da).

**Kapanış adayı (kullanıcı onayı bekliyor):** #808 (kod main'de; 3 review dokümanı bu PR'a kurtarıldı), #863 (tek commit'i #969 ile porta alınıp merge edildi).

**Son worktree tablosu:** ana checkout + deploy checkout + `aria-demo-ws` (KİRLİ — ARIA deney dosyaları, kullanıcıya bırakıldı) + `aria-ops` (#936 head) + 78de149b oturumunun 3 worktree'si (wt-847/wt-feedp2/wt-msgssot — oturum canlı olabilir, dokunulmadı) + bu programın wt-triage'ı. `aqua-324` kaldırıldı (HEAD ba05aaf45, #891 MERGED, temizdi).

**Kalan lokal branch'ler (8):** main, triage, aktif lane ×4 (a5/a6/stray/schema-gate — a5+a6+schema-gate merge oldu, lane bitince silinebilir), feed-dual-ssot-phase2 (ARŞİV), dep-847-local + refactor/messaging-partition (78de149b worktree'leri serbest kalınca silinecek), aria-autonomous-mode lokali yok (origin'de #936 head).

**Sonraki oturum kuyruğu (öncelik sırası):** (1) #900 sensor spec-realign portu — #863/#969 deseninin aynısı, güçlü aday; (2) #936 aria-autonomous tazeleme + ARIA seremonisi; (3) #934 finance-waves derin denetim (kendi oturumu); (4) #886 kalan 14 dosya artık-değer; (5) #940/#935/#871; (6) 78de149b lane bitince worktree/branch süpürmesi.
