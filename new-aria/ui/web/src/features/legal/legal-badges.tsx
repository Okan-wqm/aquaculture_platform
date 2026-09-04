// Legal vocabulary badges.
//
// WHY: the contract's epistemic distinctions (asserted != verified, party vs
// ai_inference, text vs unreadable) must be visible on every row. The kernel
// value renders VERBATIM and the English meaning sits in the title attribute, so
// a machine-produced claim can never read as a fact; `verified` is the only
// status a human earns.
// WHAT: status/source/extraction badges, the human-review marker, the confidence
// meter, evidence-reference chips and the calendar-precision date cell shared by
// every legal tab.
import type { ReactNode } from 'react';
import type { AssertionSource, ExtractionStatus, LegalEvidenceRef, StatementStatus } from '../../../../shared/legal-contract.ts';
import { Badge, type BadgeTone } from '../../design/Badge.tsx';
import { EMPTY, formatDay, formatNumber, formatPercent } from '../../design/format.ts';
import './legal.css';

const STATEMENT_TONE: Readonly<Record<StatementStatus, BadgeTone>> = {
  asserted: 'neutral',
  disputed: 'warning',
  supported: 'info',
  contradicted: 'danger',
  unverifiable: 'muted',
  verified: 'success',
};

const STATEMENT_GLOSS: Readonly<Record<StatementStatus, string>> = {
  asserted: "Asserted — one side's statement; not a fact",
  disputed: 'Disputed — a counter-statement exists',
  supported: 'Supported — evidence is referenced, no human verification',
  contradicted: 'Contradicted — contrary evidence exists',
  unverifiable: 'Unverifiable — no evidence in this archive',
  verified: 'Verified — a human reviewer recorded the verification',
};

export function StatementStatusBadge({ status }: { readonly status: StatementStatus }): ReactNode {
  return (
    <Badge tone={STATEMENT_TONE[status]} title={STATEMENT_GLOSS[status]}>
      {status}
    </Badge>
  );
}

const SOURCE_TONE: Readonly<Record<AssertionSource, BadgeTone>> = {
  party: 'neutral',
  court: 'info',
  counsel: 'neutral',
  third_party: 'neutral',
  // Two machine sources, two tones on purpose: a parser reading bytes is a
  // neutral observation, a model's proposal is a state a reader must weigh.
  mechanical_extraction: 'neutral',
  ai_inference: 'accent',
  operator: 'success',
};

const SOURCE_GLOSS: Readonly<Record<AssertionSource, string>> = {
  party: 'Party statement',
  court: 'Court record',
  counsel: 'Counsel statement',
  third_party: 'Third party',
  mechanical_extraction: 'Mechanical extraction — a parser read these bytes at the stated locator; human review required',
  ai_inference: 'AI inference — not evidence; human review required',
  operator: 'Operator record',
};

export function AssertedByBadge({ source, partyId }: { readonly source: AssertionSource; readonly partyId?: string | null | undefined }): ReactNode {
  return (
    <span className="row">
      <Badge tone={SOURCE_TONE[source]} title={SOURCE_GLOSS[source]}>
        {source}
      </Badge>
      {partyId !== undefined && partyId !== null ? (
        <span className="chip mono" title={`assertedByPartyId ${partyId}`}>
          {partyId}
        </span>
      ) : null}
    </span>
  );
}

/** Explicit marker; renders a muted dash when review is not required so the column never looks empty by accident. */
export function ReviewMarker({ required }: { readonly required: boolean }): ReactNode {
  if (!required) {
    return (
      <span className="muted" title="human_review_required = false">
        {EMPTY}
      </span>
    );
  }
  return (
    <Badge tone="warning" title="human_review_required = true">
      Human review required
    </Badge>
  );
}

const EXTRACTION_TONE: Readonly<Record<ExtractionStatus, BadgeTone>> = {
  text: 'success',
  metadata_only: 'info',
  unreadable: 'danger',
  excluded: 'muted',
};

const EXTRACTION_GLOSS: Readonly<Record<ExtractionStatus, string>> = {
  text: 'Text extracted',
  metadata_only: 'Metadata only — the bytes were not readable as text',
  unreadable: 'Unreadable — raises a pressure record instead of silence',
  excluded: 'Excluded from the sweep (excludedReason)',
};

export function ExtractionBadge({ status }: { readonly status: ExtractionStatus }): ReactNode {
  return (
    <Badge tone={EXTRACTION_TONE[status]} title={EXTRACTION_GLOSS[status]}>
      {status}
    </Badge>
  );
}

export function KindGuessBadge({ kind, confidence }: { readonly kind: string; readonly confidence: number }): ReactNode {
  return (
    <span className="row">
      <Badge tone={kind === 'UNKNOWN' ? 'muted' : 'neutral'} mono title="kindGuess — a mechanical guess, not a classification">
        {kind}
      </Badge>
      <ConfidenceMeter value={confidence} />
    </span>
  );
}

export function ConfidenceMeter({ value }: { readonly value: number }): ReactNode {
  // WHY: clamping keeps a malformed artifact from rendering a meter outside its
  // track; the numeric percentage stays next to the bar so colour is never the
  // only carrier of the value.
  const bounded = Math.max(0, Math.min(1, value));
  return (
    <span className="confidence" title={`confidence ${formatPercent(bounded)}`}>
      <meter className="confidence__meter" min={0} max={1} low={0.4} high={0.75} optimum={1} value={bounded} aria-label="Confidence" />
      <span className="confidence__text tnum">{formatPercent(bounded)}</span>
    </span>
  );
}

export function PrecisionBadge({ precision }: { readonly precision: 'day' | 'month' | 'year' | 'unknown' }): ReactNode {
  const tone: BadgeTone = precision === 'day' ? 'success' : precision === 'unknown' ? 'danger' : 'warning';
  return (
    <Badge tone={tone} title="datePrecision — how precisely the date is known">
      {precision}
    </Badge>
  );
}

export function EvidenceRefList({ refs, max = 3 }: { readonly refs: ReadonlyArray<LegalEvidenceRef>; readonly max?: number | undefined }): ReactNode {
  if (refs.length === 0) {
    return <span className="muted">{EMPTY}</span>;
  }
  const shown = refs.slice(0, max);
  const rest = refs.length - shown.length;
  return (
    <ul className="chip-list" aria-label={`Evidence: ${formatNumber(refs.length)} references`}>
      {shown.map((ref, index) => (
        <li key={`${ref.documentId}-${ref.locator ?? ''}-${index}`} className="chip mono" title={`sha256 ${ref.sha256}${ref.versionId !== undefined ? ` · version ${ref.versionId}` : ''}`}>
          {ref.documentId}
          {ref.locator !== undefined ? `@${ref.locator}` : ''}
        </li>
      ))}
      {rest > 0 ? (
        <li className="chip tnum" title={`${formatNumber(rest)} more references`}>
          +{formatNumber(rest)}
        </li>
      ) : null}
    </ul>
  );
}

/**
 * Legal calendar date (Occurred / Learned).
 *
 * WHY: the clock is noise on these fields, but PRECISION is not — a partial
 * value such as `2026-03` must never be widened into a day. A full instant is
 * formatted as an en-GB day; anything shorter renders verbatim, and the raw
 * artifact value always stays in the title.
 */
export function LegalDate({ value }: { readonly value: string | null }): ReactNode {
  if (value === null || value === '') {
    return <span className="muted">{EMPTY}</span>;
  }
  const isInstant = value.includes('T');
  return (
    <time dateTime={value} title={value} className="mono nowrap">
      {isInstant ? formatDay(value) : value}
    </time>
  );
}
