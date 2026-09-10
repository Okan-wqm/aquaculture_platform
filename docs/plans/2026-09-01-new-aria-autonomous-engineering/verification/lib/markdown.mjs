export function tableCells(line) {
  const cells = [];
  let cell = '';
  let inCode = false;
  let escaped = false;
  for (const character of line) {
    if (character === '`' && !escaped) inCode = !inCode;
    if (character === '|' && !inCode && !escaped) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += character;
    }
    escaped = character === '\\' && !escaped;
  }
  cells.push(cell.trim());
  return cells.slice(1, -1);
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
  return values;
}

export function findingRefs(source) {
  const values = [];
  const normalized = source.replaceAll('ARIA-AUDIT-', '').replaceAll('`', '');
  for (const match of normalized.matchAll(/(\d{3})(?:[–-](\d{3}))?/gu)) {
    values.push(...expandRange(match[1], match[2], 3, 'ARIA-AUDIT-'));
  }
  return values;
}

export function acceptanceRefs(source) {
  return source.match(/ACC-[A-Z0-9-]+/gu) ?? [];
}

export function operatorRefs(source) {
  return source.match(/OP-\d{2}/gu) ?? [];
}

function cardField(section, name) {
  const match = section.match(
    new RegExp(`^- \\*\\*${name}:\\*\\* ([^\\n]+(?:\\n {2,}[^\\n]+)*)$`, 'mu'),
  );
  const value = match?.[1].trim();
  if (!value?.endsWith('.')) return undefined;
  return value.slice(0, -1).replace(/\\n\\s+/gu, ' ');
}

function parseCard(phaseId, section) {
  const sprintMatch = section.match(/^(S\d{2})\b/u);
  const sprintId = sprintMatch ? sprintMatch[1] : undefined;
  const findingText = cardField(section, 'Finding IDs');
  const acceptanceText = cardField(section, 'Acceptance IDs');
  const dependencyText = cardField(section, 'Dependencies');
  if (!sprintId || !acceptanceText || !dependencyText || !findingText) {
    throw new Error(`invalid sprint card in ${phaseId}`);
  }
  const programScope = /program prevention|ARIA-AUDIT-001`?–`?088/u.test(findingText);
  const phaseScope = /P\d{2}.*bütün finding/u.test(findingText);
  return {
    sprint_id: sprintId,
    phase_id: phaseId,
    dependency_text: dependencyText,
    dependencies: [...sprintRefs(dependencyText), ...operatorRefs(dependencyText)],
    acceptance_ids: acceptanceRefs(acceptanceText),
    finding_ids: programScope ? [] : findingRefs(findingText),
    finding_scope: programScope ? 'program' : phaseScope ? 'phase' : null,
  };
}

export function parseCards(files) {
  return files.flatMap(({ phaseId, text }) =>
    text
      .split(/^## /mu)
      .slice(1)
      .map((section) => parseCard(phaseId, section)),
  );
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
