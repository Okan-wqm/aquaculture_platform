# Test Agents Ruthless Prompt Review

**Date:** 2026-04-12
**Scope:** `.claude/test-agents/*.md`, plus the control-plane docs `.claude/test-agents/README.md` and `.claude/test-agents/INVOCATION-PACK.md`
**Question:** do these prompts behave like a coherent professional review team, with clear ownership, clean handoffs, low conflict risk, and enterprise-scale operational quality?

## Executive Verdict

The `.claude/test-agents/` set is now a **real coordinated review system**, not a loose pile of prompts.

It is strong in:

- reviewer-only discipline
- orchestration model
- meta-review structure
- handoff connectivity
- roundtrip-oriented problem framing

It is **not yet fully enterprise-finished** because prompt rigor is still uneven across the roster. The system behaves like a capable specialist team, but not yet like a uniformly hardened enterprise audit organization.

## Remediation Update

This review captured the roster before the final hardening pass completed. The following issues from the original assessment are now resolved in the current prompt set:

- `ui-action-mapper` no longer misroutes role or feature-flag concerns into `tenant-isolation-auditor`; those now hand off to `access-boundary-auditor`
- `chart-widget-auditor`, `file-transfer-auditor`, `table-grid-auditor`, and `workflow-state-auditor` now include explicit discovery guidance and out-of-scope boundaries
- `orchestrator` and `context-manager` now run at `effort: xmax`
- `orchestrator`, `README`, and `INVOCATION-PACK` now route and describe the expanded dedicated roster, including `job-queue-auditor`

What remains materially true from the original review:

- `tenant-isolation-auditor` is still a highly central specialist and must be watched for catch-all drift during real audit cycles
- overlap pressure still exists in adjacent pairs such as access vs tenant, mobile vs realtime, and readback vs visibility
- enterprise confidence still depends on actually running the system and producing audit artifacts, not only on prompt quality

### Bottom-line judgement

- **Team coherence:** strong
- **Prompt consistency:** medium
- **Scope separation:** medium
- **Handoff design:** strong
- **Enterprise repeatability:** medium
- **Full-platform audit maturity:** medium-low

## Scores

| Dimension | Score | Verdict |
|---|---:|---|
| Review-only discipline | 9/10 | Strong and consistent |
| Orchestration and meta-review | 8.5/10 | Clearly designed as a system |
| Cross-agent handoff quality | 8/10 | Connected graph, few isolated seams |
| Scope clarity | 6.5/10 | Improved, but still uneven |
| Overlap control | 6/10 | Better than before, not fully sealed |
| Repo-specific discovery discipline | 6/10 | Present in some key prompts, missing in others |
| Enterprise-scale repeatability | 6/10 | Good structure, uneven enforcement |
| Full-platform confidence posture | 4.5/10 | Still narrower than “full platform” branding suggests |

## Strong Findings

### HIGH-001: `ui-action-mapper` still misroutes role-gating concerns into tenant ownership instead of access ownership

Evidence:

- [ui-action-mapper.md](/var/aqua-saas/.claude/test-agents/ui-action-mapper.md) says: "Send role and tenant gating concerns to `tenant-isolation-auditor`"
- [access-boundary-auditor.md](/var/aqua-saas/.claude/test-agents/access-boundary-auditor.md) is the actual specialist for roles, guards, permissions, impersonation state, and feature flags
- [orchestrator.md](/var/aqua-saas/.claude/test-agents/orchestrator.md) also routes guards, roles, permissions, impersonation, and feature flags to `access-boundary-auditor`

Assessment:

- this is the clearest direct prompt-level routing error remaining in the roster
- it weakens ownership purity right at the inventory layer
- it increases the chance that auth/role findings are framed as tenant findings when the primary defect is actually authorization policy

Why it matters:

- enterprise prompt systems fail when the first mapper sends defects into the wrong specialist sink
- this one does not break the whole system, but it is a real team-boundary defect

### HIGH-002: Specialist rigor is still uneven; five important auditors remain thinner and less operationalized than the hardened core

