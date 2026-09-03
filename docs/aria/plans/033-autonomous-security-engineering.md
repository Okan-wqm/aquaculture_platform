<!-- ARIA-HISTORICAL: Historical plan document.
Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# ARIA Plan 033 — Autonomous Security Engineering

> **Status:** Faz 033a–c delivered (PR #1410, merged 2026-09-03); Faz 033d–f delivered on PR #1411
> (2026-09-03); Faz 033g–i coded on `feat/aria-033-3-reproduction-readiness` (stacked on 033-2).
> Every phase's `I-V13-*` invariants were RUN and are green (56 tests). Active-lab execution
> (Docker lab, ZAP, real grants) is operator infrastructure — the kernel contracts fail closed
> until the operator supplies what only the operator can (see "Operator steps").
> **Branches:** `feat/aria-033-1-security-foundations`, `feat/aria-033-2-lab-grant-proxy`,
> `feat/aria-033-3-reproduction-readiness`. One-way doors 18–26.

## Summary

Bu plan, 1000+ çiftliğe hizmet edecek Aqua-SaaS için ARIA'nın **kendi çekirdeğinde** pasif güvenlik
analizi, izole aktif saldırı doğrulaması, otomatik düzeltme akışı ve kalıcı regresyon üretmesini
sağlar. Yetenek tamamen `aria_kernel/security/` altındadır; silinebilir Lane-B güvenlik ajanları
(`security-reviewer`, `auth-security-expert`) yalnız semantik parity kanıtı + operatör onayından
sonra arşivlenir; `database-reviewer` KALIR.

**Dürüst başarı tanımı:** "hiç açık yok" iddiası ÜRETİLMEZ — hiçbir sistem sıfır-açık ispatı
veremez. Başarı = tanımlı profil + pack sürümündeki tüm uygulanabilir kontroller taze kanıtla koştu;
zorunlu kapsamda `NOT_TESTED | INCONCLUSIVE | STALE | HUMAN_REQUIRED` kalmadı; açık doğrulanmış
CRITICAL/HIGH yok; güvenli sonuç yalnız `NO_VIOLATION_OBSERVED` (grant içinde); production / veri /
OT sınırı ihlali ve cleanup kaybı = 0.

Makineyle doğrulanan başlangıç sınırları (2026-09-03):

- `finding.py` SEVERITIES'de CRITICAL yoktu → 033a ekledi (kayıpsız, en üst rank).
- `merge_authority.py` tek merge yolu (AST-yasak) → ikinci merge executor'ı yok; 033 PR + kanıt
üretir, merge insan kararı.
- `wrap_bash_in_sandbox(allow_network=True)` host ağını paylaşır → aktif izolasyon için kullanılmaz;
policy proxy tek egress.
- `judge_fanout` metni yorumlar, exploit'i yeniden koşmaz → bağımsız doğrulama = iki executor + iki
temiz lab.
- Aqua yüzeyi NestJS REST + Apollo federation + Rust edge + React; Django YOK; tenant izolasyonu
hibrit (schema-per-tenant + ALS/GUC + RLS defense-in-depth + meşru istisnalar).
- Scanner gerçeği: Trivy → Code Scanning SARIF, Gitleaks → Actions artifact; Snyk/CodeQL/Semgrep/ZAP
kurulu değil → `not_configured` (asla temiz sayılmaz).

## İlkeler (her fazda)

- Kapalı sözlükler: RiskClass R0..R4, ProofClass, ProbeVerdict, AssuranceStatus,
  campaign/remediation
state'leri — hepsi tuple, hiçbiri env/issue/LLM metniyle genişlemez.
- Her yeni ledger `state_manifest.StateSurface` ile declared; yazıcı `append_declared_jsonl`.
- Ham güvenlik kanıtı Git'e, `aria/state`'e veya public artifact'e YAZILMAZ; ledger yalnız
metadata + digest + redakte önizleme + ref.
- LLM'e network bash yok; typed recipe + policy proxy + pinned-digest ZAP.
- Sahte-yeşil yok: pack çalışmaması, harness hatası, bayat kanıt, truncation → asla temiz sonuç.
- Operatörün vereceği şeyi ARIA icat etmez (CIDR, ZAP digest, imza anahtarı, KEK, lab provisioner);
eksikse fail-closed.

## Faz 033a — Önkoşul kapısı, CRITICAL severity, Security Profile (delivered, #1410)

`security prerequisites` 032 kabiliyetlerini (29 sembol) makineyle doğrular, eksikse exit 3.
`security/profile.py` deterministik, content-addressed, provenance'lı (`OBSERVED | INFERRED |
OPERATOR_ASSERTED`) profil; NestJS/Apollo/TypeORM/Rust/React tespiti, Django yokluğu, hibrit
izolasyon çıkarımı; hiçbir yetki içermez. Test: I-V13-SEV-01..02, -PREREQ-01..04, -PROFILE-01..05.

## Faz 033b — Pasif pack'ler + SARIF ingest (delivered, #1410)

`packs.PACK_NAMES = (api, multi_tenant)`; native kurallar `rls_coverage` (tenant_id tablosu + policy
yok; sabit istisna listesi) ve `public_write_guard` (NestJS write endpoint + guard yok). Lead'ler
`external_scanner` lane'ine UNVERIFIED gider. SARIF 2.1.0 parser güvensiz girdi varsayar
(path-traversal/scheme URI düşer, malformed karantina). Test: I-V13-PACK-01..05, -SARIF-01..04. 033i
corpus'u `rls_coverage` predicate'inde gerçek bir açık buldu (RLS yoksa denetçi koşmuyordu) →
düzeltildi (033-3).

## Faz 033c — Attack Graph + Assurance Ledger (delivered, #1410)

Versiyonlu content-addressed graph (kapalı node/edge türleri, OBSERVED/INFERRED kenar, staleness
horizon); assurance coverage uygulanabilir (asset, control) kümesine katlanır, bayat-temiz →
unknown, açık vuln → asla ready. Test: I-V13-GRAPH-01..02, -STALE-01, -ASSURE-01..02.

## Faz 033d — Scope policy, efemeral lab, persona broker (delivered, #1411)

`scope_policy` (R0..R4, ceilings, production deny inventory → eksikse otomatik risk R0;
`classify_target` production/metadata/loopback/public/lab-dışı/rebinding → R4), `lab` (sha256 pinned
image, ≥2 sentetik tenant, yalnız `TRUSTED_PROVISIONERS` lease yazar, register-target CLI YOK,
overlap reddi, teardown receipt), `persona` (secret ledger'a girmez, leak tripwire, campaign bazlı
revoke). Test: I-V13-SCOPE-01..02, -LAB-01..02, -TEARDOWN-01, -PERSONA-01.

## Faz 033e — CampaignGrant, Evidence Vault, campaign lifecycle (delivered, #1411)

`grant` compact JWS `alg=EdDSA` (başka alg/typ, bozuk imza, süre dışı, digest uyuşmazlığı, R4,
onaysız R3 → sıfır paket; anahtar workspace dışı 0600; JTI campaign_run_id başına tek kullanım),
`vault` (AES-256-GCM, per-campaign DEK, KEK FD'den, 0700/0600, redakte önizleme, truncation bayrağı,
write-once seal, purge receipt), `campaign` (sıralı kapalı state machine, write-once input,
receipt'siz cleanup → QUARANTINED, sabit kill-switch sırası). Test: I-V13-GRANT-01..02, -VAULT-01,
-CAMPAIGN-01..02.

## Faz 033f — Typed probe, policy proxy, ZAP (delivered, #1411)

`probe` (kapalı adımlar, shell/script reddi, positive control + assertion zorunlu, verdict fold
harness hatasını temiz saymaz), `policy_proxy` (tek egress: her hop'ta grant yeniden doğrulama, DNS
pin/rebinding reddi, GraphQL effect catalog, credential cross-origin yasağı, atomik bütçe, `stop()`
= kill switch; loopback forward proxy testi redirect-ile-production'ı reddeder), `zap` (yalnız
sha256 pinned image, Automation Framework allowlist, alert → UNVERIFIED lead). Test: I-V13-PROBE-01,
-NETGATE-01, -SSRF-01, -CANCEL-01, -ZAP-01.

## Faz 033g — Çift-executor doğrulama + SecurityReadinessProof (coded, 033-3)

`reproduction.dual_reproduce`: iki bağımsız principal + iki temiz lab + aynı sealed recipe + iki
positive control → CONFIRMED; aksi asla. `STATIC_CLAIM_TYPES` repo prover ile. `readiness` proof
head SHA'ya bağlı, ledger'lardan yeniden hesaplanır; kapsam açığı / kapanmamış bulgu / açık
CRITICAL-HIGH / sıfır zorunlu hücre → not ready; zero-tolerance kontroller her zaman zorunlu. Test:
I-V13-REPRO-01, -READINESS-01, -MERGE-01.

## Faz 033h — Otonom remediation, kalıcı regresyon, doctor (coded, 033-3)

`remediation` CONFIRMED → HARDENING_PLANNED → FIX_PROPOSED → FIX_DUAL_VERIFIED → REGRESSION_LOCKED →
READY_FOR_MERGE (asla merge etmez); fix aynı recipe ile dual-GREEN ister. `regression`
minimized+synthetic+deterministic recipe, positive-control hatası → HARNESS_ERROR.
`ops.security_doctor` + fitness enstrümanı (kör → unknown, açık → red). CLI `security doctor`. Test:
I-V13-REGRESS-01, -REMEDIATE-01, -OPS-01, -FITNESS-01.

## Faz 033i — Semantic parity + ajan arşivleme kapısı (coded, 033-3)

`parity` çift secure/vulnerable corpus'u kernel pack'leriyle puanlar; qualifying cycle (non-mock,
qualifying lease, ≥1 kontrol, positive control, sealed evidence, 0 sınır ihlali) sayacı;
`retirement_readiness` `RETIREMENT_THRESHOLD` (CRITICAL recall 1.0, diğer ≥0.95, FP ≤0.02, 30
ardışık cycle, 0 agent-only CRITICAL/HIGH, 0 sınır ihlali) + kalan kernel runtime bağımlılıkları
(`agent_surface`: auth-security-expert; `expert_review_gate`: security-reviewer) + operatör onayı;
asla silmez. Test: I-V13-PARITY-01, -SELF-01, -RETIRE-01.

## Operator steps (kernel fail-closed until done)

- `infrastructure/aria/security-lab/production-deny-inventory.json` → production/staging CIDR'leri.
- `infrastructure/aria/security-lab/zap.pin.json` → ZAP image sha256 digest + pinned_by/pinned_at.
- Ed25519 grant anahtarı workspace DIŞINDA (`grant.generate_keypair`), lab'da yalnız public key.
- KEK 32 byte, FD ile (`vault.kek_from_fd`); env/argv/log'da değil.
- Gerçek Docker lab provisioner (`provisioner_kind=trusted_docker`); `dry_run` qualifying sayılmaz.
- Ajan arşivleme: 30 qualifying cycle + `security parity retirement` ready + operatör onayı.

## Acceptance

```text
PYTHONPATH=aria-kernel python3 -m unittest discover -s aria-kernel/tests/invariants/v13 -t aria-kernel
python3 -m aria_kernel security prerequisites          # exit 0
python3 -m aria_kernel security profile compile --workspace-root .
python3 -m aria_kernel security pack list
python3 -m aria_kernel security graph build --workspace-root . --record
python3 -m aria_kernel security coverage --workspace-root .   # exit 1 until campaigns run
python3 -m aria_kernel security doctor --workspace-root .     # exit 3 until coverage is fresh
python3 -m aria_kernel security parity corpus                  # exit 0
python3 -m aria_kernel security parity retirement              # exit 1 until burn-in + approval
```

Hiçbir acceptance komutu URL / production credential / remote staging parametresi kabul etmez.

## Assumptions & deferred — ARIA-033-D1 (owner: aria-core, due 2026-10-03)

Self-evolving mutation/red-team lab (ARIA-034): 033i kabulünden 14 gün içinde karar-tam plan; canlı
hedef yok; üretilen recipe/skill doğrudan ACTIVE olmaz.

## Assumptions & deferred — ARIA-033-D2 (owner: aria-core, due 2026-10-19)

Fleet pack genişletmesi (cloud, container/Kubernetes, supply-chain, ai-agent, privacy, Rust edge,
PWA cache, IoT/OT): 033i kabulünden 30 gün içinde ilk genişletme planı.
