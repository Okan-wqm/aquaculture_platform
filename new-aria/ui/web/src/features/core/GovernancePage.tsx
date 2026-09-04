import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { GovernanceRow } from '../../../../shared/api-contract.ts';
import { getGovernance } from '../../api/client.ts';
import { isApiClientError, toError } from '../../api/errors.ts';
import { readGovernanceStream } from '../../api/sse.ts';
import { clearToken } from '../../api/token-store.ts';
import { Badge, type BadgeTone } from '../../design/Badge.tsx';
import { Callout } from '../../design/Callout.tsx';
import { Card } from '../../design/Card.tsx';
import { KeyValueList } from '../../design/KeyValueList.tsx';
import { PageHeader } from '../../design/PageHeader.tsx';
import { formatNumber } from '../../design/format.ts';
import { GovernanceRowsTable, governanceRowKey, type KeyedGovernanceRow } from './GovernanceRowsTable.tsx';

const INITIAL_LIMIT = 200;
const MAX_ROWS = 2000;
const RECONNECT_DELAY_MS = 3000;

type ConnectionState = 'connecting' | 'live' | 'closed' | 'error' | 'unauthorized';

const CONNECTION_TONE: Readonly<Record<ConnectionState, BadgeTone>> = {
  connecting: 'info',
  live: 'success',
  closed: 'warning',
  error: 'danger',
  unauthorized: 'danger',
};

const CONNECTION_LABEL: Readonly<Record<ConnectionState, string>> = {
  connecting: 'bağlanıyor',
  live: 'canlı',
  closed: 'sunucu kapattı — yeniden bağlanılıyor',
  error: 'hata — yeniden bağlanılıyor',
  unauthorized: 'token reddedildi',
};

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** Appends newest rows at the front, deduplicating by chain hash, bounded to MAX_ROWS. */
function mergeRows(existing: ReadonlyArray<KeyedGovernanceRow>, incoming: ReadonlyArray<KeyedGovernanceRow>): KeyedGovernanceRow[] {
  const seen = new Set(existing.map((entry) => entry.key));
  const fresh = incoming.filter((entry) => !seen.has(entry.key));
  if (fresh.length === 0) {
    return [...existing];
  }
  return [...fresh.reverse(), ...existing].slice(0, MAX_ROWS);
}

/**
 * Live governance tail.
 *
 * The initial page comes from GET /governance; afterwards the SSE stream appends
 * rows. "Pause" freezes the visible list (rows keep arriving into a buffer whose
 * size is shown) so the operator can read without the table moving; "resume"
 * flushes the buffer. The stream reconnects automatically after a server close
 * or network error, and stops for good on a 401 (token cleared → login).
 */
