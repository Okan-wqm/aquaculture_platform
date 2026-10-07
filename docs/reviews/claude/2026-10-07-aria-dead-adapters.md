# Four Plan 016 adapters that never ran outside tests (2026-10-07)

Context: found while fixing ARIA-MEDIUM-377
(`docs/reviews/claude/2026-10-07-aria-poc-unrun-tests.md`). This branch is stacked on
`fix/aria-poc-unrun-tests` because ARIA-MEDIUM-378 is registered there.

Owner: claude (implementation), okan (review). Deadline 2026-10-21.

## ARIA-MEDIUM-378

Root cause: the outbox, cqrs, banned-phrase and dual-alias adapters had a second declaration
source beside the manifests. It was `adapter_portfolio._MVP_ADAPTERS`, and every row in it ran
`shadow_runner.py`, a shim that emits zero findings.

- Only `adapter-portfolio register-mvp` ever wrote those rows, and no workflow invokes it.
- The cycle's registration door, `cycle._phase_tool_manifest_sync`, reads only
  `tools/aria-adapters/*.tool.json`. So does `registry_compiler`, which also refuses stub runners.
  None of the four had a manifest.
- As a result, the runner store's registry (11 tools) held none of them. The three parsers that
  existed (`outbox_adapter.py`, `cqrs_adapter.py`, `banned_phrase_adapter.py`) ran only in unit
  tests. No dual-alias detector existed at all.
- Two more defects were waiting behind registration:
  - outbox and cqrs emitted `{"rule", "ref"}` rows with no `evidence` and capped `read_paths` at
    200 files. That is the shape that made the evidence validator quarantine agent-harness-security
    on its first real run (ARIA-HIGH-098).
  - The banned-phrase adapter ran the gate with `--mode=staged`. A cycle's checkout has nothing
    staged, so the scan could only ever answer "clean".

Rule: an adapter is declared once, by its manifest. The manifest names its real entrypoint. An
adapter that is declared but not fit to run is quarantined by name, never left running as a no-op.

### Fix

- Each of the four adapters gets a manifest in `tools/aria-adapters/`, with these contents:
  - its real runner (`python3 <adapter>.py`);
  - its scope;
  - one rule contract per emitted rule;
  - a `real_repo_baseline` fixture case expecting an `ok` run.
- `adapter_portfolio` now only reports status. The row builder, the stub rows and `register-mvp`
  are deleted.
- outbox and cqrs emit the evidence contract (`id`, `path`, `line`, `evidence`), declare every file
  they read, and read the kernel's `repo_snapshot.allowed_paths`. cqrs also reads
  `apps/**/*.controller.ts`. Before this, 40 tracked controllers outside a `controllers/` directory
  were never read.
- `dual_alias_adapter.py` is new. In every `tsconfig*.json` `paths` block and every `jest.config.*`
  `moduleNameMapper`, it requires both root aliases (`@aquaculture/backend-common`,
  `@platform/backend-common`) to be mapped, and to the same target.
- `banned-phrase.ts --mode=tree` scans every tracked file with the gate's own rules and exemptions.
  The adapter runs that mode and emits each hit under the `banned_phrase` contract.
- A named quarantine (`adapter_quarantine`) works as follows:
  - a manifest may carry `"quarantine": {"finding", "reason"}`;
  - the registry write gate refuses the block unless it cites a finding id;
  - the manifest sync registers the adapter and then holds it QUARANTINED through
    `quarantine_tool`. The reason starts with `manifest_quarantine:<finding>`, so the registry row,
    the quarantine ledger and each night's `tool_sit_out` name it;
  - the only way out is `unquarantine_tool`.
- Gate: `aria-kernel/tests/test_adapter_registry_completeness.py`, checked against this checkout:
  - every manifest compiles into the registry;
  - every runner resolves to an existing entrypoint and is never the shim, unless the adapter is
    quarantined by name;
  - every `tools/aria-poc/*_adapter.py` and `tools/aria-adapters/*-adapter.ts` is some manifest's
    entrypoint;
  - every named quarantine cites a registered finding;
  - the manifest sync registers all of them, idempotently.

