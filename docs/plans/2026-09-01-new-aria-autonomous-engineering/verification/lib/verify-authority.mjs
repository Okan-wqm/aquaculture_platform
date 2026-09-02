import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStrictJson } from './canonical.mjs';

const requiredText = [
  [
    'authority/identity-authority-tcb.md',
    [
      /IssuerTopologyManifest/u,
      /aria-human-grant-issuer[\s\S]*aria-low-permit-issuer[\s\S]*aria-medium-permit-issuer/u,
      /security-authority[\s\S]*release-authority[\s\S]*domain-owner-authority/u,
      /aria-medium-permit-assembler/u,
      /canonical `WorkloadSubjectId`[\s\S]*failure-domain ID[\s\S]*numeric UID\/GID/u,
      /exclusive KMS handle[\s\S]*exclusive DB issue-procedure[\s\S]*authenticated RPC/u,
      /egress\/resource bounds[\s\S]*rotation epoch[\s\S]*`recovery_epoch`/u,
      /policy-attestor[\s\S]*publisher[\s\S]*merge-authority/u,
    ],
  ],
  [
    'authority/data-privacy.md',
    [
      /WorkspaceRepositoryBinding\(tenant_id, workspace_id, code_repository_id\) UNIQUE/u,
      /MissionRepositoryScope\(tenant_id, workspace_id, mission_id,[\s\S]*code_repository_id \+ base_repository_id \+ head_repository_id \+ snapshot_sha\) UNIQUE/u,
      /code_repository_id \+ base_repository_id \+ head_repository_id \+ snapshot_sha/u,
      /attempt, effect, outbox\/inbox, projection, artifact, evidence, cursor, CAS admission/u,
      /foreground, background, reconcile, CAS, restore ve delete/u,
    ],
  ],
  [
    'authority/execution-supply-chain.md',
    [
      /complete `ToolchainManifest`, `OP-05` tarafından S17 başlamadan önce/u,
      /binary\/image\/plugin\/MCP\/hook\/OS\/runtime\/lock\/registry\/lifecycle\/SBOM\/signer\/build/u,
      /S20\/S21[\s\S]*provider process count sıfır/u,
      /S22[\s\S]*ilk toolchain admission noktası değildir/u,
    ],
  ],
  [
    'authority/github-delivery.md',
    [
      /pending\|merged\|enqueued\|failed/u,
      /INTENDED\|DISPATCHED\|RECONCILING\|SUCCEEDED\|FAILED\|UNKNOWN/u,
      /`200`[\s\S]*`merged` veya `enqueued`/u,
      /`202`[\s\S]*`pending`/u,
      /`404`[\s\S]*expired result[\s\S]*`UNKNOWN`/u,
      /`409`[\s\S]*option mismatch terminal conflict/u,
      /non-empty veya unknown stack permit tüketmeden/u,
      /`merge_action=default` deny/u,
    ],
  ],
  [
    'authority/operations-reliability.md',
    [
      /PhysicalDispatchReservation/u,
      /KNOWN_ZERO -> RELEASED/u,
      /KNOWN_CHARGED -> SETTLED/u,
      /UNKNOWN_CHARGE -> HELD_UNKNOWN/u,
      /reserved\/known-zero\/settled\/held\/released/u,
      /journalGeneration[\s\S]*journalSequence[\s\S]*previous-record hash[\s\S]*Merkle/u,
      /rangeRoot, rangeCount, highWater/u,
      /Middle-record omission[\s\S]*generation swap[\s\S]*stale high-water/u,
      /ayrı region ve administrative account/u,
      /Journal writer, delete authority ve key authority/u,
    ],
  ],
  [
    'authority/api-ui.md',
    [
      /OK \| EMPTY \| MISSING \| CORRUPT \| UNAVAILABLE/u,
      /CURRENT \| STALE/u,
      /same `requestId` \+ same canonical[\s\S]*payload digest/u,
      /stored exact result/u,
      /same `requestId` \+[\s\S]*different payload/u,
    ],
  ],
];
const deliveryPolicy = {
  schema_version: '1.0.0',
  policy_id: 'new-aria-one-work-unit-per-pr-v1',
  work_units: 'D0 and each S01-S72 sprint',
  pull_request_cardinality: 'exactly one work unit',
  required_check_state: 'GitHub Actions SUCCESS',
  target_ref: 'refs/heads/main',
  merge_method: 'MERGE_COMMIT',
  forbidden_merge_methods: ['SQUASH', 'REBASE'],
  successor_base: 'exact resulting origin/main SHA',
};