export function GovernancePage(): ReactNode {
  const [rows, setRows] = useState<KeyedGovernanceRow[]>([]);
  const [initialError, setInitialError] = useState<Error | null>(null);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [connectionDetail, setConnectionDetail] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [buffered, setBuffered] = useState<KeyedGovernanceRow[]>([]);
  const [eventFilter, setEventFilter] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const streamCounter = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    getGovernance({ limit: INITIAL_LIMIT }, controller.signal)
      .then((response) => {
        if (!active) {
          return;
        }
        const keyed = response.rows.map((row, index) => ({ key: governanceRowKey(row, index), row }));
        // The ledger is chronological; the tail shows newest first.
        setRows((current) => mergeRows(current, keyed));
        setInitialLoaded(true);
      })
      .catch((reason: unknown) => {
        if (!active || controller.signal.aborted) {
          return;
        }
        const error = toError(reason);
        if (isApiClientError(error) && error.isUnauthorized) {
          clearToken();
        }
        setInitialError(error);
        setInitialLoaded(true);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [reconnectNonce]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    const handleRow = (row: GovernanceRow): void => {
      streamCounter.current += 1;
      const entry: KeyedGovernanceRow = { key: governanceRowKey(row, streamCounter.current), row };
      if (pausedRef.current) {
        setBuffered((current) => mergeRows(current, [entry]));
      } else {
        setRows((current) => mergeRows(current, [entry]));
      }
    };

    const run = async (): Promise<void> => {
      while (!cancelled) {
        setConnection('connecting');
        try {
          await readGovernanceStream({
            signal: controller.signal,
            onOpen: () => setConnection('live'),
            onRow: handleRow,
          });
          if (cancelled) {
            return;
          }
          setConnection('closed');
          setConnectionDetail(null);
        } catch (reason) {
          if (cancelled) {
            return;
          }
          const error = toError(reason);
          if (isApiClientError(error) && error.isUnauthorized) {
            setConnection('unauthorized');
            setConnectionDetail(error.message);
            clearToken();
            return;
          }
          setConnection('error');
          setConnectionDetail(error.message);
        }
        await delay(RECONNECT_DELAY_MS, controller.signal);
      }
    };
    void run();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [reconnectNonce]);

  const eventNames = useMemo(() => {
    const names = new Set<string>();
    for (const entry of rows) {
      names.add(entry.row.event);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const visibleRows = useMemo(() => {
    const needle = eventFilter.trim().toLowerCase();
    return needle === '' ? rows : rows.filter((entry) => entry.row.event.toLowerCase().includes(needle));
  }, [rows, eventFilter]);

  const selected = rows.find((entry) => entry.key === selectedKey) ?? buffered.find((entry) => entry.key === selectedKey) ?? null;

  const togglePause = (): void => {
    if (paused) {
      setRows((current) => mergeRows(current, buffered));
      setBuffered([]);
      setPaused(false);
    } else {
      setPaused(true);
    }
  };

  return (
    <>
      <PageHeader
        title="Yönetişim"
        subtitle={
          <>
            <Badge tone={CONNECTION_TONE[connection]}>{CONNECTION_LABEL[connection]}</Badge>
            <span>{formatNumber(rows.length)} satır bellekte</span>
            {paused ? <Badge tone="warning">duraklatıldı · {formatNumber(buffered.length)} yeni satır bekliyor</Badge> : null}
          </>
        }
        actions={
          <>
            <button type="button" className={`button${paused ? ' button--primary' : ''}`} onClick={togglePause} aria-pressed={paused}>
              {paused ? 'Devam et' : 'Duraklat'}
            </button>
            <button type="button" className="button" onClick={() => setReconnectNonce((value) => value + 1)}>
              Yeniden bağlan
            </button>
          </>
        }
      />
      {connectionDetail !== null && (connection === 'error' || connection === 'unauthorized') ? (
        <Callout tone="danger" role="alert">
          <span className="mono">{connectionDetail}</span>
        </Callout>
      ) : null}
      {initialError !== null ? (
        <Callout tone="warning" title="İlk sayfa yüklenemedi">
          <span className="mono">{initialError.message}</span> — canlı akış yine de denenir.
        </Callout>
      ) : null}
      <div className="split">
        <Card flush>
          <GovernanceRowsTable
            rows={visibleRows}
            caption="Yönetişim ledger satırları"
            emptyMessage={initialLoaded ? 'Henüz yönetişim satırı yok.' : 'Yükleniyor…'}
            selectedKey={selectedKey}
            onSelect={setSelectedKey}
            toolbar={
              <label className="field" htmlFor="governance-event-filter">
                <span className="visually-hidden">Olay adına göre filtrele</span>
                <input
                  id="governance-event-filter"
                  type="search"
                  list="governance-event-names"
                  placeholder="event adı filtresi…"
                  value={eventFilter}
                  onChange={(event) => setEventFilter(event.target.value)}
                  autoComplete="off"
                />
                <datalist id="governance-event-names">
                  {eventNames.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
              </label>
            }
          />
        </Card>
        <div className="detail-panel">
          <Card title="Seçili satır" subtitle={selected === null ? 'Bir satır seçin (Enter / tık).' : selected.row.event}>
            {selected === null ? <p className="muted">Seçim yok.</p> : <KeyValueList data={selected.row} expandObjects />}
          </Card>
        </div>
      </div>
    </>
  );
}
