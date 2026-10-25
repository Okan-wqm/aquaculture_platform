// ARIA-HIGH-013 — what a shell script RUNS, read without running it.
//
// WHY: the workflow/shell safety adapter decides on commands — is this stage
// of a pipeline a shell fed by a download, is this argv a forced push — so it
// needs the commands bash would execute, not lines that look like them. A
// regex over lines reports the install hint in `echo "curl … | bash"`, the
// comment above a command and the heredoc a script writes to a file, and it
// cannot see `bash <(curl …)` at all.
//
// The installed `shell-quote` package was measured first and does not answer
// that question: it reads a newline as a blank (`curl x\nbash -s` is one
// command `curl x bash -s`), lexes a heredoc body as commands, replaces
// `${TAG}` with the empty string, and is only a transitive dependency without
// types. This module is the one shell reader of tools/aria-adapters.
//
// WHAT it models: blanks, newlines and line continuations; comments; single,
// double and ANSI-C quotes; command (`$(…)`, backticks) and process (`<(…)`)
// substitution, read recursively, with how each is written (backticks or
// parentheses, inside double quotes or not); parameter and arithmetic
// expansion, kept as text; redirections, here-strings and heredocs (a heredoc body is data,
// except when it is fed to a shell that reads its script from stdin); lists,
// pipelines and subshells; the reserved words of compound commands (`if`,
// `for`, `while`, `case`, function definitions), which are stripped so the
// command inside them is what a rule sees. What it does not model is reported,
// not guessed: an unterminated quote, substitution or heredoc is a parse
// error, and the caller must treat the script as unread.

export interface ShellWord {
  /** The word after quote removal; expansions and substitutions are kept as written. */
  readonly text: string;
  readonly quoted: boolean;
}

export interface ShellRedirect {
  readonly op: string;
  readonly target: string;
}

/**
 * How the substitution that runs a command is written. Bash runs a backtick
 * inside double quotes as a command, which is what a message that names a
 * command in backticks gets wrong (`echo "run `make deploy`"`); `$(…)` and a
 * process substitution `<(…)` are `parenthesis`.
 */
export interface ShellSubstitution {
  readonly syntax: 'backtick' | 'parenthesis';
  /** Whether it sits inside a double-quoted string (`"… `x` …"`, `"$(x)"`). */
  readonly doubleQuoted: boolean;
}

export type ShellCommandVia =
  | 'top'
  | 'command_substitution'
  | 'process_substitution'
  | 'heredoc_script';

export interface ShellCommand {
  /** The command's words with assignments, redirections and reserved words removed. */
  readonly argv: readonly string[];
  readonly words: readonly ShellWord[];
  readonly assignments: readonly string[];
  readonly redirects: readonly ShellRedirect[];
  /** 1-based line of the command's first token, offset by `firstLine`. */
  readonly line: number;
  /** The pipeline this command is a stage of (unique within one parse). */
  readonly pipeline: number;
  /** 0-based stage index within that pipeline. */
  readonly stage: number;
  readonly via: ShellCommandVia;
  /** Index (in `commands`) of the command whose word or heredoc held this one. */
  readonly parent: number | null;
  /**
   * For a substitution: the index in the parent's `argv` of the word that
   * held it (`bash <(curl …)` → 1). Null for a top-level command, a heredoc
   * script, and a substitution held by an assignment or a redirection.
   */
  readonly holderWord: number | null;
  /**
   * For a command a substitution runs (`via` is `command_substitution` or
   * `process_substitution`): how that substitution is written. Null for a
   * top-level command and a heredoc script.
   */
  readonly substitution: ShellSubstitution | null;
}

export interface ShellParseError {
  readonly line: number;
  readonly message: string;
}

export interface ShellParse {
  readonly commands: readonly ShellCommand[];
  readonly errors: readonly ShellParseError[];
}

