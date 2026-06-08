import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const port = Number(process.env.FARM_WATER_CHEMISTRY_PORT ?? 4302);
const host = process.env.FARM_WATER_CHEMISTRY_HOST ?? '127.0.0.1';
const shellDist = resolve(process.env.FARM_WATER_CHEMISTRY_SHELL_DIST ?? 'web/shell/dist');
const farmDist = resolve(process.env.FARM_WATER_CHEMISTRY_FARM_DIST ?? 'web/modules/farm-module/dist');

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

function safeResolve(root, requestPath) {
  const decodedPath = decodeURIComponent(requestPath);
  const normalizedPath = normalize(decodedPath).replace(/^(\.\.[/\\])+/, '');
  const resolvedPath = resolve(root, `.${sep}${normalizedPath}`);
  return resolvedPath.startsWith(`${root}${sep}`) || resolvedPath === root
    ? resolvedPath
    : null;
}

function sendFile(response, filePath, method) {
  const type = contentTypes.get(extname(filePath).toLowerCase()) ?? 'application/octet-stream';
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': type,
  });

  if (method === 'HEAD') {
    response.end();
    return;
  }

  createReadStream(filePath).pipe(response);
}

function resolveStaticFile(root, requestPath) {
  const safePath = safeResolve(root, requestPath);
  if (!safePath || !existsSync(safePath)) return null;

  const stats = statSync(safePath);
  if (stats.isFile()) return safePath;
  if (stats.isDirectory()) {
    const indexPath = join(safePath, 'index.html');
    return existsSync(indexPath) && statSync(indexPath).isFile() ? indexPath : null;
  }
  return null;
}

const server = createServer((request, response) => {
  if (!request.url || !request.method || !['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405).end();
    return;
  }

  const url = new URL(request.url, `http://${host}:${port}`);
  if (url.pathname.startsWith('/remotes/farm-module/')) {
    const remotePath = url.pathname.slice('/remotes/farm-module/'.length);
    const filePath = resolveStaticFile(farmDist, remotePath);
    if (filePath) {
      sendFile(response, filePath, request.method);
      return;
    }
    response.writeHead(404).end('Not found');
    return;
  }

  const shellFile = resolveStaticFile(shellDist, url.pathname);
  if (shellFile) {
    sendFile(response, shellFile, request.method);
    return;
  }

  const shellIndex = join(shellDist, 'index.html');
  if (existsSync(shellIndex)) {
    sendFile(response, shellIndex, request.method);
    return;
  }

  response.writeHead(404).end('Shell index not found');
});

server.listen(port, host, () => {
  process.stdout.write(`water-chemistry shell smoke server http://${host}:${port}\n`);
  process.stdout.write(`shell dist: ${shellDist}\n`);
  process.stdout.write(`farm dist: ${farmDist}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
