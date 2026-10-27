#!/usr/bin/env ts-node
// ARIA-HIGH-013 — workflow and shell safety observation (plan Task 16).
//
// WHY: ARIA read no workflow or shell script for safety. The harness-security
// adapter looks at workflows for committed secrets, untrusted checkouts and
// broad write grants; nothing observed a mutable action pin, a pull-request
// field spliced into `run:`, `curl … | bash`, a forced push or a skipped hook
// in a deploy step, or a Bash script that keeps going after a failed command.
// Most of those are already decided somewhere in this repository; ARIA saw
// none of the verdicts.
//
// WHAT: an observation over `.github/workflows/*`, the composite actions, and
// the shell scripts and hooks under the manifest's roots. Where a rule has an
// owner, the verdict is the owner's — the module its gate or perimeter runs —
// so the gate and the observation cannot disagree:
//
//   unpinned_action                  tools/gates/gha-sha-pin.ts (`inspectUsesText`)
//   untrusted_workflow_interpolation tools/gates/workflow-input-injection.ts
//                                    (`findRunBlockInjections`; workflow inputs and
//                                    the pull-request-controlled event payload)
//   overbroad_write_token            aria-kernel/aria_kernel/workflow_contract_registry.py
//                                    (`uncontracted_write_scopes`) for a job the
//                                    registry governs; `permissions: write-all`
//                                    (every scope) for any job; an ungoverned
//                                    job's `contents: write` with no registry
//                                    contract and no scoped-reason comment
//                                    (ARIA-LOW-592, the case the harness's
//                                    broad_shell_permission used to carry)
//   governance_bypass_command        aria-kernel/aria_kernel/implementation_safety.py
//                                    (`governance_bypass_refusal`: the force-push
//                                    and hook/signing-bypass definition the
//                                    pre-PR-open perimeter refuses an argv with)
//
// The perimeter refuses an agent's `core.hooksPath` override as well. In a
// repository script that override is the hardening of a git helper that runs
// read-only commands (tools/scripts/ci/prepare-production-host-*.sh run
// `rev-parse` and `archive` with hooks off so a checkout's hooks cannot run),
// and the helper's subcommand is `"$@"`, which no reader can resolve. The
// owner's `hooks_path_override` verdicts are therefore recorded as
// observations (`workflow_shell_hooks_path_override`, with path and line),
// never dropped; the plan's three — force push, `--no-verify`,
// `--no-gpg-sign` (and the rest of the perimeter's hook-bypass flags) — are
// findings.
//
// The two kernel owners are Python; the adapter asks them in ONE `python3 -I
// -S` call (standard library only — no site packages, so it needs nothing the
// room does not bind) and never restates their rules.
//
// Three rules have no other owner and live here, read through the one shell
// reader of tools/aria-adapters (./shell-script.ts):
//
//   pipe_to_shell             a download piped into, or substituted as the
//                             script of, a shell (`curl … | sh`,
//                             `bash <(curl …)`, `sh -c "$(wget …)"`, `eval`)
//   command_substitution_in_message
//                             an `echo`/`printf` whose double-quoted argument
//                             holds a backtick substitution: bash runs the
//                             command a message meant to name (R03, the
//                             `claude setup-token` refusal ea2aa5002 removed;
//                             ARIA-LOW-736). `$(…)` is written on purpose and
//                             is not this rule.
//   missing_strict_shell_mode an executable Bash script that runs more than one
//                             command without `set -euo pipefail`. POSIX `sh`,
//                             a script that is not executable or has no
//                             interpreter line, a sourced fragment, a fixture
//                             and a one-pipeline probe carry an explicit reason
//                             on their observation instead.
//
// A workflow or composite action under a `.github/` directory that is not the
// repository root's is dead: GitHub runs only `.github/workflows/<name>.yml`
// and `.github/actions/<name>/action.yml` at the root, which is also the scope
// of the pin gate (`isActionPinScopedPath`). Such a file raises no finding and
// is no workflow here, but it is observed (`workflow_shell_nested_workflow_dir`)
// so the dead file is visible and not skipped in silence.
//
// Data is not a command: a comment, a quoted string, a heredoc fed to `cat`
// and a non-shell `run:` step (`shell: python`) are never read as commands.
// A file whose YAML or shell does not parse is an observation with
// `clean: false`, never a clean result. A file under a fixture directory is
// read and observed with the reason `fixture` and raises no finding: fixture
// workspaces are test data that no lane executes.
import { createHash } from 'node:crypto';
import { basename, join, relative } from 'node:path';

import yaml from 'js-yaml';

import { inspectUsesText, isActionPinScopedPath } from '../gates/gha-sha-pin';
import {
  findRunBlockInjections,
  isWorkflowPath,
  runBlocksOf,
} from '../gates/workflow-input-injection';

