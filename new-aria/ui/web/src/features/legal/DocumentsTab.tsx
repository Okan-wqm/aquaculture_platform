import { useState, type ReactNode } from 'react';
import { EXTRACTION_STATUSES, LEGAL_RECORD_KINDS, type LegalDocument, type LegalDocumentVersion } from '../../../../shared/legal-contract.ts';
import { getLegalDocument, getLegalDocuments } from '../../api/legal-client.ts';
import { useRequest } from '../../api/use-request.ts';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Badge } from '../../design/Badge.tsx';
import { Card } from '../../design/Card.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { KeyValueList } from '../../design/KeyValueList.tsx';
import { Timestamp } from '../../design/Timestamp.tsx';
import { EMPTY, formatBytes, formatNumber, formatPercent, textOrEmpty } from '../../design/format.ts';
import { useCaseContext } from './CaseDetailPage.tsx';
import { ExtractionBadge, KindGuessBadge, ReviewMarker, EvidenceRefList } from './legal-badges.tsx';

const COLUMNS: ReadonlyArray<ColumnDef<LegalDocument>> = [
  {
    id: 'file',
    header: 'Dosya',
    render: (row) => (
      <span title={row.relativePath}>
        <span className="mono">{row.fileName}</span>
        {row.versionGroupId !== null ? (
          <>
            {' '}
            <Badge tone="info" mono title="versionGroupId">
              v-grp {row.versionGroupId}
            </Badge>
          </>
        ) : null}
      </span>
    ),
    sortValue: (row) => row.fileName,
  },
  { id: 'kind', header: 'kindGuess', render: (row) => <KindGuessBadge kind={row.kindGuess} confidence={row.kindConfidence} />, sortValue: (row) => row.kindGuess, nowrap: true },
  { id: 'extraction', header: 'extraction', render: (row) => <ExtractionBadge status={row.extraction} />, sortValue: (row) => row.extraction, nowrap: true },
  { id: 'bytes', header: 'Boyut', render: (row) => formatBytes(row.bytes), sortValue: (row) => row.bytes, align: 'end' },
  { id: 'modified', header: 'Değiştirildi', render: (row) => <Timestamp value={row.modifiedAt} />, sortValue: (row) => row.modifiedAt, nowrap: true },
  { id: 'dates', header: 'Tarih', render: (row) => formatNumber(row.datesMentioned.length), sortValue: (row) => row.datesMentioned.length, align: 'end' },
  { id: 'amounts', header: 'Tutar', render: (row) => formatNumber(row.amountsMentioned.length), sortValue: (row) => row.amountsMentioned.length, align: 'end' },
];

function VersionGroupPanel({ group, documents }: { readonly group: LegalDocumentVersion; readonly documents: ReadonlyArray<LegalDocument> }): ReactNode {
  const nameOf = (documentId: string): string => documents.find((document) => document.documentId === documentId)?.fileName ?? documentId;
  return (
    <div className="version-group">
      <div className="row">
        <span className="mono">{group.versionGroupId}</span>
        <ReviewMarker required={group.humanReviewRequired} />
      </div>
      <ol className="version-group__members">
        {[...group.members]
          .sort((a, b) => a.ordinal - b.ordinal)
          .map((member) => (
            <li key={member.documentId} title={member.documentId}>
              #{member.ordinal} {nameOf(member.documentId)} · basis={member.basis}
              {member.similarityToPrevious !== null ? ` · sim=${formatPercent(member.similarityToPrevious)}` : ''}
              {group.signedMember === member.documentId ? ' · signed?' : ''}
              {group.filedMember === member.documentId ? ' · filed?' : ''}
            </li>
          ))}
      </ol>
      <span className="muted">
        signedMember: {textOrEmpty(group.signedMember)} · filedMember: {textOrEmpty(group.filedMember)} — sıralama mekaniktir; hangisinin imzalı/dosyalanmış olduğu insan tarafından doğrulanmalıdır.
      </span>
    </div>
  );
}

