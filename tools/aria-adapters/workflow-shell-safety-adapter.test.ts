import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { makeFixtureTree } from '../gates/fixture-tree';
import { inspectUsesText } from '../gates/gha-sha-pin';
import { findRunBlockInjections } from '../gates/workflow-input-injection';

import { analyzeWorkflowShellSafety } from './workflow-shell-safety-adapter';

// ARIA-HIGH-013 (plan Task 16). The workspace is built at run time: the
// repository's own gates refuse a committed workflow with a mutable action
// pin or an input spliced into run:, so their true positives cannot live in a
// committed fixture.

const REPO_ROOT = resolve(__dirname, '..', '..');
const workspace = makeFixtureTree('aria-workflow-shell-safety-');
const outside = makeFixtureTree('aria-workflow-shell-outside-');

const SHA = 'a'.repeat(40);

function write(path: string, body: string, executable = false): void {
  mkdirSync(dirname(join(workspace, path)), { recursive: true });
  writeFileSync(join(workspace, path), body, 'utf8');
  chmodSync(join(workspace, path), executable ? 0o755 : 0o644);
}

function workflow(jobs: readonly string[], top: readonly string[] = []): string {
  return ['name: fixture', 'on: [push]', ...top, 'jobs:', ...jobs, ''].join('\n');
}

// --------------------------------------------------------------- workflows
const PINS = workflow([
  '  build:',
  '    runs-on: ubuntu-latest',
  '    permissions:',
  '      contents: read',
  '    steps:',
  '      - uses: actions/checkout@v4',
  `      - uses: actions/setup-node@${SHA} # v4.2.0`,
  '      - uses: ./.github/actions/local',
  '      - uses: actions/cache@main',
]);
write('.github/workflows/pins.yml', PINS);

const INJECT = workflow([
  '  inject:',
  '    runs-on: ubuntu-latest',
  '    permissions:',
  '      contents: read',
  '    steps:',
  '      - name: Spliced input',
  '        run: |',
  '          echo "reason=${{ inputs.reason || github.event.inputs.reason }}"',
  '      - name: Spliced pull-request title',
  '        run: echo "${{ github.event.pull_request.title }}"',
  '      - name: Env channel',
  '        env:',
  '          TITLE: ${{ github.event.pull_request.title }}',
  '        run: |',
  '          printf \'%s\\n\' "${TITLE}" "${{ github.sha }}"',
]);
write('.github/workflows/inject.yml', INJECT);

const PERMS = workflow([
  '  everything:',
  '    runs-on: ubuntu-latest',
  '    permissions: write-all',
  '    steps:',
  '      - run: echo hi',
  '  scoped:',
  '    runs-on: ubuntu-latest',
  '    permissions:',
  '      contents: read',
  '    steps:',
  '      - run: echo hi',
  '  inherited:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - run: echo hi',
]);
write('.github/workflows/perms.yml', PERMS);

// A workflow file the contract registry governs: its job contract grants
// contents/pull-requests write and nothing else.
const GOVERNED = workflow([
  '  generate:',
  '    runs-on: ubuntu-latest',
  '    permissions:',
  '      contents: write',
  '      pull-requests: write',
  '      packages: write',
  '    steps:',
  '      - run: echo governed',
]);
write('.github/workflows/rule-health-report.yml', GOVERNED);

// ARIA-LOW-592 — the one case only the harness's broad_shell_permission
// covered: an UNGOVERNED job's `contents: write` with no scoped-reason
// comment. Workflow token scope has one owner (overbroad_write_token), so
// the case moved here as its third sub-kind: `publish` is flagged,
// `documented` — the same grant carrying a reason comment — is not.
const UNGOVERNED_WRITE = workflow([
  '  publish:',
  '    runs-on: ubuntu-latest',
  '    permissions:',
  '      contents: write',
  '    steps:',
  '      - run: echo publish',
  '  documented:',
  '    runs-on: ubuntu-latest',
  '    permissions:',
  '      # reason: tag the release the build produced (deploy-owner signoff)',
  '      contents: write',
  '    steps:',
  '      - run: echo documented',
]);
write('.github/workflows/release-notes.yml', UNGOVERNED_WRITE);