import {
  collectFiles,
  containedWorkspace,
  filterFilesBySnapshot,
  isArchivedWorkspacePath,
  isWorkspaceRelativePath,
  normalizeWorkspacePath,
  pathAllowedBySnapshot,
  requireScanRoots,
  type RepoSnapshot,
  workspaceIsExecutable,
} from './adapter-fs';
import { askKernelOwners } from './kernel-owners';
import {
  SHELL_INTERPRETERS,
  STRICT_SHELL_FLAGS,
  commandName,
  effectiveArgv,
  interpreterOf,
  parseShellScript,
  scriptWordIndex,
  shellReadsScriptFromStdin,
  strictFlagsOf,
  type ShellCommand,
  type StrictShellFlag,
} from './shell-script';

const TOOL_ID = 'workflow-shell-safety-adapter';

const PIN_OWNER = 'tools/gates/gha-sha-pin.ts';
const INJECTION_OWNER = 'tools/gates/workflow-input-injection.ts';
const REGISTRY_OWNER = 'aria-kernel/aria_kernel/workflow_contract_registry.py';
const PERIMETER_OWNER = 'aria-kernel/aria_kernel/implementation_safety.py';
const SHELL_READER = 'tools/aria-adapters/shell-script.ts';
const BRIDGE = 'tools/aria-adapters/kernel-owners.ts';
const SELF = 'tools/aria-adapters/workflow-shell-safety-adapter.ts';

/**
 * The files whose text decides a verdict here. Their hashes are the
 * observation's provenance (`metadata.authorities`): the workflow registry,
 * the action-pin owner and the command policy the plan asks the run to
 * record, plus the shell reader and this adapter's own rules.
 */
const AUTHORITY_PATHS: readonly string[] = [
  PIN_OWNER,
  INJECTION_OWNER,
  REGISTRY_OWNER,
  PERIMETER_OWNER,
  SHELL_READER,
  BRIDGE,
  SELF,
];

const DOWNLOADERS: ReadonlySet<string> = new Set(['curl', 'wget']);
/** A path inside the `workflows/` or `actions/` directory of some `.github/`, the root one or a nested one. */
const WORKFLOW_DIR_YAML = /(?:^|\/)\.github\/(?:workflows|actions)\//;
const NESTED_WORKFLOW_REASON =
  'GitHub never runs it: only .github/workflows/<name>.yml and .github/actions/<name>/action.yml ' +
  'at the repository root run';
const FIXTURE_SEGMENTS: ReadonlySet<string> = new Set([
  'fixtures',
  '__fixtures__',
  'testdata',
  'test-fixtures',
]);

interface AdapterInput {
  readonly roots?: readonly string[];
  /**
   * A workspace-relative directory under which the scanned tree mirrors the
   * repository layout (a fixture workspace). The owners' path questions — is
   * this a workflow, does the registry govern it — are asked of the path
   * below it; evidence still cites the workspace path. Absent in production.
   */
  readonly pathBase?: string;
  readonly repo_snapshot?: RepoSnapshot & { readonly base_commit_sha?: string | null };
}

interface EvidenceRef {
  readonly path: string;
  readonly line?: number;
}

interface AdapterObservation {
  readonly id: string;
  readonly type: string;
  readonly path?: string;
  readonly details?: Record<string, unknown>;
}

type WorkflowShellRule =
  | 'unpinned_action'
  | 'untrusted_workflow_interpolation'
  | 'overbroad_write_token'
  | 'pipe_to_shell'
  | 'governance_bypass_command'
  | 'missing_strict_shell_mode'
  | 'command_substitution_in_message';

type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

interface AdapterFinding {
  readonly id: string;
  readonly rule: WorkflowShellRule;
  readonly severity: FindingSeverity;
  readonly path: string;
  readonly line: number;
  readonly message: string;
  readonly evidence: readonly EvidenceRef[];
  readonly confidence: number;
  /** The module whose rule decided the verdict, and the id it reports under. */
  readonly owner: string;
  readonly owner_rule_id: string;
  readonly range: { readonly start_line: number; readonly end_line: number };
  /** The action, job, scope, command or flag set the verdict is about. */
  readonly subject: string | null;
  readonly remediation: string;
  readonly target_sha: string | null;
  readonly fingerprint: string;
}

interface AriaOutput {
  readonly observations: readonly AdapterObservation[];
  readonly findings: readonly AdapterFinding[];
  readonly read_paths: readonly string[];
  readonly evidence_sources: readonly string[];
  readonly belief_candidates: readonly unknown[];
  readonly cost_units: number;
  readonly metadata: Record<string, unknown>;
}

interface Projection {
  readonly rule: WorkflowShellRule;
  readonly severity: FindingSeverity;
  readonly confidence: number;
}

/**
 * One entry per rule the manifest contracts. Each rule id is written here
 * as a literal: the rule-contract pin (aria-kernel/tests/test_rule_contract_
 * manifests.py) reads the emitted vocabulary from this source.
 */
