/**
 * Dockerfile reader: instructions and build stages (ARIA-HIGH-012).
 *
 * WHY a real reader: a line grep for `FROM`/`USER` is wrong on exactly the files that matter.
 * `FROM builder` names an earlier stage, not an image; `USER root` inside a `RUN <<EOF`
 * heredoc body is shell text, not an instruction; `\` continuations (or the `# escape=`
 * directive's character) join physical lines; global `ARG` defaults are substituted into
 * `FROM`. Every rule about base images, the runtime user or HEALTHCHECK reads this one
 * model, following https://docs.docker.com/reference/dockerfile/.
 */
import type { ReadError } from './read-error';

const KEYWORDS: ReadonlySet<string> = new Set([
  'ADD',
  'ARG',
  'CMD',
  'COPY',
  'ENTRYPOINT',
  'ENV',
  'EXPOSE',
  'FROM',
  'HEALTHCHECK',
  'LABEL',
  'MAINTAINER',
  'ONBUILD',
  'RUN',
  'SHELL',
  'STOPSIGNAL',
  'USER',
  'VOLUME',
  'WORKDIR',
]);
const HEREDOC_KEYWORDS: ReadonlySet<string> = new Set(['RUN', 'COPY', 'ADD']);
const DIRECTIVE = /^#\s*([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(\S+)\s*$/;
const HEREDOC_MARKER = /<<(-?)(["']?)([A-Za-z_][A-Za-z0-9_]*)\2/g;

export interface DockerInstruction {
  readonly keyword: string;
  /** Arguments with continuations joined (heredoc bodies excluded). */
  readonly args: string;
  /** 1-based line of the instruction's first physical line. */
  readonly line: number;
  readonly heredocs: readonly string[];
}

export interface DockerStage {
  readonly index: number;
  /** Base reference with global ARG defaults substituted. */
  readonly from: string;
  readonly fromRaw: string;
  readonly fromLine: number;
  readonly name: string | null;
  readonly platform: string | null;
  /** `FROM <earlier stage name>`: the base is that stage, not an image. */
  readonly isStageRef: boolean;
  readonly baseStage: number | null;
  readonly isScratch: boolean;
  /** Last USER of this stage (null: none in this stage). */
  readonly user: string | null;
  readonly userLine: number | null;
  readonly healthcheck: { readonly line: number; readonly disabled: boolean } | null;
  readonly runs: readonly { readonly line: number; readonly body: string }[];
}

export interface DockerfileRead {
  readonly instructions: readonly DockerInstruction[];
  readonly stages: readonly DockerStage[];
  readonly errors: readonly ReadError[];
}

interface MutableStage {
  index: number;
  from: string;
  fromRaw: string;
  fromLine: number;
  name: string | null;
  platform: string | null;
  isStageRef: boolean;
  baseStage: number | null;
  isScratch: boolean;
  user: string | null;
  userLine: number | null;
  healthcheck: { line: number; disabled: boolean } | null;
  runs: { line: number; body: string }[];
}

/** Parser directives sit at the very top, before any comment, blank line or instruction. */
function readEscape(lines: readonly string[]): { escape: string; errors: ReadError[] } {
  let escape = '\\';
  const errors: ReadError[] = [];
  for (const [index, line] of lines.entries()) {
    const match = DIRECTIVE.exec(line);
    if (match === null) break;
    const [, name, value] = match;
    if (name !== undefined && name.toLowerCase() === 'escape') {
      if (value === '\\' || value === '`') escape = value;
      else errors.push({ line: index + 1, message: 'invalid escape directive' });
    }
  }
  return { escape, errors };
}

function endsWithEscape(line: string, escape: string): boolean {
  return line.trimEnd().endsWith(escape);
}

function isComment(line: string): boolean {
  return line.trimStart().startsWith('#');
}

/** Split the file into logical instructions; heredoc bodies are attached, never re-read. */
function readInstructions(text: string): {
  instructions: DockerInstruction[];
  errors: ReadError[];
} {
  const lines = text.split(/\r?\n/);
  const lineAt = (index: number): string => (index < lines.length ? String(lines[index]) : '');
  const { escape, errors } = readEscape(lines);
  const instructions: DockerInstruction[] = [];
  let i = 0;
  while (i < lines.length) {
    const first = lineAt(i);
    if (first.trim() === '' || isComment(first)) {
      i += 1;
      continue;
    }
    const startLine = i + 1;
    let logical = first;
    while (endsWithEscape(logical, escape) && i + 1 < lines.length) {
      logical = logical.trimEnd().slice(0, -escape.length);
      i += 1;
      // Comment and empty lines inside a continuation are dropped by the builder.
      while (i < lines.length && (isComment(lineAt(i)) || lineAt(i).trim() === '')) i += 1;
      if (i >= lines.length) break;
      logical += ` ${lineAt(i).trim()}`;
    }
    if (endsWithEscape(logical, escape)) logical = logical.trimEnd().slice(0, -escape.length);
    i += 1;
    const trimmed = logical.trim();
    const space = trimmed.search(/\s/);
    const keyword = (space < 0 ? trimmed : trimmed.slice(0, space)).toUpperCase();
    const args = space < 0 ? '' : trimmed.slice(space).trim();
    if (!KEYWORDS.has(keyword)) {
      errors.push({ line: startLine, message: 'unknown instruction' });
      continue;
    }
    const heredocs: string[] = [];
    if (HEREDOC_KEYWORDS.has(keyword)) {
      for (const marker of args.matchAll(HEREDOC_MARKER)) {
        const stripTabs = marker[1] === '-';
        const delimiter = String(marker[3]);
        const body: string[] = [];
        let closed = false;
        while (i < lines.length) {
          const raw = lineAt(i);
          i += 1;
          const candidate = stripTabs ? raw.replace(/^\t+/, '') : raw;
          if (candidate === delimiter) {
            closed = true;
            break;
          }
          body.push(candidate);
        }
        if (!closed) errors.push({ line: startLine, message: 'unterminated heredoc' });
        heredocs.push(body.join('\n'));
      }
    }
    instructions.push({ keyword, args, line: startLine, heredocs });
  }
  return { instructions, errors };
}

/** Substitute `$VAR`, `${VAR}`, `${VAR:-word}` and `${VAR:+word}` from known ARG values. */
function substituteArgs(text: string, args: ReadonlyMap<string, string | null>): string {
  return text.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([-+])([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (
      whole,
      braced: string | undefined,
      op: string | undefined,
      word: string | undefined,
      bare: string | undefined,
    ) => {
      const name = braced === undefined ? bare : braced;
      if (name === undefined) return whole;
      const value = args.get(name);
      const set = value !== undefined && value !== null && value !== '';
      if (op === '-') return set ? value : word === undefined ? '' : word;
      if (op === '+') return set ? (word === undefined ? '' : word) : '';
      return set ? value : whole;
    },
  );
}

function parseArg(args: string): [string, string | null] {
  const eq = args.indexOf('=');
  if (eq < 0) return [args.trim(), null];
  return [
    args.slice(0, eq).trim(),
    args
      .slice(eq + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/, '$2'),
  ];
}

export function readDockerfile(text: string): DockerfileRead {
  const { instructions, errors } = readInstructions(text);
  const globalArgs = new Map<string, string | null>();
  const stages: MutableStage[] = [];
  for (const instruction of instructions) {
    const { keyword, args, line } = instruction;
    const current = stages[stages.length - 1];
    if (keyword === 'FROM') {
      const tokens = args.split(/\s+/).filter((t) => t.length > 0);
      let platform: string | null = null;
      for (let flag = tokens[0]; flag !== undefined && flag.startsWith('--'); flag = tokens[0]) {
        tokens.shift();
        if (flag.startsWith('--platform=')) platform = flag.slice('--platform='.length);
      }
      const fromRaw = tokens[0];
      if (fromRaw === undefined) {
        errors.push({ line, message: 'FROM without a base' });
        continue;
      }
      const asIndex = tokens.findIndex((t) => t.toLowerCase() === 'as');
      const alias = asIndex > 0 ? tokens[asIndex + 1] : undefined;
      const name = alias === undefined ? null : alias;
      const from = substituteArgs(fromRaw, globalArgs);
      const baseStage = stages.findIndex(
        (stage) => stage.name !== null && stage.name.toLowerCase() === from.toLowerCase(),
      );
      stages.push({
        index: stages.length,
        from,
        fromRaw,
        fromLine: line,
        name,
        platform,
        isStageRef: baseStage >= 0,
        baseStage: baseStage >= 0 ? baseStage : null,
        isScratch: from.toLowerCase() === 'scratch',
        user: null,
        userLine: null,
        healthcheck: null,
        runs: [],
      });
      continue;
    }
    if (current === undefined) {
      if (keyword === 'ARG') {
        const [argName, value] = parseArg(args);
        globalArgs.set(argName, value);
      } else {
        errors.push({ line, message: 'instruction before the first FROM' });
      }
      continue;
    }
    if (keyword === 'USER') {
      current.user = String(args.split(/\s+/)[0]);
      current.userLine = line;
    } else if (keyword === 'HEALTHCHECK') {
      current.healthcheck = {
        line,
        disabled: String(args.split(/\s+/)[0]).toUpperCase() === 'NONE',
      };
    } else if (keyword === 'RUN') {
      const body = [args, ...instruction.heredocs].join('\n');
      current.runs.push({ line, body });
    }
  }
  if (stages.length === 0 && errors.length === 0)
    errors.push({ line: 1, message: 'no FROM instruction' });
  return { instructions, stages, errors };
}
