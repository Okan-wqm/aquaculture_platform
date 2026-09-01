export function tableCells(line) {
  return line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
}

function expandRange(start, end, width, prefix) {
  const values = [];
  for (let value = Number(start); value <= Number(end ?? start); value += 1) {
    values.push(`${prefix}${String(value).padStart(width, '0')}`);
  }
  return values;
}

export function sprintRefs(source) {
  const values = [];
  for (const match of source.matchAll(/S(\d{2})(?:[–-]S?(\d{2}))?/gu)) {
    values.push(...expandRange(match[1], match[2], 2, 'S'));
  }
  return [...new Set(values)];
}

export function findingRefs(source) {
  const values = [];
  const normalized = source.replaceAll('ARIA-AUDIT-', '').replaceAll('`', '');
  for (const match of normalized.matchAll(/(\d{3})(?:[–-](\d{3}))?/gu)) {
    values.push(...expandRange(match[1], match[2], 3, 'ARIA-AUDIT-'));
  }
  return [...new Set(values)];
}

export function acceptanceRefs(source) {
  return [...new Set(source.match(/ACC-[A-Z0-9-]+/gu) ?? [])];
}

export function operatorRefs(source) {
  return [...new Set(source.match(/OP-\d{2}/gu) ?? [])];
}

export function parseCards(files) {
  const cards = [];
  for (const { phaseId, text } of files) {
    for (const section of text.split(/^## /mu).slice(1)) {
      const sprintId = section.match(/^(S\d{2})\b/u)?.[1];
      const field = (name) =>
        section.match(new RegExp(`^- \\*\\*${name}:\\*\\* (.+)\\.$`, 'mu'))?.[1];
      const findingText = field('Finding IDs');
      const programScope = /program prevention|ARIA-AUDIT-001`?–`?088/u.test(findingText ?? '');
      const phaseScope = /P\d{2}.*bütün finding/u.test(findingText ?? '');
      const scope = programScope ? 'program' : phaseScope ? 'phase' : null;
      if (!sprintId || !field('Acceptance IDs') || !field('Dependencies') || !findingText) {
        throw new Error(`invalid sprint card in ${phaseId}`);
      }
      cards.push({
        sprint_id: sprintId,
        phase_id: phaseId,
        dependency_text: field('Dependencies'),
        dependencies: [
          ...sprintRefs(field('Dependencies')),
          ...operatorRefs(field('Dependencies')),
        ],
        acceptance_ids: acceptanceRefs(field('Acceptance IDs')),
        finding_ids: programScope ? [] : findingRefs(findingText),
        finding_scope: scope,
      });
    }
  }
  return cards;
}

export function parsePlan(text) {
  const sprints = [];
  for (const line of text.split('\n')) {
    const cells = tableCells(line);
    if (cells.length !== 4 || !/^S\d{2}$/u.test(cells[0])) continue;
    sprints.push({
      sprint_id: cells[0],
      dependency_text: cells[2],
      dependencies: [...sprintRefs(cells[2]), ...operatorRefs(cells[2])],
      acceptance_ids: acceptanceRefs(cells[3]),
    });
  }
  return sprints;
}

export function parseOperatorIndex(text) {
  const values = new Map();
  for (const line of text.split('\n')) {
    const cells = tableCells(line);
    if (cells.length !== 3 || !/^`OP-\d{2}`$/u.test(cells[0])) continue;
    values.set(cells[0].slice(1, -1), sprintRefs(cells[2]));
  }
  return values;
}

export function parseMatrix(text) {
  const findings = [];
  for (const line of text.split('\n')) {
    const cells = tableCells(line);
    if (cells.length !== 9 || !/^`ARIA-AUDIT-\d{3}`$/u.test(cells[0])) continue;
    findings.push({
      id: cells[0].slice(1, -1),
      title: cells[1],
      disposition: cells[2],
      inherited_failure: cells[3],
      control: cells[4],
      evidence: cells[5],
      owning_sprints: sprintRefs(cells[6]),
      acceptance_ids: acceptanceRefs(cells[7]),
      closure_rules: cells[8].match(/CR-[A-Z]+/gu) ?? [],
    });
  }
  return findings;
}

export function markdownLinks(text) {
  const links = [];
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) links.push(match[1]);
  return links;
}
