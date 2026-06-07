<!-- ARIA-HISTORICAL: Historical plan document. Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# ARIA Plan 011: Architecture-First Intelligence

## Summary

Plan 011 makes ARIA adoption-aware and architecture-first. ARIA must not recommend replacing a load-bearing technology merely because another option is newer, and it must not hide root causes behind local patches. The default posture is to keep established technology, correct ownership and boundaries, then migrate incrementally only when hard evidence justifies it.

## Key Changes

- Technology reviews classify actions as `fix_in_place`, `harden_boundary`, `introduce_abstraction`, `incremental_refactor`, `replace_with_adr`, or `emergency_patch`.
- Adoption gravity is computed from repo evidence refs; high adoption blocks replacement unless hard replacement grounds, migration plan, and rollback plan exist.
- Normal architecture option sets exclude patch actions and prefer boundary hardening or abstraction for repeated cross-file patterns.
- Replacement grounds are explicit and narrow: unsupported technology, unpatched critical CVE, compliance/license blocker, accepted ADR conflict, recurring production failure, or target-architecture conflict.
- Emergency patching requires a cleanup task; repeated pattern fixes without a boundary are blocked as `architecture_incomplete`.
- Architecture reviews and option sets are recorded in hash-chained ledgers and exposed through the `architecture` CLI.

## Acceptance

- A high-adoption Redis replacement request without hard evidence is blocked and recommends abstraction/boundary work instead.
- A Redis hardening proposal with authoritative refs, repo priors, boundary, and validation commands can reach `ready_for_architecture_review`.
- A repeated cross-file `fix_in_place` proposal is blocked as architecture incomplete.
- A low-adoption unsupported package can pass `replace_with_adr` only with hard grounds, migration plan, rollback plan, and validation.
- Unknown replacement grounds such as “newer technology exists” are rejected.

## Assumptions

- Repo adoption is load-bearing evidence.
- Best-practice research informs hardening before replacement.
- Load-bearing replacement still requires ADR/operator review before any apply path.
- Kernel self-change remains under the dedicated 2-person PR gate.
