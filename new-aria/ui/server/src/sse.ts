// Governance live stream — Server-Sent Events over the governance ledger tail.
//
// WHY: the operator wants to see kernel governance events as they land without
// reloading; the ledger is append-only, so "new rows" is exactly "bytes after
// the offset we last read". Polling the file size once a second is cheaper and
// more portable than inotify on a bind-mounted volume.
// WHAT: on connect, records the current size (no history replay — the REST
// endpoint serves history), then every 1000 ms reads any appended bytes,
// parses complete lines and writes one `data:` frame per row. A `: keepalive`
// comment every 15 s keeps proxies from closing an idle connection.

import { open } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { HttpError } from './errors.ts';
import { fileSize } from './jsonl.ts';
import { toGovernanceRow } from './readers/governance.ts';

export interface StreamOptions {
  readonly pollMs?: number;
  readonly heartbeatMs?: number;
}

export async function streamGovernance(path: string, req: IncomingMessage, res: ServerResponse, authorized: () => boolean, options: StreamOptions = {}): Promise<void> {
  const pollMs = options.pollMs ?? 1000;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const permitted = (): boolean => {
    try { return authorized(); } catch { return false; }
  };
  if (!permitted()) throw new HttpError(403, 'instance_operator_required');
  let offset = (await fileSize(path)) ?? 0;
  if (!permitted()) throw new HttpError(403, 'instance_operator_required');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  let carry = '';

  await new Promise<void>((resolveDone) => {
    let closed = false;
    let reading = false;
    const finish = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(poll);
      clearInterval(heartbeat);
      res.end();
      resolveDone();
    };
    const mayContinue = (): boolean => {
      if (closed) return false;
      if (permitted()) return true;
      finish();
      return false;
    };
    const readAppended = async (): Promise<void> => {
      if (!mayContinue()) return;
      const size = await fileSize(path);
      if (!mayContinue() || size === null) return;
      if (size < offset) {
        offset = size;
        carry = '';
        return;
      }
      if (size === offset) return;
      const handle = await open(path, 'r');
      try {
        if (!mayContinue()) return;
        const length = size - offset;
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, offset);
        offset = size;
        const lines = (carry + buffer.toString('utf8')).split('\n');
        carry = lines.pop() ?? '';
        for (const line of lines) {
          if (!mayContinue()) return;
          const trimmed = line.trim();
          if (trimmed === '') continue;
          try {
            const row = toGovernanceRow(JSON.parse(trimmed) as Record<string, unknown>);
            res.write(`data: ${JSON.stringify(row)}\n\n`);
          } catch {
            res.write(': corrupt row skipped\n\n');
          }
        }
      } finally {
        await handle.close();
      }
    };
    const poll = setInterval(async () => {
      // Even an idle ledger or an in-flight read must re-check identity.
      if (!mayContinue() || reading) return;
      reading = true;
      try {
        await readAppended();
      } catch {
        if (mayContinue()) res.write(': read error\n\n');
      } finally {
        reading = false;
      }
    }, pollMs);
    const heartbeat = setInterval(() => {
      if (mayContinue()) res.write(': keepalive\n\n');
    }, heartbeatMs);
    req.on('close', finish);
    req.on('error', finish);
    res.on('close', finish);
    if (req.destroyed || res.destroyed) finish();
  });
}
