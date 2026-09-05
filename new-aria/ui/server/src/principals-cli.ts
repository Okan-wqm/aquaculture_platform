// principals — the operator's command for who may open the console.
//
// WHY: a principal's token is shown ONCE, at creation, and only its digest is
// stored; there is no other honest way to hand a lawyer a credential without
// the console ever holding the secret. Editing the JSON by hand would mean
// inventing a digest, which nobody can do without the token.
//
// WHAT (run from ui/, `npm run principals -- <command>`):
//   add    --file <principals.json> --id kari --display "Advokat Kari Nordmann" --role lawyer --cases sak-24-001,sak-24-002 | --cases '*'
//   list   --file <principals.json>
//   revoke --file <principals.json> --id kari
// The file path defaults to ARIA_UI_PRINCIPALS_FILE.

import { existsSync } from 'node:fs';

import { LEGAL_CASE_ID_RE } from '../../shared/legal-contract.ts';
import { ConfigError } from './config.ts';
import { isPrincipalRole } from './principal.ts';
import { addPrincipal, loadPrincipals, revokePrincipal } from './principals.ts';

function argValue(argv: ReadonlyArray<string>, name: string): string | null {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return null;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? null : value;
}

function usage(): never {
  process.stderr.write(
    [
      'usage:',
      '  principals add    --file <principals.json> --id <id> --display <name> --role operator|lawyer --cases <id,id|*>',
      '  principals list   --file <principals.json>',
      '  principals revoke --file <principals.json> --id <id>',
      '--file defaults to ARIA_UI_PRINCIPALS_FILE.',
      '',
    ].join('\n'),
  );
  process.exit(2);
}

export function runPrincipalsCli(argv: ReadonlyArray<string>, env: NodeJS.ProcessEnv, now: string): string {
  const command = argv[0];
  const file = argValue(argv, 'file') ?? env['ARIA_UI_PRINCIPALS_FILE'] ?? null;
  if (command === undefined || file === null) usage();
  if (command === 'list') {
    if (!existsSync(file)) return `no principals file at ${file}\n`;
    const rows = loadPrincipals(file).list();
    return rows.map((row) => `${row.id}\t${row.role}\t${row.revokedAt === null ? 'active' : `revoked ${row.revokedAt}`}\t${row.cases === '*' ? '*' : row.cases.join(',')}\t${row.displayName}`).join('\n') + '\n';
  }
  if (command === 'add') {
    const id = argValue(argv, 'id');
    const displayName = argValue(argv, 'display');
    const role = argValue(argv, 'role');
    const casesRaw = argValue(argv, 'cases');
    if (id === null || displayName === null || role === null || casesRaw === null) usage();
    if (!isPrincipalRole(role)) throw new ConfigError('ARIA_UI_PRINCIPALS_FILE', `role ${role} is not one the console can authenticate (operator, lawyer)`);
    const cases = casesRaw === '*' ? ('*' as const) : casesRaw.split(',').map((item) => item.trim()).filter((item) => item !== '');
    if (cases !== '*') {
      for (const caseId of cases) {
        if (!LEGAL_CASE_ID_RE.test(caseId)) throw new ConfigError('ARIA_UI_PRINCIPALS_FILE', `case id ${caseId} does not match the case id pattern`);
      }
    }
    const { token, record } = addPrincipal(file, { id, displayName, role, cases }, now);
    return [
      `added ${record.id} (${record.role}) to ${file}`,
      'token (shown once, never stored):',
      token,
      '',
    ].join('\n');
  }
  if (command === 'revoke') {
    const id = argValue(argv, 'id');
    if (id === null) usage();
    const record = revokePrincipal(file, id, now);
    return `revoked ${record.id} at ${record.revokedAt ?? now}\n`;
  }
  return usage();
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    process.stdout.write(runPrincipalsCli(process.argv.slice(2), process.env, new Date().toISOString()));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
