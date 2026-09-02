const findingIds = Array.from(
  { length: 88 },
  (_, index) => `ARIA-AUDIT-${String(index + 1).padStart(3, '0')}`,
);
const sprintIds = Array.from(
  { length: 72 },
  (_, index) => `S${String(index + 1).padStart(2, '0')}`,
);
const operatorIds = Array.from(
  { length: 8 },
  (_, index) => `OP-${String(index + 1).padStart(2, '0')}`,
);
const globalAcceptanceIds = [
  'ACC-D0-001',
  'ACC-ISO-001',
  'ACC-EVD-001',
  'ACC-TCB-001',
  'ACC-SEP-001',
  'ACC-READ-001',
  'ACC-LIVE-001',
  'ACC-REL-001',
  'ACC-NOHR-001',
];
const acceptanceIds = new Set([...sprintIds.map((id) => `ACC-${id}`), ...globalAcceptanceIds]);
const programKeys = [
  'schema_version',
  'sprint_id',
  'phase_id',
  'dependency_text',
  'dependencies',
  'acceptance_ids',
  'finding_ids',
  'finding_scope',
  'owned_finding_ids',
];
const artifacts = [
  'distinct_principal',
  'immutable_report',
  'capability_match',
  'conflict_graph',
  'deterministic_oracle',
  'dissent_disposition',
  'appellate_verdict',
  'exact_reviewed_target',
  'zero_unresolved_load_bearing_findings',
];

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function add(errors, code, message) {
  errors.push({ code, message });
}

function unknown(values, allowed) {
  return values.filter((value) => !allowed.has(value));
}

function unique(values) {
  return new Set(values).size === values.length;
}

function exactKeys(value, keys) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    equal(Object.keys(value).sort(), [...keys].sort())
  );
}

function verifyRelationArrays(errors, owner, relations) {
  for (const [field, values] of relations) {
    if (!Array.isArray(values) || !unique(values)) {
      add(errors, 'CLOSED_RELATION', `${owner}: ${field} must be a duplicate-free array`);
    }
  }
}

function hasProgramArrays(row) {
  return [row.dependencies, row.acceptance_ids, row.finding_ids, row.owned_finding_ids].every(
    Array.isArray,
  );
}

function verifyProgramMembers(errors, row, domains) {
  const findingUnknown = unknown([...row.finding_ids, ...row.owned_finding_ids], domains.findings);
  const dependencyUnknown = row.dependencies.filter(
    (id) => !domains.sprints.has(id) && !domains.operators.has(id),
  );
  const acceptanceUnknown = unknown(row.acceptance_ids, acceptanceIds);
  if ([findingUnknown, dependencyUnknown, acceptanceUnknown].some((values) => values.length > 0)) {
    add(errors, 'CLOSED_RELATION', `${row.sprint_id}: unknown relation member`);
  }
}

function verifyProgramPlacement(errors, row) {
  const sprintNumber = Number(row.sprint_id.slice(1));
  const expectedPhase = `P${String(Math.ceil(sprintNumber / 8)).padStart(2, '0')}`;
  const validScope = ['phase', 'program', null].includes(row.finding_scope);
  if (row.phase_id !== expectedPhase || !validScope) {
    add(errors, 'CLOSED_RELATION', `${row.sprint_id}: phase/scope domain drift`);
  }
}

function verifyProgramRow(errors, row, domains) {
  if (!exactKeys(row, programKeys) || row.schema_version !== '1.0.0') {
    add(errors, 'CLOSED_RELATION', `${row.sprint_id}: record schema is open or drifted`);
  }
  verifyRelationArrays(errors, row.sprint_id, [
    ['dependencies', row.dependencies],
    ['acceptance_ids', row.acceptance_ids],
    ['finding_ids', row.finding_ids],
    ['owned_finding_ids', row.owned_finding_ids],
  ]);
  if (!hasProgramArrays(row)) return;
  verifyProgramMembers(errors, row, domains);
  verifyProgramPlacement(errors, row);
}

