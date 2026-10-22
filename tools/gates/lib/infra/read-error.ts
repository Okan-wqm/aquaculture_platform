/**
 * The error shape every infrastructure reader returns instead of throwing.
 *
 * WHY: a reader that throws on one malformed file aborts a whole scan, and a reader that
 * swallows the problem drops the file silently. Returning errors next to the partial result
 * lets the caller record the file as `parse_error` and keep going (ARIA-HIGH-012).
 */
export interface ReadError {
  /** 1-based line the problem was detected on. */
  readonly line: number;
  readonly message: string;
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
  return { line, message: `nesting deeper than ${MAX_NESTING_DEPTH} levels is not read` };
}