function DocumentDetail({ caseId, document }: { readonly caseId: string; readonly document: LegalDocument }): ReactNode {
  const { state, reload } = useRequest((signal) => getLegalDocument(caseId, document.documentId, signal), [caseId, document.documentId]);
  return (
    <div className="stack">
      <div className="row">
        <ExtractionBadge status={document.extraction} />
        <KindGuessBadge kind={document.kindGuess} confidence={document.kindConfidence} />
      </div>
      <KeyValueList
        data={{
          documentId: document.documentId,
          relativePath: document.relativePath,
          mediaType: document.mediaType,
          extension: document.extension,
          bytes: formatBytes(document.bytes),
          sha256: document.sha256,
          modifiedAt: document.modifiedAt,
          versionGroupId: document.versionGroupId,
          excludedReason: document.excludedReason,
        }}
      />
      <div>
        <h3>Anılan tarihler ({formatNumber(document.datesMentioned.length)})</h3>
        {document.datesMentioned.length === 0 ? (
          <p className="muted">{EMPTY}</p>
        ) : (
          <ul className="chip-list">
            {document.datesMentioned.map((value, index) => (
              <li key={`${value}-${index}`} className="chip">
                {value}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h3>Anılan tutarlar ({formatNumber(document.amountsMentioned.length)})</h3>
        {document.amountsMentioned.length === 0 ? (
          <p className="muted">{EMPTY}</p>
        ) : (
          <ul className="chip-list">
            {document.amountsMentioned.map((value, index) => (
              <li key={`${value}-${index}`} className="chip">
                {value}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h3>Alıntı (excerpt)</h3>
        {document.excerpt === null ? <p className="muted">Alıntı yok ({document.extraction}).</p> : <blockquote className="mono">{document.excerpt}</blockquote>}
      </div>
      <AsyncState state={state} onRetry={reload}>
        {(data) => (
          <div>
            <h3>Bağlantılar ({formatNumber(data.links.length)})</h3>
            {data.links.length === 0 ? (
              <p className="muted">Bu belgeye bağlı kayıt yok.</p>
            ) : (
              <ul className="version-group__members">
                {data.links.map((link) => (
                  <li key={link.linkId}>
                    <Badge tone="neutral" mono>
                      {link.kind}
                    </Badge>{' '}
                    {link.from.kind}:{link.from.id} → {link.to.kind}:{link.to.id} · conf {formatPercent(link.confidence)} <EvidenceRefList refs={link.evidence} max={2} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </AsyncState>
    </div>
  );
}

export function DocumentsTab(): ReactNode {
  const { caseId } = useCaseContext();
  const [extraction, setExtraction] = useState('');
  const [kind, setKind] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { state, reload } = useRequest(
    (signal) => getLegalDocuments(caseId, { extraction: extraction === '' ? undefined : extraction, kind: kind === '' ? undefined : kind, limit: 1000 }, signal),
    [caseId, extraction, kind],
  );

  return (
    <div className="stack">
      <div className="toolbar">
        <label className="field" htmlFor="documents-extraction">
          <span>extraction</span>
          <select id="documents-extraction" value={extraction} onChange={(event) => setExtraction(event.target.value)}>
            <option value="">(hepsi)</option>
            {EXTRACTION_STATUSES.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>
        <label className="field" htmlFor="documents-kind">
          <span>kindGuess</span>
          <select id="documents-kind" value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="">(hepsi)</option>
            {LEGAL_RECORD_KINDS.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
            <option value="UNKNOWN">UNKNOWN</option>
          </select>
        </label>
        <button type="button" className="button" onClick={reload}>
          Yenile
        </button>
      </div>
      <AsyncState state={state} onRetry={reload}>
        {(data) => {
          const selected = data.documents.find((document) => document.documentId === selectedId) ?? null;
          return (
            <div className="stack">
              <div className="split">
                <Card title={`Belgeler (${formatNumber(data.total)})`} flush>
                  <DataTable
                    columns={COLUMNS}
                    rows={data.documents}
                    rowKey={(row) => row.documentId}
                    caption="Dava belgeleri"
                    emptyMessage="Bu filtrelerle belge yok."
                    filter={{
                      placeholder: 'dosya adı / yol ara…',
                      predicate: (row, query) => `${row.fileName} ${row.relativePath} ${row.kindGuess}`.toLocaleLowerCase('tr').includes(query),
                    }}
                    initialSort={{ columnId: 'file', direction: 'asc' }}
                    onRowActivate={(row) => setSelectedId(row.documentId)}
                    rowClassName={(row) => (row.documentId === selectedId ? 'row-selected' : row.extraction === 'unreadable' ? 'row-danger' : row.extraction === 'excluded' ? 'row-muted' : undefined)}
                  />
                </Card>
                <div className="detail-panel">
                  <Card title="Belge ayrıntısı" subtitle={selected === null ? 'Bir belge seçin (Enter / tık).' : selected.fileName}>
                    {selected === null ? <p className="muted">Seçim yok.</p> : <DocumentDetail caseId={caseId} document={selected} />}
                  </Card>
                </div>
              </div>
              <Card title={`Sürüm grupları (${formatNumber(data.versionGroups.length)})`} subtitle="Aynı belgenin sürümleri; sıralama mekanik, imzalı/dosyalı tespiti insan doğrulaması ister">
                {data.versionGroups.length === 0 ? (
                  <p className="muted">Sürüm grubu tespit edilmedi.</p>
                ) : (
                  <div className="grid-2">
                    {data.versionGroups.map((group) => (
                      <VersionGroupPanel key={group.versionGroupId} group={group} documents={data.documents} />
                    ))}
                  </div>
                )}
              </Card>
            </div>
          );
        }}
      </AsyncState>
    </div>
  );
}
