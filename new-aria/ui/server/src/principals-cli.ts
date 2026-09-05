// Online management is the default. Offline recovery takes the same storage locks as the service.
import { ENDPOINTS } from '../../shared/api-contract.ts';
import { loadConfig } from './config.ts';
import { acquireInstallationLock, installationStoragePaths } from './installation-lock.ts';
import { PrincipalAdministration, parsePrincipalCommand } from './principal-admin.ts';
import { TOKEN_HOLDER_PRINCIPAL } from './principal.ts';
import { loadOrCreatePrincipals } from './principals.ts';

function argValue(argv: ReadonlyArray<string>, name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} requires a value`);
  return value;
}

export async function runPrincipalsCli(argv: ReadonlyArray<string>, env: NodeJS.ProcessEnv, now: string): Promise<string> {
  const action = argv[0];
  const cases = argValue(argv, 'cases');
  const raw = action === 'add' ? { action, id: argValue(argv, 'id'), displayName: argValue(argv, 'display'), role: argValue(argv, 'role'), cases: cases === '*' ? '*' : cases?.split(',').map((value) => value.trim()) } : action === 'revoke' ? { action, id: argValue(argv, 'id') } : { action };
  const command = parsePrincipalCommand(raw);
  if (argv.includes('--offline')) {
    const config = loadConfig({ ...env, ARIA_UI_PRINCIPALS_FILE: argValue(argv, 'file') ?? env['ARIA_UI_PRINCIPALS_FILE'] });
    if (config.principalsFile === null) throw new Error('offline mode requires a principals file');
    const lease = acquireInstallationLock(installationStoragePaths(config));
    try {
      const directory = loadOrCreatePrincipals(config.principalsFile, null, now);
      return `${JSON.stringify(new PrincipalAdministration(directory, lease).execute(TOKEN_HOLDER_PRINCIPAL, { ...command }))}\n`;
    } finally { lease.close(); }
  }
  if (argValue(argv, 'file') !== undefined) throw new Error('--file requires explicit --offline; online management uses service storage');
  const token = env['ARIA_UI_TOKEN'];
  if (token === undefined || token.trim() === '') throw new Error('ARIA_UI_TOKEN is required for online management');
  const base = argValue(argv, 'url') ?? env['ARIA_UI_URL'] ?? 'http://127.0.0.1:8480';
  const url = new URL(ENDPOINTS.principalAdmin.path, base);
  const response = await fetch(url, { method: ENDPOINTS.principalAdmin.method, redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
  if (!response.ok) throw new Error(`principal management refused (${response.status})`);
  return `${JSON.stringify(await response.json())}\n`;
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    process.stdout.write(await runPrincipalsCli(process.argv.slice(2), process.env, new Date().toISOString()));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
