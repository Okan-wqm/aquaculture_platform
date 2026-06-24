# Aqua-SaaS Worktree Audit Inventory

Generated: 2026-06-23T07:30:32.398Z

## Counts

- Total worktrees: 42
- Dirty worktrees: 15
- Detached worktrees: 5
- /tmp worktrees: 32
- Worktrees with ownership gaps: 12

## Decision Counts

- DETACHED_TEMP: 1
- DIRTY_NEEDS_OWNER: 10
- PASSIVE_KEEP: 2
- PASSIVE_REMOVE_AFTER_APPROVAL: 24
- STAGED_NEEDS_COMMIT_DECISION: 5

## Worktrees

| Path | Branch | Dirty | Ahead/Behind | Decision | Primary Owners |
|---|---|---:|---:|---|---|
| /var/aqua-saas | (detached) | 55 (0 staged, 0 unstaged, 55 untracked) | 0/0 | DIRTY_NEEDS_OWNER | PROCESS HIGH ownership gap (22), test-runner (15), frontend-expert (4), auth-security-expert (3), farm-expert (3), alert-engine-expert (2), hr-expert (2), data-expert (1), mcp-expert (1), admin-expert (1), sensor-expert (1) |
| /tmp/aqua-agents-main | codex/enforce-claude-agent-bootstrap | 0 (0 staged, 0 unstaged, 0 untracked) | 0/0 | PASSIVE_REMOVE_AFTER_APPROVAL | - |
| /tmp/aqua-aria-agent-ssot-cleanup | codex/aria-live-agent-ssot-cleanup | 0 (0 staged, 0 unstaged, 0 untracked) | 0/37 | PASSIVE_REMOVE_AFTER_APPROVAL | - |
| /tmp/aqua-aria-autonomy-decisions-doc | codex/aria-autonomy-decisions-doc | 0 (0 staged, 0 unstaged, 0 untracked) | 0/0 | PASSIVE_REMOVE_AFTER_APPROVAL | - |
| /tmp/aqua-aria-docs | chore/aria-docs-port-to-main | 0 (0 staged, 0 unstaged, 0 untracked) | 0/0 | PASSIVE_REMOVE_AFTER_APPROVAL | - |
| /tmp/aqua-aria-executor-convergence | codex/aria-snowball-executor-convergence | 0 (0 staged, 0 unstaged, 0 untracked) | 0/0 | PASSIVE_REMOVE_AFTER_APPROVAL | - |
| /tmp/aqua-aria-itemA | feat/aria-per-job-governance | 13 (0 staged, 13 unstaged, 0 untracked) | 0/0 | DIRTY_NEEDS_OWNER | PROCESS HIGH ownership gap (7), infra-expert (6) |
| /tmp/aqua-aria-runtime-owners | codex/aria-snowball-runtime-owners | 0 (0 staged, 0 unstaged, 0 untracked) | 0/0 | PASSIVE_REMOVE_AFTER_APPROVAL | - |
| /tmp/aqua-backup-encryption-remediation | codex/deploy-migration-selection-ssot | 75 (15 staged, 61 unstaged, 3 untracked) | 0/0 | STAGED_NEEDS_COMMIT_DECISION | auth-security-expert (42), alert-engine-expert (10), PROCESS HIGH ownership gap (6), farm-expert (5), multi-tenant-saas-expert (3), test-runner (3), infra-expert (2), context-manager (2), platform-kernel-expert (2) |
| /tmp/aqua-capacity-budget | codex/capacity-preflight-budget | 0 (0 staged, 0 unstaged, 0 untracked) | 1/3 | PASSIVE_REMOVE_AFTER_APPROVAL | - |
| /tmp/aqua-capacity-budget-ff | codex/capacity-preflight-budget-ff | 0 (0 staged, 0 unstaged, 0 untracked) | 0/0 | PASSIVE_REMOVE_AFTER_APPROVAL | - |
| /tmp/aqua-capacity-diagnostics | codex/droplet-capacity-diagnostics | 0 (0 staged, 0 unstaged, 0 untracked) | 0/17 | PASSIVE_REMOVE_AFTER_APPROVAL | - |
| /tmp/aqua-capacity-pipefail-fix | codex/capacity-diagnostics-pipefail | 0 (0 staged, 0 unstaged, 0 untracked) | 0/0 | PASSIVE_REMOVE_AFTER_APPROVAL | - |
| /tmp/aqua-capacity-registry-close | codex/close-capacity-diagnostics-findings | 0 (0 staged, 0 unstaged, 0 untracked) | 0/0 | PASSIVE_REMOVE_AFTER_APPROVAL | - |
| /tmp/aqua-claude-md | (detached) | 2 (0 staged, 0 unstaged, 2 untracked) | 0/0 | DIRTY_NEEDS_OWNER | farm-expert (2) |
| /tmp/aqua-close-capacity-preflight | codex/close-capacity-preflight-budget | 0 (0 staged, 0 unstaged, 0 untracked) | 0/0 | PASSIVE_REMOVE_AFTER_APPROVAL | - |
| /tmp/aqua-consent-bootstrap-commit | codex/fix-digitalocean-consent-bootstrap-clean | 0 (0 staged, 0 unstaged, 0 untracked) | 0/0 | PASSIVE_REMOVE_AFTER_APPROVAL | - |
| /tmp/aqua-control-plane | codex/control-plane-csp-geospatial | 0 (0 staged, 0 unstaged, 0 untracked) | 0/31 | PASSIVE_REMOVE_AFTER_APPROVAL | - |
| /tmp/aqua-critical-plan | codex/critical-registry-close | 0 (0 staged, 0 unstaged, 0 untracked) | 0/0 | PASSIVE_REMOVE_AFTER_APPROVAL | - |
| /tmp/aqua-geospatial-gate | codex/geospatial-browser-bundle-gate | 24 (0 staged, 13 unstaged, 11 untracked) | 10/4 | DIRTY_NEEDS_OWNER | farm-expert (6), messaging-expert (3), alert-engine-expert (3), test-runner (3), auth-security-expert (2), admin-expert (2), infra-expert (1), ai-safety-auditor (1), billing-expert (1), hr-expert (1), sensor-expert (1) |
| /tmp/aqua-infra014-trace | codex/close-infra-critical-009-runtime-synchronize-ssot | 0 (0 staged, 0 unstaged, 0 untracked) | 0/0 | PASSIVE_REMOVE_AFTER_APPROVAL | - |
| /tmp/aqua-lint-base-jjazQU/repo | (detached) | 3 (0 staged, 1 unstaged, 2 untracked) | 0/0 | DIRTY_NEEDS_OWNER | PROCESS HIGH ownership gap (3) |
| /tmp/aqua-lint-base-tJFSMB/repo | (detached) | 3 (0 staged, 1 unstaged, 2 untracked) | 0/0 | DIRTY_NEEDS_OWNER | PROCESS HIGH ownership gap (3) |
| /tmp/aqua-plan-reconcile | main | 0 (0 staged, 0 unstaged, 0 untracked) | 1/76 | PASSIVE_REMOVE_AFTER_APPROVAL | - |
| /tmp/aqua-plan-wave1 | codex/continue-enterprise-plan-wave1 | 0 (0 staged, 0 unstaged, 0 untracked) | 0/0 | PASSIVE_REMOVE_AFTER_APPROVAL | - |
| /tmp/aqua-plan-wave1b | codex/close-infra-critical-020 | 0 (0 staged, 0 unstaged, 0 untracked) | 0/0 | PASSIVE_REMOVE_AFTER_APPROVAL | - |
| /tmp/aqua-pr414 | resolve/pr414-rechain-20260613 | 0 (0 staged, 0 unstaged, 0 untracked) | 0/0 | PASSIVE_REMOVE_AFTER_APPROVAL | - |
| /tmp/aqua-pr417 | resolve/pr417-rechain-20260613 | 0 (0 staged, 0 unstaged, 0 untracked) | 0/0 | PASSIVE_REMOVE_AFTER_APPROVAL | - |
| /tmp/aqua-pr531 | codex/close-infra-critical-014-registry | 4 (0 staged, 4 unstaged, 0 untracked) | 0/91 | DIRTY_NEEDS_OWNER | PROCESS HIGH ownership gap (3), context-manager (1) |
| /tmp/aqua-salvage | salvage/agent-finding-id-prefix-contract | 0 (0 staged, 0 unstaged, 0 untracked) | 0/0 | PASSIVE_REMOVE_AFTER_APPROVAL | - |
| /tmp/aqua-snowball-audit | codex/aria-snowball-audit | 0 (0 staged, 0 unstaged, 0 untracked) | 0/0 | PASSIVE_REMOVE_AFTER_APPROVAL | - |
| /tmp/aqua-ssot-critical-impl | codex/ssot-critical-implementation | 0 (0 staged, 0 unstaged, 0 untracked) | 0/0 | PASSIVE_REMOVE_AFTER_APPROVAL | - |
| /tmp/aqua-tscfix | (detached) | 0 (0 staged, 0 unstaged, 0 untracked) | 0/0 | DETACHED_TEMP | - |
| /var/aqua-saas-wave3 | fix/auth-audit-wave3-tenancy-data | 73 (73 staged, 0 unstaged, 0 untracked) | 0/0 | STAGED_NEEDS_COMMIT_DECISION | messaging-expert (17), infra-expert (13), context-manager (11), farm-expert (8), auth-security-expert (7), PROCESS HIGH ownership gap (6), test-runner (4), frontend-expert (3), platform-kernel-expert (2), admin-expert (1), data-expert (1) |
| /var/aqua-saas/.claude/worktrees/b1-metrics | remediation/b1-metrics-completeness | 117 (117 staged, 0 unstaged, 0 untracked) | 0/0 | STAGED_NEEDS_COMMIT_DECISION | PROCESS HIGH ownership gap (78), infra-expert (10), edge-expert (6), messaging-expert (5), test-runner (4), context-manager (4), data-expert (4), auth-security-expert (2), frontend-expert (2), multi-tenant-saas-expert (1), admin-expert (1) |
| /var/aqua-saas/.claude/worktrees/c0-federation | remediation/c0-federation-invariants | 250 (250 staged, 0 unstaged, 0 untracked) | 0/0 | STAGED_NEEDS_COMMIT_DECISION | PROCESS HIGH ownership gap (89), data-expert (27), infra-expert (25), messaging-expert (16), test-runner (13), context-manager (11), farm-expert (10), frontend-expert (9), auth-security-expert (8), admin-expert (7), edge-expert (6), alert-engine-expert (5), sensor-expert (5), hr-expert (4), multi-tenant-saas-expert (3), observability-expert (3), ai-safety-auditor (2), billing-expert (2), platform-kernel-expert (2), mcp-expert (2), {respective domain expert} (1) |
| /var/aqua-saas/.claude/worktrees/c1-pr1b | remediation/c2-react19-xyflow | 1 (0 staged, 0 unstaged, 1 untracked) | 0/0 | DIRTY_NEEDS_OWNER | frontend-expert (1) |
| /var/aqua-saas/.claude/worktrees/r1-coprocessor | remediation/r1-router-coprocessor | 9 (0 staged, 6 unstaged, 3 untracked) | 3/184 | DIRTY_NEEDS_OWNER | PROCESS HIGH ownership gap (4), auth-security-expert (2), edge-expert (1), infra-expert (1), platform-kernel-expert (1) |
| /var/aqua-saas/.claude/worktrees/rust-cve-001 | remediation/rust-cve-001-rumqttc-fork | 160 (160 staged, 0 unstaged, 0 untracked) | 0/0 | STAGED_NEEDS_COMMIT_DECISION | data-expert (27), infra-expert (21), messaging-expert (16), PROCESS HIGH ownership gap (12), test-runner (11), context-manager (11), farm-expert (10), frontend-expert (9), auth-security-expert (8), admin-expert (6), alert-engine-expert (5), sensor-expert (5), hr-expert (4), multi-tenant-saas-expert (3), observability-expert (3), ai-safety-auditor (2), billing-expert (2), platform-kernel-expert (2), mcp-expert (2), {respective domain expert} (1) |
| /var/aqua-saas/.claude/worktrees/rustcve-close | chore/close-rust-cve-001-postmerge | 0 (0 staged, 0 unstaged, 0 untracked) | 0/0 | PASSIVE_KEEP | - |
| /var/aqua-saas/.codex-worktrees/maintanance | maintanance | 0 (0 staged, 0 unstaged, 0 untracked) | 0/0 | PASSIVE_KEEP | - |
| /var/aqua-saas/.worktrees/snowball | codex/snowball-main-safe-20260530 | 68 (0 staged, 0 unstaged, 68 untracked) | 1/305 | DIRTY_NEEDS_OWNER | PROCESS HIGH ownership gap (68) |

