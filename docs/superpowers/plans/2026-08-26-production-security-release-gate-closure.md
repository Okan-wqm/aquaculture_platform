# Production Security Release Gate Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining security release-control gaps, prove the final tree locally and in
protected GitHub Actions, squash-merge it to `main`, and complete the post-merge finding ceremony.

**Architecture:** Keep the protected context names unchanged and strengthen the work they attest to.
One required Rust job owns all independently resolved release graphs; CI publishes separate
validation and deployment intent; Dependabot owns multi-directory graphs without overlap;
Hydroponics becomes a normal jsdom/Nx test consumer; and both WASM builds consume locked, audited
dependency graphs.

**Tech Stack:** GitHub Actions, dorny/paths-filter, Dependabot v2, Jest/ts-jest invariants, Nx
22.7.8, Vitest 3.2.7, jsdom, Rust 1.88.0, cargo-audit, wasm-bindgen 0.2.127, npm 10+, GitHub CLI.

**Spec:** `docs/superpowers/specs/2026-08-26-security-release-gate-closure-design.md`

## Global Constraints

- Work only in `/var/aqua-saas/.worktrees/security-release-hardening` on
  `security/production-hardening-20260825` until the first PR is merged.
- Read root `CLAUDE.md` and the applicable nested `CLAUDE.md` before editing; NATS identity, entity
  schema, root-cause-only, and no-bypass rules remain in force.
- Preserve the required context names `sens-enterprise-summary`, `merge-gate`,
  `aria-merge-authority`, and `build-status`; do not edit
  `.github/manifests/main-required-status-checks.json` for this work.
- Never use `continue-on-error`, `|| true`, missing-output fallbacks, administrator bypass,
  `--no-verify`, `--no-gpg-sign`, force push, or direct manual deployment.
- `has_changes` means validation/audit work is required; `deploy_changes` alone authorizes
  staging/production workflow calls.
- Root and AquaMobil npm updates use one multi-directory authority with `versioning-strategy:
increase` and `group-by: dependency-name`; `/e2e` stays independent.
- Root and the two standalone WASM Cargo directories have explicit update ownership; edge and fuzz
  keep documented exceptions but required audit coverage.
- Pin both WASM crates and the local generation command to `wasm-bindgen = 0.2.127`. crates.io
  reports crate MSRV 1.77 and CLI MSRV 1.86, both compatible with repository Rust 1.88.0.
- Use TDD for every behavior change: record the expected red failure, make the smallest
  production/configuration change, and rerun the same command green.
- Every implementation commit is signed and immediately pushed normally. `security(...)` commits
  carry the canonical `SUPPLY-HIGH-003` trailer. The Hydroponics-only `test(...)` commit does not
  claim an unrelated finding.
- The first PR uses squash merge because existing commit `6328f364d` has a non-canonical `docs(...)`
  type. Its squash body must carry all four genuine finding trailers so the post-merge registry
  ceremony has one `origin/main`-reachable authority SHA.
- The initial unconstrained full test run is not passing evidence. Normalize executable worktree
  modes from the Git index and use controlled Nx parallelism for the final run.

---

## File Responsibility Map

