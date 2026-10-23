/**
 * The error shape every infrastructure reader returns instead of throwing.
 *
 * WHY: a reader that throws on one malformed file aborts a whole scan, and a reader that
 * swallows the problem drops the file silently. Returning errors next to the partial result
 * lets the caller record the file as `parse_error` and keep going (ARIA-HIGH-012).
 */
import type { ErrorCode as YamlErrorCode } from 'yaml';

/**
 * The kind of token a reader stopped on, named in a message instead of the token's text.
 */
export type ReadErrorTokenKind =
  | 'identifier'
  | 'string'
  | 'heredoc'
  | 'number'
  | 'punctuation'
  | 'newline';

/**
 * Every message a reader may give: a closed set of fixed texts whose only variable parts are
 * closed unions (a token kind, a yaml error code), never text taken from the file.
 *
 * WHY closed: a read error becomes the adapter's infrastructure_parse_failure observation, which
 * ARIA keeps in its state and evidence. Messages that quoted what the reader failed on
 * (`unexpected ${token.text}`, `directive ${name} has no ; or {`, `unknown instruction: ${word}`,
 * the yaml library's own messages) put a credential written on a malformed line there (ARIA-HIGH-012
 * round-3 review R2, kc/r12r2-review probe-leak.log ws/tf4). A template literal with a `string` or
 * `number` hole is not assignable to this type, so a reader that copies file text into an error
 * does not compile. Never add a member with such a hole: an all-digit credential is a number.
 * The position the reader stopped at is the error's `line`.
 */
export type ReadErrorMessage =
  // every reader that descends into nested structures
  | `nesting deeper than ${typeof MAX_NESTING_DEPTH} levels is not read`
  // more than one reader
  | 'newline in a quoted string'
  | 'unterminated quoted string'
  | 'unterminated heredoc'
  | 'unexpected }'
  // HCL (hcl-blocks.ts)
  | 'unterminated /* comment'
  | 'unterminated string'
  | 'unterminated template sequence'
  | 'invalid escape sequence in a quoted string'
  | 'block label is not a string literal'
  | 'malformed heredoc introducer'
  | 'unclosed block'
  | `unexpected ${ReadErrorTokenKind}`
  | `unexpected ${ReadErrorTokenKind} in block header`
  | 'block has no body'
  | 'attribute has no value'
  // nginx (nginx-conf.ts)
  | 'directive has no ; or {'
  | 'block is not closed'
  | 'empty directive'
  | 'block without a directive name'
  // NATS (nats-conf.ts)
  | 'map is not closed'
  | 'entry without a key'
  | 'missing value'
  | 'array is not closed'
  | 'unexpected } in array'
  // Dockerfile (dockerfile.ts)
  | 'invalid escape directive'
  | 'unknown instruction'
  | 'FROM without a base'
  | 'instruction before the first FROM'
  | 'no FROM instruction'
  // YAML (yaml-documents.ts): the library's error code, never its message
  | `YAML ${YamlErrorCode}`
  | 'the document expands through aliases and merge keys past the expansion budget'
  | 'an alias or merge key does not resolve to a value';

export interface ReadError {
  /** 1-based line the problem was detected on. */
  readonly line: number;
  readonly message: ReadErrorMessage;
}

/**
 * How deep a reader descends into nested blocks, maps, arrays or objects before it refuses the
 * rest of the file with a ReadError.
 *
 * WHY a bound: the NATS, nginx and HCL readers descend recursively, and 5000 levels (20 KB of
 * `a {`) overflowed the stack, so a RangeError escaped readers whose contract is to return errors:
 * the corpus test failed naming no file, and an adapter scan aborted instead of recording one
 * parse failure (ARIA-HIGH-012 landing fix 4). The tracked configurations nest fewer than ten
 * levels; 256 leaves room for any real file and stays far below the stack.
 */
export const MAX_NESTING_DEPTH = 256;

/**
 * The error every reader gives when it stops at MAX_NESTING_DEPTH: the NATS and nginx readers and
 * HCL blocks stop reading the file there; an HCL object value deeper than the bound keeps its raw
 * text and loses only its entries.
 */
export function nestingError(line: number): ReadError {
  return { line, message: `nesting deeper than ${MAX_NESTING_DEPTH} levels is not read` as const };
}
