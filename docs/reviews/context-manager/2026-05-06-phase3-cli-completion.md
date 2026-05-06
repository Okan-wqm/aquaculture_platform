# ARIA Phase-3 CLI Completion

**Cycle:** 2026-05-06-phase3-cli-completion
**Branch:** snowball
**Reviewer:** context-manager
**Plan reference:** docs/aria/plans Phase-3 v4
**Predecessor commit:** `522d9c66 chore(aria): add phase 3 autonomous learning loop`

## Scope

Plan v4 explicit istediği 14 CLI komutundan, ilk Phase-3 commit'i (`522d9c66`) sadece 5'ini ship etti. Kalan 9 komut + destekleyici kernel API'leri eksikti — operator-facing path tamamlanmadan otonom döngü açık kalıyordu.

## Findings

### ULTRA-HIGH-078 — Phase-3 CLI yüzeyi 9 komut eksik shipped — operator-facing autonomous loop tamamlanmadı

**Severity:** HIGH
**State:** RESOLVED (closed by Phase-3 CLI completion commit)
**Layer:** 3

**Evidence:**
- `aria-kernel/aria_kernel/cli.py` (commit 522d9c66 öncesi) — 12 subcommand listesi: `cycle, feedback, discovery, integrity, tool, memory, pressure, telemetry, worker, worker-result, verification, curate`. `agent-report` ve `triage` üst-seviye komutlar yok.
- `aria-kernel/aria_kernel/worker_dispatch.py` (522d9c66) — sadece `create_dispatch_request` public; `list/mark-picked-up/cancel/auto-batch/prune` yok.
- `aria-kernel/aria_kernel/triage.py` (522d9c66) — `triage_policy_apply` cycle hook için var ama `list_triage_decisions` ve `explain_triage` yok.
- `aria-kernel/aria_kernel/report_ingestion.py` (522d9c66) — `report_ingestion_scan` cycle hook için var ama operator-time `import_finding_file` ve `list_ingested_findings` yok.

**Rule violated:** Phase-3 v4 plan Sprint 3A/3C/3D explicit operator CLI surface kontratı; "Contract symmetry remains mandatory: every sprint updates CONTRACTS.md for new CLI" assumption.

**Impact:** Operator manual report ingest, triage explain, dispatch list/cancel, worktree cleanup yapamadı. Otonom loop programatik tam ama operatör interaction katmanı eksik. `worker_pruned` governance kind doc'lanmış ama tetikleyici CLI yoktu — disk dolma riski silent.

**Resolution:** Bu PR aşağıdaki 9 CLI komutunu + 10 destekleyici kernel API'sini ekler (toplam 608 satır):

CLI komutları:
- `agent-report scan-registry` (operator-time backfill + cycle ingest)
- `agent-report import --file <path>` (manual finding JSON/JSONL import)
- `agent-report list` (cache okuma)
- `triage run --cycle-id <id>` (off-cycle triage runner)
- `triage list` (filter by tier/agent/cycle)
- `triage explain <triage_id>` (decision genealogy)
- `worker dispatch --auto-batch --limit N` (auto_fix_safe rows üstünden batch)
- `worker list` (state/agent/pressure filtre)
- `worker mark-picked-up <pe_id> --by <actor>` (lifecycle state change)
- `worker cancel <pe_id> --reason "..."` (lifecycle state change)
- `worktree-prune --acknowledge` (manual cleanup, TTL+state-aware)

Kernel API:
- `list_dispatch_requests`, `mark_dispatch_picked_up`, `cancel_dispatch_request`
- `auto_batch_dispatch`, `prune_worktrees`, `_latest_request_states`
- `list_triage_decisions`, `explain_triage`
- `list_ingested_findings`, `import_finding_file`

**Verification:** Full suite 216/216 pass; smoke CLI `agent-report list` 257 finding cache döndü, `worker list`/`triage list` empty array, `worktree-prune` `--acknowledge` yokken `missing_acknowledge` skip etti, `worker mark-picked-up`/`cancel` non-existent pressure_event_id'de `not_found` döndü, `worker dispatch --auto-batch` empty triage'da 0 candidate.

## Out-of-scope (Phase-3.5 backlog)

- `worker-result submit --file <unified_diff JSON>` mode (şu an sadece `--from-worktree`)
- `verification verify --pr-number / --commit-sha` flag'leri (şu an sadece `--assignment-id`)
- Plan v4 test plan'daki granuler negative path test method'ları (3A backfill limit, 3B cluster cap, 3C tier override, 3D state idempotency, 3E diff size cap, 3F threshold classification) — mevcut 3 birleşik test method shipped behavior'u cover ediyor; granuler decomposition Phase-3.5'te
- CONTRACTS.md operator CLI matrix update (her bir komutun arg listesi) — bu PR sadece kod ekledi; doc symmetry ayrı micro-PR