| File                                                                     | Responsibility in this plan                                                                                                |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci-affected.yml`                                      | Produces CI/deploy intent, runs the required Rust audit authority, and invokes deployment only for deploy-capable changes. |
| `.github/workflows/rust-ci.yml`                                          | Re-runs the advisory-ignore synchronization gate whenever the required affected workflow changes.                          |
| `.github/dependabot.yml`                                                 | Owns root/AquaMobil npm and root/WASM Cargo update graphs without overlapping entries.                                     |
| `scripts/ci/check-advisory-ignore-sync.ts`                               | Keeps the new required edge audit ignore list identical to every existing edge audit policy surface.                       |
| `tests/invariants/dependency-security-floor.spec.ts`                     | Executes the change-classifier shell and proves E2E audit-only behavior plus the Hydroponics Vitest floor.                 |
| `tests/invariants/dependabot-lockfile-coverage.spec.ts`                  | Proves every lock has update/audit ownership and that the required/optional edge policies do not drift.                    |
| `tests/invariants/wasm-lock-build-contract.spec.ts`                      | Proves both WASM manifests, locks, build scripts, and Nx cache inputs share one reproducibility contract.                  |
| `crates/{alarm-core-wasm,protocol-codec-wasm}/Cargo.toml`                | Pins the binding crate version and declares each graph as a standalone Cargo workspace.                                    |
| `crates/{alarm-core-wasm,protocol-codec-wasm}/Cargo.lock`                | Freezes the two independently resolved WASM graphs.                                                                        |
| `libs/{alarm-core,protocol-codec}/project.json`                          | Makes each standalone lock an Nx cache input.                                                                              |
| `libs/{alarm-core,protocol-codec}/scripts/build-wasm.sh`                 | Refuses CLI version drift and builds with `cargo build --locked`.                                                          |
| `libs/{alarm-core,protocol-codec}/src/generated/*`                       | Stores regenerated Node bindings produced by 0.2.127.                                                                      |
| `web/modules/hydroponics-module/package.json`                            | Declares its Vitest runner and direct test dependencies.                                                                   |
| `web/modules/hydroponics-module/vite.config.ts`                          | Supplies jsdom and shared Vitest policy.                                                                                   |
| `web/modules/hydroponics-module/src/test-setup.ts`                       | Installs jest-dom matchers.                                                                                                |
| `web/modules/hydroponics-module/project.json`                            | Adds shared-ui build ordering to the inferred Nx test target.                                                              |
| `package-lock.json`                                                      | Resolves the new Hydroponics test declarations in the canonical npm graph.                                                 |
| `tools/quality/coverage-report-inventory.json`                           | Adds Hydroponics' lcov producer to the governed report inventory.                                                          |
| `tests/invariants/coverage-evidence-contract.spec.ts`                    | Updates the exact governed coverage/Vitest producer counts for Hydroponics.                                                |
| `docs/reviews/security-reviewer/2026-08-25-production-security-audit.md` | Records corrected final evidence while staying `IN-PROGRESS` until merge.                                                  |
| `tools/quality/format-scope.json`                                        | Generated file inventory for the plan/new invariant/doc surfaces.                                                          |

The release-authority tasks stay in one plan because `.github/workflows/ci-affected.yml`, lock
ownership, and the cross-lock invariants form one protected attestation. Hydroponics and WASM remain
separate, independently reviewable commits within that plan.

---

### Task 1: Required CI Release Authority

**Files:**

- Modify: `tests/invariants/dependency-security-floor.spec.ts`
- Modify: `tests/invariants/dependabot-lockfile-coverage.spec.ts`
- Modify: `.github/workflows/ci-affected.yml`
- Modify: `scripts/ci/check-advisory-ignore-sync.ts`
- Modify: `.github/workflows/rust-ci.yml`

**Interfaces:**

- Consumes: dorny outputs `apps`, `libs`, `web`, `infra_image`, `deploy-config`, and new
  `audit_only`; the edge audit commands and canonical ignore list in
  `sens-api-gateway/.cargo/audit.toml`.
- Produces: string outputs `has_changes` and `deploy_changes`; required job `sens-api-gateway-rust`
  with root, edge, fuzz, and two WASM audit steps.

- [ ] **Step 1: Write the failing executable classifier contract**

Extend the existing workflow test types so steps have `id`, jobs have `if` and `outputs`, and add
this helper beside the existing repository read helpers:

```ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

function executeChangeClassifier(
  script: string,
  values: Readonly<Record<string, 'true' | 'false'>>,
): Readonly<Record<string, string>> {
  const directory = mkdtempSync(resolve(tmpdir(), 'aqua-change-classifier-'));
  const outputPath = resolve(directory, 'github-output');
  const rendered = script.replace(
    /\$\{\{ steps\.changes\.outputs\.([a-z_-]+) \}\}/g,
    (_match, name: string) => values[name] ?? 'false',
  );
  try {
    execFileSync('bash', ['-c', `set -euo pipefail\n${rendered}`], {
      cwd: REPO_ROOT,
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
    });
    return Object.fromEntries(
      readFileSync(outputPath, 'utf8')
        .trim()
        .split(/\r?\n/)
        .map((line) => line.split('=', 2) as [string, string]),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
```

Replace `routes standalone E2E dependency changes through the affected security gate` with:

```ts
test('keeps E2E-only changes inside CI without granting deploy authority', () => {
  const workflow = YAML.parse(readRepoFile('.github/workflows/ci-affected.yml')) as Workflow;
  const detect = workflow.jobs?.['detect-changes'];
  const filtersSource = detect?.steps?.find((step) => step.id === 'changes')?.with?.filters;
  const filters = YAML.parse(String(filtersSource ?? '')) as Record<string, string[]>;
  const classifier = detect?.steps?.find((step) => step.id === 'check')?.run ?? '';

  expect(filters.audit_only).toEqual(['e2e/**']);
  expect(filters['deploy-config']).not.toContain('e2e/**');
  expect(detect?.outputs).toMatchObject({
    has_changes: '${{ steps.check.outputs.has_changes }}',
    deploy_changes: '${{ steps.check.outputs.deploy_changes }}',
  });
  expect(executeChangeClassifier(classifier, { audit_only: 'true' })).toEqual({
    has_changes: 'true',
    deploy_changes: 'false',
  });
  expect(executeChangeClassifier(classifier, { apps: 'true' })).toEqual({
    has_changes: 'true',
    deploy_changes: 'true',
  });

  for (const jobName of ['deploy-staging', 'deploy-production']) {
    const condition = workflow.jobs?.[jobName]?.if ?? '';
    expect(condition).toContain("needs.detect-changes.outputs.deploy_changes == 'true'");
    expect(condition).not.toContain('outputs.has_changes');
  }
  expect(workflow.jobs?.['security-audit']?.if).toContain(
    "needs.detect-changes.outputs.has_changes == 'true'",
  );
});
```

- [ ] **Step 2: Run the classifier test and capture the expected red result**

Run:

```bash
npx jest --config tests/invariants/jest.config.ts --runInBand \
  --runTestsByPath tests/invariants/dependency-security-floor.spec.ts \
  -t "keeps E2E-only changes inside CI without granting deploy authority"
```

Expected: FAIL because `audit_only` and `deploy_changes` do not exist and both deploy jobs still
consume `has_changes`.

- [ ] **Step 3: Write the failing required Rust-audit contract**

In `dependabot-lockfile-coverage.spec.ts`, add `requiredWorkflowPath`,
`rustWorkflowPath`, and `ignoreSyncPath`; extend `WorkflowConfig` with job
`needs` plus `on.push.paths`/`on.pull_request.paths`; and replace the misleading
single fuzz test with these assertions:

```ts
const requiredWorkflowPath = resolve(repoRoot, '.github/workflows/ci-affected.yml');
const rustWorkflowPath = resolve(repoRoot, '.github/workflows/rust-ci.yml');
const ignoreSyncPath = resolve(repoRoot, 'scripts/ci/check-advisory-ignore-sync.ts');

it('audits every independently resolved Rust lock in the required Sens gate', () => {
  const workflow = parse(readFileSync(requiredWorkflowPath, 'utf8')) as WorkflowConfig;
  const job = workflow.jobs?.['sens-api-gateway-rust'];
  const steps = job?.steps ?? [];

  expect(steps.find((step) => step.name === 'Install cargo-audit (precompiled)')).toMatchObject({
    uses: 'taiki-e/install-action@6c6fd71fe4fb72c3697d269963d0e15df8adedad',
    with: { tool: 'cargo-audit' },
  });
  expect(steps.find((step) => step.name === 'Audit root lockfile')?.run).toBe(
    'cargo audit --deny warnings',
  );
  expect(steps.find((step) => step.name === 'Audit fuzz lockfile')).toMatchObject({
    'working-directory': 'sens-api-gateway',
    run: 'cargo audit --file fuzz/Cargo.lock',
  });
  expect(steps.find((step) => step.name === 'Audit alarm-core WASM lockfile')?.run).toBe(
    'cargo audit --file crates/alarm-core-wasm/Cargo.lock --deny warnings',
  );
  expect(steps.find((step) => step.name === 'Audit protocol-codec WASM lockfile')?.run).toBe(
    'cargo audit --file crates/protocol-codec-wasm/Cargo.lock --deny warnings',
  );

  const summary = workflow.jobs?.['sens-enterprise-summary'];
  expect(summary?.needs).toContain('sens-api-gateway-rust');
  expect(summary?.steps?.map((step) => step.run ?? '').join('\n')).toContain(
    'needs.sens-api-gateway-rust.result',
  );
});

it('keeps required edge audit policy aligned with the optional edge workflow', () => {
  const required = parse(readFileSync(requiredWorkflowPath, 'utf8')) as WorkflowConfig;
  const optional = parse(readFileSync(edgeWorkflowPath, 'utf8')) as WorkflowConfig;
  const requiredSteps = required.jobs?.['sens-api-gateway-rust']?.steps ?? [];
  const optionalSteps = optional.jobs?.audit?.steps ?? [];

  for (const name of ['Audit gateway lockfile', 'Audit fuzz lockfile']) {
    const requiredStep = requiredSteps.find((step) => step.name === name);
    const optionalStep = optionalSteps.find((step) => step.name === name);
    expect(requiredStep?.run).toBe(optionalStep?.run);
    expect(requiredStep?.['working-directory']).toBe('sens-api-gateway');
    expect(optionalStep?.['working-directory']).toBe('${{ env.SENS_API_GATEWAY_DIR }}');
  }
});

it('reruns advisory lock-step governance when the required edge audit changes', () => {
  const syncSource = readFileSync(ignoreSyncPath, 'utf8');
  const rustWorkflow = parse(readFileSync(rustWorkflowPath, 'utf8')) as WorkflowConfig;

  expect(syncSource).toContain("'.github/workflows/ci-affected.yml'");
  for (const eventName of ['push', 'pull_request'] as const) {
    expect(rustWorkflow.on?.[eventName]?.paths).toContain('.github/workflows/ci-affected.yml');
  }
});
```

Add `uses?: string`, `with?: Record<string, string>`, and `needs?: readonly string[]` to the local
workflow types used by those assertions.
Add this event shape at the `WorkflowConfig` level:

```ts
readonly on?: Readonly<
  Record<'push' | 'pull_request', { readonly paths?: readonly string[] }>
>;
```

- [ ] **Step 4: Run the Rust authority test and capture the expected red result**

Run:

```bash
npx jest --config tests/invariants/jest.config.ts --runInBand \
  --runTestsByPath tests/invariants/dependabot-lockfile-coverage.spec.ts \
  -t "audits every independently resolved Rust lock|required edge audit policy|advisory lock-step
governance"
```

Expected: FAIL because the required Sens job only performs `cargo check`, the
lock-step script does not scan this required audit surface, and Rust CI does not
rerun when that surface changes.

- [ ] **Step 5: Implement the two-output change classifier**

In the dorny filter block, remove `e2e/**` from `deploy-config` and add:

```yaml
audit_only:
  - 'e2e/**'
```

Map the additional output:

```yaml
outputs:
  docs_changed: ${{ steps.changes.outputs.docs }}
  has_changes: ${{ steps.check.outputs.has_changes }}
  deploy_changes: ${{ steps.check.outputs.deploy_changes }}
  infra_image_changed: ${{ steps.changes.outputs.infra_image }}
  is_pr: ${{ github.event_name == 'pull_request' }}
```

Replace the `check` shell with a complete two-value classifier that writes each output once:

```bash
deploy_changes=false
if [ "${{ steps.changes.outputs.apps }}" = "true" ] || \
   [ "${{ steps.changes.outputs.libs }}" = "true" ] || \
   [ "${{ steps.changes.outputs.web }}" = "true" ] || \
   [ "${{ steps.changes.outputs.infra_image }}" = "true" ] || \
   [ "${{ steps.changes.outputs.deploy-config }}" = "true" ]; then
  deploy_changes=true
fi

has_changes="$deploy_changes"
if [ "${{ steps.changes.outputs.audit_only }}" = "true" ]; then
  has_changes=true
fi

echo "has_changes=$has_changes" >> "$GITHUB_OUTPUT"
echo "deploy_changes=$deploy_changes" >> "$GITHUB_OUTPUT"
```

Change only the staging and production workflow-call predicates from `has_changes` to
`deploy_changes`. All CI, audit, and required summary predicates keep `has_changes`.

- [ ] **Step 6: Implement the required Rust audit steps before TPM compilation setup**

Insert these steps after the Rust toolchain step and before TPM dependencies:

```yaml
- name: Install cargo-audit (precompiled)
  uses: taiki-e/install-action@6c6fd71fe4fb72c3697d269963d0e15df8adedad # v2.85.10
  with:
    tool: cargo-audit
- name: Audit root lockfile
  run: cargo audit --deny warnings
- name: Audit gateway lockfile
  working-directory: sens-api-gateway
  run: |
    cargo audit --deny warnings \
      --ignore RUSTSEC-2023-0071 \
      --ignore RUSTSEC-2025-0141 \
      --ignore RUSTSEC-2024-0388 \
      --ignore RUSTSEC-2023-0089 \
      --ignore RUSTSEC-2026-0173 \
      --ignore RUSTSEC-2024-0436
- name: Audit fuzz lockfile
  working-directory: sens-api-gateway
  run: cargo audit --file fuzz/Cargo.lock
- name: Audit alarm-core WASM lockfile
  run: cargo audit --file crates/alarm-core-wasm/Cargo.lock --deny warnings
- name: Audit protocol-codec WASM lockfile
  run: cargo audit --file crates/protocol-codec-wasm/Cargo.lock --deny warnings
```

- [ ] **Step 7: Prove both contracts green and keep required context governance unchanged**

Add `.github/workflows/ci-affected.yml` as a fourth edge workflow in
`scripts/ci/check-advisory-ignore-sync.ts`, update its governed surface comments
from eight to nine and its final workflow count from three to four, and add that
workflow path to both the `push.paths` and `pull_request.paths` lists in
`.github/workflows/rust-ci.yml`. This makes any future edit to the required edge
audit rerun the lock-step policy gate.

Run:

```bash
npx jest --config tests/invariants/jest.config.ts --runInBand \
  --runTestsByPath \
  tests/invariants/dependency-security-floor.spec.ts \
  tests/invariants/dependabot-lockfile-coverage.spec.ts
node scripts/ci/check-advisory-ignore-sync.ts
npm run gates:required-status-checks
git diff --check
```

Expected: both invariant files PASS, the required-status manifest gate PASS, and
`.github/manifests/main-required-status-checks.json` remains untouched.

- [ ] **Step 8: Commit and push the CI release authority**

```bash
git add .github/workflows/ci-affected.yml \
  .github/workflows/rust-ci.yml \
  scripts/ci/check-advisory-ignore-sync.ts \
  tests/invariants/dependency-security-floor.spec.ts \
  tests/invariants/dependabot-lockfile-coverage.spec.ts
git commit -m "security(ci): bind audits to release intent" \
  -m "Separate validation from deployment authority and make every independently resolved Rust graph
fail closed inside the existing protected Sens summary." \
  -m "Closes:
docs/reviews/security-reviewer/2026-08-25-production-security-audit.md#SUPPLY-HIGH-003"
git push
```

Expected: signed commit, pre-commit/pre-push hooks green, normal push succeeds.

---

### Task 2: Non-overlapping Dependency Update Ownership

**Files:**

- Modify: `tests/invariants/dependabot-lockfile-coverage.spec.ts`
- Modify: `.github/dependabot.yml`

**Interfaces:**

- Consumes: `DependabotUpdate.directories`, `versioning-strategy`, and `groups.*.group-by` parsed by
  the lock coverage invariant.
- Produces: one npm authority for `/` plus `/web/apps/aquamobil`, one Cargo authority for `/` plus
  both WASM crates, and independent `/e2e` ownership.

- [ ] **Step 1: Write the failing ownership assertions**

Add `'group-by'?: string` to the group type, remove the two WASM entries from
`DOCUMENTED_EXCLUSIONS`, and replace the AquaMobil `lockfile-only` test with:

```ts
it('gives root and AquaMobil one atomic npm update authority', () => {
  const authorities = (config().updates ?? []).filter((update) => {
    if (update['package-ecosystem'] !== 'npm') return false;
    const directories = update.directories ?? [update.directory ?? '/'];
    return directories.some((directory) => ['/', '/web/apps/aquamobil'].includes(directory));
  });

  expect(authorities).toHaveLength(1);
  const authority = authorities[0];
  expect(authority?.directory).toBeUndefined();
  expect(authority?.directories).toEqual(['/', '/web/apps/aquamobil']);
  expect(authority?.['versioning-strategy']).toBe('increase');
  expect(Object.values(authority?.groups ?? {})).toContainEqual({
    'group-by': 'dependency-name',
  });
});

it('gives root and production WASM locks one Cargo update authority', () => {
  const cargo = config().updates?.filter((update) => update['package-ecosystem'] === 'cargo');

  expect(cargo).toHaveLength(1);
  expect(cargo?.[0]?.directory).toBeUndefined();
  expect(cargo?.[0]?.directories).toEqual([
    '/',
    '/crates/alarm-core-wasm',
    '/crates/protocol-codec-wasm',
  ]);
});
```

Keep edge and fuzz in `DOCUMENTED_EXCLUSIONS`, but rewrite both reasons to name the required
`sens-api-gateway-rust` audit authority rather than only the optional edge workflow.

- [ ] **Step 2: Run the ownership tests and capture the expected red result**

```bash
npx jest --config tests/invariants/jest.config.ts --runInBand \
  --runTestsByPath tests/invariants/dependabot-lockfile-coverage.spec.ts \
  -t "atomic npm update authority|production WASM locks|exclusion list"
```

Expected: FAIL because npm has two overlapping entries and the standalone WASM directories have no
updater.

- [ ] **Step 3: Replace the npm entries with one atomic authority**

Keep the root npm schedule, limits, labels, reviewer, and commit prefix, but use this
directory/group contract:

```yaml
- package-ecosystem: npm
  directories:
    - /
    - /web/apps/aquamobil
  schedule:
    interval: weekly
    day: monday
    time: '06:00'
    timezone: Europe/Istanbul
  open-pull-requests-limit: 5
  versioning-strategy: increase
  commit-message:
    prefix: 'chore(deps)'
    include: scope
  labels:
    - dependencies
  reviewers:
    - Okan-wqm
  groups:
    npm-by-dependency:
      group-by: dependency-name
```

Delete the separate `/web/apps/aquamobil` `lockfile-only` block. Leave `/e2e` unchanged. GitHub's
current options reference explicitly supports `directories`, Cargo/npm `group-by: dependency-name`,
and `versioning-strategy: increase`; cross-directory grouping applies to version updates.

- [ ] **Step 4: Give the two standalone WASM locks Cargo update ownership**

Change the existing Cargo entry from `directory` to:

```yaml
directories:
  - /
  - /crates/alarm-core-wasm
  - /crates/protocol-codec-wasm
```

Preserve its weekly schedule, limits, labels, reviewer, commit prefix, and existing
`cargo-minor-patch` group. Do not add `sens-api-gateway` or `sens-api-gateway/fuzz` to this
authority.

- [ ] **Step 5: Prove all lockfiles are covered without overlap**

```bash
npx jest --config tests/invariants/jest.config.ts --runInBand \
  --runTestsByPath tests/invariants/dependabot-lockfile-coverage.spec.ts
npx prettier --check .github/dependabot.yml \
  tests/invariants/dependabot-lockfile-coverage.spec.ts
git diff --check
```

Expected: every coverage/ownership assertion PASS and no stale exclusion remains.

- [ ] **Step 6: Commit and push update ownership**

```bash
git add .github/dependabot.yml tests/invariants/dependabot-lockfile-coverage.spec.ts
git commit -m "security(supply): make lock update ownership explicit" \
  -m "Coordinate root and AquaMobil version updates while giving each production WASM lock an
automated owner without absorbing the independently governed edge tree." \
  -m "Closes:
docs/reviews/security-reviewer/2026-08-25-production-security-audit.md#SUPPLY-HIGH-003"
git push
```

---

### Task 3: Locked and Auditable WASM Generation

**Files:**

- Create: `tests/invariants/wasm-lock-build-contract.spec.ts`
- Modify: `crates/alarm-core-wasm/Cargo.toml`
- Modify: `crates/alarm-core-wasm/Cargo.lock`
- Modify: `crates/protocol-codec-wasm/Cargo.toml`
- Modify: `crates/protocol-codec-wasm/Cargo.lock`
- Modify: `libs/alarm-core/project.json`
- Modify: `libs/protocol-codec/project.json`
- Modify: `libs/alarm-core/scripts/build-wasm.sh`
- Modify: `libs/protocol-codec/scripts/build-wasm.sh`
- Regenerate: `libs/alarm-core/src/generated/*`
- Regenerate: `libs/protocol-codec/src/generated/*`
- Regenerate: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes: Rust 1.88.0, wasm32 target, `wasm-bindgen-cli 0.2.127`, committed standalone locks.
- Produces: `build-wasm` targets that fail on lock drift or CLI mismatch and whose cache keys
  include `Cargo.lock`.

- [ ] **Step 1: Create the failing WASM lock/build invariant**

Create `tests/invariants/wasm-lock-build-contract.spec.ts` with:

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WASM_BINDGEN_VERSION = '0.2.127';

const CONTRACTS = [
  {
    name: 'alarm-core',
    project: 'libs/alarm-core/project.json',
    manifest: 'crates/alarm-core-wasm/Cargo.toml',
    lock: 'crates/alarm-core-wasm/Cargo.lock',
    script: 'libs/alarm-core/scripts/build-wasm.sh',
  },
  {
    name: 'protocol-codec',
    project: 'libs/protocol-codec/project.json',
    manifest: 'crates/protocol-codec-wasm/Cargo.toml',
    lock: 'crates/protocol-codec-wasm/Cargo.lock',
    script: 'libs/protocol-codec/scripts/build-wasm.sh',
  },
] as const;

function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

describe('standalone WASM lock/build contract', () => {
  test.each(CONTRACTS)('$name pins one binding toolchain and consumes its lock', (contract) => {
    const project = JSON.parse(read(contract.project)) as {
      targets?: { 'build-wasm'?: { inputs?: string[] } };
    };
    const manifest = read(contract.manifest);
    const lock = read(contract.lock);
    const script = read(contract.script);

    expect(project.targets?.['build-wasm']?.inputs).toContain(`{workspaceRoot}/${contract.lock}`);
    expect(manifest).toContain(`wasm-bindgen = "=${WASM_BINDGEN_VERSION}"`);
    expect(manifest).toMatch(/^\[workspace\]\s*$/m);
    expect(lock).toContain(`name = "wasm-bindgen"\nversion = "${WASM_BINDGEN_VERSION}"`);
    expect(script).toContain(`WASM_BINDGEN_VERSION="${WASM_BINDGEN_VERSION}"`);
    expect(script).toContain('wasm-bindgen --version');
    expect(script).toContain('cargo build --locked --target wasm32-unknown-unknown --release');
  });
});
```

- [ ] **Step 2: Run the invariant and capture the expected red result**

```bash
npx jest --config tests/invariants/jest.config.ts --runInBand \
  --runTestsByPath tests/invariants/wasm-lock-build-contract.spec.ts
```

Expected: both table rows FAIL on missing standalone workspace boundaries, missing lock inputs, old
0.2.100 pins, and unlocked build commands.

- [ ] **Step 3: Pin manifests and refresh only the binding families**

Change both manifests to the exact dependency pin:

```toml
wasm-bindgen = "=0.2.127"
```

Append an empty standalone workspace boundary to both manifests, following
`sens-api-gateway/fuzz/Cargo.toml`:

```toml
# Keep this independently resolved production binding graph outside ancestor workspaces.
[workspace]
```

Then update each independent lock:

```bash
cargo update --manifest-path crates/alarm-core-wasm/Cargo.toml \
  -p wasm-bindgen --precise 0.2.127
cargo update --manifest-path crates/protocol-codec-wasm/Cargo.toml \
  -p wasm-bindgen --precise 0.2.127
```

Expected: both locks resolve `wasm-bindgen`, macro/support families at 0.2.127 and no longer contain
`wasm-bindgen-backend 0.2.100`.

- [ ] **Step 4: Make Nx cache inputs consume the locks**

Append these exact inputs next to each WASM `Cargo.toml` input:

```json
"{workspaceRoot}/crates/alarm-core-wasm/Cargo.lock"
```

```json
"{workspaceRoot}/crates/protocol-codec-wasm/Cargo.lock"
```

- [ ] **Step 5: Make both build scripts reject CLI and lock drift**

In both scripts, define and check the exact CLI before building:

```bash
WASM_BINDGEN_VERSION="0.2.127"

if ! command -v wasm-bindgen >/dev/null 2>&1; then
  echo "error: wasm-bindgen CLI not found. Install: cargo install wasm-bindgen-cli --version
${WASM_BINDGEN_VERSION} --locked" >&2
  exit 1
fi

actual_wasm_bindgen_version="$(wasm-bindgen --version)"
if [ "$actual_wasm_bindgen_version" != "wasm-bindgen ${WASM_BINDGEN_VERSION}" ]; then
  echo "error: expected wasm-bindgen ${WASM_BINDGEN_VERSION}, got ${actual_wasm_bindgen_version}"
>&2
  exit 1
fi
```

Replace each compile line with:

```bash
(cd "$CRATE_DIR" && cargo build --locked --target wasm32-unknown-unknown --release)
```

- [ ] **Step 6: Install the exact CLI and regenerate committed bindings**

```bash
cargo install wasm-bindgen-cli --version 0.2.127 --locked
wasm-bindgen --version
NX_DAEMON=false npx nx run alarm-core:build-wasm --skip-nx-cache
NX_DAEMON=false npx nx run protocol-codec:build-wasm --skip-nx-cache
```

Expected CLI output: `wasm-bindgen 0.2.127`. Review all eight generated files; no source outside the
two generated directories may be produced by these commands.

- [ ] **Step 7: Prove reproducibility, functionality, and advisories green**

```bash
npx jest --config tests/invariants/jest.config.ts --runInBand \
  --runTestsByPath tests/invariants/wasm-lock-build-contract.spec.ts
cargo check --locked --manifest-path crates/alarm-core-wasm/Cargo.toml \
  --target wasm32-unknown-unknown
cargo check --locked --manifest-path crates/protocol-codec-wasm/Cargo.toml \
  --target wasm32-unknown-unknown
cargo metadata --locked --manifest-path crates/alarm-core-wasm/Cargo.toml --no-deps
cargo metadata --locked --manifest-path crates/protocol-codec-wasm/Cargo.toml --no-deps
cargo audit --file crates/alarm-core-wasm/Cargo.lock --deny warnings
cargo audit --file crates/protocol-codec-wasm/Cargo.lock --deny warnings
NX_DAEMON=false npx nx test alarm-core --skip-nx-cache
NX_DAEMON=false npx nx test protocol-codec --skip-nx-cache
node --experimental-strip-types tools/scripts/check-codec-drift.ts
```

Expected: all commands exit 0; neither audit contains vulnerability, warning, or yanked-package
failure.

- [ ] **Step 8: Refresh generated file governance, commit, and push**

```bash
npm run quality:format-scope:generate
npm run quality:format-scope:check
git diff --check
git add tests/invariants/wasm-lock-build-contract.spec.ts \
  crates/alarm-core-wasm/Cargo.toml crates/alarm-core-wasm/Cargo.lock \
  crates/protocol-codec-wasm/Cargo.toml crates/protocol-codec-wasm/Cargo.lock \
  libs/alarm-core/project.json libs/alarm-core/scripts/build-wasm.sh \
  libs/alarm-core/src/generated \
  libs/protocol-codec/project.json libs/protocol-codec/scripts/build-wasm.sh \
  libs/protocol-codec/src/generated tools/quality/format-scope.json
git commit -m "security(wasm): enforce locked binding generation" \
  -m "Make each production WASM binding consume an audited lock, invalidate Nx cache on lock
changes, and refuse a generator whose version differs from the crate ABI." \
  -m "Closes:
docs/reviews/security-reviewer/2026-08-25-production-security-audit.md#SUPPLY-HIGH-003"
git push
```

---

### Task 4: Hydroponics Router Regression Runner

**Files:**

- Modify: `tests/invariants/dependency-security-floor.spec.ts`
- Modify: `web/modules/hydroponics-module/package.json`
- Modify: `web/modules/hydroponics-module/vite.config.ts`
- Create: `web/modules/hydroponics-module/src/test-setup.ts`
- Modify: `web/modules/hydroponics-module/project.json`
- Regenerate: `package-lock.json`
- Modify: `tools/quality/coverage-report-inventory.json`
- Modify: `tests/invariants/coverage-evidence-contract.spec.ts`
- Regenerate: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes: root npm workspace lock, shared `@aquaculture/testing/vitest` policy, built `shared-ui`
  dependency.
- Produces: inferred Nx `test` target executing `SolutionPage.router.spec.tsx` in jsdom.

- [ ] **Step 1: Write the failing Hydroponics runner contract**

Add `web/modules/hydroponics-module/package.json` to `VITEST_WORKSPACES` and add:

```ts
test('keeps the Hydroponics Router regression on the shared jsdom runner', () => {
  const manifest = readJson<PackageManifest>('web/modules/hydroponics-module/package.json');
  const vite = readRepoFile('web/modules/hydroponics-module/vite.config.ts');
  const project = readJson<{
    targets?: Record<string, { dependsOn?: string[] }>;
  }>('web/modules/hydroponics-module/project.json');

  expect(
    (manifest as PackageManifest & { scripts?: Record<string, string> }).scripts,
  ).toMatchObject({
    test: 'vitest run',
    'test:watch': 'vitest',
  });
  expect(manifest.devDependencies).toMatchObject({
    '@testing-library/dom': '^10.4.1',
    '@testing-library/jest-dom': '^6.2.0',
    '@testing-library/react': '^16.3.2',
    '@testing-library/user-event': '^14.5.2',
    jsdom: '^24.0.0',
    vitest: '^3.2.7',
  });
  expect(vite).toContain("import { defineConfig } from 'vitest/config';");
  expect(vite).toContain("environment: 'jsdom'");
  expect(vite).toContain('...createVitestTestPolicy()');
  expect(project.targets?.test?.dependsOn).toEqual(['shared-ui:build']);
});
```

Extend the local manifest type with `scripts?: Record<string, string>` if preferred instead of the
intersection shown above.

- [ ] **Step 2: Demonstrate both current failure modes**

```bash
npx jest --config tests/invariants/jest.config.ts --runInBand \
  --runTestsByPath \
  tests/invariants/dependency-security-floor.spec.ts \
  tests/invariants/spec-has-a-runner.spec.ts \
  -t "Hydroponics Router regression|leaves no spec file unreachable"
NX_DAEMON=false npx vitest run \
  web/modules/hydroponics-module/src/pages/solution/__tests__/SolutionPage.router.spec.tsx
```

Expected: invariant FAIL because the package has no runner contract; direct Vitest FAIL because the
default environment has no DOM.

- [ ] **Step 3: Declare the direct test dependencies and scripts**

Add these scripts:

```json
"test": "vitest run",
"test:watch": "vitest"
```

Add these direct dev dependencies, preserving the package's existing entries:

```json
"@testing-library/dom": "^10.4.1",
"@testing-library/jest-dom": "^6.2.0",
"@testing-library/react": "^16.3.2",
"@testing-library/user-event": "^14.5.2",
"jsdom": "^24.0.0",
"vitest": "^3.2.7"
```

- [ ] **Step 4: Apply the shared jsdom Vitest policy**

Replace the Vite config's `defineConfig` import and add the shared policy import:

```ts
import { defineConfig } from 'vitest/config';
import createVitestTestPolicy from '@aquaculture/testing/vitest';
```

Add this top-level config member after `build`:

```ts
test: {
  environment: 'jsdom',
  globals: true,
  setupFiles: ['./src/test-setup.ts'],
  ...createVitestTestPolicy(),
},
```

Create `src/test-setup.ts` with:

```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 5: Expose the inferred package-script target with shared-ui ordering**

Add this target to `project.json`; do not add an executor or command because Nx infers
`nx:run-script` from the package `test` script:

```json
"test": {
  "dependsOn": ["shared-ui:build"]
}
```

Regenerate only the canonical root lock:

```bash
npm install --package-lock-only --ignore-scripts --no-audit --no-fund
npm ci --ignore-scripts --no-audit
```

- [ ] **Step 6: Capture and repair the coverage-governance failure**

Run the coverage evidence contract after the package has become a Vitest
producer:

```bash
npx jest --config tests/invariants/jest.config.ts --runInBand \
  --runTestsByPath tests/invariants/coverage-evidence-contract.spec.ts
```

Expected: FAIL because producer discovery now returns 12 while the governed
inventory still has 35 reports and omits Hydroponics.

Insert this report in sorted order between `farm-module` and `hr-module`:

```json
"web/modules/hydroponics-module/coverage/lcov.info"
```

In `coverage-evidence-contract.spec.ts`, update only the exact topology counts:

```ts
expect(inventory.reports).toHaveLength(36);
expect(VITEST_PRODUCERS).toHaveLength(12);
```

Rerun the same coverage command. Expected: PASS with a sorted, duplicate-free
inventory whose non-root reports exactly equal all 12 discovered Vitest
producers.

- [ ] **Step 7: Prove the regression is reachable and green**

```bash
NX_DAEMON=false npx nx show projects --with-target=test --json
NX_DAEMON=false npx nx test hydroponics-module --skip-nx-cache
npx jest --config tests/invariants/jest.config.ts --runInBand \
  --runTestsByPath \
  tests/invariants/dependency-security-floor.spec.ts \
  tests/invariants/spec-has-a-runner.spec.ts \
  tests/invariants/coverage-evidence-contract.spec.ts
npx tsc --noEmit -p web/modules/hydroponics-module/tsconfig.json
NX_DAEMON=false npx nx build hydroponics-module --skip-nx-cache
```

Expected: Nx's project list contains `hydroponics-module`; the router test executes in jsdom and
passes; both invariants, type-check, and production build pass.

- [ ] **Step 8: Refresh governance, commit, and push without a false finding claim**

```bash
npm run quality:format-scope:generate
npm run quality:format-scope:check
git diff --check
git add tests/invariants/dependency-security-floor.spec.ts package-lock.json \
  tests/invariants/coverage-evidence-contract.spec.ts \
  web/modules/hydroponics-module/package.json \
  web/modules/hydroponics-module/vite.config.ts \
  web/modules/hydroponics-module/src/test-setup.ts \
  web/modules/hydroponics-module/project.json \
  tools/quality/coverage-report-inventory.json \
  tools/quality/format-scope.json
git commit -m "test(hydroponics): wire router regression into Nx" \
  -m "Give the Router 7 regression a declared jsdom environment and a normal Nx target so required
test discovery can execute it instead of merely type-checking the file."
git push
```

The commit deliberately has no `Closes:` trailer: the reviewer observation has no canonical registry
ID, and using `SUPPLY-CRITICAL-002` would falsely claim that this runner wiring fixed the dependency
advisories already closed by the earlier dependency commit.

---

### Task 5: Correct the Release Evidence and Run Fresh Verification

**Files:**

- Modify: `docs/reviews/security-reviewer/2026-08-25-production-security-audit.md`
- Regenerate: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes: final implementation SHA, fresh targeted/full test output, cargo/npm audit output.
- Produces: accurate pre-merge remediation evidence; finding states remain `IN-PROGRESS` until the
  squash SHA reaches `origin/main`.

- [ ] **Step 1: Normalize executable modes from the Git index**

The checkout was created under umask `0077`; restore every Git-tracked executable to its committed
executable mode without changing Git content:

```bash
git ls-files -s | awk '$1 == "100755" { print $4 }' | while IFS= read -r path; do
  chmod 755 "$path"
done
git status --short
```

Expected: no source diff from chmod;
`infrastructure/scripts/provider-console-bootstrap-postgres-walg.sh` reports mode 755 locally.

- [ ] **Step 2: Run focused security and release contracts**

```bash
npx jest --config tests/invariants/jest.config.ts --runInBand \
  --runTestsByPath \
  tests/invariants/dependabot-lockfile-coverage.spec.ts \
  tests/invariants/dependency-security-floor.spec.ts \
  tests/invariants/coverage-evidence-contract.spec.ts \
  tests/invariants/spec-has-a-runner.spec.ts \
  tests/invariants/wasm-lock-build-contract.spec.ts
npx jest --config apps/admin-api-service/jest.config.ts --runInBand \
  apps/admin-api-service/src/security/controllers/__tests__/sorting.dto.spec.ts \
  apps/admin-api-service/src/security/services/__tests__/activity-logging.service.sorting.spec.ts \
  apps/admin-api-service/src/security/services/__tests__/audit-trail.service.sorting.spec.ts \
apps/admin-api-service/src/system-management/services/__tests__/error-tracking.service.sorting.spec.ts
cargo test --locked --manifest-path sens-api-gateway/Cargo.toml command_acceptance
cargo test --locked --manifest-path sens-api-gateway/Cargo.toml mqtt_dispatch
export
SENS_API_GATEWAY_CI_FEATURES='health,telemetry,metrics,strict-security,scada-display,lorawan,signed-deploy,tpm,st-bytecode,multi-task-scheduler,opc-ua-server,live-debug,license-enforce'
cargo check --locked --release --all-targets \
  --manifest-path sens-api-gateway/Cargo.toml \
  --features "$SENS_API_GATEWAY_CI_FEATURES"
```

Expected: every focused command exits 0 and the admin malicious sort inputs never reach `orderBy`.

- [ ] **Step 3: Run all five required Rust audits**

```bash
cargo audit --deny warnings
(cd sens-api-gateway && cargo audit --deny warnings \
  --ignore RUSTSEC-2023-0071 \
  --ignore RUSTSEC-2025-0141 \
  --ignore RUSTSEC-2024-0388 \
  --ignore RUSTSEC-2023-0089 \
  --ignore RUSTSEC-2026-0173 \
  --ignore RUSTSEC-2024-0436)
(cd sens-api-gateway && cargo audit --file fuzz/Cargo.lock)
cargo audit --file crates/alarm-core-wasm/Cargo.lock --deny warnings
cargo audit --file crates/protocol-codec-wasm/Cargo.lock --deny warnings
```

Expected: zero active vulnerabilities. Only the already documented edge maintenance warnings and
non-shipping fuzz yanked warning may appear under their exact non-`--deny warnings` policy.

- [ ] **Step 4: Run all six npm audit thresholds**

```bash
npm audit --audit-level=moderate --omit=dev
npm audit --audit-level=high
npm --prefix web/apps/aquamobil audit --audit-level=moderate --omit=dev
npm --prefix web/apps/aquamobil audit --audit-level=high
npm --prefix e2e audit --audit-level=moderate --omit=dev
npm --prefix e2e audit --audit-level=high
```

Expected: root, AquaMobil, and E2E production graphs have zero vulnerabilities; all three full
graphs have zero high/critical vulnerabilities.

- [ ] **Step 5: Re-run the previously starved database project in isolation**

```bash
NX_DAEMON=false NX_TUI=false NX_TASKS_RUNNER_DYNAMIC_OUTPUT=false \
  npx nx test db-migrate --runInBand --skip-nx-cache
```

Expected: the bootstrap-from-scratch suite finishes within its configured timeout and no cascaded
`beforeAll` timeout remains.

- [ ] **Step 6: Run the full repository gates with controlled parallelism**

Run these sequentially, never concurrently:

```bash
NX_DAEMON=false NX_TUI=false NX_TASKS_RUNNER_DYNAMIC_OUTPUT=false \
  npm run test:all -- --parallel=1
NX_DAEMON=false npm run lint:all -- --parallel=2 --max-warnings=0
NX_DAEMON=false PARALLEL=1 npm run type-check
NX_DAEMON=false NX_TUI=false NX_TASKS_RUNNER_DYNAMIC_OUTPUT=false \
  npm run build:all -- --parallel=2
npx jest --config tests/invariants/jest.config.ts --runInBand
npm run format:check
npm run findings:verify
npm run gates:dependency-policy
npm run gates:required-status-checks
npm run gates:sens-enterprise-validation
npm run gates:all
npx ts-node --project tools/gates/tsconfig.json \
  tools/gates/commit-msg-validator.ts --mode=range origin/main HEAD
git diff --check
```

Expected: every command exits 0 on the final tree. Record exact counts and durations; do not replace
a red command with a narrower command.

- [ ] **Step 7: Update only evidence statements that the fresh run proved**

Keep all four audit finding states `IN-PROGRESS`. Replace the obsolete `lockfile-only`/single
optional audit statements under `SUPPLY-HIGH-003` with this evidence:

```markdown
- CI Affected publishes independent `has_changes` and `deploy_changes` outputs:
  `e2e/**` enters the required audit/test chain through `audit_only` but cannot
  authorize staging or production. Executable invariants run the real classifier
  shell for both audit-only and deploy-capable inputs.
- Root and Aquamobil share one multi-directory npm update authority with
  dependency-name grouping and manifest-increasing updates; the two production
  WASM locks are explicitly owned by the Cargo updater. Edge/fuzz exceptions
  retain independent policy but no longer escape required audit coverage.
- The existing required `sens-api-gateway-rust` job audits root, edge, fuzz,
  alarm-core WASM, and protocol-codec WASM locks before compilation. All five
  fresh audits report zero active vulnerabilities under their tracked policies.
- Both WASM builds consume committed locks with `--locked`, verify
  `wasm-bindgen 0.2.127`, include lockfiles in Nx cache inputs, regenerate their
  Node bindings, and pass functional twin tests.
```

Under `SUPPLY-CRITICAL-002`, replace the generic Hydroponics claim with:

```markdown
- `hydroponics-module` now declares the pinned Vitest/jsdom toolchain, inherits
  the shared Vitest policy, and exposes an Nx test target. The Router 7 nested
  redirect regression executes through `nx test hydroponics-module` rather than
  remaining an orphaned TypeScript file.
```

Include exact fresh test/audit counts from Steps 2–6 in the surrounding evidence prose.

- [ ] **Step 8: Format, commit, and push the corrected evidence**

```bash
npm run quality:format-scope:generate
npx prettier --write \
  docs/reviews/security-reviewer/2026-08-25-production-security-audit.md \
  tools/quality/format-scope.json
npm run quality:format-scope:check
git diff --check
git add docs/reviews/security-reviewer/2026-08-25-production-security-audit.md \
  tools/quality/format-scope.json
git commit -m "chore(security): record final release gate evidence" \
  -m "Replace provisional lock and runner claims with fresh required-gate, audit, build, and
controlled full-suite evidence while findings remain pending merge."
git push
```

---

### Task 6: Independent Re-review and Exact-SHA PR Gates

**Files:**

- No planned source edits; any reviewer finding returns to the owning task and repeats its red-green
  cycle.

**Interfaces:**

- Consumes: clean pushed branch, full local evidence, protected branch settings.
- Produces: no unresolved Critical/Important review item and four successful required contexts on
  the exact PR head SHA.

- [ ] **Step 1: Run independent security and governance reviews**

Use `superpowers:requesting-code-review`. Give separate reviewers these non-overlapping scopes:

```text
Reviewer A: .github/workflows/ci-affected.yml, .github/dependabot.yml, required-context
reachability, deploy authorization, and their invariants.
Reviewer B: WASM manifests/locks/build scripts/generated outputs, Hydroponics jsdom/Nx runner,
security tests, and audit evidence.
```

Expected: each reviewer reads `origin/main...HEAD`, runs focused verification, and reports
severity-ranked issues. Resolve every Critical/Important finding before continuing.

- [ ] **Step 2: Rebase-free freshness check and final signed-tree check**

```bash
git fetch --prune origin main security/production-hardening-20260825
git rev-list --left-right --count origin/main...HEAD
git status --short --branch
git log --format='%H %G? %s' origin/main..HEAD
```

Expected: `0` commits behind, clean worktree, every new commit signature marker `G`. If
`origin/main` advanced, merge `origin/main` normally, resolve conflicts without rewriting history,
rerun Task 5, commit, and push.

- [ ] **Step 3: Create or update the PR with a compliant title and evidence body**

```bash
PR_URL="$(gh pr view --json url --jq .url 2>/dev/null || gh pr create \
  --base main \
  --head security/production-hardening-20260825 \
  --title 'security(release): close production security blockers' \
  --body-file docs/superpowers/specs/2026-08-26-security-release-gate-closure-design.md)"
PR_NUMBER="$(gh pr view --json number --jq .number)"
HEAD_SHA="$(git rev-parse HEAD)"
printf 'PR=%s\nNUMBER=%s\nHEAD=%s\n' "$PR_URL" "$PR_NUMBER" "$HEAD_SHA"
```

Then edit the PR body to add the exact local counts, five Rust audits, six npm audit thresholds,
independent review result, and the four intended squash trailers. Do not claim GitHub checks that
have not completed.

- [ ] **Step 4: Wait for required contexts on the exact head SHA**

```bash
PR_NUMBER="$(gh pr view --json number --jq .number)"
HEAD_SHA="$(git rev-parse HEAD)"
gh pr checks "$PR_NUMBER" --watch --fail-fast
gh pr checks "$PR_NUMBER" --required
gh api "repos/Okan-wqm/aquaculture_platform/commits/${HEAD_SHA}/check-runs" \
  --jq '.check_runs[] | [.name, .status, .conclusion, .head_sha] | @tsv'
```

Expected on `$HEAD_SHA`: `sens-enterprise-summary`, `merge-gate`, `aria-merge-authority`, and
`build-status` all have conclusion `success`. A cancelled, stale-SHA, neutral, skipped required
producer, or administrator override is not success.

- [ ] **Step 5: Apply the verification-before-completion gate**

Use `superpowers:verification-before-completion` and repeat the smallest commands that prove the
final post-review tree: focused invariants, five Rust audits, six npm audits, `git diff --check`,
signature list, and required check snapshot. Only then declare the PR mergeable.

---

### Task 7: Squash Merge, Main Actions, and Finding Closure

**Files:**

- Post-merge closure branch modifies: `docs/reviews/_registry/findings.jsonl`
- Post-merge closure branch modifies:
  `docs/reviews/security-reviewer/2026-08-25-production-security-audit.md`
- Post-merge closure branch modifies:
  `docs/plans/2026-06-18-enterprise-grade-debt-closure/manifest.json`
- Post-merge closure branch modifies:
  `docs/plans/2026-06-18-enterprise-grade-debt-closure/finding-truth-table.md`
- Post-merge closure branch regenerates:
  `docs/plans/2026-06-18-enterprise-grade-debt-closure/README.md`
- Post-merge closure branch regenerates: `tools/quality/format-scope.json`

**Interfaces:**

- Consumes: green PR number, exact PR head, protected squash merge, resulting `origin/main` SHA.
- Produces: merged production hardening, successful post-merge Actions/deploy evidence, and registry
  findings resolved against one reachable closing SHA.

- [ ] **Step 1: Squash merge without bypass and with canonical finding trailers**

```bash
PR_NUMBER="$(gh pr view --json number --jq .number)"
gh pr merge "$PR_NUMBER" --squash \
  --subject 'security(release): close production security blockers' \
  --body $'Close the MQTT authentication/replay, admin SQL identifier, JavaScript advisory, and
standalone dependency release-gate findings with fresh local and protected-CI evidence.\n\nCloses:
docs/reviews/security-reviewer/2026-08-25-production-security-audit.md#RUST-HIGH-003\nCloses:
docs/reviews/security-reviewer/2026-08-25-production-security-audit.md#ADMIN-HIGH-005\nCloses:
docs/reviews/security-reviewer/2026-08-25-production-security-audit.md#SUPPLY-CRITICAL-002\nCloses:
docs/reviews/security-reviewer/2026-08-25-production-security-audit.md#SUPPLY-HIGH-003'
```

Expected: merge succeeds through branch protection without `--admin`; GitHub reports the PR merged.

- [ ] **Step 2: Prove the squash authority is on main and carries all trailers**

```bash
PR_NUMBER="$(gh pr view security/production-hardening-20260825 \
  --json number --jq .number)"
git fetch --prune origin main
MERGED_SHA="$(gh pr view "$PR_NUMBER" --json mergeCommit --jq '.mergeCommit.oid')"
git merge-base --is-ancestor "$MERGED_SHA" origin/main
git show -s --show-signature --format='%H%n%G? %GS%n%B' "$MERGED_SHA"
gh api "repos/Okan-wqm/aquaculture_platform/git/commits/${MERGED_SHA}" \
  --jq '.verification.verified' | grep -Fxq true
for finding in RUST-HIGH-003 ADMIN-HIGH-005 SUPPLY-CRITICAL-002 SUPPLY-HIGH-003; do
  git show -s --format=%B "$MERGED_SHA" | grep -Fq "#${finding}"
done
```

Expected: ancestor, GitHub signature verification, and all four trailer checks
exit 0.

- [ ] **Step 3: Watch post-merge Actions and normal deployment evidence**

```bash
MERGED_SHA="$(gh pr view security/production-hardening-20260825 \
  --json mergeCommit --jq '.mergeCommit.oid')"
for workflow in \
  ci-affected.yml \
  ci-full.yml \
  rust-ci.yml \
  sens-api-gateway-ci.yml \
  ci-edge.yml \
  security-gitleaks.yml; do
  run_id=''
  for attempt in $(seq 1 20); do
    run_id="$(gh run list --workflow "$workflow" --branch main \
      --commit "$MERGED_SHA" --limit 1 --json databaseId \
      --jq '.[0].databaseId')"
    [ -n "$run_id" ] && break
    sleep 15
  done
  test -n "$run_id"
  gh run watch "$run_id" --exit-status
  gh run view "$run_id" --json jobs,url,status,conclusion
done
```

Resolve the CI Affected run again and prove the called post-deploy job and exact
production tag/artifact:

```bash
MERGED_SHA="$(gh pr view security/production-hardening-20260825 \
  --json mergeCommit --jq '.mergeCommit.oid')"
AFFECTED_RUN="$(gh run list --workflow ci-affected.yml --branch main \
  --commit "$MERGED_SHA" --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run view "$AFFECTED_RUN" --json jobs --jq \
  '.jobs[] | select(.name == "production-post-deploy-verify / verify") | select(.conclusion ==
"success") | .databaseId' \
  | grep -Eq '^[0-9]+$'
git fetch --force origin \
  '+refs/tags/deployed/production:refs/tags/deployed/production'
test "$(git rev-parse deployed/production)" = "$MERGED_SHA"
gh api
"repos/Okan-wqm/aquaculture_platform/actions/artifacts?name=production-post-deploy-evidence-${MERGED_SHA}&per_page=100"
\
  --jq '.artifacts[] | select(.expired == false) | .id' \
  | grep -Eq '^[0-9]+$'
```

Confirm CI Affected invoked staging/production because this merge contains
deploy-capable runtime/config changes. Do not dispatch a replacement deployment
manually.

Expected: main CI/build/security workflows succeed; the repository's normal staging, production, and
post-deploy verification chain reports success for `$MERGED_SHA`.

If any run, deployed tag, health proof, or evidence-artifact assertion fails,
stop here, report the exact failed run, and leave all four findings
`IN-PROGRESS`. Do not create the closure worktree or manually dispatch a
replacement deployment.

- [ ] **Step 4: Create an isolated post-merge finding-closure worktree**

Use `superpowers:using-git-worktrees`, then:

```bash
git worktree add /var/aqua-saas/.worktrees/security-finding-closure \
  -b chore/security-finding-closure-20260826 origin/main
cd /var/aqua-saas/.worktrees/security-finding-closure
IMPLEMENTATION_PR_NUMBER="$(gh pr view security/production-hardening-20260825 \
  --json number --jq .number)"
IMPLEMENTATION_PR_URL="$(gh pr view security/production-hardening-20260825 \
  --json url --jq .url)"
MERGED_SHA="$(gh pr view security/production-hardening-20260825 \
  --json mergeCommit --jq '.mergeCommit.oid')"
git merge-base --is-ancestor "$MERGED_SHA" origin/main
POST_DEPLOY_RUN_ID="$(gh run list --workflow ci-affected.yml --branch main \
  --commit "$MERGED_SHA" --limit 1 --json databaseId --jq '.[0].databaseId')"
POST_DEPLOY_RUN_URL="$(gh run view "$POST_DEPLOY_RUN_ID" --json url --jq .url)"
```

Read root `CLAUDE.md` before mutation.

- [ ] **Step 5: Close the four registry findings through the canonical CLI**

```bash
MERGED_SHA="$(gh pr view security/production-hardening-20260825 \
  --json mergeCommit --jq '.mergeCommit.oid')"
npm run findings:close -- RUST-HIGH-003 "$MERGED_SHA"
npm run findings:close -- ADMIN-HIGH-005 "$MERGED_SHA"
npm run findings:close -- SUPPLY-CRITICAL-002 "$MERGED_SHA"
npm run findings:close -- SUPPLY-HIGH-003 "$MERGED_SHA"
rg -n "SUPPLY-CRITICAL-002" \
  docs/plans/2026-06-18-enterprise-grade-debt-closure/manifest.json \
  docs/plans/2026-06-18-enterprise-grade-debt-closure/finding-truth-table.md
```

The registry CLI is the only writer for `findings.jsonl`. Once it has closed
`SUPPLY-CRITICAL-002`, consciously remove that ID from
`manifest.json.active_critical_ids`, remove its active table row from
`finding-truth-table.md`, and append a dated closure-history paragraph naming
the exact first PR number, `$MERGED_SHA`, successful post-deploy run URL, and
the resulting active-CRITICAL count. Apply those two narrative/control-plane
edits together; the repin command deliberately refuses to guess them.

Then regenerate only the scalar/tip mirrors and verify the complete closure:

```bash
npm run gates:debt-plan:repin
npm run findings:verify
npx jest --config tests/invariants/jest.config.ts --runInBand \
  --runTestsByPath tests/invariants/enterprise-grade-debt-plan-contract.spec.ts
npm run quality:format-scope:generate
npm run quality:format-scope:check
npm run invariants:fast
```

Expected: each CLI reports `state=RESOLVED` with `$MERGED_SHA`; chain verification succeeds. Never
edit registry hashes by hand.

- [ ] **Step 6: Align the narrative audit states and commit the closure ceremony**

Change the four audit headings' states from `IN-PROGRESS` to `RESOLVED` and add the exact squash SHA
plus successful main workflow URLs to their final evidence. Then:

```bash
npx prettier --write \
  docs/reviews/security-reviewer/2026-08-25-production-security-audit.md \
  tools/quality/format-scope.json
npm run findings:verify
npm run gates:debt-plan:check
npx jest --config tests/invariants/jest.config.ts --runInBand \
  --runTestsByPath tests/invariants/enterprise-grade-debt-plan-contract.spec.ts
npm run quality:format-scope:check
git diff --check
git add docs/reviews/_registry/findings.jsonl \
  docs/reviews/security-reviewer/2026-08-25-production-security-audit.md \
  docs/plans/2026-06-18-enterprise-grade-debt-closure/manifest.json \
  docs/plans/2026-06-18-enterprise-grade-debt-closure/finding-truth-table.md \
  docs/plans/2026-06-18-enterprise-grade-debt-closure/README.md \
  tools/quality/format-scope.json
git commit -m "chore(security): record merged finding closures" \
  -m "Bind the four production audit findings to the protected main squash authority and restitch
every registry and debt-plan mirror through their canonical generators."
git push -u origin chore/security-finding-closure-20260826
```

- [ ] **Step 7: Merge the closure PR through the same protected checks**

```bash
CLOSURE_PR_URL="$(gh pr create \
  --base main \
  --head chore/security-finding-closure-20260826 \
  --title 'chore(security): record merged finding closures' \
  --body 'Post-merge registry ceremony for the production security release. No runtime or deployment
behavior changes.')"
CLOSURE_PR_NUMBER="$(gh pr view --json number --jq .number)"
gh pr checks "$CLOSURE_PR_NUMBER" --watch --fail-fast
gh pr checks "$CLOSURE_PR_NUMBER" --required
gh pr merge "$CLOSURE_PR_NUMBER" --squash \
  --subject 'chore(security): record merged finding closures' \
  --body 'Record canonical post-merge registry state and evidence for the production security
release.'
```

Expected: closure PR passes the same four required contexts and merges without bypass.

- [ ] **Step 8: Re-index and report final security state**

```bash
git fetch --prune origin main
FINAL_MAIN_SHA="$(git rev-parse origin/main)"
for workflow in ci-affected.yml ci-full.yml security-gitleaks.yml; do
  run_id=''
  for attempt in $(seq 1 20); do
    run_id="$(gh run list --workflow "$workflow" --branch main \
      --commit "$FINAL_MAIN_SHA" --limit 1 --json databaseId \
      --jq '.[0].databaseId')"
    [ -n "$run_id" ] && break
    sleep 15
  done
  test -n "$run_id"
  gh run watch "$run_id" --exit-status
done
dependency_graph_current=false
for attempt in $(seq 1 20); do
  if [ "$(gh api repos/Okan-wqm/aquaculture_platform/dependency-graph/sbom \
    --jq '(([.sbom.packages[]? | select(.name == "vitest" and .versionInfo == "3.2.7")] | length) >
0) and (([.sbom.packages[]? | select(.name == "wasm-bindgen" and .versionInfo == "0.2.127")] |
length) > 0)')" = "true" ]; then
    dependency_graph_current=true
    break
  fi
  sleep 30
done
test "$dependency_graph_current" = true
gh api --method GET --paginate \
  repos/Okan-wqm/aquaculture_platform/dependabot/alerts \
  -f state=open -f per_page=100 \
  --jq '[.[] | {number, dependency: .dependency.package.name, severity: .security_advisory.severity,
manifest: .dependency.manifest_path, url: .html_url}]'
gh run list --branch main --commit "$FINAL_MAIN_SHA" --limit 30 \
  --json workflowName,status,conclusion,headSha,url
```

The bounded poll proves GitHub's dependency graph sees both the updated npm
toolchain and standalone Cargo graph before the alert snapshot is trusted. If it
times out, report re-indexing as incomplete and do not claim the remote alert
state is current. Any remaining Critical/High alert must be mapped to its
manifest and compared with the fresh local audit before claiming closure. Report
separately:

```text
runtime/production npm graphs
full build/CI npm graphs
root/edge/fuzz/WASM Rust graphs
required PR contexts
post-merge main workflows
staging/production/post-deploy evidence
registry finding states
remaining accepted advisory policy entries
```

Completion requires exact SHAs, workflow URLs, audit counts, and explicit residual risks; “all
green” without those artifacts is not sufficient.
