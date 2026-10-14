/**
 * orchestrator.md table parsers — shared SSoT for the invariants that ask who
 * is on the Runtime Review Roster and who is auxiliary tooling outside it.
 *
 * One home: maintenance-isolation.spec.ts (roster exclusion),
 * doc-cardinality.spec.ts (Lane-A membership) and
 * orchestrator-routing-coverage.spec.ts (routing ⇄ roster) read the same
 * bounded sections; a second copy of the section bounds would be exactly the
 * drift they catch.
 * Each parser throws when its section cannot be bounded or a table row does
 * not carry an agent name, so a reshaped orchestrator.md fails loudly instead
 * of yielding a short list that passes every membership check.
 */

const RUNTIME_ROSTER_HEADING = '## Runtime Review Roster';
const AUXILIARY_HEADING = '## Auxiliary Maintenance Tooling';
const INVOCATION_HEADING = '## Invocation Examples';

const NAME_CELL = /^\|\s*([a-z][a-z0-9-]*)\s*\|/;

function boundedSection(
  content: string,
  startHeading: string,
  endHeading: string,
  label: string,
): string {
  const start = content.indexOf(startHeading);
  const end = content.indexOf(endHeading);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Could not bound ${label} section in orchestrator.md`);
  }
  return content.slice(start, end);
}

function tableRows(section: string): string[] {
  return section.split('\n').filter((l) => l.startsWith('|'));
}

/** First-column names of a `| <headerCell> | ... |` table, header and separator skipped. */
function tableNames(rows: string[], headerCell: string, label: string): string[] {
  const [header, separator, ...data] = rows;
  const headerRe = new RegExp(`^\\|\\s*${headerCell}\\s*\\|`);
  if (!header || !headerRe.test(header) || !separator || !/^\|\s*-+\s*\|/.test(separator)) {
    throw new Error(`${label} table in orchestrator.md lacks its | ${headerCell} | header`);
  }
  return data.map((row) => {
    const match = NAME_CELL.exec(row);
    if (!match || !match[1]) {
      throw new Error(`${label} row without an agent name in orchestrator.md: ${row.trim()}`);
    }
    return match[1];
  });
}

/** Every `|`-prefixed line between Runtime Review Roster and Auxiliary Maintenance Tooling. */
export function extractRuntimeRosterRows(content: string): string[] {
  return tableRows(
    boundedSection(content, RUNTIME_ROSTER_HEADING, AUXILIARY_HEADING, 'Runtime Review Roster'),
  );
}

/** Agent names listed in the Runtime Review Roster table. */
export function runtimeRosterAgentNames(orchestratorContent: string): string[] {
  return tableNames(
    extractRuntimeRosterRows(orchestratorContent),
    'Agent',
    'Runtime Review Roster',
  );
}

/** Tool names listed in the Auxiliary Maintenance Tooling table. */
export function auxiliaryToolNames(orchestratorContent: string): string[] {
  return tableNames(
    tableRows(
      boundedSection(
        orchestratorContent,
        AUXILIARY_HEADING,
        INVOCATION_HEADING,
        'Auxiliary Maintenance Tooling',
      ),
    ),
    'Tool',
    'Auxiliary Maintenance Tooling',
  );
}
