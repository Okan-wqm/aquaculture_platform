/**
 * The alarm glyph's paint on the operator's dark chrome — the header's alarm
 * button, the alarm summary bar and the shell's alarm list all sit on
 * `bg-gray-900` in both themes.
 *
 * WHY its own map and not severityClasses(…, 'text'): that tone is ink for
 * paper (amber-800 / dark amber-200) and would read dark on dark here. WHY
 * shape and not only colour: inside the console `accent` and `warning` are the
 * one hazard amber (suderra.css), so HIGH and WARNING cannot differ by hue. The
 * annunciator draws them apart by fill (README §7.5: HIGH a filled amber tile,
 * MED an amber mark on a surface), and so does the glyph: HIGH is the filled
 * hazard sign — amber body, ink outline and "!" — WARNING the amber outline.
 *
 * Colour and fill only; a site that blinks the critical glyph adds
 * `motion-safe:animate-pulse` itself, so reduced motion keeps it still.
 */
import type { Severity } from '@aquaculture/shared-ui';

const GLYPH: Record<Severity, string> = {
  critical: 'text-error-400',
  high: 'text-gray-900 fill-accent-400',
  medium: 'text-warning-400',
  warning: 'text-warning-400',
  low: 'text-info-400',
  info: 'text-info-400',
};

/** Tailwind classes for an alarm glyph of `severity` on the dark operator chrome. */
export function alarmGlyphClass(severity: Severity): string {
  return GLYPH[severity];
}
