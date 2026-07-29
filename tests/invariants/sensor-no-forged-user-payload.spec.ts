import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * INVARIANT (SENSOR-MEDIUM-070): only the gateway may mint or forward a
 * user-identity header. A backend service that CONSTRUCTS an `x-user-payload`
 * header on an outbound call is fabricating privilege — the exact anti-pattern
 * sensor-service's channel-detection shipped:
 *
 *   'x-user-payload': JSON.stringify({ sub: 'system', roles: ['supervisor'] })
 *
 * pointed, moreover, at a long-dead endpoint. Internal service→service calls
 * authenticate by HMAC service identity (`signedFetch`) or the mTLS NATS cert,
 * never by a hand-crafted user payload. This invariant fails if any service
 * source outside the gateway assigns to an `x-user-payload` object key.
 */
const REPO_ROOT = resolve(__dirname, '..', '..');
const APPS_DIR = resolve(REPO_ROOT, 'apps');

// A CONSTRUCTION is a quoted key immediately followed by ':'. This deliberately
// does NOT match: array membership ('x-user-payload',) in the gateway proxy
// header allowlist; bracket reads (req.headers['x-user-payload']); or backticked
// prose in doc comments (which is stripped before the scan anyway).
const CONSTRUCTION = /['"]x-user-payload['"]\s*:/;

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...tsFilesUnder(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Strip block + line comments so backticked prose mentions never trip the scan. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

describe('INVARIANT: no forged x-user-payload outside the gateway (SENSOR-MEDIUM-070)', () => {
  // Scan each service's src/ only — the gateway legitimately forwards the header,
  // and e2e harness apps under test/ legitimately simulate the gateway injecting
  // a user payload; neither is under a scanned src/ dir.
  const serviceSrcDirs = readdirSync(APPS_DIR)
    .filter((svc) => svc !== 'gateway-api')
    .map((svc) => join(APPS_DIR, svc, 'src'))
    .filter(isDir);

  it('no backend service constructs an x-user-payload header on an outbound call', () => {
    const offenders: string[] = [];
    for (const dir of serviceSrcDirs) {
      for (const file of tsFilesUnder(dir)) {
        const raw = readFileSync(file, 'utf8');
        // Cheap pre-filter: only the rare file that mentions the header at all
        // pays the comment-strip + regex cost.
        if (!raw.includes('x-user-payload')) continue;
        if (CONSTRUCTION.test(stripComments(raw))) {
          offenders.push(file.replace(`${REPO_ROOT}/`, ''));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