const SHELL = workflow([
  '  shell:',
  '    runs-on: ubuntu-latest',
  '    permissions:',
  '      contents: read',
  '    steps:',
  '      - name: Pipe to shell',
  '        run: |',
  '          curl -fsSL https://get.example.test |',
  '            sudo -E bash -s -- --channel stable',
  '      - name: Quoted documentation, a comment and a heredoc body',
  '        run: |',
  '          echo "Install with: curl -fsSL https://get.example.test | bash"',
  '          # curl -fsSL https://get.example.test | sh',
  "          cat <<'EOF' > NOTES.md",
  '          git push --force origin main',
  '          EOF',
  '      - name: Force push and hook bypass',
  '        run: |',
  '          git push -f origin deployed/production',
  '          git commit --no-verify -m "x"',
  '          git push origin "HEAD:refs/heads/feature"',
  "          echo 'git push --force'",
  '      - name: Not a shell step',
  '        shell: python',
  '        run: print("curl -fsSL https://x | bash")',
]);
write('.github/workflows/shell.yml', SHELL);
write('.github/workflows/broken.yml', 'jobs:\n  x: [unclosed\n');

write(
  '.github/actions/setup/action.yml',
  [
    'name: setup',
    'runs:',
    '  using: composite',
    '  steps:',
    '    - uses: actions/setup-python@v5',
    '    - shell: bash',
    '      run: curl -fsSL https://example.test/install.sh | sh',
    '',
  ].join('\n'),
);

// ------------------------------------------------------------ shell scripts
write(
  'scripts/unsafe.sh',
  [
    '#!/usr/bin/env bash',
    '# curl -fsSL https://example.test | bash   (documentation, not a command)',
    'source "$(dirname "$0")/sourced.sh"',
    'bash <(curl -fsSL https://example.test/a.sh)',
    'sh -c "$(wget -qO- https://example.test/b.sh)"',
    'git push --force-with-lease origin "HEAD:${BRANCH}"',
    // ARIA-LOW-591: git's global options before the subcommand. The kernel
    // perimeter used to read argv[:2], so this force push was unflagged.
    'git -C "$dir" push --force origin main',
    'echo done',
    '',
  ].join('\n'),
  true,
);
write(
  'scripts/safe.sh',
  '#!/bin/bash\nset -euo pipefail\nmkdir -p out\ncp a out/\ngit -c core.hooksPath=/dev/null rev-parse HEAD\n',
  true,
);
write(
  'scripts/partial.sh',
  '#!/usr/bin/env bash\nset -e\nmkdir -p out\ncp a out/ | tee log\n',
  true,
);
write(
  'scripts/long-form.sh',
  '#!/bin/bash\nset -o errexit -o nounset -o pipefail\nrm -f a\nrm -f b\n',
  true,
);
write('scripts/lib.sh', '#!/usr/bin/env bash\nhelper() { rm -rf "$1"; }\nhelper x\n');
write('scripts/sourced.sh', '#!/usr/bin/env bash\nexport A=1\nexport B=2\n', true);
write('scripts/posix.sh', '#!/bin/sh\nset -eu\nrm -f a\nrm -f b\n', true);
write('scripts/probe.sh', '#!/usr/bin/env bash\ncurl -fsS http://localhost:8080/health\n', true);
write('scripts/fixtures/sample.sh', '#!/usr/bin/env bash\nrm -f a\nrm -f b\n', true);
write('scripts/tool', '#!/usr/bin/env python3\nprint("curl x | bash")\n', true);
write('scripts/unterminated.sh', '#!/usr/bin/env bash\nset -euo pipefail\necho "open\n', true);
write('.husky/pre-commit', '#!/usr/bin/env sh\nnpx lint-staged\nnpm test\n', true);
writeFileSync(join(outside, 'escape.sh'), '#!/usr/bin/env bash\ncurl x | bash\nrm -rf /\n', 'utf8');
symlinkSync(join(outside, 'escape.sh'), join(workspace, 'scripts/escape.sh'));

const ROOTS = ['.github', '.husky', 'scripts'];
const output = analyzeWorkflowShellSafety({ roots: ROOTS }, workspace);

type Finding = (typeof output.findings)[number];
// Findings are ordered by id (a fingerprint); these helpers give file order.
const byRule = (rule: string): Finding[] =>
  output.findings.filter((finding) => finding.rule === rule).sort((a, b) => a.line - b.line);
const at = (rule: string, path: string): Finding[] =>
  byRule(rule).filter((finding) => finding.path === path);
const observation = (id: string): Record<string, unknown> => {
  const found = output.observations.find((candidate) => candidate.id === id);
  assert.ok(found !== undefined, `missing observation ${id}`);
  return found.details ?? {};
};

