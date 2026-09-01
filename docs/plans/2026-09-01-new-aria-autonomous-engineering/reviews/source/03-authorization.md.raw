# D0 adversarial review — authorization / TCB / separation of duty

## Verdict

`CHANGES_REQUIRED`

The access predicate, protected-TCB inventory, producer/reviewer prohibition, runtime role split,
risk-tier progression, high-risk deny boundary, and human release/deploy boundary are stated
clearly. However, D0 never assigns step-up or merge-permit issuance to an immutable authority
principal. That leaves the central authorization edge open to an implementation in which a
consumer mints its own authority. Two authorization-relevant finding mappings are also internally
inconsistent or bound to the wrong phase acceptance path.

## Findings

### P1-01 — Step-up and merge-permit issuers are absent from the authority model

**Evidence:**

- `docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:79-88` assigns
  `merge-authority` permit consumption and gives `policy-attestor` attestation-write capability,
  but assigns no role the authority to issue a step-up grant or merge permit.
- `docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P04.md:41-51` requires grant
  mint/verify/consume but never identifies the minting principal, its credential, its DB/KMS
  capability, or a prohibition on issuer/consumer identity overlap.
- `docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P07.md:17-27` repeats the omission
  for low-risk autonomous merge permits.
- `docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P08.md:17-27` says medium risk uses
  independent multi-authority quorum, but does not name the authority classes/threshold that may
  cause permit issuance or the principal that performs issuance.
- `docs/plans/2026-09-01-new-aria-autonomous-engineering/PLAN.md:101-110` maps production,
  attestation, publication, merge, and release, but has no row for grant/permit issuance.

**Consequence:** A conforming implementation could allow `control`, `merge-authority`, or another
DB-writing runtime identity to mint the exact grant/permit it later consumes. Cryptographic
binding, expiry, and atomic single use would then prevent replay but would not provide separation
of duty. Medium-risk "multi-authority" could likewise degrade into an unspecified set of votes or
a single operational trust domain.

**Minimal fix:** Add issuance rows to the design and PLAN authority matrices. Name the immutable
issuer principal(s) for (1) human step-up grants, (2) low-risk autonomous permits, and (3)
medium-risk permits; define the exact protected prerequisites/quorum categories; bind issuer and
audience in the signed envelope; give issuers mutually exclusive KMS/DB capabilities from
consumers; and prohibit issuer/consumer and producer/approver identity overlap. Extend S28, S50,
and S58 negatives with unauthorized issuer, issuer-equals-consumer, direct permit-ledger insert,
wrong audience, and below-quorum issuance cases.

**Checks:** Re-review the completed authority/capability graph for an explicit issuer on every
`ISSUED` transition. Mutation tests must prove that removal of any required issuer/quorum edge and
direct writes by `control`, `publisher`, `policy-attestor`, or `merge-authority` cannot create a
consumable grant/permit.

### P2-01 — ARIA-AUDIT-015 owner range and acceptance/card coverage disagree

**Evidence:**

- `docs/plans/2026-09-01-new-aria-autonomous-engineering/FINDING-COVERAGE.md:41` assigns owners
  `S27-S29, S50, S58, S66-S69`, which expands to include S68, but its acceptance list omits
  `ACC-S68`.
- `docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P09.md:41-51` does not list
  `ARIA-AUDIT-015` or an approval-envelope control in S68.
- `docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P09.md:53-63` assigns the approval
  pressure test to S69, consistent with the existing `ACC-S69` entry.

**Consequence:** The future S38 machine-readable coverage contract cannot determine whether S68 is
a required closure owner. One projection can require S68 while an acceptance-derived projection
can mark the finding's planned proof path complete without it.

**Minimal fix:** If S68 is not intended to own this control, change the owner suffix to
`S66-S67, S69`. If S68 is intended, add `ACC-S68` and add an explicit approval-envelope negative
control plus `ARIA-AUDIT-015` to the S68 card.

