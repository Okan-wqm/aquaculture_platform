import type { ReactNode } from 'react';
import { EXTRACTION_STATUSES } from '../../../../shared/legal-contract.ts';
import { getLegalCoverage } from '../../api/legal-client.ts';
import { useRequest } from '../../api/use-request.ts';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Callout } from '../../design/Callout.tsx';
import { Card } from '../../design/Card.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { Stat } from '../../design/Stat.tsx';
import { formatNumber } from '../../design/format.ts';
import { useCaseContext } from './CaseDetailPage.tsx';
import { ExtractionBadge } from './legal-badges.tsx';

interface KindCount {
  readonly kind: string;
  readonly count: number;
}

interface UnreadableRow {
  readonly relativePath: string;
  readonly reason: string;
}

const KIND_COLUMNS: ReadonlyArray<ColumnDef<KindCount>> = [
  { id: 'kind', header: 'kind', render: (row) => <span className="mono">{row.kind}</span>, sortValue: (row) => row.kind },
  { id: 'count', header: 'Belge', render: (row) => formatNumber(row.count), sortValue: (row) => row.count, align: 'end' },
];

const UNREADABLE_COLUMNS: ReadonlyArray<ColumnDef<UnreadableRow>> = [
  { id: 'path', header: 'Göreli yol', render: (row) => <span className="mono">{row.relativePath}</span>, sortValue: (row) => row.relativePath },
  { id: 'reason', header: 'Neden', render: (row) => row.reason, sortValue: (row) => row.reason },
];

export function CoverageTab(): ReactNode {
  const { caseId } = useCaseContext();
  const { state, reload } = useRequest((signal) => getLegalCoverage(caseId, signal), [caseId]);
  return (
    <AsyncState state={state} onRetry={reload}>
      {({ coverage }) => {
        const kinds: KindCount[] = Object.entries(coverage.byKind).map(([kind, count]) => ({ kind, count }));
        const accounted = EXTRACTION_STATUSES.reduce((sum, status) => sum + (coverage.byExtraction[status] ?? 0), 0);
        return (
          <div className="stack">
            {coverage.complete ? (
              <Callout tone="success" title="Kapsam tam (complete = true)">
                Arşivdeki {formatNumber(coverage.totalFiles)} dosyanın her birinin bir akıbeti var: metin, yalnız meta veri, okunamadı veya kapsam dışı.
              </Callout>
            ) : (
              <Callout tone="danger" title="Kapsam eksik (complete = false)" role="alert">
                Bazı dosyaların akıbeti kayıtlı değil ({formatNumber(coverage.totalFiles)} dosya, {formatNumber(accounted)} hesaplanmış). Sessiz atlama kabul edilmez; adaptör koşusu yeniden incelenmelidir.
              </Callout>
            )}
            <div className="stat-grid">
              <Stat label="Toplam dosya" value={formatNumber(coverage.totalFiles)} />
              {EXTRACTION_STATUSES.map((status) => (
                <Stat
                  key={status}
                  label={status}
                  value={formatNumber(coverage.byExtraction[status] ?? 0)}
                  hint={<ExtractionBadge status={status} />}
                  tone={status === 'unreadable' && (coverage.byExtraction[status] ?? 0) > 0 ? 'danger' : 'default'}
                />
              ))}
            </div>
            <div className="grid-2">
              <Card title="Türe göre (byKind)" flush>
                <DataTable columns={KIND_COLUMNS} rows={kinds} rowKey={(row) => row.kind} caption="Belge türü dağılımı" emptyMessage="Tür dağılımı yok." initialSort={{ columnId: 'count', direction: 'desc' }} dense />
              </Card>
              <Card title={`Kapsam dışı kökler (${formatNumber(coverage.excludedRoots.length)})`}>
                {coverage.excludedRoots.length === 0 ? (
                  <p className="muted">Kapsam dışı bırakılan kök yok.</p>
                ) : (
                  <ul className="chip-list">
                    {coverage.excludedRoots.map((root) => (
                      <li key={root} className="chip" title={root}>
                        {root}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
            <Card title={`Okunamayan dosyalar (${formatNumber(coverage.unreadable.length)})`} subtitle="Her biri basınç kaydı üretir; sessizce yutulmaz" flush>
              <DataTable
                columns={UNREADABLE_COLUMNS}
                rows={coverage.unreadable}
                rowKey={(row) => row.relativePath}
                caption="Okunamayan dosyalar"
                emptyMessage="Okunamayan dosya yok."
                filter={{ placeholder: 'yol / neden ara…', predicate: (row, query) => `${row.relativePath} ${row.reason}`.toLocaleLowerCase('tr').includes(query) }}
                rowClassName={() => 'row-danger'}
                dense
              />
            </Card>
          </div>
        );
      }}
    </AsyncState>
  );
}
