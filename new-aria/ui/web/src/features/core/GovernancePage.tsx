import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { GovernanceRow } from '../../../../shared/api-contract.ts';
import { getGovernance } from '../../api/client.ts';
import { isApiClientError, toError } from '../../api/errors.ts';
import { readGovernanceStream } from '../../api/sse.ts';
import { clearToken } from '../../api/token-store.ts';
import { LoadingBlock } from '../../design/AsyncState.tsx';
import { Badge, type BadgeTone } from '../../design/Badge.tsx';
import { Callout } from '../../design/Callout.tsx';
import { Card } from '../../design/Card.tsx';
import { CopyButton } from '../../design/CopyButton.tsx';
import { EmptyState } from '../../design/EmptyState.tsx';
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

/** Connection wording is the console's own vocabulary, not a kernel value, so it is written in English. */
const CONNECTION_LABEL: Readonly<Record<ConnectionState, string>> = {
  connecting: 'Connecting',
  live: 'Live',
  closed: 'Closed by server',
  error: 'Stream error',
  unauthorized: 'Token rejected',
};

const CONNECTION_HINT: Readonly<Record<ConnectionState, string>> = {
  connecting: 'Opening the governance event stream.',
  live: 'New governance rows arrive as the kernel appends them.',
  closed: 'The server closed the stream; the console reconnects automatically.',
  error: 'The stream failed; the console retries every few seconds.',
  unauthorized: 'The session token was refused. Sign in again to resume the stream.',
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
 * rows. Pause freezes the visible list (rows keep arriving into a buffer whose
 * size is shown) so the operator can read without the table moving; Resume
 * flushes the buffer. The stream reconnects automatically after a server close
 * or network error, and stops for good on a 401 (token cleared, sign in again).
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
    return [...names].sort((a, b) => a.localeCompare(b, 'en-GB'));
  }, [rows]);

  const visibleRows = useMemo(() => {
    const needle = eventFilter.trim().toLowerCase();
    return needle === '' ? rows : rows.filter((entry) => entry.row.event.toLowerCase().includes(needle));
  }, [rows, eventFilter]);

  const selected = rows.find((entry) => entry.key === selectedKey) ?? buffered.find((entry) => entry.key === selectedKey) ?? null;
  const selectedHash = selected !== null && typeof selected.row.ledger_hash === 'string' ? selected.row.ledger_hash : null;
  const waitingForFirstPage = !initialLoaded && rows.length === 0 && initialError === null;

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
        title="Governance"
        subtitle={
          <>
            <Badge tone={CONNECTION_TONE[connection]} title={CONNECTION_HINT[connection]}>
              {CONNECTION_LABEL[connection]}
            </Badge>
            <span className="tnum">{formatNumber(rows.length)} rows held</span>
            <span className="tnum">{formatNumber(eventNames.length)} event names</span>
            {paused ? <Badge tone="warning" title="Rows keep arriving while the table is frozen; Resume flushes them in.">Paused · {formatNumber(buffered.length)} waiting</Badge> : null}
          </>
        }
        actions={
          <>
            <button type="button" className={`button${paused ? ' button--primary' : ''}`} onClick={togglePause} aria-pressed={paused}>
              {paused ? 'Resume' : 'Pause'}
            </button>
            <button type="button" className="button" onClick={() => setReconnectNonce((value) => value + 1)}>
              Reconnect
            </button>
          </>
        }
      />
      {connectionDetail !== null && (connection === 'error' || connection === 'unauthorized') ? (
        <Callout tone="danger" role="alert" title={connection === 'unauthorized' ? 'The stream was refused' : 'The stream dropped'}>
          <span className="mono">{connectionDetail}</span> — {CONNECTION_HINT[connection]}
        </Callout>
      ) : null}
      {initialError !== null ? (
        <Callout tone="warning" title="The first page of history could not be loaded">
          <span className="mono">{initialError.message}</span> — the live stream is still being attempted, so newly appended rows will appear below.
        </Callout>
      ) : null}
      <div className="split">
        <Card flush>
          {waitingForFirstPage ? (
            <LoadingBlock shape="table" label="Loading governance rows…" />
          ) : (
            <GovernanceRowsTable
              rows={visibleRows}
              caption="Governance ledger rows"
              emptyTitle={eventFilter.trim() === '' ? 'No governance rows yet' : 'No event name matches'}
              emptyMessage={
                eventFilter.trim() === ''
                  ? 'Every decision the kernel records — gate outcomes, profile changes, escalations — is appended here; nothing has been appended to this ledger yet.'
                  : 'No held row carries an event name containing this text. Clear the filter to see the whole tail.'
              }
              selectedKey={selectedKey}
              onSelect={setSelectedKey}
              toolbar={
                <label className="field" htmlFor="governance-event-filter">
                  <span className="visually-hidden">Filter by event name</span>
                  <input
                    id="governance-event-filter"
                    type="search"
                    list="governance-event-names"
                    placeholder="Filter event name…"
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
          )}
        </Card>
        <div className="detail-panel">
          <Card
            title="Details"
            subtitle={selected === null ? undefined : selected.row.event}
            actions={selectedHash === null ? undefined : <CopyButton value={selectedHash} label="Copy ledger hash" />}
          >
            {selected === null ? (
              <EmptyState
                title="No row selected"
                message="Select a row in the tail — with a click or with Enter — to read its full event payload and the hash that chains it to the row before."
                flush
              />
            ) : (
              <KeyValueList data={selected.row} expandObjects />
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