### Per adapter, measured read-only on main `88878799e`

| Adapter       | Files read | Findings | Decision                               |
| ------------- | ---------- | -------- | -------------------------------------- |
| cqrs          | 92         | 6        | runs (SHADOW); 3 controllers, all real |
| dual-alias    | 223        | 0        | runs (SHADOW); every surface maps both |
| outbox        | 36         | 3        | quarantined by name, ARIA-MEDIUM-379   |
| banned-phrase | whole tree | 49       | quarantined by name, ARIA-MEDIUM-380   |

- cqrs: the 6 findings are two rules on 3 controllers. These are `internal-auth`,
  `stripe-webhook` and `internal-hr-contact`, and each injects a TypeORM repository and calls it.
  Each is a real CLAUDE.md layer rule 1 violation.
- outbox: all 3 hits are false positives. The adapter reads only outbox directories, so it sees
  only the outbox relay and the sanctioned best-effort wrapper. Raw publishes in domain code are
  never read.
- banned-phrase: about 6 of the 49 hits are unfinished-work comments in code. The rest are domain
  values (`GoalStatus.DEFERRED`), research notes and quoted headings.

No flood reaches an operator. A SHADOW tool's findings are recorded as raw run output, and only an
ACTIVE tool emits operator-facing findings (`tool_health.can_emit_operator_facing`). Promotion
needs the panel and the precision floor. Past that, the finding-opener and backlog caps from #1733
bound what opens.

Not changed here: `PLAN_016_MVP_TOOL_IDS` still names `schema-drift-adapter` and
`nats-cert-identity-adapter`. Neither has a manifest or code, and `adapter-portfolio status`
already reports both as missing.

## ARIA-MEDIUM-379

`outbox-adapter` reads `apps/**/outbox/**` and `platform/libs/outbox/**` only
(`tools/aria-poc/outbox_adapter.py:70`). Both of its rules look for `eventBus.publish`, so every
hit is the outbox implementation:

- `apps/auth-service/src/outbox/best-effort-event-publisher.ts:97`, the sanctioned lossy path;
- `platform/libs/outbox/src/outbox-worker.service.ts:392`, the relay itself.

About 28 non-test app files publish raw events, and none of them is read. The adapter is
quarantined by name until its scope and rules are redesigned and their precision is measured.

## ARIA-MEDIUM-380

`banned-phrase-adapter`'s tree scan reports 49 hits, and about 6 of them are real. That is far
under the 0.85 precision floor, so the adapter is quarantined by name until the scan is narrowed
to prose and comments this repository wrote. The pre-commit and CI range-mode gate keep blocking
new phrases.

Recount (branch `fix/aria-adapter-precision`): labelled line by line, 14 of the 49 hits are real
gating excuses (29%). Earlier in this doc they were estimated at "about 6". The other 35 fall
into these classes:

- domain values: `GoalStatus.DEFERRED`, SQL enum literals, `{ label: 'Deferred' }`;
- technical senses: temporary directories and variables, events "deferred past the request";
- documents that describe something else: `docs/research/**`, `docs/product-audits/**`, agent
  audit reports, archived migrations, issue templates;
- a spec's own "Out of Scope" heading;
- one deferral tracked by an id on the next line (`INFRA-BACKUP-003`).

Fix: `tools/gates/banned-phrase-excuse.ts` (`isGatingExcuse`) runs in `--mode=tree` only. The
diff-time modes stay word-strict. A hit survives only when the word is used as the reason to leave
work unfinished. Every narrowing names the class of false positive it removes, and any shape it
does not recognise stays a hit. `tools/gates/banned-phrase.spec.ts` pins 8 true-positive and 13
false-positive cases taken from main.

Measured after the fix on the same tree: 14 hits, all 14 real (100%). The manifest's quarantine
block is removed. A tool that a cycle has already held QUARANTINED leaves only through
`unquarantine_tool`, which needs an operator approval (ARIA-CRITICAL-216). The kernel never lifts
a quarantine on its own.
