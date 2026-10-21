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