/** Interpreters that run a shell script. */
export const SHELL_INTERPRETERS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'dash',
  'zsh',
  'ksh',
  'mksh',
  'ash',
]);

// ------------------------------------------------------------------- tokens
interface NestedScript {
  readonly via: 'command_substitution' | 'process_substitution';
  readonly substitution: ShellSubstitution;
  readonly text: string;
  readonly start: number;
}

interface WordToken {
  readonly kind: 'word';
  readonly text: string;
  readonly raw: string;
  readonly quoted: boolean;
  readonly start: number;
  readonly nested: readonly NestedScript[];
}

interface OpToken {
  readonly kind: 'op';
  readonly op: string;
  readonly start: number;
}

interface Heredoc {
  readonly delimiter: string;
  readonly stripTabs: boolean;
  body: string | null;
  bodyStart: number;
}

interface RedirectToken {
  readonly kind: 'redirect';
  readonly op: string;
  readonly target: string;
  readonly start: number;
  readonly nested: readonly NestedScript[];
  readonly heredoc: Heredoc | null;
}

type Token = WordToken | OpToken | RedirectToken;

class ParseFailure extends Error {
  constructor(
    readonly position: number,
    message: string,
  ) {
    super(message);
  }
}

const BLANK = new Set([' ', '\t']);
const META = new Set(['|', '&', ';', '(', ')', '<', '>', ' ', '\t', '\n']);
const ANSI_C_ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  t: '\t',
  r: '\r',
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?',
};

/** Index just past the `)` that closes the `(` before `from`, honouring quotes and nesting. */
function closingParen(src: string, from: number, construct: string): number {
  let depth = 1;
  let i = from;
  while (i < src.length) {
    const char = src[i];
    if (char === '\\') {
      i += 2;
    } else if (char === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) throw new ParseFailure(from, `unterminated ${construct}`);
      i = end + 1;
    } else if (char === '"') {
      i = closingDoubleQuote(src, i + 1) + 1;
    } else if (char === '`') {
      i = closingBacktick(src, i + 1) + 1;
    } else if (char === '(') {
      depth += 1;
      i += 1;
    } else if (char === ')') {
      depth -= 1;
      i += 1;
      if (depth === 0) return i;
    } else {
      i += 1;
    }
  }
  throw new ParseFailure(from, `unterminated ${construct}`);
}

/** Index of the `"` that closes a double-quoted string whose body starts at `from`. */
function closingDoubleQuote(src: string, from: number): number {
  let i = from;
  while (i < src.length) {
    const char = src[i];
    if (char === '\\') i += 2;
    else if (char === '"') return i;
    else if (char === '`') i = closingBacktick(src, i + 1) + 1;
    else if (char === '$' && src[i + 1] === '(') i = closingParen(src, i + 2, '$(');
    else if (char === '$' && src[i + 1] === '{') i = closingBrace(src, i + 2);
    else i += 1;
  }
  throw new ParseFailure(from - 1, 'unterminated double quote');
}

/** Index of the backtick that closes a backtick substitution whose body starts at `from`. */
function closingBacktick(src: string, from: number): number {
  let i = from;
  while (i < src.length) {
    if (src[i] === '\\') i += 2;
    else if (src[i] === '`') return i;
    else i += 1;
  }
  throw new ParseFailure(from - 1, 'unterminated backtick substitution');
}

/** Index just past the `}` that closes a `${` whose body starts at `from`. */
function closingBrace(src: string, from: number): number {
  let depth = 1;
  let i = from;
  while (i < src.length) {
    const char = src[i];
    if (char === '\\') i += 2;
    else if (char === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) throw new ParseFailure(from, 'unterminated ${');
      i = end + 1;
    } else if (char === '"') i = closingDoubleQuote(src, i + 1) + 1;
    else if (char === '{') {
      depth += 1;
      i += 1;
    } else if (char === '}') {
      depth -= 1;
      i += 1;
      if (depth === 0) return i;
    } else i += 1;
  }
  throw new ParseFailure(from, 'unterminated ${');
}

