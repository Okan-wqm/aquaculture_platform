# Readiness claim — a policy this repository cannot satisfy (2026-10-03)

Context: `aria-readiness-claim` (`.github/workflows/aria-readiness-claim.yml`) assembles the enterprise readiness claim
the merge runner consumes before any ARIA autonomous merge. On `main`, 58 of its last 60 runs are red; the two green
ones skipped every step (no PR resolved for the completed run). Every red run fails the same way:
`enterprise_readiness_claim_rejected: branch_protection_proof_invalid; …signed_commits_required_required;
…reviews_required_required; …conversation_resolution_required_required; …code_owner_reviews_required;
…required_approving_review_count_unmeasured; …ruleset_ids_required; …merge_queue_required` (run 37143765894, head
405f2ecac).

IDs: ARIA-HIGH-321 (unsatisfiable policy), ARIA-MEDIUM-322 (lane semantics).

Owner: claude (ADR + implementation), okan (decision on the organization move). Deadline 2026-10-31, after the first
live end-to-end run; nothing here changes a gate during the rev3.1 freeze.

## The claim is unsatisfiable by construction

- `aria-kernel/aria_kernel/enterprise_readiness.py:622-623` requires a merge queue (squash, `preflight.py:156`;
  operator decision 2026-09-26, ARIA-HIGH-221). GitHub offers merge queues only in organization-owned repositories
  ([Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue));
  this repository is owned by a user account (`gh api repos/Okan-wqm/aquaculture_platform` → `owner.type: User`).
- `enterprise_readiness.py:608-609` requires code-owner reviews, and `:629-633` forbids any bypass actor. With one
  human code owner, every operator PR touching an owned path needs an approval nobody can give (GitHub does not let an
  author approve their own PR) and nobody may bypass. This is why the review rules were left off on 2026-10-02.

So ARIA's autonomous merge path (merge runner → claim → L1 merge) cannot open on this account whatever the code does.

## The lane reports a policy verdict as an infrastructure failure

- `.github/workflows/aria-readiness-claim.yml:264-275` lets `GovernanceError(enterprise_readiness_claim_rejected …)`
  fail the job. A measured "not ready" is a correct answer, not a fault; a lane that is red on every run hides the
  day it fails for a real reason.
- The state publish (`:345-366`) runs only when the claim step succeeded, so the CI-evidence rows the lane records
  (`:177-188`) are dropped on every rejection (same class as ARIA-HIGH-218 / ARIA-HIGH-222).

## Decision (to be written as one ADR after the first live run)

1. Move the repository into a free GitHub organization — the standard home for a bot-operated repository (merge
   queue, rulesets, App identities). Operator action; the migration checklist (GHCR image paths, self-hosted runner
   registration, App installation, deploy workflows, secrets/variables) ships with the ADR.
2. Replace "a person reviews code-owned paths" with an operator-signed approval of the exact head SHA (ADR-0023 keys),
   verified by `aria-merge-authority` as a required status check; the bypass list stays empty.
3. The lane records the verdict (ready / not ready + reasons) as data, publishes state whatever the verdict, and goes
   red only when it could not measure.
