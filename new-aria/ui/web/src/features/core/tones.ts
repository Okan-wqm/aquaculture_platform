// Maps kernel vocabulary (shown verbatim) to badge tones. The words themselves
// are never translated; only their colour carries the Turkish operator's gloss.
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

/** Turkish gloss shown on hover so the English kernel value stays verbatim on screen. */
export function glossForProfile(profile: RuntimeProfile | null | undefined): string {
  switch (profile) {
    case 'observe':
      return 'Gözlem: yalnızca okur, hiçbir şey uygulamaz';
    case 'standard':
      return 'Standart: olağan döngü';
    case 'strict':
      return 'Sıkı: ek kapılar etkin';
    case 'frozen':
      return 'Donmuş: hiçbir değişiklik yapılmaz';
    case 'autonomous':
      return 'Otonom: operatör onayı olmadan ilerleyebilir';
    default:
      return 'Profil bilinmiyor';
  }
}