**Checks:** Expanding every sprint range and comparing it with parsed `ACC-Snn` values must produce
zero missing/extra acceptance IDs. The same check must compare each expanded owner with its phase
card finding list.

### P2-02 — ARIA-AUDIT-076 is not mapped to the sprints that exercise GitHub authority

**Evidence:**

- The frozen finding requires exact capability introspection before an effective operation, and
  `docs/plans/2026-09-01-new-aria-autonomous-engineering/FINDING-COVERAGE.md:102` promises a live
  capability/permission negative probe. Its owners are only S04, S29, S54, S66, and S69.
- S04's tests are application access-predicate tests
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P01.md:41-51`), while S29 is a
  code/operator-attested policy-admission sprint, not live provider permission evidence
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P04.md:53-63`).
- The actual GitHub permission/token/readback controls live in S25
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P04.md:5-15`), S31
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P04.md:77-87`), and S52
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P07.md:41-51`), but none is an owner
  or acceptance ID in the ARIA-AUDIT-076 row.

**Consequence:** The mapped closure path can satisfy the row without demonstrating that the
Publisher and Merge Apps possess exactly the repository/action/permission/expiry/actor authority
used at the mutating boundary. This preserves the original config/presence-preflight failure mode
in the executable finding program even though related tests exist elsewhere in the plan.

**Minimal fix:** Add S25 and S52 (and S31 if its sandbox permission probe is an independent required
witness) with matching acceptance IDs to ARIA-AUDIT-076. Make S52 explicitly bind live capability
introspection to the immutable merge effect envelope immediately before dispatch; keep S54/S69 for
the distinct human release boundary.

**Checks:** For publisher, merge, and release principals, test missing permission, wrong App/actor,
wrong repository/workspace, expired/revoked credential, bypass permission, and capability change
between admission and dispatch. Each failure must prevent the external call, not merely alter a
report.

## Controls verified

- Exact base access predicate and header rejection:
  `docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:95-101` and
  `docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P01.md:41-51`.
- Operator-owned TCB inventory and explicit write/activate/omitted-path negatives:
  `docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:103-106` and
  `docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P01.md:53-63`.
- Publisher, attestor, merger, executor, and release capabilities are otherwise separated; Merge
  App has no bypass and ARIA has no release/deploy capability:
  `docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:79-92,197-210`.
- Producer self-approval and transport-to-semantic-verdict promotion are explicitly attacked in
  S27, S34-S37, and S67/S70.
- Low-risk is explicit semantic allowlist only, medium risk is deny-by-default with prohibited
  boundary, and high-risk execution/merge remains unreachable through S72:
  `docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P07.md:5-15`,
  `docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P08.md:5-27`, and
  `docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P09.md:5-27,89-99`.
- Human release/deploy and exact-deployed-SHA closure remain explicit:
  `docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P07.md:53-75` and
  `docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P09.md:53-63`.
- I checked all 88 coverage rows and inspected the authorization-relevant mappings, including
  012-020, 024, 032, 036-037, 045, 047-048, 051, 057-059, 065, 068, 075-076, and 079. Apart from
  P2-01 and P2-02 above, their stated controls align with the cited phase objectives/negative
  controls at D0 planning granularity.

## Review checks performed

- Read the root `CLAUDE.md`, adversarial brief, task contract, implementer report, complete design,
  PLAN, all nine phase cards, all 88 finding rows, progress/evidence artifacts, format-scope diff,
  and frozen source findings relevant to authorization.
- Inspected the full frozen review diff and independently compared the exact base/head changed-file
  set. It is documentation-only plus the generated format-scope manifest; protected legacy ARIA
  and workflow paths have zero diff.
- `git diff --check eeb401131260fe45f3f60be55fa25d023a082d18..c6065d6dac97306f147de67ef58a96e3a67524ac`
  passed.
- A range-expansion check over all 88 matrix rows found exactly one owner/acceptance mismatch:
  ARIA-AUDIT-015 missing S68 acceptance coverage.