const RULES: Readonly<Record<WorkflowShellRule, Projection>> = {
  unpinned_action: { rule: 'unpinned_action', severity: 'high', confidence: 0.95 },
  untrusted_workflow_interpolation: {
    rule: 'untrusted_workflow_interpolation',
    severity: 'critical',
    confidence: 0.9,
  },
  overbroad_write_token: { rule: 'overbroad_write_token', severity: 'high', confidence: 0.85 },
  pipe_to_shell: { rule: 'pipe_to_shell', severity: 'high', confidence: 0.85 },
  governance_bypass_command: {
    rule: 'governance_bypass_command',
    severity: 'high',
    confidence: 0.9,
  },
  missing_strict_shell_mode: {
    rule: 'missing_strict_shell_mode',
    severity: 'medium',
    confidence: 0.8,
  },
  command_substitution_in_message: {
    rule: 'command_substitution_in_message',
    severity: 'medium',
    confidence: 0.9,
  },
};

/** The commands that print a message: their arguments are text, never meant to run. */
const MESSAGE_COMMANDS: ReadonlySet<string> = new Set(['echo', 'printf']);

// ------------------------------------------------------------------ helpers
function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function repoShapedPath(workspacePath: string, pathBase: string | null): string | null {
  if (pathBase === null) return workspacePath;
  return workspacePath.startsWith(`${pathBase}/`) ? workspacePath.slice(pathBase.length + 1) : null;
}

function isFixturePath(repoPath: string): boolean {
  return repoPath.split('/').some((segment) => FIXTURE_SEGMENTS.has(segment));
}

