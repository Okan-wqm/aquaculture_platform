// Maps kernel vocabulary to badge tones.
//
// WHY: the kernel's words are evidence — a screen that rewrites `contradicted`
// into prose destroys the operator's ability to match what is on screen against
// what is in the ledger. WHAT: the word itself always renders verbatim; only the
// colour, and the hover gloss, are authored here.
import type { RuntimeProfile } from '../../../../shared/api-contract.ts';
import type { BadgeTone } from '../../design/Badge.tsx';

export function toneForSeverity(severity: string | null | undefined): BadgeTone {
  switch ((severity ?? '').toUpperCase()) {
    case 'CRITICAL':
      return 'danger';
    case 'HIGH':
      return 'danger';
    case 'MEDIUM':
      return 'warning';
    case 'LOW':
      return 'info';
    case 'INFORMATIONAL':
      return 'muted';
    default:
      return 'neutral';
  }
}

const SUCCESS_WORDS = new Set(['completed', 'succeeded', 'accepted', 'supported', 'ok', 'healthy', 'closed', 'active', 'resolved', 'converged', 'verified', 'true_positive', 'passed', 'present', 'registered']);
const DANGER_WORDS = new Set(['failed', 'aborted', 'rejected', 'contradicted', 'tripped', 'open_circuit', 'breached', 'error', 'false_positive', 'withdrawn', 'quarantined', 'blocked', 'disabled', 'missing']);
const WARNING_WORDS = new Set(['stopped', 'expired', 'needs_revalidation', 'stale', 'half_open', 'paused', 'degraded', 'pending_review', 'escalated', 'warning']);
const INFO_WORDS = new Set(['started', 'running', 'claimed', 'submitted', 'queued', 'pending', 'in_progress', 'proposed', 'draft']);

export function toneForStatus(status: string | null | undefined): BadgeTone {
  const word = (status ?? '').toLowerCase();
  if (SUCCESS_WORDS.has(word)) {
    return 'success';
  }
  if (DANGER_WORDS.has(word)) {
    return 'danger';
  }
  if (WARNING_WORDS.has(word)) {
    return 'warning';
  }
  if (INFO_WORDS.has(word)) {
    return 'info';
  }
  return word === '' || word === 'unknown' ? 'muted' : 'neutral';
}

export function toneForProfile(profile: RuntimeProfile | null | undefined): BadgeTone {
  switch (profile) {
    case 'observe':
      return 'info';
    case 'standard':
      return 'success';
    case 'strict':
      return 'warning';
    case 'frozen':
      return 'danger';
    case 'autonomous':
      return 'accent';
    default:
      return 'muted';
  }
}

/**
 * Hover explanation for a runtime profile.
 *
 * WHY: the profile decides what the kernel is allowed to do, so the operator
 * needs the consequence — not a synonym. WHAT: the gloss goes in `title`; the
 * profile word itself still renders verbatim inside the badge.
 */
export function glossForProfile(profile: RuntimeProfile | null | undefined): string {
  switch (profile) {
    case 'observe':
      return 'observe: reads only, applies nothing';
    case 'standard':
      return 'standard: the ordinary cycle';
    case 'strict':
      return 'strict: additional gates are enforced';
    case 'frozen':
      return 'frozen: no change is written at all';
    case 'autonomous':
      return 'autonomous: may proceed without operator approval';
    default:
      return 'Profile unknown';
  }
}

export type StatTone = 'default' | 'danger' | 'warning' | 'success';

/**
 * Narrows a badge tone to the four tones a `Stat` tile understands.
 *
 * WHY: a distribution tile should be tinted by the same rule as the badge for
 * the same kernel word, otherwise the two say different things about one state.
 */
export function statToneForBadgeTone(tone: BadgeTone): StatTone {
  switch (tone) {
    case 'danger':
      return 'danger';
    case 'warning':
      return 'warning';
    case 'success':
      return 'success';
    default:
      return 'default';
  }
}

/**
 * Row tint for a severity, used by `rowClassName`.
 *
 * WHY: on a long findings table the badge alone is easy to miss when scanning;
 * tinting the whole row for the one severity that stops the world keeps colour
 * meaningful instead of decorative.
 */
export function rowClassForSeverity(severity: string | null | undefined): string | undefined {
  return (severity ?? '').toUpperCase() === 'CRITICAL' ? 'row-danger' : undefined;
}
