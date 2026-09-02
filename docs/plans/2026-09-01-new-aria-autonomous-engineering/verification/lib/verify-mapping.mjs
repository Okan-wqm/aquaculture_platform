import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStrictJson } from './canonical.mjs';
import { parseCards, parseMatrix, parseOperatorIndex, parsePlan } from './markdown.mjs';
import { loadAuditOracle, verifyAuditRows } from './verify-audit-oracle.mjs';
import { createGitSession } from './hermetic-git.mjs';
import { loadReviewPolicy, verifyGatePolicy } from './verify-dossier.mjs';
import {
  verifyClosedRelations,
  verifyGateIdentity,
  verifyOperatorDomain,
} from './verify-relations.mjs';

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
    for (const findingId of sprint.owned_finding_ids) {
      const owners = mapped.get(findingId);
      if (owners) owners.push(sprint.sprint_id);
      else
        add(errors, 'CLOSED_RELATION', `${sprint.sprint_id}: unknown owned finding ${findingId}`);
    }
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

function verifyGateEntry(errors, cards, gate, index) {
  const mechanism =
    index < 4
      ? 'external-adversarial-review-v1'
      : 'productized-reviewers-plus-external-appellate-v1';
  const phaseId = `P${String(index + 1).padStart(2, '0')}`;
  if (gate.phase_id !== phaseId || gate.mechanism !== mechanism) {
    add(errors, 'PHASE_GATES', `${gate.phase_id}: mechanism/phase drift`);
  }
  const card = cards.find((item) => item.sprint_id === gate.sprint_id);
  if (!card) {
    add(errors, 'PHASE_GATES', `${gate.phase_id}: gate card missing`);
    return;
  }
  if (!card.finding_scope) add(errors, 'PHASE_GATES', `${gate.phase_id}: card scope missing`);
}

function verifyGateContract(errors, gates, cards) {
  const expectedRoles = [
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
  verifyGateIdentity(errors, gates);
  if (!Array.isArray(gates.roles) || !Array.isArray(gates.gates)) {
    add(errors, 'PHASE_GATES', 'role or gate roster is not an array');
    return;
  }
  if (
    !equal(gates.roles, expectedRoles) ||
    !equal(
      gates.gates.map((gate) => gate.sprint_id),
      gateSprints,
    )
  )
    add(errors, 'PHASE_GATES', 'role or gate roster drift');
  if (new Set(gates.roles).size !== 12) add(errors, 'PHASE_GATES', 'gate requirements incomplete');
  for (let index = 0; index < gates.gates.length; index += 1) {
    verifyGateEntry(errors, cards, gates.gates[index], index);
  }
}

export function verifyMapping(planRoot, repositoryRoot, gitTool) {
  const errors = [];
  const git = createGitSession(gitTool);
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
  const oracle = loadAuditOracle(planRoot, repositoryRoot, errors, git);
  verifyRosters(errors, { findings, cards, plan, program, frozen });
  verifyAuditRows(errors, findings, frozen, oracle);
  verifySprintParity(errors, cards, plan, program);
  verifyFindingOwners(errors, findings, program);
  verifyClosedRelations(errors, { findings, cards, plan, program });
  verifyOperatorDomain(errors, parseOperatorIndex(planText), cards);
  verifyGateContract(errors, gates, cards);
  verifyGatePolicy(errors, gates, loadReviewPolicy(planRoot));
  return errors;
}