// ---------------------------------------------------------- unpinned_action
// The owner decides: the adapter's verdict IS gha-sha-pin's, line for line.
const pinVerdicts = inspectUsesText('.github/workflows/pins.yml', PINS);
assert.deepEqual(
  at('unpinned_action', '.github/workflows/pins.yml').map((finding) => [
    finding.line,
    finding.subject,
  ]),
  pinVerdicts.map((violation) => [violation.line, violation.uses]),
);
assert.equal(
  pinVerdicts.length,
  2,
  'the tag pin and the branch pin; the SHA pin and the local action pass',
);
assert.equal(at('unpinned_action', '.github/actions/setup/action.yml').length, 1);
for (const finding of byRule('unpinned_action')) {
  assert.equal(finding.owner, 'tools/gates/gha-sha-pin.ts');
}

// ------------------------------------------ untrusted_workflow_interpolation
const injected = at('untrusted_workflow_interpolation', '.github/workflows/inject.yml');
assert.deepEqual(
  injected.map((finding) => [finding.line, finding.owner_rule_id]),
  findRunBlockInjections(INJECT, '.github/workflows/inject.yml').map((violation) => [
    violation.lineNo,
    violation.contextClass,
  ]),
);
assert.deepEqual(
  injected.map((finding) => [finding.line, finding.owner_rule_id]),
  [
    [11, 'workflow_input'],
    [13, 'event_payload'],
  ],
  'the env channel and github.sha are not untrusted interpolation',
);

// --------------------------------------------------- overbroad_write_token
const overbroad = byRule('overbroad_write_token');
assert.deepEqual(
  overbroad.map((finding) => [finding.path, finding.subject, finding.owner_rule_id]).sort(),
  [
    ['.github/workflows/perms.yml', 'everything', 'write-all'],
    ['.github/workflows/release-notes.yml', 'publish', 'ungoverned-write-scope'],
    ['.github/workflows/rule-health-report.yml', 'generate:packages', 'uncontracted-write-scope'],
  ],
);
const governedOwner = overbroad.find(
  (finding) => finding.owner_rule_id === 'uncontracted-write-scope',
);
assert.equal(governedOwner?.owner, 'aria-kernel/aria_kernel/workflow_contract_registry.py');
const ungovernedFinding = overbroad.find(
  (finding) => finding.owner_rule_id === 'ungoverned-write-scope',
);
assert.equal(
  ungovernedFinding?.subject,
  'publish',
  'the documented grant carries its reason and is not flagged',
);
const permsJobs = observation(
  'workflow-shell-safety-adapter:file:.github/workflows/perms.yml',
).jobs;
assert.deepEqual(permsJobs, [
  {
    job: 'everything',
    governed: false,
    token_scope: 'write-all',
    declared_at: 'job',
    write_scopes: ['*'],
  },
  { job: 'scoped', governed: false, token_scope: 'scoped', declared_at: 'job', write_scopes: [] },
  {
    job: 'inherited',
    governed: false,
    token_scope: 'repository_default',
    declared_at: null,
    write_scopes: [],
  },
]);

// ------------------------------------------------------------ pipe_to_shell
assert.deepEqual(
  at('pipe_to_shell', '.github/workflows/shell.yml').map((finding) => finding.line),
  [11],
  'the curl|sudo bash pipeline only: not the quoted install hint, the comment, the heredoc or the python step',
);
assert.deepEqual(
  at('pipe_to_shell', 'scripts/unsafe.sh').map((finding) => [finding.line, finding.owner_rule_id]),
  [
    [4, 'process_substitution'],
    [5, 'command_substitution'],
  ],
);
assert.equal(at('pipe_to_shell', '.github/actions/setup/action.yml').length, 1);
assert.equal(
  at('pipe_to_shell', 'scripts/tool').length,
  0,
  'a Python script is not a shell script',
);