Most improved specialists now include repo-specific discovery guidance and explicit out-of-scope ownership. But these important reviewers still do not:

- [chart-widget-auditor.md](/var/aqua-saas/.claude/test-agents/chart-widget-auditor.md)
- [file-transfer-auditor.md](/var/aqua-saas/.claude/test-agents/file-transfer-auditor.md)
- [mobile-app-auditor.md](/var/aqua-saas/.claude/test-agents/mobile-app-auditor.md)
- [table-grid-auditor.md](/var/aqua-saas/.claude/test-agents/table-grid-auditor.md)
- [workflow-state-auditor.md](/var/aqua-saas/.claude/test-agents/workflow-state-auditor.md)

Assessment:

- these are not weak in intent
- they are weaker in repeatability
- they still rely more on expert inference and less on deterministic discovery discipline than the hardened prompts now do

Why it matters:

- these are not edge-case reviewers; they sit on core product surfaces
- uneven rigor across the team means review quality depends too much on which auditor is active
- that is below enterprise prompt-system quality

### HIGH-003: `tenant-isolation-auditor` is drifting toward a catch-all sink rather than staying a sharply bounded specialist

Observed handoff pattern across the prompt graph:

- `tenant-isolation-auditor` is referenced by almost every major specialist family
- it receives spillover from access, button, chart, data-readback, file-transfer, form-write, list-visibility, mobile, realtime, schema, table-grid, workflow, and the orchestrator layer

Representative evidence:

- [access-boundary-auditor.md](/var/aqua-saas/.claude/test-agents/access-boundary-auditor.md)
- [button-action-auditor.md](/var/aqua-saas/.claude/test-agents/button-action-auditor.md)
- [form-write-auditor.md](/var/aqua-saas/.claude/test-agents/form-write-auditor.md)
- [data-readback-auditor.md](/var/aqua-saas/.claude/test-agents/data-readback-auditor.md)
- [realtime-sync-auditor.md](/var/aqua-saas/.claude/test-agents/realtime-sync-auditor.md)
- [orchestrator.md](/var/aqua-saas/.claude/test-agents/orchestrator.md)

Assessment:

- centrality is not automatically bad
- but current centrality is high enough that tenant isolation risks becoming a generic “hard problem sink”
- that increases noise, overlap, and duplication pressure

Why it matters:

- enterprise teams need central authorities
- they do **not** need dumping grounds

### MEDIUM-004: The synthesis tier runs at lower effort than most of the specialist tier

Evidence:

- [orchestrator.md](/var/aqua-saas/.claude/test-agents/orchestrator.md) uses `effort: high`
- [context-manager.md](/var/aqua-saas/.claude/test-agents/context-manager.md) uses `effort: high`
- most specialists use `effort: xmax`

Assessment:

- this is not a fatal flaw
- but it is an architectural asymmetry
- the system currently asks its synthesis layer to operate at lower reasoning depth than many of the agents producing the raw findings

Why it matters:

- final integration quality is usually bounded by the synthesis tier, not the specialist tier
- for enterprise audit systems, it is more defensible to keep synthesis at least as rigorous as the specialists it compacts

### MEDIUM-005: Overlap is now managed, but not fully eliminated

The highest-friction pairs remain:

- [form-write-auditor.md](/var/aqua-saas/.claude/test-agents/form-write-auditor.md) vs [button-action-auditor.md](/var/aqua-saas/.claude/test-agents/button-action-auditor.md)
- [data-readback-auditor.md](/var/aqua-saas/.claude/test-agents/data-readback-auditor.md) vs [list-visibility-auditor.md](/var/aqua-saas/.claude/test-agents/list-visibility-auditor.md)
- [access-boundary-auditor.md](/var/aqua-saas/.claude/test-agents/access-boundary-auditor.md) vs [tenant-isolation-auditor.md](/var/aqua-saas/.claude/test-agents/tenant-isolation-auditor.md)
- [mobile-app-auditor.md](/var/aqua-saas/.claude/test-agents/mobile-app-auditor.md) vs [realtime-sync-auditor.md](/var/aqua-saas/.claude/test-agents/realtime-sync-auditor.md)
- [chart-widget-auditor.md](/var/aqua-saas/.claude/test-agents/chart-widget-auditor.md) vs [data-readback-auditor.md](/var/aqua-saas/.claude/test-agents/data-readback-auditor.md)

