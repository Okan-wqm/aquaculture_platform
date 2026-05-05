# Test Agents E2E Alignment Review

**Date:** 2026-04-12  
**Scope:** `.claude/agents/product-audit/*.md`

## Verdict

The `test-agents` system does perform end-to-end product auditing, but not every prompt should be judged by the same standard.

- `orchestrator` is the true end-to-end coordinator.
- `context-manager` and `architectural-arbiter` are meta agents, not direct e2e reviewers by design.
- The specialist auditors are slice owners inside the roundtrip, not standalone "full platform" auditors. Their quality depends on whether they:
  - anchor to a concrete user action or visible surface
  - trace far enough upstream and downstream
  - declare exact handoff edges instead of stopping at a local layer
  - use repo-specific discovery instead of generic advice

Before this hardening pass, several specialists were still too local and too generic. The main weaknesses were:

- missing repo-specific discovery guidance
- weak or absent out-of-scope boundaries
- insufficient instruction to name upstream trigger and downstream consequence
- mobile review behaving more like an offline-state note taker than a ruthless mobile roundtrip reviewer

After this pass, the system is materially stronger and more honestly end-to-end:

- specialist prompts are more explicit about what they own in the roundtrip
- weak prompts now require concrete discovery against this repo
- ambiguous ownership boundaries are tighter
- mobile auditing now has a named scenario matrix rather than vague "offline/reconnect" language
- orchestrator and invocation profiles now route the expanded dedicated roster instead of leaving new specialists disconnected

## Prompt Matrix

| Prompt | E2E Role | Status | Notes |
|---|---|---|---|
| `orchestrator` | full e2e coordinator | strong | Dispatches specialists and merges action -> payload -> persistence -> read-back -> visible state. |
| `context-manager` | meta-only | correct by design | Not a direct tester; compacts specialist findings and preserves critical evidence. |
| `architectural-arbiter` | meta-only | correct by design | Not a direct tester; resolves cross-agent root-cause conflicts. |
| `ui-action-mapper` | e2e entry inventory | strong | Maps visible controls to owning read/write paths and specialist handoffs. |
| `access-boundary-auditor` | slice-level e2e specialist | hardened | Now explicitly treats access as route/control/API/export/live/mobile roundtrip, with repo-specific discovery and clearer boundaries. |
| `accessibility-auditor` | slice-level e2e specialist | strong | Operability-focused; already tied to shared primitives and critical flows. |
| `ai-tool-execution-auditor` | slice-level e2e specialist | strong | Good bounded runtime domain with concrete repo evidence. |
| `billing-reconciliation-auditor` | slice-level e2e specialist | strong | Properly anchored to ingress, handlers, durable entities, and operator truth. |
| `button-action-auditor` | slice-level e2e specialist | hardened | Now requires UI trigger, mutation call, backend acceptance, and visible completion path. |
| `chart-widget-auditor` | slice-level e2e specialist | strong | Already good after earlier hardening; rooted in displayed truth vs source truth. |
| `contract-parity-auditor` | slice-level e2e specialist | hardened | No longer allowed to act like a static DTO/entity diff; must anchor to real product behavior. |
| `data-readback-auditor` | slice-level e2e specialist | hardened | Now starts from concrete stored truth and explicit read surfaces, not generic display drift. |
| `edge-industrial-auditor` | slice-level e2e specialist | strong | Properly scoped to field-control truth, safe-state, queueing, and telemetry read-back. |
| `file-transfer-auditor` | slice-level e2e specialist | strong | Already hardened with roundtrip artifact truth and retrieval checks. |
| `form-write-auditor` | slice-level e2e specialist | hardened | Now forced to trace beyond controller receipt toward durable target and expected read-back surfaces. |
| `gdpr-compliance-auditor` | slice-level e2e specialist | strong | Grounded in consent/export/erase/audit evidence, not policy text. |
| `job-queue-auditor` | slice-level e2e specialist | strong | Covers async enqueue, retry, dead-letter, and queue-dashboard truth that was previously a meaningful blind spot. |
| `list-visibility-auditor` | slice-level e2e specialist | hardened | Now more explicit about post-write surface enumeration and discovery. |
| `mobile-app-auditor` | slice-level e2e specialist | heavily hardened | Biggest weakness before this pass; now has named AquaMobil scenario matrix and concrete repo surfaces. |
| `realtime-sync-auditor` | slice-level e2e specialist | hardened | Now explicitly checks transport + cache + reload/reconnect + final convergence. |
| `schema-surface-parity-auditor` | slice-level e2e specialist | hardened | Better protected against drifting into generic schema archaeology. |
| `table-grid-auditor` | slice-level e2e specialist | strong | Already hardened with concrete discovery and out-of-scope boundaries. |
| `tenant-isolation-auditor` | slice-level e2e specialist | hardened | Now better grounded in real tenant guards, service identity, impersonation, and AquaMobil cache boundaries. |
| `webhook-ingress-auditor` | slice-level e2e specialist | strong | Clear ingress trust boundary with good downstream handoffs. |
| `workflow-state-auditor` | slice-level e2e specialist | strong | Already in good shape; validates legal transition path plus required side effects. |

## Hardening Applied In This Pass

Updated prompts:

- `.claude/agents/product-audit/ui-action-mapper.md`
- `.claude/agents/product-audit/access-boundary-auditor.md`
- `.claude/agents/product-audit/button-action-auditor.md`
- `.claude/agents/product-audit/chart-widget-auditor.md`
- `.claude/agents/product-audit/form-write-auditor.md`
- `.claude/agents/product-audit/data-readback-auditor.md`
- `.claude/agents/product-audit/contract-parity-auditor.md`
- `.claude/agents/product-audit/file-transfer-auditor.md`
- `.claude/agents/product-audit/tenant-isolation-auditor.md`
- `.claude/agents/product-audit/list-visibility-auditor.md`
- `.claude/agents/product-audit/mobile-app-auditor.md`
- `.claude/agents/product-audit/orchestrator.md`
- `.claude/agents/product-audit/realtime-sync-auditor.md`
- `.claude/agents/product-audit/schema-surface-parity-auditor.md`
- `.claude/agents/product-audit/table-grid-auditor.md`
- `.claude/agents/product-audit/workflow-state-auditor.md`
- `.claude/agents/product-audit/context-manager.md`
- `.claude/agents/product-audit/job-queue-auditor.md`

System-level discipline updates:

- `.claude/agents/product-audit/README.md`
- `.claude/agents/product-audit/INVOCATION-PACK.md`

## Mobile-Specific Conclusion

The original concern about `mobile-app-auditor` being surface-level was correct.

The prompt now explicitly requires review of:

- session restore and logout cleanup
- tenant switch behavior
- offline queue and reconnect replay
- sync status surfaces
- notification and background entry points
- media and attachment flows
- IndexedDB, service-worker, local storage, and permission-cache boundaries

That change moves it from "mobile offline notes" toward a real mobile roundtrip specialist.

## Remaining Truth

Even after hardening, specialist auditors are still specialists. They should not be mistaken for standalone full-platform e2e runners.

The intended model is:

1. `orchestrator` chooses the right specialist set.
2. Specialists trace their owned slice with explicit upstream and downstream edges.
3. `context-manager` compacts overlap.
4. `architectural-arbiter` resolves conflicts.
5. `orchestrator` writes the unified end-to-end decision.

That is the correct enterprise shape for this prompt system.
