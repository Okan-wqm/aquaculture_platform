import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStrictJson } from './canonical.mjs';
import { parseCards, parseMatrix, parseOperatorIndex, parsePlan } from './markdown.mjs';

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function add(errors, code, message) {
  errors.push({ code, message });
}

function jsonLines(path) {
  return readFileSync(path, 'utf8').trimEnd().split('\n').map(parseStrictJson);
}

function expectedIds(prefix, count, width) {
  return Array.from(
    { length: count },
    (_, index) => `${prefix}${String(index + 1).padStart(width, '0')}`,
  );
}

function verifyRosters(errors, rosters) {
  const { findings, cards, plan, program, frozen } = rosters;
  for (const [code, actual, expected] of [
    ['AUDIT_SNAPSHOT', findings.map((item) => item.id), expectedIds('ARIA-AUDIT-', 88, 3)],
    ['AUDIT_SNAPSHOT', frozen.map((item) => item.id), expectedIds('ARIA-AUDIT-', 88, 3)],
    ['PROGRAM_PARITY', cards.map((item) => item.sprint_id), expectedIds('S', 72, 2)],
    ['PROGRAM_PARITY', plan.map((item) => item.sprint_id), expectedIds('S', 72, 2)],
    ['PROGRAM_PARITY', program.map((item) => item.sprint_id), expectedIds('S', 72, 2)],
  ]) {
    if (!equal(actual, expected)) add(errors, code, 'ordered roster mismatch');
  }
}

function verifyAuditSnapshot(errors, findings, frozen) {
  for (let index = 0; index < findings.length; index += 1) {
    const current = findings[index];
    const snapshot = frozen[index];
    if (
      !snapshot ||
      current.id !== snapshot.id ||
      current.title !== snapshot.title ||
      current.disposition !== snapshot.disposition
    ) {
      add(errors, 'AUDIT_SNAPSHOT', `${current.id ?? index}: title/disposition drift`);
    }
  }
}

function verifySprintParity(errors, cards, plan, program) {
  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index];
    const planRow = plan[index];
    const mapRow = program[index];
    if (
      !planRow ||
      card.sprint_id !== planRow.sprint_id ||
      card.dependency_text !== planRow.dependency_text ||
      !equal(card.acceptance_ids, planRow.acceptance_ids)
    ) {
      add(errors, 'PROGRAM_PARITY', `${card.sprint_id}: PLAN/card drift`);
    }
    const expected = {
      sprint_id: card.sprint_id,
      phase_id: card.phase_id,
      dependency_text: card.dependency_text,
      dependencies: card.dependencies,
      acceptance_ids: card.acceptance_ids,
      finding_ids: card.finding_ids,
      finding_scope: card.finding_scope,
    };
    for (const [key, value] of Object.entries(expected)) {
      if (!mapRow || !equal(mapRow[key], value))
        add(errors, 'PROGRAM_PARITY', `${card.sprint_id}: program-map ${key}`);
    }
  }
}

function verifyFindingOwners(errors, findings, program) {
  const mapped = new Map(findings.map((finding) => [finding.id, []]));
  for (const sprint of program) {
    for (const findingId of sprint.owned_finding_ids) mapped.get(findingId)?.push(sprint.sprint_id);
  }
  for (const finding of findings) {
    const owners = mapped.get(finding.id) ?? [];
    const acceptances = owners.map((sprint) => `ACC-${sprint}`);
    if (!equal(finding.owning_sprints, owners))
      add(errors, 'PROGRAM_PARITY', `${finding.id}: owner/card drift`);
    if (!equal(finding.acceptance_ids, acceptances))
      add(errors, 'PROGRAM_PARITY', `${finding.id}: acceptance/owner drift`);
    if (finding.closure_rules.length === 0)
      add(errors, 'PROGRAM_PARITY', `${finding.id}: missing closure path`);
  }
}

function verifyOperatorIndex(errors, planText, cards) {
  const declared = parseOperatorIndex(planText);
  for (const operator of expectedIds('OP-', 8, 2)) {
    const actual = cards
      .filter((card) => card.dependencies.includes(operator))
      .map((card) => card.sprint_id);
    if (!equal(declared.get(operator) ?? [], actual))
      add(errors, 'PROGRAM_PARITY', `${operator}: reverse index drift`);
  }
}

function verifyGateContract(errors, gates, cards) {
  const roles = [
    'integrity',
    'identity',
    'authorization',
    'execution-containment',
    'supply-chain',
    'data-privacy',
    'cost-capacity',
    'reliability-dr',
    'github-delivery',
    'api-ui',
    'portability-readability',
    'appellate',
  ];
  const gateSprints = ['S08', 'S16', 'S24', 'S32', 'S40', 'S48', 'S56', 'S64', 'S70'];
  if (
    !equal(gates.roles, roles) ||
    !equal(
      gates.gates.map((gate) => gate.sprint_id),
      gateSprints,
    )
  )
    add(errors, 'PHASE_GATES', 'role or gate roster drift');
  if (new Set(gates.roles).size !== 12 || gates.required_artifacts.length !== 9)
    add(errors, 'PHASE_GATES', 'gate requirements incomplete');
  for (let index = 0; index < gates.gates.length; index += 1) {
    const gate = gates.gates[index];
    const mechanism =
      index < 4
        ? 'external-adversarial-review-v1'
        : 'productized-reviewers-plus-external-appellate-v1';
    const card = cards.find((item) => item.sprint_id === gate.sprint_id);
    if (
      gate.phase_id !== `P${String(index + 1).padStart(2, '0')}` ||
      gate.mechanism !== mechanism ||
      !card?.finding_scope
    ) {
      add(errors, 'PHASE_GATES', `${gate.phase_id}: mechanism/card scope drift`);
    }
  }
}

export function verifyMapping(planRoot) {
  const errors = [];
  const planText = readFileSync(join(planRoot, 'PLAN.md'), 'utf8');
  const cardFiles = expectedIds('P', 9, 2).map((phaseId) => ({
    phaseId,
    text: readFileSync(join(planRoot, `phases/${phaseId}.md`), 'utf8'),
  }));
  const findings = parseMatrix(readFileSync(join(planRoot, 'FINDING-COVERAGE.md'), 'utf8'));
  const cards = parseCards(cardFiles);
  const plan = parsePlan(planText);
  const program = jsonLines(join(planRoot, 'verification/program-map.jsonl'));
  const frozen = jsonLines(join(planRoot, 'verification/frozen-audit.jsonl'));
  const gates = parseStrictJson(
    readFileSync(join(planRoot, 'verification/phase-gates.json'), 'utf8'),
  );
  verifyRosters(errors, { findings, cards, plan, program, frozen });
  verifyAuditSnapshot(errors, findings, frozen);
  verifySprintParity(errors, cards, plan, program);
  verifyFindingOwners(errors, findings, program);
  verifyOperatorIndex(errors, planText, cards);
  verifyGateContract(errors, gates, cards);
  return errors;
}
