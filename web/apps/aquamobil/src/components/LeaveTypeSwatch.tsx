import type { ReactElement } from 'react';

/**
 * The colour dot beside a leave type.
 *
 * WHY a class fallback: `leaveType.color` is nullable (hr-service stores it
 * only when the tenant set one), and a leave type without a colour still
 * needs a dot. The ocean brand swatch stands in as a Tailwind class, so no
 * second hex lives in TypeScript beside the palette in tailwind.config.js.
 */
export function LeaveTypeSwatch({ color }: { color: string | null | undefined }): ReactElement {
  if (!color) return <div className="w-3 h-3 rounded-full bg-ocean-500" />;
  return <div className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />;
}