function unescapeBacktickBody(body: string): string {
  return body.replace(/\\([\\`$])/g, '$1');
}

class Lexer {
  private i = 0;
  private readonly tokens: Token[] = [];
  private readonly pending: Heredoc[] = [];

  constructor(private readonly src: string) {}

  run(): Token[] {
    const { src } = this;
    while (this.i < src.length) {
      const char = src[this.i] as string;
      if (BLANK.has(char)) {
        this.i += 1;
      } else if (char === '\\' && src[this.i + 1] === '\n') {
        this.i += 2;
      } else if (char === '#') {
        while (this.i < src.length && src[this.i] !== '\n') this.i += 1;
      } else if (char === '\n') {
        this.tokens.push({ kind: 'op', op: '\n', start: this.i });
        this.i += 1;
        this.readHeredocBodies();
      } else if (char === '(' && src[this.i + 1] === '(') {
        // An arithmetic command `(( … ))`: no command runs inside it.
        this.i = closingParen(src, closingParen(src, this.i + 2, '(('), '((');
      } else if ((char === '<' || char === '>') && src[this.i + 1] === '(') {
        this.tokens.push(this.word());
      } else if (META.has(char)) {
        this.operator();
      } else if (/^[0-9]+[<>](?!\()/.test(src.slice(this.i, this.i + 12))) {
        // `2>&1`, `3<file`: the digits are the redirection's file descriptor.
        while (/[0-9]/.test(src[this.i] ?? '')) this.i += 1;
        this.operator();
      } else {
        this.tokens.push(this.word());
      }
    }
    if (this.pending.length > 0) {
      const [first] = this.pending;
      throw new ParseFailure(this.src.length, `unterminated heredoc ${first?.delimiter ?? ''}`);
    }
    return this.tokens;
  }

  private operator(): void {
    const { src } = this;
    const start = this.i;
    for (const op of [
      '<<<',
      '<<-',
      '&>>',
      ';;&',
      '||',
      '&&',
      ';;',
      ';&',
      '|&',
      '<<',
      '<&',
      '<>',
      '>>',
      '>&',
      '>|',
      '&>',
    ]) {
      if (src.startsWith(op, start)) {
        this.i += op.length;
        this.emitOperator(op, start);
        return;
      }
    }
    this.i += 1;
    this.emitOperator(src[start] as string, start);
  }

  private emitOperator(op: string, start: number): void {
    const redirect = op.includes('<') || op.includes('>');
    if (!redirect) {
      this.tokens.push({ kind: 'op', op, start });
      return;
    }
    while (BLANK.has(this.src[this.i] ?? '')) this.i += 1;
    const target =
      this.i < this.src.length && !META.has(this.src[this.i] as string) ? this.word() : null;
    let heredoc: Heredoc | null = null;
    if (op === '<<' || op === '<<-') {
      if (target === null) throw new ParseFailure(start, 'heredoc without a delimiter');
      heredoc = { delimiter: target.text, stripTabs: op === '<<-', body: null, bodyStart: -1 };
      this.pending.push(heredoc);
    }
    this.tokens.push({
      kind: 'redirect',
      op,
      target: target?.text ?? '',
      start,
      nested: target?.nested ?? [],
      heredoc,
    });
  }

  private readHeredocBodies(): void {
    const { src } = this;
    while (this.pending.length > 0) {
      const heredoc = this.pending.shift() as Heredoc;
      heredoc.bodyStart = this.i;
      for (;;) {
        if (this.i >= src.length) {
          throw new ParseFailure(heredoc.bodyStart, `unterminated heredoc ${heredoc.delimiter}`);
        }
        const lineEnd = src.indexOf('\n', this.i);
        const end = lineEnd < 0 ? src.length : lineEnd;
        const line = src.slice(this.i, end);
        const candidate = heredoc.stripTabs ? line.replace(/^\t+/, '') : line;
        if (candidate === heredoc.delimiter) {
          heredoc.body = src.slice(heredoc.bodyStart, this.i);
          this.i = lineEnd < 0 ? src.length : lineEnd + 1;
          break;
        }
        this.i = lineEnd < 0 ? src.length : lineEnd + 1;
      }
    }
  }

  private word(): WordToken {
    const { src } = this;
    const start = this.i;
    let text = '';
    let quoted = false;
    const nested: NestedScript[] = [];
    const substitution = (via: NestedScript['via'], open: number): void => {
      const close = closingParen(
        src,
        open + 2,
        via === 'command_substitution' ? '$(' : `${src[open]}(`,
      );
      nested.push({
        via,
        substitution: { syntax: 'parenthesis', doubleQuoted: false },
        text: src.slice(open + 2, close - 1),
        start: open + 2,
      });
      text += src.slice(open, close);
      this.i = close;
    };
    if ((src[this.i] === '<' || src[this.i] === '>') && src[this.i + 1] === '(') {
      substitution('process_substitution', this.i);
    }
    while (this.i < src.length) {
      const char = src[this.i] as string;
      const next = src[this.i + 1];
      if (char === '\\') {
        if (next === '\n') {
          this.i += 2;
        } else {
          text += next ?? '';
          quoted = true;
          this.i += 2;
        }
      } else if (char === "'") {
        const end = src.indexOf("'", this.i + 1);
        if (end < 0) throw new ParseFailure(this.i, 'unterminated single quote');
        text += src.slice(this.i + 1, end);
        quoted = true;
        this.i = end + 1;
      } else if (char === '$' && next === "'") {
        quoted = true;
        this.i += 2;
        for (;;) {
          if (this.i >= src.length) throw new ParseFailure(start, 'unterminated ANSI-C quote');
          const inner = src[this.i] as string;
          if (inner === "'") {
            this.i += 1;
            break;
          }
          if (inner === '\\') {
            const escaped = src[this.i + 1] ?? '';
            text += ANSI_C_ESCAPES[escaped] ?? escaped;
            this.i += 2;
          } else {
            text += inner;
            this.i += 1;
          }
        }
      } else if (char === '"' || (char === '$' && next === '"')) {
        const open = char === '"' ? this.i : this.i + 1;
        const close = closingDoubleQuote(src, open + 1);
        text += this.doubleQuoted(open + 1, close, nested);
        quoted = true;
        this.i = close + 1;
      } else if (char === '`') {
        const close = closingBacktick(src, this.i + 1);
        nested.push({
          via: 'command_substitution',
          substitution: { syntax: 'backtick', doubleQuoted: false },
          text: unescapeBacktickBody(src.slice(this.i + 1, close)),
          start: this.i + 1,
        });
        text += src.slice(this.i, close + 1);
        this.i = close + 1;
      } else if (char === '$' && next === '(' && src[this.i + 2] === '(') {
        const close = closingParen(src, closingParen(src, this.i + 3, '$(('), '$((');
        text += src.slice(this.i, close);
        this.i = close;
      } else if (char === '$' && next === '(') {
        substitution('command_substitution', this.i);
      } else if (char === '$' && next === '{') {
        const close = closingBrace(src, this.i + 2);
        text += src.slice(this.i, close);
        this.i = close;
      } else if (META.has(char)) {
        break;
      } else {
        text += char;
        this.i += 1;
      }
    }
    return { kind: 'word', text, raw: src.slice(start, this.i), quoted, start, nested };
  }

  private doubleQuoted(from: number, close: number, nested: NestedScript[]): string {
    const { src } = this;
    let text = '';
    let i = from;
    while (i < close) {
      const char = src[i] as string;
      const next = src[i + 1];
      if (char === '\\' && next !== undefined && '$`"\\\n'.includes(next)) {
        if (next !== '\n') text += next;
        i += 2;
      } else if (char === '`') {
        const end = closingBacktick(src, i + 1);
        nested.push({
          via: 'command_substitution',
          substitution: { syntax: 'backtick', doubleQuoted: true },
          text: unescapeBacktickBody(src.slice(i + 1, end)),
          start: i + 1,
        });
        text += src.slice(i, end + 1);
        i = end + 1;
      } else if (char === '$' && next === '(' && src[i + 2] === '(') {
        const end = closingParen(src, closingParen(src, i + 3, '$(('), '$((');
        text += src.slice(i, end);
        i = end;
      } else if (char === '$' && next === '(') {
        const end = closingParen(src, i + 2, '$(');
        nested.push({
          via: 'command_substitution',
          substitution: { syntax: 'parenthesis', doubleQuoted: true },
          text: src.slice(i + 2, end - 1),
          start: i + 2,
        });
        text += src.slice(i, end);
        i = end;
      } else if (char === '$' && next === '{') {
        const end = closingBrace(src, i + 2);
        text += src.slice(i, end);
        i = end;
      } else {
        text += char;
        i += 1;
      }
    }
    return text;
  }
}

// ----------------------------------------------------------------- commands
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;
const SKIPPED_RESERVED = new Set([
  'if',
  'then',
  'else',
  'elif',
  'do',
  'while',
  'until',
  '!',
  '{',
  'time',
  'fi',
  'done',
  '}',
]);
const LIST_SEPARATORS = new Set(['||', '&&', ';', '&', '\n', '(', ')']);
const CASE_TERMINATORS = new Set([';;', ';&', ';;&']);
const CONNECTORS = new Set(['|', '|&', '&&', '||']);

/**
 * Wrappers that run the command named by a later word: `sudo -E bash`,
 * `env A=1 sh`, `timeout 30 git push`. Each entry lists the options that take
 * a separate argument; the first word that is neither an option nor (for
 * `env`) an assignment is the command, after `timeout`'s duration.
 */
const WRAPPERS: Readonly<
  Record<string, { readonly withArgument: ReadonlySet<string>; readonly operands?: number }>
> = {
  sudo: { withArgument: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-T', '-U']) },
  env: { withArgument: new Set(['-u', '-C', '-S']) },
  command: { withArgument: new Set() },
  exec: { withArgument: new Set(['-a']) },
  nohup: { withArgument: new Set() },
  nice: { withArgument: new Set(['-n']) },
  stdbuf: { withArgument: new Set(['-i', '-o', '-e']) },
  time: { withArgument: new Set() },
  timeout: { withArgument: new Set(['-s', '-k']), operands: 1 },
};

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

/** The argv a wrapper (`sudo`, `env`, `timeout`, …) finally executes; the argv itself when there is none. */
export function effectiveArgv(argv: readonly string[]): readonly string[] {
  let rest = argv;
  for (;;) {
    const name = rest[0] === undefined ? undefined : basename(rest[0]);
    const wrapper = name === undefined ? undefined : WRAPPERS[name];
    if (wrapper === undefined) return rest;
    // `command -v x` looks x up; it does not run it.
    if (name === 'command' && (rest[1] === '-v' || rest[1] === '-V')) return rest;
    let index = 1;
    let operands = wrapper.operands ?? 0;
    while (index < rest.length) {
      const word = rest[index] as string;
      if (word === '--') {
        index += 1;
        break;
      }
      if (word.startsWith('-') && word.length > 1) {
        index += wrapper.withArgument.has(word) ? 2 : 1;
      } else if (name === 'env' && ASSIGNMENT_RE.test(word)) {
        index += 1;
      } else if (operands > 0) {
        operands -= 1;
        index += 1;
      } else {
        break;
      }
    }
    rest = rest.slice(index);
  }
}

/** The basename of the program `argv` executes, through any wrapper; null for an empty argv. */
export function commandName(argv: readonly string[]): string | null {
  const [program] = effectiveArgv(argv);
  return program === undefined ? null : basename(program);
}

/**
 * Whether a shell invocation (already through `effectiveArgv`) reads its
 * script from standard input: `bash`, `sh -s -- args`, `bash -` read stdin;
 * `bash -c '…'` and `bash script.sh` do not.
 */
export function shellReadsScriptFromStdin(argv: readonly string[]): boolean {
  const program = argv[0];
  if (program === undefined || !SHELL_INTERPRETERS.has(basename(program))) return false;
  for (let index = 1; index < argv.length; index += 1) {
    const word = argv[index] as string;
    if (word === '-') return true;
    if (word === '--') return index + 1 >= argv.length;
    if (word === '-o' || word === '+o') {
      index += 1;
      continue;
    }
    if (/^[-+][A-Za-z]+$/.test(word)) {
      if (word.slice(1).includes('s')) return true;
      if (word.slice(1).includes('c')) return false;
      continue;
    }
    if (word.startsWith('--')) continue;
    return false;
  }
  return true;
}

/** The three options a strict Bash script turns on. */
export const STRICT_SHELL_FLAGS = ['errexit', 'nounset', 'pipefail'] as const;
export type StrictShellFlag = (typeof STRICT_SHELL_FLAGS)[number];

/** The interpreter a `#!` line names (through `env`), and the flags it passes. */
export function interpreterOf(
  firstLine: string,
): { readonly name: string; readonly flags: readonly string[] } | null {
  if (!firstLine.startsWith('#!')) return null;
  const words = firstLine
    .slice(2)
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '');
  let index = 0;
  if (words[0] !== undefined && basename(words[0]) === 'env') {
    index = 1;
    while (words[index]?.startsWith('-') === true) index += 1;
  }
  const program = words[index];
  return program === undefined ? null : { name: basename(program), flags: words.slice(index + 1) };
}

/** Which of errexit / nounset / pipefail a `set` argv (or interpreter flags) turns on. */
export function strictFlagsOf(args: readonly string[], into: Set<StrictShellFlag>): void {
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] as string;
    const long = (name: string | undefined): void => {
      if (name === 'errexit' || name === 'nounset' || name === 'pipefail') into.add(name);
    };
    if (word === '-o') {
      index += 1;
      long(args[index]);
    } else if (/^-[A-Za-z]+$/.test(word)) {
      for (const letter of word.slice(1)) {
        if (letter === 'e') into.add('errexit');
        else if (letter === 'u') into.add('nounset');
        else if (letter === 'o') {
          index += 1;
          long(args[index]);
        }
      }
    }
  }
}

