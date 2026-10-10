import type { ReactElement } from 'react';

/**
 * The colour dot beside a leave type.
 *
 * WHY a class fallback: `leaveType.color` is nullable (hr-service stores it
 * only when the tenant set one), and a leave type without a colour still
 * needs a dot. The accent token stands in as a class, so no second colour
 * lives in TypeScript beside the tokens in src/styles/tokens.css.
 */
export function LeaveTypeSwatch({ color }: { color: string | null | undefined }): ReactElement {
  if (!color) return <div className="w-3 h-3 shrink-0 rounded-full bg-acc" />;
  return <div className="w-3 h-3 shrink-0 rounded-full" style={{ backgroundColor: color }} />;
}
