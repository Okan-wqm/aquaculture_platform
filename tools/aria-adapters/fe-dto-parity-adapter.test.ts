import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyzeFeDtoParity } from './fe-dto-parity-adapter';

const workspace = mkdtempSync(join(tmpdir(), 'aria-fe-dto-parity-'));
mkdirSync(join(workspace, 'apps/farm-service/src/batch/dto'), { recursive: true });
mkdirSync(join(workspace, 'web/modules/farm-module/src/types'), { recursive: true });
mkdirSync(join(workspace, 'web/modules/farm-module/src/generated'), { recursive: true });

writeFileSync(
  join(workspace, 'apps/farm-service/src/batch/dto', 'create-batch.dto.ts'),
  [
    'export class CreateBatchDto {',
    '  name: string;',
    '  speciesId: string;',
    '  protocolId: string;',
    '}',
    'export class AlignedDto {',
    '  id: string;',
    '}',
  ].join('\n'),
  'utf8',
);

// Hand-copied FE twin that drifted: protocolId missing, legacyField extra.
writeFileSync(
  join(workspace, 'web/modules/farm-module/src/types', 'batch.ts'),
  [
    'export interface CreateBatchDto {',
    '  name: string;',
    '  speciesId: string;',
    '  legacyField: string;',
    '}',
    'export interface AlignedDto {',
    '  id: string;',
    '}',
  ].join('\n'),
  'utf8',
);

// Generated files are the FIX for this rule, never suspects.
writeFileSync(
  join(workspace, 'web/modules/farm-module/src/generated', 'contracts.ts'),
  'export interface CreateBatchDto { totallyDifferent: string; }\n',
  'utf8',
);

const output = analyzeFeDtoParity({}, workspace);

assert.equal(output.findings.length, 1, JSON.stringify(output.findings));
const [finding] = output.findings;
assert.equal(finding.rule, 'hand_copied_dto_field_drift');
assert.equal(finding.path, 'web/modules/farm-module/src/types/batch.ts');
assert.ok(finding.message.includes('missing [protocolId]'), finding.message);
assert.ok(finding.message.includes('extra [legacyField]'), finding.message);
assert.equal(finding.evidence.length, 2);

const pairs = output.observations.filter((o) => o.type === 'fe_dto_parity_pair');
assert.equal(pairs.length, 2, 'both name-matched pairs observed, generated file excluded');

process.stdout.write('fe-dto-parity-adapter tests passed\n');