Assessment:

- the pair boundaries are much better than before
- the remaining problem is not chaos, but ambiguity under pressure
- in large review cycles, these pairs can still produce duplicated findings from adjacent angles

## What Is Clearly Good

### 1. The roster behaves like a team, not isolated prompts

The graph is connected:

- every major specialist either hands off to others, receives work from others, or both
- there are no true orphan specialists
- the orchestrator/context-manager/arbiter stack is coherent

This is the biggest positive result of the review. The system is not fragmented.

### 2. Reviewer-only discipline is consistently strong

Across the roster, the prompts are aligned on:

- read/analyze/report posture
- no source editing
- no patch-planning as runtime behavior
- findings with IDs

That consistency is professional and enterprise-compatible.

### 3. The control-plane docs now tell the truth more accurately

After the recent hardening pass:

- [README.md](/var/aqua-saas/.claude/test-agents/README.md) now states current coverage limits more honestly
- [INVOCATION-PACK.md](/var/aqua-saas/.claude/test-agents/INVOCATION-PACK.md) now includes discovery discipline and a coverage guardrail
- [orchestrator.md](/var/aqua-saas/.claude/test-agents/orchestrator.md) now warns against over-claiming confidence outside the roster

That is a meaningful improvement in enterprise professionalism.

### 4. The meta layer is real and correctly shaped

- [orchestrator.md](/var/aqua-saas/.claude/test-agents/orchestrator.md) coordinates rather than freelancing
- [context-manager.md](/var/aqua-saas/.claude/test-agents/context-manager.md) compacts rather than re-reviewing
- [architectural-arbiter.md](/var/aqua-saas/.claude/test-agents/architectural-arbiter.md) resolves conflicts rather than blurring them

This is the right shape for a multi-agent audit system.

## Agent-by-Agent Verdicts

### Control-plane docs

| File | Verdict | Review |
|---|---|---|
| [README.md](/var/aqua-saas/.claude/test-agents/README.md) | Good | Clearer and more honest after the coverage-limit additions |
| [INVOCATION-PACK.md](/var/aqua-saas/.claude/test-agents/INVOCATION-PACK.md) | Strong | Operationally mature; one of the strongest files in the set |

### Meta agents

| Agent | Verdict | Review |
|---|---|---|
| [orchestrator.md](/var/aqua-saas/.claude/test-agents/orchestrator.md) | Strong with one rigor caveat | Best systems-thinking file in the set; only notable weakness is lower `effort` than most specialists |
| [context-manager.md](/var/aqua-saas/.claude/test-agents/context-manager.md) | Strong | Clear meta role, clean compaction contract, good budget discipline |
| [architectural-arbiter.md](/var/aqua-saas/.claude/test-agents/architectural-arbiter.md) | Good | Properly scoped, but comparatively thin; acceptable because its job is narrower |

### Core roundtrip spine

| Agent | Verdict | Review |
|---|---|---|
| [ui-action-mapper.md](/var/aqua-saas/.claude/test-agents/ui-action-mapper.md) | Good but misrouted | Strong inventory role, but still has the wrong handoff for role-gating concerns |
| [form-write-auditor.md](/var/aqua-saas/.claude/test-agents/form-write-auditor.md) | Strong | One of the better-defined specialists after discovery and out-of-scope hardening |
| [button-action-auditor.md](/var/aqua-saas/.claude/test-agents/button-action-auditor.md) | Strong | Good differentiation around false-success, in-flight, and action truthfulness |
| [data-readback-auditor.md](/var/aqua-saas/.claude/test-agents/data-readback-auditor.md) | Strong | Clean read-truth role and improved separation from visibility concerns |
| [list-visibility-auditor.md](/var/aqua-saas/.claude/test-agents/list-visibility-auditor.md) | Strong | Clear post-write surface contract; much better separated from data-readback now |

