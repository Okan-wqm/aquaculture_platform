// Legal vocabulary badges.
//
// WHY: the contract's epistemic distinctions (asserted ≠ verified, party vs
// ai_inference, text vs unreadable) must be visible on every row, with the
// English value verbatim and the Turkish meaning on hover. A statement must never
// look like a fact; `verified` is the only status a human earns.
import type { ReactNode } from 'react';
import type { AssertionSource, ExtractionStatus, LegalEvidenceRef, StatementStatus } from '../../../../shared/legal-contract.ts';
import { Badge, type BadgeTone } from '../../design/Badge.tsx';
import { EMPTY, formatPercent } from '../../design/format.ts';
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
  asserted: 'İddia edildi — bir tarafın beyanı; olgu değildir',
  disputed: 'İhtilaflı — karşı beyan var',
  supported: 'Destekleniyor — kanıt referansı var, insan doğrulaması yok',
  contradicted: 'Çelişiyor — karşıt kanıt var',
  unverifiable: 'Doğrulanamaz — mevcut arşivde kanıt yok',
  verified: 'Doğrulandı — bir insan denetçi kayıt altına aldı',
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
  ai_inference: 'accent',
  operator: 'success',
};

const SOURCE_GLOSS: Readonly<Record<AssertionSource, string>> = {
  party: 'Taraf beyanı',
  court: 'Mahkeme kaydı',
  counsel: 'Vekil beyanı',
  third_party: 'Üçüncü taraf',
  ai_inference: 'Yapay zekâ çıkarımı — kanıt değil, insan doğrulaması gerekir',
  operator: 'Operatör kaydı',
};

export function AssertedByBadge({ source, partyId }: { readonly source: AssertionSource; readonly partyId?: string | null | undefined }): ReactNode {
  return (
    <span className="row">
      <Badge tone={SOURCE_TONE[source]} title={SOURCE_GLOSS[source]}>
        {source}
      </Badge>
      {partyId !== undefined && partyId !== null ? (
        <span className="chip" title={partyId}>
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
      <span className="muted" title="İnsan doğrulaması işaretlenmedi">
        {EMPTY}
      </span>
    );
  }
  return (
    <Badge tone="warning" title="human_review_required = true">
      insan doğrulaması gerekli
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
  text: 'Metin çıkarıldı',
  metadata_only: 'Yalnızca meta veri okunabildi',
  unreadable: 'Okunamadı — basınç kaydı oluşur',
  excluded: 'Kapsam dışı bırakıldı (excludedReason)',
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
      <Badge tone={kind === 'UNKNOWN' ? 'muted' : 'neutral'} mono title="kindGuess — mekanik tahmin, sınıflandırma değil">
        {kind}
      </Badge>
      <ConfidenceMeter value={confidence} />
    </span>
  );
}

export function ConfidenceMeter({ value }: { readonly value: number }): ReactNode {
  const bounded = Math.max(0, Math.min(1, value));
  return (
    <span className="confidence" title={`confidence ${bounded.toFixed(2)}`}>
      <meter className="confidence__meter" min={0} max={1} low={0.4} high={0.75} optimum={1} value={bounded} aria-label="güven" />
      <span className="confidence__text">{formatPercent(bounded)}</span>
    </span>
  );
}

export function PrecisionBadge({ precision }: { readonly precision: 'day' | 'month' | 'year' | 'unknown' }): ReactNode {
  const tone: BadgeTone = precision === 'day' ? 'success' : precision === 'unknown' ? 'danger' : 'warning';
  return (
    <Badge tone={tone} title="datePrecision — tarihin hangi kesinlikte bilindiği">
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
    <ul className="chip-list" aria-label={`${refs.length} kanıt`}>
      {shown.map((ref, index) => (
        <li key={`${ref.documentId}-${ref.locator ?? ''}-${index}`} className="chip" title={`sha256 ${ref.sha256}${ref.versionId !== undefined ? ` · version ${ref.versionId}` : ''}`}>
          {ref.documentId}
          {ref.locator !== undefined ? `@${ref.locator}` : ''}
        </li>
      ))}
      {rest > 0 ? <li className="chip">+{rest}</li> : null}
    </ul>
  );
}

/** Verbatim legal date (never relative — precision matters), with the raw value on hover. */
export function LegalDate({ value }: { readonly value: string | null }): ReactNode {
  if (value === null || value === '') {
    return <span className="muted">{EMPTY}</span>;
  }
  return (
    <time dateTime={value} title={value} className="mono nowrap">
      {value}
    </time>
  );
}
