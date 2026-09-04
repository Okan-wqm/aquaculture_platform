// Server-Sent Events over fetch.
//
// WHY: the governance stream needs the bearer header, and the browser's
// EventSource cannot send custom headers. So the stream is read with fetch +
// ReadableStream and parsed line-by-line per the SSE wire format (`data:` lines
// joined with "\n", blank line dispatches, `:` comments ignored, CRLF tolerated).
// WHAT: a pure incremental line parser (unit-tested) and readGovernanceStream,
// which turns each dispatched `data:` JSON payload into a GovernanceRow.
import { AUTH_HEADER, AUTH_SCHEME, ENDPOINTS, type GovernanceRow } from '../../../shared/api-contract.ts';
import { ApiClientError } from './errors.ts';
import { parseErrorBody } from './http.ts';
import { getToken } from './token-store.ts';

export interface SseMessage {
  readonly event: string | null;
  readonly data: string;
  readonly id: string | null;
}

export interface SseParser {
  /** Feed a decoded text chunk; chunks may split lines and even multi-byte glyphs are already decoded. */
  push(chunk: string): void;
  /** Dispatch a trailing message when the stream ends without a final blank line. */
  flush(): void;
}

export function createSseParser(onMessage: (message: SseMessage) => void): SseParser {
  let buffer = '';
  let dataLines: string[] = [];
  let eventName: string | null = null;
  let lastId: string | null = null;

  const dispatch = (): void => {
    if (dataLines.length === 0) {
      eventName = null;
      return;
    }
    onMessage({ event: eventName, data: dataLines.join('\n'), id: lastId });
    dataLines = [];
    eventName = null;
  };

  const handleLine = (rawLine: string): void => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) {
      return;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    switch (field) {
      case 'data':
        dataLines.push(value);
        break;
      case 'event':
        eventName = value;
        break;
      case 'id':
        lastId = value;
        break;
      default:
        // `retry` and unknown fields carry nothing the operator view needs.
        break;
    }
  };

  return {
    push(chunk: string): void {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    },
    flush(): void {
      if (buffer !== '') {
        handleLine(buffer);
        buffer = '';
      }
      dispatch();
    },
  };
}

export function parseGovernanceRow(data: string): GovernanceRow | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const candidate = parsed as { readonly event?: unknown };
    if (typeof candidate.event !== 'string') {
      return null;
    }
    return parsed as GovernanceRow;
  } catch {
    return null;
  }
}

export interface GovernanceStreamOptions {
  readonly signal: AbortSignal;
  readonly onRow: (row: GovernanceRow) => void;
  readonly onOpen?: (() => void) | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

/**
 * Reads /governance/stream until the signal aborts or the server closes.
 * Resolves on a clean close; rejects with ApiClientError on a non-2xx handshake
 * and with the underlying error on network failure. Abort resolves silently.
 */
export async function readGovernanceStream(options: GovernanceStreamOptions): Promise<void> {
  const token = getToken();
  if (token === null) {
    throw new ApiClientError(401, { error: 'missing_token', detail: 'Operator token is missing. Sign in to continue.' }, ENDPOINTS.governanceStream.path);
  }
  const headers = new Headers();
  headers.set('accept', 'text/event-stream');
  headers.set(AUTH_HEADER, `${AUTH_SCHEME} ${token}`);
  const fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => fetch(input, init));

  let response: Response;
  try {
    response = await fetchImpl(ENDPOINTS.governanceStream.path, {
      method: 'GET',
      headers,
      credentials: 'omit',
      cache: 'no-store',
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal.aborted) {
      return;
    }
    throw error;
  }
  if (!response.ok) {
    throw new ApiClientError(response.status, await parseErrorBody(response), ENDPOINTS.governanceStream.path);
  }
  if (response.body === null) {
    throw new Error('Stream body is empty: the server returned no text/event-stream body.');
  }
  options.onOpen?.();

  const parser = createSseParser((message) => {
    const row = parseGovernanceRow(message.data);
    if (row !== null) {
      options.onRow(row);
    }
  });
  const decoder = new TextDecoder('utf-8');
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.flush();
  } catch (error) {
    if (!options.signal.aborted) {
      throw error;
    }
  } finally {
    reader.releaseLock();
  }
}