/**
 * The index (in a shell's effective argv) of the word that supplies its
 * script: the first operand, which is the command string under `-c` and the
 * script file otherwise. Null when the shell reads stdin (`-s`, `-`, no operand).
 */
export function scriptWordIndex(argv: readonly string[]): number | null {
  for (let index = 1; index < argv.length; index += 1) {
    const word = argv[index] as string;
    if (word === '-o' || word === '+o') {
      index += 1;
    } else if (/^[-+][A-Za-z]+$/.test(word)) {
      if (word.slice(1).includes('s')) return null;
    } else if (word === '--') {
      return index + 1 < argv.length ? index + 1 : null;
    } else if (word === '-') {
      return null;
    } else if (!word.startsWith('--')) {
      return index;
    }
  }
  return null;
}

interface Assembly {
  readonly commands: ShellCommand[];
  readonly errors: ShellParseError[];
  nextPipeline: number;
}

interface Pending {
  words: WordToken[];
  assignments: string[];
  /** Substitutions an assignment holds (`out=$(curl …)`): they run too. */
  assignmentNested: NestedScript[];
  redirects: RedirectToken[];
  start: number | null;
}

function emptyPending(): Pending {
  return { words: [], assignments: [], assignmentNested: [], redirects: [], start: null };
}

type CaseState = 'header' | 'pattern' | 'body';

