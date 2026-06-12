import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args.some((arg) => arg.startsWith('--skip-'))) {
  process.stderr.write('enterprise-closure: skip flags are illegal in acceptance mode\n');
  process.exit(2);
}

const result = spawnSync(
  process.execPath,
  ['tools/quality/quality.mjs', 'closure-run', '--profile', 'enterprise-closure'],
  {
    cwd: process.cwd(),
    stdio: 'inherit',
  },
);

process.exit(result.status ?? 1);