function add(errors, message) {
  errors.push({ code: 'AUTHORITY_CONTRACT', message });
}

function verifyText(errors, planRoot) {
  for (const [path, patterns] of requiredText) {
    const source = readFileSync(join(planRoot, path), 'utf8');
    for (const pattern of patterns) {
      if (!pattern.test(source)) add(errors, `${path}: missing ${pattern.source}`);
    }
  }
  const phase = readFileSync(join(planRoot, 'phases/P07.md'), 'utf8');
  if (/stack ordering|out-of-order stack/u.test(phase))
    add(errors, 'P07: stack ordering is forbidden');
}

function verifyDependencies(errors, planRoot) {
  const rows = readFileSync(join(planRoot, 'verification/program-map.jsonl'), 'utf8')
    .trimEnd()
    .split('\n')
    .map(parseStrictJson);
  const bySprint = new Map(rows.map((row) => [row.sprint_id, row.dependencies]));
  for (const [sprint, dependency] of [
    ['S04', 'OP-03'],
    ['S28', 'OP-03'],
    ['S50', 'OP-03'],
    ['S58', 'OP-03'],
    ['S20', 'OP-05'],
    ['S21', 'OP-05'],
    ['S52', 'OP-01'],
  ]) {
    const dependencies = bySprint.get(sprint);
    if (!Array.isArray(dependencies) || !dependencies.includes(dependency)) {
      add(errors, `${sprint}: missing mandatory ${dependency} dependency`);
    }
  }
}

function verifyEnums(errors, planRoot) {
  const status = 'OK|EMPTY|MISSING|CORRUPT|UNAVAILABLE';
  const freshness = 'CURRENT|STALE';
  const expected = new Map([
    [
      'FINDING-COVERAGE.md',
      [`${status.replaceAll('|', '\\|')}`, `${freshness.replaceAll('|', '\\|')}`],
    ],
    ['phases/P01.md', [status, freshness]],
    ['phases/P05.md', [status, freshness]],
    ['phases/P06.md', [status, freshness]],
  ]);
  for (const [path, [expectedStatus, expectedFreshness]] of expected) {
    const source = readFileSync(join(planRoot, path), 'utf8');
    if (!source.includes(expectedStatus) || !source.includes(expectedFreshness)) {
      add(errors, `${path}: projection status/freshness enum drift`);
    }
  }
}

function verifyDelivery(errors, planRoot) {
  const actual = parseStrictJson(
    readFileSync(join(planRoot, 'verification/delivery-policy.json'), 'utf8'),
  );
  const plan = readFileSync(join(planRoot, 'PLAN.md'), 'utf8');
  if (JSON.stringify(actual) !== JSON.stringify(deliveryPolicy)) {
    add(errors, 'delivery policy identity drift');
  }
  for (const pattern of [
    /D0 ve ayrı ayrı S01-S72/u,
    /GitHub Actions `SUCCESS` olmadan merge yasaktır/u,
    /tek yöntem merge commit'tir, squash ve rebase merge yasaktır/u,
    /exact `origin\/main` SHA'dan/u,
  ]) {
    if (!pattern.test(plan)) add(errors, `PLAN delivery rule missing ${pattern.source}`);
  }
}

export function verifyAuthorityContracts(planRoot) {
  const errors = [];
  verifyText(errors, planRoot);
  verifyDependencies(errors, planRoot);
  verifyEnums(errors, planRoot);
  verifyDelivery(errors, planRoot);
  return errors;
}
