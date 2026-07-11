// Post-build gate (SENSOR-MEDIUM-004/005): a sensor-module dist WITHOUT the
// bundled canvas — or with a CDN-dependent one — must be impossible to
// produce through the build target. CI and the Docker image both consume
// dist/ via this build, so failing here stops a broken canvas at the source
// instead of shipping a stale or hand-managed artifact to /remotes.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(here, 'dist', 'process-editor-canvas.html');

let html;
try {
  html = readFileSync(htmlPath, 'utf8');
} catch {
  console.error(`[canvas-artifact] MISSING: ${htmlPath} — the canvas pre-build did not run before the module build.`);
  process.exit(1);
}

const failures = [];
if (/https?:\/\/(unpkg\.com|cdn\.jsdelivr\.net|cdn\.tailwindcss\.com)/.test(html)) {
  failures.push('built canvas still references a CDN host — it must be fully bundled');
}
if (!/assets\/process-editor-canvas-[\w-]+\.js/.test(html)) {
  failures.push('built canvas does not reference a hashed bundle asset — wrong (pre-bundling) artifact');
}
if (failures.length > 0) {
  console.error(`[canvas-artifact] INVALID dist/process-editor-canvas.html:\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
console.log('[canvas-artifact] OK: bundled canvas present in dist, no CDN references.');
