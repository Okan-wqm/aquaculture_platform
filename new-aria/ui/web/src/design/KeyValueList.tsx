import type { ReactNode } from 'react';
import { compactJson, EMPTY } from './format.ts';
import './KeyValueList.css';

export interface KeyValueListProps {
  readonly data: Readonly<Record<string, unknown>> | null | undefined;
  readonly emptyMessage?: string | undefined;
  /** Render nested objects fully instead of a compacted single line. */
  readonly expandObjects?: boolean | undefined;
}

/** Definition list for free-form kernel records (proofs, metrics, contexts). */
export function KeyValueList({ data, emptyMessage = 'Kayıt yok.', expandObjects = false }: KeyValueListProps): ReactNode {
  if (data === null || data === undefined) {
    return <p className="muted">{emptyMessage}</p>;
  }
  const entries = Object.entries(data);
  if (entries.length === 0) {
    return <p className="muted">{emptyMessage}</p>;
  }
  return (
    <dl className="kv">
      {entries.map(([key, value]) => {
        const isObject = typeof value === 'object' && value !== null;
        return (
          <div className="kv__row" key={key}>
            <dt className="kv__key">{key}</dt>
            <dd className="kv__value">
              {isObject && expandObjects ? (
                <pre className="kv__pre">{JSON.stringify(value, null, 2) ?? EMPTY}</pre>
              ) : (
                <span className={isObject ? 'mono' : ''}>{compactJson(value)}</span>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
