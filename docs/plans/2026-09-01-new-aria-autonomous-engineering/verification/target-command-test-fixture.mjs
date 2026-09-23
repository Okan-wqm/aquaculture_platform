import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const planPath = 'docs/plans/2026-09-01-new-aria-autonomous-engineering';

export function canonicalCommand(repositoryRoot, script = 'verify-d0.mjs') {
  const path = join(repositoryRoot, planPath, 'authority/verification-evidence.md');
  const evidence = readFileSync(path, 'utf8');
  const block = evidence.match(/Fresh clone canonical argv:\n\n```text\n(?<body>[\s\S]*?)```/u);
  assert(block?.groups?.body, 'canonical argv block is missing');
  const commands = block.groups.body
    .trim()
    .split('\n')
    .filter((line) => line.includes(`/verification/${script}`));
  assert.equal(commands.length, 1, `exactly one canonical ${script} command is required`);
  const argv = commands[0].trim().split(/\s+/u);
  assert(
    argv.every((value) => !/[<>]/u.test(value)),
    'canonical argv contains a placeholder',
  );
  return argv;
}

export function invokeWithPackageTripwire(repositoryRoot, markerPath, invoke) {
  const entry = join(repositoryRoot, 'node_modules/graphql/index.mjs');
  const original = readFileSync(entry);
  const tripwire = Buffer.from(
    `import { writeFileSync as tripwireWrite } from 'node:fs';\n` +
      `tripwireWrite(${JSON.stringify(markerPath)}, 'executed');\n`,
  );
  try {
    writeFileSync(entry, Buffer.concat([tripwire, original]));
    const result = invoke();
    assert.equal(
      existsSync(markerPath),
      false,
      'third-party package executed before target authority rejection',
    );
    return result;
  } finally {
    writeFileSync(entry, original);
  }
}