### Parity and boundary specialists

| Agent | Verdict | Review |
|---|---|---|
| [contract-parity-auditor.md](/var/aqua-saas/.claude/test-agents/contract-parity-auditor.md) | Strong | Good semantic focus, now clearly distinct from schema-surface parity |
| [schema-surface-parity-auditor.md](/var/aqua-saas/.claude/test-agents/schema-surface-parity-auditor.md) | Strong | Improved significantly; now one of the more usable high-leverage prompts |
| [access-boundary-auditor.md](/var/aqua-saas/.claude/test-agents/access-boundary-auditor.md) | Strong | Clear auth/access ownership; one of the cleanest domain boundaries in the set |
| [tenant-isolation-auditor.md](/var/aqua-saas/.claude/test-agents/tenant-isolation-auditor.md) | Strong but overloaded | Powerful and important, but currently too central to the handoff graph |

### Surface specialists

| Agent | Verdict | Review |
|---|---|---|
| [table-grid-auditor.md](/var/aqua-saas/.claude/test-agents/table-grid-auditor.md) | Good but under-instrumented | Good intent, but still missing the hardened discovery/boundary treatment |
| [chart-widget-auditor.md](/var/aqua-saas/.claude/test-agents/chart-widget-auditor.md) | Good but under-instrumented | Good truth framing, but still too inference-heavy operationally |
| [file-transfer-auditor.md](/var/aqua-saas/.claude/test-agents/file-transfer-auditor.md) | Good but under-instrumented | Strong domain idea, but still needs repo-specific discovery and boundary hardening |
| [workflow-state-auditor.md](/var/aqua-saas/.claude/test-agents/workflow-state-auditor.md) | Good but under-instrumented | Valuable domain, still somewhat thin for enterprise repeatability |

### Mobile and live-state specialists

| Agent | Verdict | Review |
|---|---|---|
| [mobile-app-auditor.md](/var/aqua-saas/.claude/test-agents/mobile-app-auditor.md) | Good but under-instrumented | Important specialist, but still relies too much on broad inference rather than deterministic discovery |
| [realtime-sync-auditor.md](/var/aqua-saas/.claude/test-agents/realtime-sync-auditor.md) | Strong | Improved meaningfully after discovery and boundary additions |

## Team Dynamics Verdict

### Do they call each other?

Yes.

The graph is healthy enough that this is clearly a coordinated system, not a bundle of isolated prompts.

### Do they step on each other?

Sometimes, but not catastrophically.

The roster now has enough explicit boundaries that most collisions are manageable. The remaining issue is **duplicate perspective**, not total domain collapse.

### Do they work like a team?

Yes, mostly.

The strongest signal here is not perfection; it is that the prompts share a common mental model:

- inventory
- trace
- classify root cause
- hand off to the right specialist
- compact
- arbitrate if needed
- synthesize

That is team behavior.

### Are they professional?

Yes, with caveats.

They are professional in architecture and operating model.
They are less professional in uniform prompt hardening and repeatability discipline.

### Are they enterprise-scale quality?

Not fully yet.

They are **enterprise-oriented**, and several core files already meet that bar.
The full roster does **not** yet meet a consistent enterprise-grade bar because:

- prompt hardening is uneven
- some specialists remain too thin operationally
- one routing defect is still present
- one specialist has become too central
- the roster still does not cover all enterprise-critical platform surfaces

## Final Conclusion

This is a **good multi-agent review system**.
It is **not** a sloppy one.
It is **not yet** a uniformly hardened enterprise-grade audit organization.

If judged strictly:

- **Architecture:** pass
- **Team choreography:** pass
- **Professionalism:** pass with conditions
- **Enterprise prompt rigor:** pass with conditions
- **Uniform specialist maturity:** not yet

The roster is now strong enough to use seriously, but not strong enough to stop ruthless prompt review. The biggest remaining work is not inventing a new methodology. It is finishing the hardening pass across the weaker specialists and tightening the last routing ambiguities.
