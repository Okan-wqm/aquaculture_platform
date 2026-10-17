/**
 * A panel's way out — "All alarms →", "Open audit log →" — as a link, since
 * it navigates. The arrow is lucide's, drawn beside the label and hidden from
 * assistive technology (the label alone names the destination).
 */
import { ArrowRight } from 'lucide-react';
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';

export function PanelLink({
  to,
  label,
}: {
  readonly to: string;
  readonly label: string;
}): ReactElement {
  return (
    <Link
      to={to}
      className="inline-flex min-h-10 items-center gap-1.5 text-base font-medium text-sd-accent-700 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      {label}
      <ArrowRight className="size-4" aria-hidden="true" />
    </Link>
  );
}