// ------------------------------------------------ governance_bypass_command
const bypass = byRule('governance_bypass_command');
assert.deepEqual(
  bypass.map((finding) => [finding.path, finding.line, finding.owner_rule_id]).sort(),
  [
    ['.github/workflows/shell.yml', 22, 'no_force_push'],
    ['.github/workflows/shell.yml', 23, 'no_no_verify'],
    ['scripts/unsafe.sh', 6, 'no_force_push'],
    // ARIA-LOW-591: the same force push behind git's -C global option.
    ['scripts/unsafe.sh', 7, 'no_force_push'],
  ].sort(),
);
for (const finding of bypass) {
  assert.equal(finding.owner, 'aria-kernel/aria_kernel/implementation_safety.py');
}
// The verdict is the kernel perimeter's own: the same argv through the same
// function, outside the adapter.
const kernelVerdict = execFileSync(
  'python3',
  [
    '-I',
    '-S',
    '-c',
    'import json,sys; sys.path.insert(0, sys.argv[1]); ' +
      'from aria_kernel.implementation_safety import governance_bypass_refusal as g; ' +
      'print(json.dumps([g(a) for a in json.load(sys.stdin)]))',
    join(REPO_ROOT, 'aria-kernel'),
  ],
  {
    input: JSON.stringify([
      ['git', 'push', '-f', 'origin', 'deployed/production'],
      ['git', 'commit', '--no-verify', '-m', 'x'],
      ['git', 'push', 'origin', 'HEAD:refs/heads/feature'],
      ['git', '-C', 'd', 'push', '--force', 'origin', 'main'],
    ]),
    encoding: 'utf8',
  },
);
assert.deepEqual(JSON.parse(kernelVerdict), [
  ['no_force_push', 'force_flag_in_bash_argv:-f'],
  ['no_no_verify', 'hook_bypass_flag:--no-verify'],
  null,
  ['no_force_push', 'force_flag_in_bash_argv:--force'],
]);

// A hooksPath override is the perimeter's verdict too, but in a repository
// script it hardens a read-only git call: recorded, not raised.
assert.equal(at('governance_bypass_command', 'scripts/safe.sh').length, 0);
assert.deepEqual(
  observation('workflow-shell-safety-adapter:hooks-path-override:scripts/safe.sh:5'),
  {
    line: 5,
    detail: 'hooks_path_override:core.hooksPath=/dev/null',
    owner: 'aria-kernel/aria_kernel/implementation_safety.py',
    argv: 'git -c core.hooksPath=/dev/null rev-parse HEAD',
  },
);

// ------------------------------------------------ missing_strict_shell_mode
assert.deepEqual(
  byRule('missing_strict_shell_mode')
    .map((finding) => [finding.path, finding.subject])
    .sort(),
  [
    ['scripts/partial.sh', 'nounset,pipefail'],
    ['scripts/unsafe.sh', 'errexit,nounset,pipefail'],
  ],
);
const strict = (path: string): unknown =>
  observation(`workflow-shell-safety-adapter:file:${path}`).strict_mode;
assert.deepEqual(strict('scripts/safe.sh'), {
  required: true,
  reason: null,
  flags: ['errexit', 'nounset', 'pipefail'],
  missing: [],
});
assert.deepEqual(strict('scripts/long-form.sh'), {
  required: true,
  reason: null,
  flags: ['errexit', 'nounset', 'pipefail'],
  missing: [],
});
for (const [path, reason] of [
  ['scripts/lib.sh', 'not_executable'],
  ['scripts/sourced.sh', 'sourced_fragment'],
  ['scripts/posix.sh', 'posix_sh'],
  ['scripts/probe.sh', 'one_line_probe'],
  ['scripts/fixtures/sample.sh', 'fixture'],
  ['.husky/pre-commit', 'posix_sh'],
] as const) {
  assert.deepEqual(
    (strict(path) as { required: boolean; reason: string }).reason,
    reason,
    `${path} is exempt with an explicit reason`,
  );
  assert.equal(at('missing_strict_shell_mode', path).length, 0);
}

// ------------------------------------------------- parse failures and scope
const summary = observation('workflow-shell-safety-adapter:summary');
assert.equal(summary.parse_failures, 2, 'broken.yml and unterminated.sh');
assert.equal(summary.clean, false);
assert.equal(
  output.observations.filter((candidate) => candidate.type === 'workflow_shell_parse_failure')
    .length,
  2,
);
assert.equal(
  output.read_paths.includes('scripts/escape.sh'),
  false,
  'a symlink out of the workspace is never followed',
);
assert.equal(
  output.read_paths.includes('scripts/tool'),
  true,
  'its shebang was read to classify it',
);
assert.equal(
  observation('workflow-shell-safety-adapter:file:scripts/tool').kind,
  'other_executable',
);

// ------------------------------------------------------- evidence contract
for (const finding of output.findings) {
  assert.ok(output.read_paths.includes(finding.path), `${finding.id} cites a read path`);
  assert.deepEqual(finding.evidence, [{ path: finding.path, line: finding.line }]);
  assert.match(finding.fingerprint, /^sha256:[0-9a-f]{64}$/);
}
assert.equal(new Set(output.findings.map((finding) => finding.id)).size, output.findings.length);