function verifyProgramDomains(errors, program) {
  const domains = {
    findings: new Set(findingIds),
    operators: new Set(operatorIds),
    sprints: new Set(sprintIds),
  };
  for (const row of program) verifyProgramRow(errors, row, domains);
}

function verifyDag(errors, program) {
  const edges = new Map(
    program.map((row) => [row.sprint_id, row.dependencies.filter((id) => /^S/u.test(id))]),
  );
  for (const [sprint, dependencies] of edges) {
    const number = Number(sprint.slice(1));
    if (dependencies.some((dependency) => Number(dependency.slice(1)) >= number)) {
      add(errors, 'PROGRAM_DAG', `${sprint}: dependency is forward or self-referential`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(sprint) {
    if (visiting.has(sprint)) return true;
    if (visited.has(sprint)) return false;
    visiting.add(sprint);
    if ((edges.get(sprint) ?? []).some(visit)) return true;
    visiting.delete(sprint);
    visited.add(sprint);
    return false;
  }
  if (sprintIds.some(visit)) add(errors, 'PROGRAM_DAG', 'sprint dependency cycle');
}

export function verifyClosedRelations(errors, { findings, cards, plan, program }) {
  verifyProgramDomains(errors, program);
  verifyDag(errors, program);
  const findingSet = new Set(findingIds);
  for (const card of cards) {
    verifyRelationArrays(errors, card.sprint_id, [
      ['dependencies', card.dependencies],
      ['acceptance_ids', card.acceptance_ids],
      ['finding_ids', card.finding_ids],
    ]);
    if (
      unknown(card.finding_ids, findingSet).length ||
      unknown(card.acceptance_ids, acceptanceIds).length
    ) {
      add(errors, 'CLOSED_RELATION', `${card.sprint_id}: card has unknown relation`);
    }
  }
  for (const row of plan) {
    verifyRelationArrays(errors, row.sprint_id, [
      ['dependencies', row.dependencies],
      ['acceptance_ids', row.acceptance_ids],
    ]);
    if (unknown(row.acceptance_ids, acceptanceIds).length) {
      add(errors, 'CLOSED_RELATION', `${row.sprint_id}: PLAN has unknown acceptance`);
    }
  }
  const closureRules = new Set(['CR-CODE', 'CR-LIVE', 'CR-OP', 'CR-PROGRAM']);
  for (const finding of findings) {
    verifyRelationArrays(errors, finding.id, [
      ['owning_sprints', finding.owning_sprints],
      ['acceptance_ids', finding.acceptance_ids],
      ['closure_rules', finding.closure_rules],
    ]);
    if (
      unknown(finding.acceptance_ids, acceptanceIds).length ||
      unknown(finding.closure_rules, closureRules).length
    ) {
      add(errors, 'CLOSED_RELATION', `${finding.id}: matrix has unknown relation`);
    }
  }
}

export function verifyOperatorDomain(errors, declared, cards) {
  if (!equal([...declared.keys()], operatorIds)) add(errors, 'CLOSED_RELATION', 'OP roster drift');
  for (const operator of operatorIds) {
    const reverse = cards
      .filter((card) => card.dependencies.includes(operator))
      .map((card) => card.sprint_id);
    if (!equal(declared.get(operator), reverse)) {
      add(errors, 'PROGRAM_PARITY', `${operator}: reverse index drift`);
    }
  }
}

export function verifyGateIdentity(errors, gates) {
  const topKeys = [
    'schema_version',
    'contract_id',
    'dossier_schema_version',
    'dossier_contract_id',
    'roles',
    'required_artifacts',
    'gates',
  ];
  const gateKeys = ['phase_id', 'sprint_id', 'mechanism'];
  if (
    !exactKeys(gates, topKeys) ||
    !Array.isArray(gates.gates) ||
    gates.gates.some((gate) => !exactKeys(gate, gateKeys)) ||
    gates.schema_version !== '1.0.0' ||
    gates.contract_id !== 'new-aria-twelve-role-gates-v1' ||
    !equal(gates.required_artifacts, artifacts)
  ) {
    add(errors, 'PHASE_GATES', 'schema, contract, or exact artifact roster drift');
  }
}
