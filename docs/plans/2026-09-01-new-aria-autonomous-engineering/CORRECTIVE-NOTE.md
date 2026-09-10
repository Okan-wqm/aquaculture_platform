# D0 Corrective Round 1 Note

[Review package](reviews/INDEX.md) · [Binding appellate report](reviews/12-appellate.md) ·
[Authority index](authority/INDEX.md) · [D0 verifier](verification/verify-d0.mjs)

Status: remediation is authored against reviewed head
`c6065d6dac97306f147de67ef58a96e3a67524ac`, but no `APP-*` finding is claimed closed. D0 stays
`VERIFYING` until a fresh exact-head twelve-role review and independent appellate verdict accepts
the corrected bytes. The existing materialization evidence and first four events remain immutable.

## APP-P1-001

- **Authority:** [evidence/hash contract](authority/verification-evidence.md),
  [history verifier](verification/lib/verify-history.mjs), versioned review evidence and event 5.
- **Predicate:** old bytes/digests, historical `git show` authority, strict canonical event chain,
  report/evidence digests and non-admission tail reproduce in a fresh clone.

## APP-P1-002

- **Authority:** [program map](verification/program-map.jsonl), PLAN/cards,
  [finding matrix](FINDING-COVERAGE.md), [mapping verifier](verification/lib/verify-mapping.mjs).
- **Predicate:** exact 88/72 rosters; PLAN/card acceptance and dependency equality; OP reverse index;
  distinct card-coverage and finding-owner relations; 015/023/076 mappings have zero drift.

## APP-P1-003

- **Authority:** [phase gates](verification/phase-gates.json),
  [twelve-role contract](authority/verification-evidence.md), all nine gate cards.
- **Predicate:** deleting/duplicating a role, principal, report, oracle, dissent or appellate result
  denies every gate; P01-P04 require `external-adversarial-review-v1`.

## APP-P1-004

- **Authority:** [identity/issuer contract](authority/identity-authority-tcb.md), S28/S50/S58.
- **Predicate:** human, low-risk and exact 3-of-3 medium issuers have exclusive capabilities;
  self/unknown/below-quorum issue, direct insert, swap, replay and double consume deny.

## APP-P1-005

- **Authority:** [canonical identity contract](authority/identity-authority-tcb.md), S04/S09/S18/S59.
- **Predicate:** issuer/audience/subject epoch, provider repository roles and cert/VM/UID/job bindings
  reject rename/recreate/fork/ref/cert/attestation substitution and replay.

## APP-P1-006

- **Authority:** [eight-role topology](authority/identity-authority-tcb.md),
  [broker envelope](authority/execution-supply-chain.md), S18/S20/S21.
- **Predicate:** pairwise host/UID/mount/secret/RPC/egress/capability/resource collisions fail;
  stale fence/cancel/reservation cannot spawn or admit CLI/provider work.

## APP-P1-007

- **Authority:** [supervisor cleanup contract](authority/execution-supply-chain.md), S19.
- **Predicate:** rename/symlink/bind-mount/path-reuse/active-lease mutants can destroy only the exact
  opaque disposable terminal volume; no raw recursive fallback exists.

## APP-P1-008

- **Authority:** [data ownership contract](authority/data-privacy.md), S03.
- **Predicate:** non-public `aria` schema, migration/drift gate and composite
  tenant/workspace/repository scope reject foreground/background/CAS substitution.

## APP-P1-009

- **Authority:** [data/privacy contract](authority/data-privacy.md), S14/S23/S39/S61.
- **Predicate:** pre-call full-payload DLP produces zero spawn/network on deny; quarantine is bounded
  and non-versioned; CAS rehash/encryption/redaction/capture/hold/delete races fail closed.

## APP-P1-010

- **Authority:** [execution/supply-chain contract](authority/execution-supply-chain.md), S20-S23.
- **Predicate:** binary/image/CLI/plugin/MCP/OS/runtime/lock/registry/lifecycle/signer drift blocks
  execution; two admitted clean builds reproduce or emit a denied nondeterminism witness.

## APP-P1-011

- **Authority:** [GitHub authority](authority/github-delivery.md), S25/S30/S31/S52.
- **Predicate:** narrowed token plus effective rules/bypass/base/head/review/trusted-check digest is
  re-read under lock; any drift invalidates the permit before merge dispatch.

## APP-P1-012

- **Authority:** [async merge/reconciliation contract](authority/github-delivery.md), S26/S31/S52.
- **Predicate:** local effect and provider UUID/options remain distinct; every status, 409 adoption,
  expiry/stack/crash/duplicate PR/check/pagination/response-loss case yields one match or denial.

## APP-P1-013

- **Authority:** [operations/DR contract](authority/operations-reliability.md), S45/S61/S68.
- **Predicate:** dispatch horizon, signed DB/object cut, independent backup domain and monotonic
  failover epoch reconcile behind-cut effects and fence the old region.

## APP-P1-014

- **Authority:** [capacity contract](authority/operations-reliability.md), S14/S17/S39/S41-S44.
- **Predicate:** charged-unknown holds, exact-once settlement, durable capped cooldown and aggregate
  count/byte/age limits survive restart; S43 cannot general-dispatch before S44 admission.

## APP-P1-015

- **Authority:** [promotion ordering](authority/operations-reliability.md), S39/S41/S43/S48/S52-S56.
- **Predicate:** out-of-band kill/page/revoke works through control/DB/droplet loss; S52 is disposable
  sandbox only, S54 rollback precedes S55, and S55 is the first production merge.

## APP-P1-016

- **Authority:** [API/UI contract](authority/api-ui.md), S06/S15/S46 and rows 073/074/082.
- **Predicate:** exact seven-query/nine-mutation schema, typed idempotency/version/result semantics,
  resumable gap recovery and five projection states reject duplicate/conflict/corrupt/unsafe actions.

## APP-P1-017

- **Authority:** [browser/integration contract](authority/api-ui.md), S06/S07/S41/S46/S60.
- **Predicate:** same-origin auth/CSRF/CORS/CSP/cache/revoke and direct-subgraph negatives pass; a
  clean host regenerates, builds, migrates, composes, serves and revokes `/aria` across all SSoTs.

## APP-P2-018

- **Authority:** [readability policy](verification/readability-policy.json),
  [generated projections](finding-projections/), [readability verifier](verification/lib/verify-readability.mjs).
- **Predicate:** numeric file/function/parameter/complexity and dependency direction reject god
  function/reverse import/forged exception; eight fixed ranges retain field/digest/link parity.

## Next review

The next evidence record must bind the final corrective commit, exact verifier argv/version/input
digests, all twelve fresh reports and the independent appellate result. It must be a new immutable
manifest/event; neither the original D0 materialization evidence nor this `CHANGES_REQUIRED` record
may be rewritten.