// The same tree twice gives the same answer; a line shift keeps fingerprints.
assert.deepEqual(analyzeWorkflowShellSafety({ roots: ROOTS }, workspace), output);
write(
  'scripts/unsafe.sh',
  readFileSync(join(workspace, 'scripts/unsafe.sh'), 'utf8').replace(
    '#!/usr/bin/env bash\n',
    '#!/usr/bin/env bash\n# shifted\n# shifted\n',
  ),
  true,
);
const shifted = analyzeWorkflowShellSafety({ roots: ROOTS }, workspace);
assert.deepEqual(
  shifted.findings
    .filter((finding) => finding.path === 'scripts/unsafe.sh')
    .map((f) => f.fingerprint),
  output.findings
    .filter((finding) => finding.path === 'scripts/unsafe.sh')
    .map((f) => f.fingerprint),
);

// ---------------------------------------------------------- input contract
assert.throws(() => analyzeWorkflowShellSafety({}, workspace), /roots is required/);
assert.throws(
  () => analyzeWorkflowShellSafety({ roots: ['../escape'] }, workspace),
  /not a contained workspace-relative path/,
);
const snapshot = analyzeWorkflowShellSafety(
  { roots: ROOTS, repo_snapshot: { allowed_paths: ['scripts/safe.sh'], base_commit_sha: SHA } },
  workspace,
);
assert.deepEqual(
  snapshot.read_paths.filter(
    (path) => !path.startsWith('aria-kernel/') && !path.startsWith('tools/'),
  ),
  ['scripts/safe.sh'],
);
assert.equal(observation('workflow-shell-safety-adapter:summary').target_sha, null);
assert.equal(
  (
    snapshot.observations.find((o) => o.id === 'workflow-shell-safety-adapter:summary')?.details ??
    {}
  ).target_sha,
  SHA,
);

// ---------------------------------------------------------------- real repo
// The production scan surface (the manifest's roots) over this checkout:
// every authority present, nothing unparsable.
const manifest = JSON.parse(
  readFileSync(join(__dirname, 'workflow-shell-safety-adapter.tool.json'), 'utf8'),
) as { declared_scope: string[]; default_input: { roots: string[] } };