function lineIndexer(src: string, firstLine: number): (position: number) => number {
  const breaks: number[] = [];
  for (let index = 0; index < src.length; index += 1) if (src[index] === '\n') breaks.push(index);
  return (position) => {
    let low = 0;
    let high = breaks.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((breaks[mid] as number) < position) low = mid + 1;
      else high = mid;
    }
    return firstLine + low;
  };
}

function assemble(
  src: string,
  firstLine: number,
  via: ShellCommandVia,
  substitution: ShellSubstitution | null,
  parent: number | null,
  out: Assembly,
): void {
  const lineAt = lineIndexer(src, firstLine);
  let tokens: Token[];
  let failure: ParseFailure | null = null;
  const lexer = new Lexer(src);
  try {
    tokens = lexer.run();
  } catch (error) {
    if (!(error instanceof ParseFailure)) throw error;
    failure = error;
    tokens = [];
  }
  if (failure !== null) {
    out.errors.push({ line: lineAt(failure.position), message: failure.message });
    return;
  }

  let pending = emptyPending();
  let pipeline: number | null = null;
  let stage = 0;
  const cases: CaseState[] = [];
  let skipLoopHeader = false;
  let expectFunctionName = false;
  // `a |` + newline + `b` is one pipeline: a line break after a connector
  // (`|`, `|&`, `&&`, `||`) continues the list instead of ending it.
  let afterConnector = false;

  const nestedOf = (command: Pending): { script: NestedScript; holderWord: number | null }[] => [
    ...command.assignmentNested.map((script) => ({ script, holderWord: null })),
    ...command.words.flatMap((word, wordIndex) =>
      word.nested.map((script) => ({ script, holderWord: wordIndex })),
    ),
    ...command.redirects.flatMap((redirect) =>
      redirect.nested.map((script) => ({ script, holderWord: null })),
    ),
  ];

  const finish = (): void => {
    const command = pending;
    pending = emptyPending();
    const argvWords = command.words;
    if (argvWords.length === 0 && command.assignments.length === 0) {
      // A command of redirections only (`done < file`) runs nothing.
      return;
    }
    const nested = nestedOf(command);
    // Substitutions run before the command that holds them.
    const nestedCommandsStart = out.commands.length;
    const holders = new Map<number, number | null>();
    for (const { script, holderWord } of nested) {
      const before = out.commands.length;
      assemble(script.text, lineAt(script.start), script.via, script.substitution, null, out);
      for (let child = before; child < out.commands.length; child += 1) {
        if ((out.commands[child] as ShellCommand).parent === null) holders.set(child, holderWord);
      }
    }
    if (pipeline === null) {
      pipeline = out.nextPipeline;
      out.nextPipeline += 1;
    }
    const index = out.commands.length;
    for (let child = nestedCommandsStart; child < index; child += 1) {
      const existing = out.commands[child] as ShellCommand;
      if (holders.has(child)) {
        out.commands[child] = {
          ...existing,
          parent: index,
          holderWord: holders.get(child) ?? null,
        };
      }
    }
    const argv = argvWords.map((word) => word.text);
    out.commands.push({
      argv,
      words: argvWords.map((word) => ({ text: word.text, quoted: word.quoted })),
      assignments: command.assignments,
      redirects: command.redirects.map((redirect) => ({
        op: redirect.op,
        target: redirect.target,
      })),
      line: lineAt(command.start ?? 0),
      pipeline,
      stage,
      via,
      parent,
      holderWord: null,
      substitution,
    });
    // A heredoc fed to a shell that reads its script from stdin is a script.
    if (shellReadsScriptFromStdin(effectiveArgv(argv))) {
      for (const redirect of command.redirects) {
        const body = redirect.heredoc?.body;
        if (redirect.heredoc !== null && body !== null && body !== undefined) {
          assemble(body, lineAt(redirect.heredoc.bodyStart), 'heredoc_script', null, index, out);
        }
      }
    }
  };

  const separate = (): void => {
    finish();
    pipeline = null;
    stage = 0;
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as Token;
    const caseState = cases[cases.length - 1];

    if (skipLoopHeader) {
      if (token.kind === 'op' && (token.op === ';' || token.op === '\n')) skipLoopHeader = false;
      else if (token.kind === 'word' && !token.quoted && token.text === 'do')
        skipLoopHeader = false;
      continue;
    }
    if (caseState === 'header') {
      if (token.kind === 'word' && !token.quoted && token.text === 'in')
        cases[cases.length - 1] = 'pattern';
      continue;
    }
    if (caseState === 'pattern') {
      if (token.kind === 'word' && !token.quoted && token.text === 'esac') cases.pop();
      else if (token.kind === 'op' && token.op === ')') cases[cases.length - 1] = 'body';
      continue;
    }

    if (token.kind === 'redirect') {
      afterConnector = false;
      if (pending.start === null) pending.start = token.start;
      pending.redirects.push(token);
      continue;
    }
    if (token.kind === 'op') {
      if (token.op === '\n' && afterConnector) continue;
      afterConnector = CONNECTORS.has(token.op);
      if (token.op === '|' || token.op === '|&') {
        finish();
        stage += 1;
        continue;
      }
      if (caseState === 'body' && CASE_TERMINATORS.has(token.op)) {
        separate();
        cases[cases.length - 1] = 'pattern';
        continue;
      }
      if (token.op === '(') {
        const onlyWord = pending.words.length === 1 && pending.assignments.length === 0;
        const nextToken = tokens[index + 1];
        if (onlyWord && nextToken?.kind === 'op' && nextToken.op === ')') {
          // `name () { … }`: a function definition, not a command.
          pending = emptyPending();
          index += 1;
          continue;
        }
      }
      if (LIST_SEPARATORS.has(token.op) || CASE_TERMINATORS.has(token.op)) separate();
      continue;
    }

    // A word.
    afterConnector = false;
    const atStart = pending.words.length === 0 && pending.assignments.length === 0;
    if (expectFunctionName) {
      expectFunctionName = false;
      const nextToken = tokens[index + 1];
      const afterNext = tokens[index + 2];
      if (
        nextToken?.kind === 'op' &&
        nextToken.op === '(' &&
        afterNext?.kind === 'op' &&
        afterNext.op === ')'
      ) {
        index += 2;
      }
      continue;
    }
    if (atStart && !token.quoted) {
      if (token.text === 'case') {
        cases.push('header');
        continue;
      }
      if (token.text === 'esac' && caseState === 'body') {
        separate();
        cases.pop();
        continue;
      }
      if (token.text === 'for' || token.text === 'select') {
        skipLoopHeader = true;
        continue;
      }
      if (token.text === 'function') {
        expectFunctionName = true;
        continue;
      }
      if (SKIPPED_RESERVED.has(token.text)) continue;
    }
    if (pending.start === null) pending.start = token.start;
    if (pending.words.length === 0 && ASSIGNMENT_RE.test(token.raw)) {
      pending.assignments.push(token.text);
      pending.assignmentNested.push(...token.nested);
      continue;
    }
    pending.words.push(token);
  }
  separate();
}

/**
 * The commands `text` runs, in execution order (a substitution before the
 * command that holds it, a heredoc-fed script after the shell that reads it),
 * or the errors that stopped the reading.
 */
export function parseShellScript(
  text: string,
  options: { readonly firstLine?: number } = {},
): ShellParse {
  const out: Assembly = { commands: [], errors: [], nextPipeline: 0 };
  assemble(text, options.firstLine ?? 1, 'top', null, null, out);
  return { commands: out.commands, errors: out.errors };
}
