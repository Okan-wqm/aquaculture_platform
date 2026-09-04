// Static serving of the built SPA with history-API fallback.
//
// WHY: the console is one origin: the same process serves `/api/*` and the
// React bundle, so the browser never needs CORS and the token never crosses an
// origin. Vite emits hashed asset names, so assets are immutable while
// index.html must always be revalidated.
// WHAT: resolves a request path inside ARIA_UI_STATIC_DIR (traversal-safe),
// streams files with a content type, and answers every unknown non-/api GET
// with index.html so client-side routes deep-link.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { extname } from 'node:path';

import { HttpError } from './errors.ts';
import { existsInside, resolveInside } from './fsafe.ts';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const MISSING_BUILD_HTML =
  '<!doctype html><html lang="en"><meta charset="utf-8"><title>ARIA operator console</title>' +
  '<body style="font-family:system-ui;padding:2rem"><h1>Console build not found</h1>' +
  '<p>No <code>index.html</code> under <code>ARIA_UI_STATIC_DIR</code>. Run <code>npm run build:web</code>.</p></body></html>';

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** Vite emits `name-<hash>.<ext>` under assets/; those are safe to cache forever. */
export function isImmutableAsset(relativePath: string): boolean {
  return /^\/assets\/[^/]+-[A-Za-z0-9_-]{6,}\.[a-z0-9]+$/.test(relativePath);
}

export async function serveStatic(staticDir: string, requestPath: string, res: ServerResponse): Promise<void> {
  const decoded = decodeURIComponent(requestPath);
  const relative = decoded === '/' ? '/index.html' : decoded;
  let target: string;
  try {
    target = resolveInside(staticDir, `.${relative}`);
  } catch (error) {
    if (error instanceof HttpError) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    throw error;
  }
  let servePath = target;
  let isFile = false;
  try {
    isFile = (await stat(target)).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    // Client-side route (or a missing asset): the SPA decides what to render.
    servePath = resolveInside(staticDir, 'index.html');
    if (!(await existsInside(servePath))) {
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(MISSING_BUILD_HTML);
      return;
    }
  }
  const size = (await stat(servePath)).size;
  const immutable = servePath === target && isImmutableAsset(relative);
  res.writeHead(200, {
    'Content-Type': contentTypeFor(servePath),
    'Content-Length': size,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  createReadStream(servePath).pipe(res);
}
