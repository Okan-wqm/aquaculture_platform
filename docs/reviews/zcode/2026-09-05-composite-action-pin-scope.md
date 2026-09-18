# Composite-action pin scope — second branch sweep, 2026-09-05

Reviewer: zcode. Cycle: `2026-09-05-branch-sweep`. Target: `origin/main` @ `7e55d2a1a`.

## INFRA-MEDIUM-160 — composite actions were watched by nothing

**Severity:** MEDIUM. **Owner:** infra-expert. **State:** IN-PROGRESS.

**Evidence.** Evaluating the last unmerged dependabot branch
(`dependabot/github_actions/actions/setup-node-7.0.0`) showed main carrying `actions/setup-node`
at three versions simultaneously: 57 usages on v7.0.0, `.github/workflows/ci-full.yml:257` and
`.github/workflows/db-migration-check.yml:534` on v6.4.0, and
`.github/actions/setup-node-env/action.yml:48` on **v4.2.0**. Widening the check to every
third-party action showed the same shape elsewhere:
`.github/actions/docker-build-push/action.yml:90` on `docker/build-push-action` v5.1.0 while
twelve workflow usages are on v7.3.0, and `.github/actions/setup-aria-kernel/action.yml:49` on
`actions/setup-python` v6.3.0 against v7.0.0 in `ci-affected.yml`.

Every long-stale pin but the two workflow lines lives under `.github/actions/**`, and that is not
a coincidence — two independent mechanisms both stop at the workflows directory:

- `.github/dependabot.yml` declares the `github-actions` ecosystem with `directory: /`, which
  covers `.github/workflows/**` and the repo-root action manifest. A composite action at
  `.github/actions/<name>/action.yml` needs its own directory entry, so Dependabot never proposed
  a single bump for one.
- `tests/invariants/aria-workflow-sha-pin.spec.ts` read `.github/workflows/` only, so the gate
  that proves every action is SHA-pinned had never looked at those files either.

**Rule violated.** A composite action runs third-party action code in exactly the same trust
position as a workflow step. A file in that position must be watched by the same pin gate and the
same update automation, whatever directory it lives in.

**Fix.**

- `.github/dependabot.yml` — the `github-actions` ecosystem now takes `directories: ['/',
'/.github/actions/*']`. The glob is deliberate: a composite action added later is covered without
  another edit here, so the automation cannot silently narrow again.
- `tests/invariants/aria-workflow-sha-pin.spec.ts` — `scanWorkflow` became `scanUsesFile` and a
  second case walks every `action.yml`/`action.yaml` the repo owns. It passes on today's tree
  (all composite pins are SHAs); it exists so a mutable tag introduced there fails at PR time
  instead of living for months.
- The three stale `actions/setup-node` pins are consolidated on
  `820762786026740c76f36085b0efc47a31fe5020` (v7.0.0) — 60 of 60 usages now agree. This is the
  content of the dependabot branch, completed: the branch bumped the two workflow lines and could
  not have seen the composite action.

**Not fixed here, by design.** `docker/build-push-action` v5.1.0 → v7.3.0 and
`actions/setup-python` v6.3.0 → v7.0.0 in the composite actions are major bumps with behaviour
risk that no test in this repo exercises. Dependabot now proposes them as reviewable PRs, which is
the correct path for a major bump; hand-bumping them blind in this commit would be the failure mode
this finding is about, in the other direction.

**Closure criterion.** `aria-workflow-sha-pin.spec.ts` passes with both cases; every
`actions/setup-node` pin under `.github/` resolves to one SHA; a Dependabot run opens (or has no
work for) `/.github/actions/*`.