function asMapping(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function yamlErrorLine(error: unknown): number {
  const mark = asMapping(asMapping(error)?.mark);
  return typeof mark?.line === 'number' ? mark.line + 1 : 1;
}

type Permissions = Record<string, unknown> | string | null;

/** A job's token scope as declared: undeclared (the repository default), a keyword, none, or a scope map. */
function tokenScopeOf(permissions: Permissions): string {
  if (permissions === null) return 'repository_default';
  if (typeof permissions === 'string') return permissions;
  return Object.keys(permissions).length === 0 ? 'none' : 'scoped';
}

function writeScopesOf(permissions: Permissions): string[] {
  if (permissions === 'write-all') return ['*'];
  if (permissions === null || typeof permissions === 'string') return [];
  return Object.entries(permissions)
    .filter(([, value]) => value === 'write')
    .map(([key]) => key);
}

function lineIndexOf(
  lines: readonly string[],
  pattern: RegExp,
  from = 0,
  until = lines.length,
): number {
  for (let index = from; index < until; index += 1)
    if (pattern.test(lines[index] as string)) return index;
  return -1;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 0-based line range of a job's mapping under `jobs:` (start = its key line). */
function jobRange(lines: readonly string[], job: string): { start: number; end: number } | null {
  const jobsLine = lineIndexOf(lines, /^jobs:\s*(?:#.*)?$/);
  if (jobsLine < 0) return null;
  const start = lineIndexOf(
    lines,
    new RegExp(`^(\\s+)${escapeRegExp(job)}:\\s*(?:#.*)?$`),
    jobsLine + 1,
  );
  if (start < 0) return null;
  const indent = (lines[start] as string).search(/\S/);
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end] as string;
    if (line.trim() !== '' && !line.trim().startsWith('#') && line.search(/\S/) <= indent) break;
    end += 1;
  }
  return { start, end };
}

// ------------------------------------------------------------------ the scan
interface FileContext {
  readonly path: string;
  readonly repoPath: string;
  readonly lines: readonly string[];
  readonly fixture: boolean;
}

interface CommandSite {
  readonly file: FileContext;
  readonly command: ShellCommand;
  /** Every command of the same parse, indexable by `ShellCommand.parent`. */
  readonly siblings: readonly ShellCommand[];
  /** Clamp for a folded `run: >` block, whose inner lines are unknown. */
  readonly lineOverride: number | null;
}

export function analyzeWorkflowShellSafety(
  input: AdapterInput,
  workspaceRoot = process.cwd(),
): AriaOutput {
  const roots = requireScanRoots(TOOL_ID, input.roots);
  const workspace = containedWorkspace(workspaceRoot);
  const pathBase = input.pathBase === undefined ? null : input.pathBase;
  if (pathBase !== null && !isWorkspaceRelativePath(pathBase)) {
    throw new Error(
      `${TOOL_ID}: pathBase must be a normalised workspace-relative path: ${pathBase}`,
    );
  }
  const targetSha = input.repo_snapshot?.base_commit_sha ?? null;
  const readPaths = new Set<string>();
  const observations: AdapterObservation[] = [];
  const findings: AdapterFinding[] = [];

  const rootDirs = roots.filter((root) => {
    const entry = workspace.entry(root);
    if (entry === 'refused') {
      throw new Error(`${TOOL_ID}: root is not a contained workspace-relative path: ${root}`);
    }
    return entry === 'directory';
  });
  const candidates = filterFilesBySnapshot(
    rootDirs.flatMap((root) =>
      collectFiles(workspaceRoot, join(workspaceRoot, root), {
        extensions: [''],
        // ADAPTER_EXCLUDED_DIRS skips every `build` directory as generated
        // output, but tools/build/ holds tracked scripts (build-service.sh).
        includeExcludedDir: (name) => name === 'build',
        includeFile: (name, path) =>
          /\.(?:ya?ml|sh|bash)$/.test(name) ||
          (!name.includes('.') && workspaceIsExecutable(workspaceRoot, path)),
      }),
    ),
    workspaceRoot,
    input,
  );

  const occurrences = new Map<string, number>();
  const emit = (
    projection: Projection,
    file: FileContext,
    line: number,
    snippet: string,
    owner: string,
    ownerRuleId: string,
    subject: string | null,
    message: string,
    remediation: string,
  ): void => {
    if (file.fixture) return;
    const { rule, severity, confidence } = projection;
    const key = [rule, file.path, ownerRuleId, snippet.replace(/\s+/g, ' ').trim()].join('\n');
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);
    const fingerprint = sha256(`${key}\n${occurrence}`);
    const at = Math.max(1, line);
    findings.push({
      id: `${TOOL_ID}:${rule}:${file.path}:${fingerprint.slice(7, 23)}`,
      rule,
      severity,
      path: file.path,
      line: at,
      message,
      evidence: [{ path: file.path, line: at }],
      confidence,
      owner,
      owner_rule_id: ownerRuleId,
      range: { start_line: at, end_line: at },
      subject,
      remediation,
      target_sha: targetSha,
      fingerprint,
    });
  };

  const parseFailures: { file: FileContext; line: number; message: string }[] = [];
  const failParse = (file: FileContext, line: number, message: string): void => {
    if (!parseFailures.some((failure) => failure.file.path === file.path)) {
      parseFailures.push({ file, line, message: message.slice(0, 300) });
    }
  };

  const commandSites: CommandSite[] = [];
  const sourcedNames = new Set<string>();
  const collectCommands = (
    file: FileContext,
    commands: readonly ShellCommand[],
    lineOverride: number | null,
  ): void => {
    for (const command of commands) {
      commandSites.push({ file, command, siblings: commands, lineOverride });
      const name = commandName(command.argv);
      if (name === 'source' || name === '.') {
        const target = effectiveArgv(command.argv)[1];
        if (target !== undefined) sourcedNames.add(basename(target));
      }
    }
  };

  // ------------------------------------------------------------ workflows
  interface JobScope {
    readonly job: string;
    readonly declaredAt: 'job' | 'workflow' | null;
    readonly permissions: Permissions;
  }
  const workflowJobs: { file: FileContext; jobs: JobScope[]; details: Record<string, unknown> }[] =
    [];
  interface ScriptFile {
    readonly file: FileContext;
    readonly interpreter: string | null;
    readonly interpreterFlags: readonly string[];
    readonly executable: boolean;
    readonly commands: readonly ShellCommand[] | null;
  }
  const scripts: ScriptFile[] = [];
  const otherExecutables: { file: FileContext; interpreter: string | null }[] = [];
  const yamlFiles: {
    file: FileContext;
    kind: 'workflow' | 'composite_action';
    details: Record<string, unknown>;
  }[] = [];
  const nestedWorkflowDirs: { path: string; fixture: boolean }[] = [];

  for (const absolute of candidates) {
    const path = normalizeWorkspacePath(relative(workspaceRoot, absolute));
    const repoPath = repoShapedPath(path, pathBase);
    if (repoPath === null || isArchivedWorkspacePath(repoPath)) continue;
    const isYaml = /\.ya?ml$/.test(path);
    if (isYaml && !isActionPinScopedPath(repoPath)) {
      if (WORKFLOW_DIR_YAML.test(repoPath)) {
        nestedWorkflowDirs.push({ path, fixture: isFixturePath(repoPath) });
      }
      continue;
    }
    if (workspace.entry(path) !== 'file') continue;
    const text = workspace.readFile(path);
    readPaths.add(path);
    const file: FileContext = {
      path,
      repoPath,
      lines: text.split('\n'),
      fixture: isFixturePath(repoPath),
    };

    if (isYaml) {
      const kind = isWorkflowPath(repoPath) ? 'workflow' : 'composite_action';
      const details: Record<string, unknown> = { kind, fixture: file.fixture };
      yamlFiles.push({ file, kind, details });
      for (const pin of inspectUsesText(repoPath, text)) {
        emit(
          RULES.unpinned_action,
          file,
          pin.line,
          pin.uses,
          PIN_OWNER,
          'R27-sha-pin',
          pin.uses,
          `\`uses: ${pin.uses}\` is not pinned to a 40-character commit SHA, so whoever can move that tag or branch decides what this step runs.`,
          'Pin the action to the commit SHA of the release and keep the tag as a trailing comment ' +
            '(gh api repos/<owner>/<repo>/git/refs/tags/<tag> --jq .object.sha; peel annotated tags).',
        );
      }
      let document: Record<string, unknown> | null;
      let blocks: ReturnType<typeof runBlocksOf>;
      try {
        document = asMapping(yaml.load(text));
        blocks = runBlocksOf(text);
      } catch (error) {
        failParse(
          file,
          yamlErrorLine(error),
          error instanceof Error ? error.message : String(error),
        );
        details.verdict = 'unparsable';
        continue;
      }
      details.verdict = 'observed';
      if (kind === 'workflow') {
        for (const violation of findRunBlockInjections(text, path)) {
          emit(
            RULES.untrusted_workflow_interpolation,
            file,
            violation.lineNo,
            violation.snippet,
            INJECTION_OWNER,
            violation.contextClass,
            violation.snippet,
            violation.contextClass === 'workflow_input'
              ? `run: splices a workflow input (${violation.snippet}) into shell source; the runner substitutes it before bash parses, so the value is code.`
              : `run: splices a field an outside author writes (${violation.snippet}) into shell source; the runner substitutes it before bash parses, so the value is code.`,
            'Pass the value through the step env: block and read "$VAR" inside run: (tools/gates/workflow-input-injection.ts).',
          );
        }
        const workflowPermissions = document?.permissions;
        const jobs: JobScope[] = [];
        for (const [job, body] of Object.entries(asMapping(document?.jobs) ?? {})) {
          const own = asMapping(body)?.permissions;
          const declared = own !== undefined ? own : workflowPermissions;
          const declaredAt =
            own !== undefined ? 'job' : workflowPermissions !== undefined ? 'workflow' : null;
          const permissions =
            typeof declared === 'string'
              ? declared
              : (asMapping(declared) ?? (declared === undefined ? null : {}));
          jobs.push({ job, declaredAt, permissions });
        }
        workflowJobs.push({ file, jobs, details });
      }
      let shellBlocks = 0;
      let nonShellBlocks = 0;
      for (const block of blocks) {
        if (block.shell !== null && !/^(?:bash|sh)\b/.test(block.shell)) {
          nonShellBlocks += 1;
          continue;
        }
        shellBlocks += 1;
        const firstLine = block.startLine > 0 ? block.startLine : 1;
        const parsed = parseShellScript(block.run, { firstLine });
        const [error] = parsed.errors;
        if (error !== undefined) {
          failParse(
            file,
            block.linesExact ? error.line : firstLine,
            `run: step ${block.stepIndex}: ${error.message}`,
          );
          continue;
        }
        collectCommands(file, parsed.commands, block.linesExact ? null : firstLine);
      }
      details.run_blocks = blocks.length;
      details.shell_run_blocks = shellBlocks;
      details.non_shell_run_blocks = nonShellBlocks;
      continue;
    }

    // ------------------------------------------------------ shell scripts
    const interpreter = interpreterOf(file.lines[0] ?? '');
    const isShellName = /\.(?:sh|bash)$/.test(path);
    if (interpreter !== null && !SHELL_INTERPRETERS.has(interpreter.name)) {
      otherExecutables.push({ file, interpreter: interpreter.name });
      continue;
    }
    if (interpreter === null && !isShellName) {
      otherExecutables.push({ file, interpreter: null });
      continue;
    }
    const executable = workspaceIsExecutable(workspaceRoot, path);
    const parsed = parseShellScript(text);
    const [error] = parsed.errors;
    if (error !== undefined) failParse(file, error.line, error.message);
    else collectCommands(file, parsed.commands, null);
    scripts.push({
      file,
      interpreter: interpreter?.name ?? null,
      interpreterFlags: interpreter?.flags ?? [],
      executable,
      commands: error === undefined ? parsed.commands : null,
    });
  }

  // ------------------------------------------------- command-level verdicts
  const gitSites: { site: CommandSite; argv: readonly string[] }[] = [];
  const lineOf = (site: CommandSite): number => site.lineOverride ?? site.command.line;
  for (const site of commandSites) {
    const { command, siblings, file } = site;
    const name = commandName(command.argv);
    if (name === 'git') gitSites.push({ site, argv: effectiveArgv(command.argv) });

    // A download piped into a shell that reads its script from stdin. The
    // pipeline is reported once, at the stage that downloads.
    if (name !== null && DOWNLOADERS.has(name)) {
      const shellStage = siblings.find(
        (other) =>
          other.pipeline === command.pipeline &&
          other.stage > command.stage &&
          shellReadsScriptFromStdin(effectiveArgv(other.argv)),
      );
      if (shellStage !== undefined) {
        const shell = commandName(shellStage.argv) ?? 'sh';
        emit(
          RULES.pipe_to_shell,
          file,
          lineOf(site),
          `${command.argv.join(' ')} | ${shellStage.argv.join(' ')}`,
          SELF,
          'pipeline',
          `${name} | ${shell}`,
          `\`${name}\` output is piped into \`${shell}\`, which runs whatever the server returns, unverified, with this job's credentials.`,
          'Download to a file, verify its checksum or signature, then run the file.',
        );
      }
    }

    // A message that runs what it names: a backtick inside a double-quoted
    // `echo`/`printf` argument is a command substitution. Reported once per
    // message, at the command, naming the first command it runs.
    if (name !== null && MESSAGE_COMMANDS.has(name)) {
      const messageIndex = siblings.indexOf(command);
      const ran = siblings.find(
        (child) =>
          child.parent === messageIndex &&
          child.holderWord !== null &&
          child.substitution !== null &&
          child.substitution.syntax === 'backtick' &&
          child.substitution.doubleQuoted,
      );
      if (ran !== undefined) {
        const named = ran.argv.join(' ');
        emit(
          RULES.command_substitution_in_message,
          file,
          lineOf(site),
          command.argv.join(' '),
          SELF,
          'backtick-in-double-quotes',
          named,
          `\`${name}\` prints a double-quoted message holding \`${named}\` in backticks; bash runs it as a command substitution before the message prints, with this step's credentials.`,
          "Name the command in plain or single quotes ('…'), or escape the backticks (\\`…\\`).",
        );
      }
    }

    // A download substituted as the script itself: `bash <(curl …)`,
    // `sh -c "$(wget …)"`, `eval "$(curl …)"`, `source <(curl …)`.
    const argv = effectiveArgv(command.argv);
    const offset = command.argv.length - argv.length;
    const scriptWord = name !== null && SHELL_INTERPRETERS.has(name) ? scriptWordIndex(argv) : null;
    const codeWords = new Set<number>();
    if (scriptWord !== null) codeWords.add(scriptWord + offset);
    if (name === 'eval')
      for (let index = 1; index < argv.length; index += 1) codeWords.add(index + offset);
    if ((name === 'source' || name === '.') && argv.length > 1) codeWords.add(1 + offset);
    if (codeWords.size === 0) continue;
    const index = siblings.indexOf(command);
    const downloaded = siblings.find(
      (child) =>
        child.parent === index &&
        child.holderWord !== null &&
        codeWords.has(child.holderWord) &&
        (child.via === 'command_substitution' || child.via === 'process_substitution') &&
        DOWNLOADERS.has(commandName(child.argv) ?? ''),
    );
    if (downloaded !== undefined) {
      const downloader = commandName(downloaded.argv) ?? 'curl';
      emit(
        RULES.pipe_to_shell,
        file,
        lineOf(site),
        command.argv.join(' '),
        SELF,
        downloaded.via,
        `${downloader} -> ${name}`,
        `\`${name}\` runs the output of \`${downloader}\` as its script, unverified, with this job's credentials.`,
        'Download to a file, verify its checksum or signature, then run the file.',
      );
    }
  }

  // --------------------------------------------- the kernel owners, asked once
  const jobQuestions = workflowJobs.flatMap(({ file, jobs }) =>
    jobs.map((scope) => ({ file, scope })),
  );
  const answer = askKernelOwners({
    argvs: gitSites.map(({ argv }) => [...argv]),
    jobs: jobQuestions.map(({ file, scope }) => ({
      workflow_file: file.repoPath,
      job_id: scope.job,
      permissions: scope.permissions,
    })),
  });

  const hooksPathOverrides: { site: CommandSite; detail: string }[] = [];
  gitSites.forEach(({ site, argv }, index) => {
    const verdict = answer.argvs[index];
    if (verdict === null || verdict === undefined) return;
    const [check, detail] = verdict;
    if (detail.startsWith('hooks_path_override:')) {
      if (!site.file.fixture) hooksPathOverrides.push({ site, detail });
      return;
    }
    const forcePush = check === 'no_force_push';
    emit(
      RULES.governance_bypass_command,
      site.file,
      lineOf(site),
      argv.join(' '),
      PERIMETER_OWNER,
      check,
      detail,
      forcePush
        ? `\`${argv.join(' ')}\` force-pushes (${detail}); CLAUDE.md forbids force push, and the pre-PR-open perimeter refuses this argv.`
        : `\`${argv.join(' ')}\` skips git's hooks or signing (${detail}); CLAUDE.md forbids it, and the pre-PR-open perimeter refuses this argv.`,
      forcePush
        ? 'Push without force: publish to a new ref, or let the reviewed merge flow move the branch.'
        : 'Let the hooks and signing run; fix what they refuse instead of skipping them.',
    );
  });

  const tokenScopes: Record<string, number> = {};
  jobQuestions.forEach(({ file, scope }, index) => {
    const verdict = answer.jobs[index];
    const tokenScope = tokenScopeOf(scope.permissions);
    tokenScopes[tokenScope] = (tokenScopes[tokenScope] ?? 0) + 1;
    const range = jobRange(file.lines, scope.job);
    const permissionsLine =
      scope.declaredAt === 'job' && range !== null
        ? lineIndexOf(file.lines, /^\s+permissions:/, range.start + 1, range.end)
        : lineIndexOf(file.lines, /^permissions:/);
    const anchor = permissionsLine >= 0 ? permissionsLine + 1 : (range?.start ?? 0) + 1;
    if (scope.permissions === 'write-all') {
      emit(
        RULES.overbroad_write_token,
        file,
        anchor,
        `${scope.job}: permissions: write-all`,
        SELF,
        'write-all',
        scope.job,
        `job \`${scope.job}\` runs with \`permissions: write-all\`: its token can write every scope, whatever its steps use.`,
        "Declare the job's permissions: with only the scopes its steps use.",
      );
    }
    for (const scopeName of verdict?.uncontracted ?? []) {
      const scopeLine =
        permissionsLine >= 0
          ? lineIndexOf(
              file.lines,
              new RegExp(`^\\s+${escapeRegExp(scopeName)}:\\s*write\\b`),
              permissionsLine + 1,
            )
          : -1;
      emit(
        RULES.overbroad_write_token,
        file,
        scopeLine >= 0 ? scopeLine + 1 : anchor,
        `${scope.job}:${scopeName}: write`,
        REGISTRY_OWNER,
        'uncontracted-write-scope',
        `${scope.job}:${scopeName}`,
        `job \`${scope.job}\` grants \`${scopeName}: write\`, which its contract in the workflow registry does not; the contract is the job's least privilege.`,
        `Drop ${scopeName}: write from the job, or add it to the job contract in ${REGISTRY_OWNER} with the reason it is needed.`,
      );
    }
    // ARIA-LOW-592 — the one case only the harness's broad_shell_permission
    // covered: an UNGOVERNED job's `contents: write`. Workflow token scope
    // has one owner (this rule), so the case moved here: the repository
    // write scope is granted with no registry contract to justify it and no
    // `reason:` comment beside the grant. A governed job is the registry's
    // business alone (uncontracted-write-scope above); the harness's
    // comment-less regex never asks the registry and is retired.
    if (
      verdict?.governed !== true &&
      typeof scope.permissions === 'object' &&
      scope.permissions !== null &&
      scope.permissions.contents === 'write'
    ) {
      const contentsLine =
        scope.declaredAt === 'job' && permissionsLine >= 0
          ? lineIndexOf(file.lines, /^\s+contents:\s*write\b/, permissionsLine + 1)
          : lineIndexOf(file.lines, /^contents:\s*write\b/);
      // The same escape the retired harness rule gave: a `reason` in the
      // two lines above the grant (comment or text) is the scoped
      // justification the finding asks for.
      const oneBased = contentsLine + 1;
      const escapeChunk =
        contentsLine >= 0
          ? file.lines.slice(Math.max(0, oneBased - 3), oneBased - 1).join('\n')
          : '';
      if (!/reason/i.test(escapeChunk)) {
        emit(
          RULES.overbroad_write_token,
          file,
          contentsLine >= 0 ? oneBased : anchor,
          `${scope.job}:contents: write`,
          SELF,
          'ungoverned-write-scope',
          scope.job,
          `job \`${scope.job}\` grants \`contents: write\` with no registry contract and no scoped-reason comment: the workflow token can write the repository, whatever its steps use.`,
          'Register the job contract in aria-kernel/aria_kernel/workflow_contract_registry.py with the scopes it needs, or carry a `reason:` comment beside the grant naming why the write scope is needed.',
        );
      }
    }
  });
  for (const { jobs, details } of workflowJobs) {
    details.jobs = jobs.map((scope) => ({
      job: scope.job,
      governed:
        answer.jobs[jobQuestions.findIndex((question) => question.scope === scope)]?.governed ===
        true,
      token_scope: tokenScopeOf(scope.permissions),
      declared_at: scope.declaredAt,
      write_scopes: writeScopesOf(scope.permissions),
    }));
  }

  // ------------------------------------------------------------ strict mode
  const exemptions: Record<string, number> = {};
  for (const script of scripts) {
    const flags = new Set<StrictShellFlag>();
    strictFlagsOf(script.interpreterFlags, flags);
    const topLevel = (script.commands ?? []).filter(
      (command) => command.via === 'top' && command.parent === null,
    );
    for (const command of topLevel) {
      if (command.argv[0] === 'set') strictFlagsOf(command.argv.slice(1), flags);
    }
    const work = topLevel.filter((command) => command.argv[0] !== 'set');
    const pipelines = new Set(work.map((command) => command.pipeline));
    const reason =
      script.commands === null
        ? 'unparsable'
        : work.length === 0
          ? 'empty'
          : script.interpreter === 'sh' ||
              script.interpreter === 'dash' ||
              script.interpreter === 'ash'
            ? 'posix_sh'
            : !script.executable
              ? 'not_executable'
              : script.interpreter === null
                ? 'no_interpreter_line'
                : script.file.fixture
                  ? 'fixture'
                  : sourcedNames.has(basename(script.file.path))
                    ? 'sourced_fragment'
                    : pipelines.size <= 1
                      ? 'one_line_probe'
                      : null;
    const present = STRICT_SHELL_FLAGS.filter((flag) => flags.has(flag));
    const missing = reason === null ? STRICT_SHELL_FLAGS.filter((flag) => !flags.has(flag)) : [];
    if (reason !== null) exemptions[reason] = (exemptions[reason] ?? 0) + 1;
    if (missing.length > 0) {
      emit(
        RULES.missing_strict_shell_mode,
        script.file,
        1,
        missing.join(','),
        SELF,
        'strict-mode',
        missing.join(','),
        `executable ${script.interpreter ?? 'shell'} script runs ${work.length} commands without ${missing
          .map((flag) => `\`set -o ${flag}\``)
          .join(
            ', ',
          )}: a failed command lets the next one run, and a failed pipeline stage is masked.`,
        'Start the script with `set -euo pipefail` after the interpreter line.',
      );
    }
    observations.push({
      id: `${TOOL_ID}:file:${script.file.path}`,
      type: 'workflow_shell_file',
      path: script.file.path,
      details: {
        kind: 'shell_script',
        verdict: script.commands === null ? 'unparsable' : 'observed',
        interpreter: script.interpreter,
        executable: script.executable,
        commands: script.commands?.length ?? 0,
        fixture: script.file.fixture,
        strict_mode: { required: reason === null, reason, flags: present, missing },
      },
    });
  }
  for (const { file, details } of yamlFiles) {
    observations.push({
      id: `${TOOL_ID}:file:${file.path}`,
      type: 'workflow_shell_file',
      path: file.path,
      details,
    });
  }
  for (const { file, interpreter } of otherExecutables) {
    observations.push({
      id: `${TOOL_ID}:file:${file.path}`,
      type: 'workflow_shell_file',
      path: file.path,
      details: { kind: 'other_executable', interpreter },
    });
  }
  for (const { path, fixture } of nestedWorkflowDirs) {
    observations.push({
      id: `${TOOL_ID}:nested-workflow-dir:${path}`,
      type: 'workflow_shell_nested_workflow_dir',
      path,
      details: { reason: NESTED_WORKFLOW_REASON, owner: PIN_OWNER, fixture },
    });
  }
  for (const { site, detail } of hooksPathOverrides) {
    const line = lineOf(site);
    observations.push({
      id: `${TOOL_ID}:hooks-path-override:${site.file.path}:${line}`,
      type: 'workflow_shell_hooks_path_override',
      path: site.file.path,
      details: {
        line,
        detail,
        owner: PERIMETER_OWNER,
        argv: effectiveArgv(site.command.argv).join(' '),
      },
    });
  }
  for (const failure of parseFailures) {
    observations.push({
      id: `${TOOL_ID}:parse-failure:${failure.file.path}`,
      type: 'workflow_shell_parse_failure',
      path: failure.file.path,
      details: { line: failure.line, message: failure.message },
    });
  }

  // ------------------------------------------------------------ provenance
  const authorities: Record<string, string | null> = {};
  for (const path of AUTHORITY_PATHS) {
    if (workspace.entry(path) === 'file' && pathAllowedBySnapshot(workspaceRoot, path, input)) {
      authorities[path] = sha256(workspace.readFile(path));
      readPaths.add(path);
    } else {
      authorities[path] = null;
    }
  }

  const findingCounts: Record<string, number> = {};
  for (const finding of findings)
    findingCounts[finding.rule] = (findingCounts[finding.rule] ?? 0) + 1;
  // Findings are emitted per file but scripts are classified last; counting
  // per path keeps the per-file observation honest about what it raised.
  const perPath = new Map<string, number>();
  for (const finding of findings) perPath.set(finding.path, (perPath.get(finding.path) ?? 0) + 1);
  for (const observation of observations) {
    if (
      observation.type === 'workflow_shell_file' &&
      observation.path !== undefined &&
      observation.details
    ) {
      observation.details.findings = perPath.get(observation.path) ?? 0;
    }
  }
  observations.push({
    id: `${TOOL_ID}:summary`,
    type: 'workflow_shell_summary',
    details: {
      files: yamlFiles.length + scripts.length + otherExecutables.length,
      workflows: yamlFiles.filter((entry) => entry.kind === 'workflow').length,
      composite_actions: yamlFiles.filter((entry) => entry.kind === 'composite_action').length,
      shell_scripts: scripts.length,
      other_executables: otherExecutables.length,
      nested_workflow_dirs: nestedWorkflowDirs.length,
      fixture_files: [
        ...yamlFiles.map((entry) => entry.file),
        ...scripts.map((entry) => entry.file),
      ].filter((file) => file.fixture).length,
      git_commands: gitSites.length,
      hooks_path_overrides: hooksPathOverrides.length,
      parse_failures: parseFailures.length,
      clean: parseFailures.length === 0,
      findings: findingCounts,
      strict_mode_exemptions: exemptions,
      token_scope: tokenScopes,
      authorities,
      authorities_complete: Object.values(authorities).every((hash) => hash !== null),
      target_sha: targetSha,
    },
  });

  const sortedReadPaths = [...readPaths].sort();
  return {
    observations: observations.sort((a, b) => a.id.localeCompare(b.id)),
    findings: findings.sort((a, b) => a.id.localeCompare(b.id)),
    read_paths: sortedReadPaths,
    evidence_sources: sortedReadPaths,
    belief_candidates: [],
    cost_units: sortedReadPaths.length,
    metadata: { scanMode: 'workflow_shell_safety_v1', pathBase, authorities },
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string | Buffer) => {
      input += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    process.stdin.on('end', () => resolvePromise(input));
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  const rawInput = await readStdin();
  const input = rawInput.trim().length > 0 ? (JSON.parse(rawInput) as AdapterInput) : {};
  process.stdout.write(`${JSON.stringify(analyzeWorkflowShellSafety(input))}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
