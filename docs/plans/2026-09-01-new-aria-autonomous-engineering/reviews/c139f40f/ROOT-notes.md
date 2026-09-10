<!-- markdownlint-disable MD013 MD033 -->
<!-- Historical review text preserves long evidence tokens and placeholders. -->

# Root independent hostile notes — exact head c139f40f6

Interim verdict: `CHANGES_REQUIRED` unless the appellate reviewer disproves or narrows the roots below. These
are independent of the three fresh panels.

## ROOT-P1-001 — The advertised protected-diff gate checks only dirty worktree paths

- **Evidence:** `authority/verification-evidence.md:64-68` says the full command contains protected legacy
  diff and D0 allowed-scope checks. `verification/lib/verify.mjs:63-77` obtains paths only from
  `git status --porcelain`; `:119-131` passes that list to the scope predicate. A clean checkout with a
  committed forbidden path therefore supplies an empty list. The CLI has no base/head argument and does not
  check `HEAD` identity or `git diff <base>..<head>`.
- **Failure path:** a corrective/admission commit can alter legacy ARIA or product code, remain clean, and
  receive a green canonical verifier. The negative suite injects `changedPaths` directly, so it does not
  exercise the production CLI failure mode.
- **Narrow fix:** bind expected base/head (and current `HEAD`) in immutable review target metadata; compute
  committed paths using `git diff --name-only --diff-filter=ACMRD <base>..<head`; separately require a clean
  worktree. Add a temporary-repository/commit negative test, not a dependency-injected path-list unit test.

## ROOT-P1-002 — Verifier runtime provenance is syntax-checked, not verified

- **Evidence:** `verification/lib/verify-provenance.mjs:37-42` accepts any Node version matching a broad regex
  and any 64-hex executable digest. `:53-70` never compares recorded version/path/digest to `process.version`,
  `process.execPath`, or the executable bytes. The provenance manifest excludes itself from the input roster.
- **Hostile proof:** in a temporary full plan copy, replacing runtime metadata with `v99.0.0`, `/forged/node`,
  and 64 `f` characters produced `errors=[]` and `forged_runtime_accepted=true` from `verifyD0`.
- **Failure path:** a substituted runtime can claim arbitrary recorded provenance while the command remains
  green, contrary to APP-P1-001's executable-provenance predicate.
- **Narrow fix:** compare the recorded runtime to the actual version, canonical executable identity, and
  SHA-256 bytes (or produce a fresh immutable per-run observation that admission independently verifies). Add
  a forged-runtime negative control.

## ROOT-P1-003 — The 88-title source oracle is mutable self-consistency

- **Evidence:** `verification/lib/verify-mapping.mjs:153+` compares the canonical matrix only with
  `verification/frozen-audit.jsonl`; both are current-head writable inputs. `verify-history.mjs` validates the
  old c606 authority bundle but never compares current titles/dispositions with the historical matrix or the
  frozen audit source commit.
- **Hostile proof:** in a temporary plan copy, changing ARIA-AUDIT-001's title in both the matrix and frozen
  snapshot, regenerating projections and verifier-input digests, produced `errors=[]` and
  `forged_audit_source_accepted=true`.
- **Failure path:** exact audit titles/dispositions can be rewritten while the claimed 88/source-truth gate
  stays green.
- **Narrow fix:** compare current id/title/disposition directly to a fixed historical Git object already
  pinned by the immutable D0 evidence, or to the exact frozen-audit source commit/digest. Add a coordinated
  matrix+snapshot+manifest mutant.

## ROOT-P1-004 — Phase-gate artifacts are checked by count, not immutable semantics

- **Evidence:** `verification/lib/verify-mapping.mjs:110-150` checks the exact role list and gate
  sprints/mechanisms, but `required_artifacts` is accepted whenever its length is nine (`:134-135`).
- **Hostile proof:** in a temporary plan copy, replacing `distinct_principal` with `self_approval_allowed`
  while preserving length, then refreshing verifier-input digests, produced `errors=[]` and
  `forged_gate_semantics_accepted=true`.
- **Failure path:** the machine authority can remove independence, oracle, dissent, or zero-finding
  requirements without tripping APP-P1-003's executable predicate.
- **Narrow fix:** compare the entire ordered artifact roster (and schema/contract identity) exactly; add
  coordinated semantic-tamper mutants which refresh generic provenance so the semantic oracle, not a stale
  hash, must reject them.

## Controls independently reproduced

- Full verifier: PASS (`88/72/9/5`, D0 `VERIFYING`).
- Projection parity: PASS (`11`).
- Negative suite: PASS (`23`).
- Historic manifest, first four event bytes, 12 raw reports, exact branch/remote SHA and current
  protected-path diff: PASS at the reviewed bytes.

The green baseline demonstrates current-byte consistency; it does not refute the four false-green mutations
above.
