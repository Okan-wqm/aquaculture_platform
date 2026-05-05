#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const forkDir = process.env.TYPEORM_FORK_PACKAGE_DIR;
const failures = [];

if (!forkDir) {
  console.error(
    'TYPEORM_FORK_PACKAGE_DIR is required. Point it at a checked-out governed @aquaculture/typeorm package.',
  );
  process.exit(2);
}

const packagePath = resolve(forkDir, 'package.json');
if (!existsSync(packagePath)) {
  failures.push(`Missing package.json at ${packagePath}`);
} else {
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (pkg.name !== '@aquaculture/typeorm') {
    failures.push(`Fork package name must be @aquaculture/typeorm, got ${pkg.name}`);
  }
  if (!pkg.aquaGovernance?.upstreamTypeormSha) {
    failures.push('Fork package must declare aquaGovernance.upstreamTypeormSha');
  }
  if (!pkg.aquaGovernance?.owner) {
    failures.push('Fork package must declare aquaGovernance.owner');
  }
  if (!pkg.aquaGovernance?.sbomPath) {
    failures.push('Fork package must declare aquaGovernance.sbomPath');
  }
  if (pkg.dependencies?.uuid || pkg.optionalDependencies?.uuid) {
    failures.push('Fork package must not depend on uuid; use Node crypto.randomUUID() internally');
  }
}

const requiredEvidence = [
  'test-results/typeorm-upstream.json',
  'test-results/aqua-db-platform.json',
  'CHANGELOG.md',
];

for (const relativePath of requiredEvidence) {
  if (!existsSync(resolve(forkDir, relativePath))) {
    failures.push(`Missing governed fork evidence: ${relativePath}`);
  }
}

if (failures.length > 0) {
  console.error('Governed TypeORM fork verification failed:');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log('Governed TypeORM fork verification passed.');