// The manifest claims only what the production input walks. The kernel's
// observation map (aria_kernel/observation_coverage.py) counts every tracked
// path a declared_scope glob matches as observed; a glob reaching past
// default_input.roots (`**/*.sh`) would count a script under apps/ or web/ as
// seen although no run reads it, and hide the blind spot the map exists to
// report. Each glob's literal prefix (up to its first wildcard) must sit under
// one of the roots.
for (const glob of manifest.declared_scope) {
  const wildcard = glob.search(/[*?[{]/);
  const literal = wildcard < 0 ? glob : glob.slice(0, wildcard);
  assert.ok(
    manifest.default_input.roots.some((root) => literal.startsWith(`${root}/`)),
    `declared_scope ${glob} reaches outside the scan roots ${manifest.default_input.roots.join(', ')}`,
  );
}
const real = analyzeWorkflowShellSafety({ roots: manifest.default_input.roots }, REPO_ROOT);
const realSummary =
  real.observations.find((o) => o.id === 'workflow-shell-safety-adapter:summary')?.details ?? {};
assert.equal(realSummary.parse_failures, 0);
assert.equal(realSummary.authorities_complete, true);
assert.ok((realSummary.workflows as number) >= 50, 'every workflow is read');
assert.ok((realSummary.shell_scripts as number) >= 70, 'every tracked shell script is read');
assert.deepEqual(
  real.findings.filter((finding) => finding.rule === 'unpinned_action'),
  [],
  'gha-sha-pin is green on this tree, so the projection is too',
);
assert.deepEqual(
  real.findings.filter((finding) => finding.rule === 'untrusted_workflow_interpolation'),
  [],
  'the injection invariant is green on this tree, so the projection is too',
);

// ------------------------------------- command_substitution_in_message (R03)
// ARIA-LOW-736 (PLAN-v2 F2.1). Inside double quotes bash runs a backtick as a
// command substitution, so a message that names a command in backticks runs
// it: ea2aa5002 (ARIA-MEDIUM-563) removed `echo "::error::… (`claude
// setup-token` …)"` from the API-key refusal path of aria-agent-executor.yml,
// where the runner would have started the interactive token mint in a CI step.
// The kernel's hygiene invariant (test_phase_b1_argv_proven_workflow_hygiene)
// refuses the shape in workflows, but the adapter modelled substitution only
// as a downloaded script, so ARIA's discovery read that step and saw nothing.
// New API pinned here: the rule id `command_substitution_in_message`, a
// finding at the echo/printf whose double-quoted argument holds a backtick
// substitution, read through the one shell reader (./shell-script.ts).
const messages = makeFixtureTree('aria-workflow-shell-message-');
function writeMessage(path: string, body: string, executable = false): void {
  mkdirSync(dirname(join(messages, path)), { recursive: true });
  writeFileSync(join(messages, path), body, 'utf8');
  chmodSync(join(messages, path), executable ? 0o755 : 0o644);
}
writeMessage(
  '.github/workflows/r03.yml',
  workflow([
    '  preflight:',
    '    runs-on: ubuntu-latest',
    '    permissions:',
    '      contents: read',
    '    steps:',
    '      - name: Refuse API-key mode (the R03 step, ea2aa5002^ aria-agent-executor.yml:524)',
    '        run: |',
    '          if [ "${EFFECTIVE_MOCK}" = "false" ]; then',
    "            if env | grep -E '^(ANTHROPIC_API_KEY|CLAUDE_API_KEY|ANTHROPIC_AUTH_TOKEN)=' >/dev/null; then",
    '              echo "::error::API-key Claude mode is disallowed for ARIA; use the kernel\'s Claude token (`claude setup-token` into the 0600 file ARIA_CLAUDE_OAUTH_TOKEN_FILE names) on the trusted runner." >&2',
    '              exit 1',
    '            fi',
    '          fi',
    '      - name: A printf message',
    '        run: printf "%s\\n" "next, run `make deploy` by hand"',
    '      - name: Text, and substitutions that are meant',
    '        run: |',
    "          echo 'single-quoted `claude setup-token` is text'",
    '          echo "escaped \\`claude setup-token\\` is text"',
    '          echo "named in plain quotes (\'claude setup-token\')"',
    '          echo "sha=$(git rev-parse HEAD)"',
    '          STAMP="`date -u`"',
    '          # echo "a comment naming `claude setup-token`"',
    "          cat <<'EOF' > NOTES.md",
    '          echo "a heredoc body naming `claude setup-token`"',
    '          EOF',
  ]),
);
writeMessage(
  'scripts/message.sh',
  [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'echo "Run `make migrate` before deploying."',
    'printf \'%s\\n\' "done"',
    '',
  ].join('\n'),
  true,
);
const messageOutput = analyzeWorkflowShellSafety({ roots: ['.github', 'scripts'] }, messages);
assert.equal(
  (
    messageOutput.observations.find((o) => o.id === 'workflow-shell-safety-adapter:summary')
      ?.details ?? {}
  ).parse_failures,
  0,
  'the fixture parses, so a missing finding is the rule, not the reader',
);
assert.deepEqual(
  messageOutput.findings
    .filter((finding) => finding.rule === 'command_substitution_in_message')
    .map((finding) => [finding.path, finding.line])
    .sort(),
  [
    ['.github/workflows/r03.yml', 13],
    ['.github/workflows/r03.yml', 18],
    ['scripts/message.sh', 3],
  ],
  'the R03 echo, the printf and the script message; not single quotes, an escaped backtick, plain quotes, $(…), an assignment, a comment or a heredoc body',
);
for (const finding of messageOutput.findings) {
  assert.ok(messageOutput.read_paths.includes(finding.path), `${finding.id} cites a read path`);
  assert.deepEqual(finding.evidence, [{ path: finding.path, line: finding.line }]);
}
const messageRule = (
  JSON.parse(readFileSync(join(__dirname, 'workflow-shell-safety-adapter.tool.json'), 'utf8')) as {
    rules: Record<string, { claim_type?: string; premises?: unknown[] }>;
  }
).rules.command_substitution_in_message;
assert.ok(messageRule !== undefined, 'the manifest declares the rule its findings carry');
assert.equal(messageRule.claim_type, 'wrong_code');
assert.ok((messageRule.premises ?? []).length > 0, 'the rule states the premises a judge checks');
assert.deepEqual(
  real.findings.filter(
    (finding) =>
      finding.rule === 'command_substitution_in_message' && finding.path.startsWith('.github/'),
  ),
  [],
  'the hygiene invariant is green on this tree, so the projection is too',
);

process.stdout.write('workflow-shell-safety-adapter.test.ts OK\n');
