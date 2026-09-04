// Route path constants. Builders encode params so a cycleId containing "/" or
// "#" cannot break out of its segment.
export const ROUTES = {
  login: '/login',
  overview: '/',
  cycles: '/cycles',
  cycle: (cycleId: string): string => `/cycles/${encodeURIComponent(cycleId)}`,
  governance: '/governance',
  findings: '/findings',
  beliefs: '/beliefs',
  pressures: '/pressures',
  humanRequired: '/human-required',
  agents: '/agents',
  plans: '/plans',
  tools: '/tools',
  reports: '/reports',
  report: (date: string): string => `/reports/${encodeURIComponent(date)}`,
  ledgers: '/ledgers',
  actions: '/actions',
  legalCases: '/legal/cases',
  legalCase: (caseId: string, tab: LegalCaseTab = 'documents'): string =>
    `/legal/cases/${encodeURIComponent(caseId)}/${tab}`,
} as const;

export const LEGAL_CASE_TABS = ['intake', 'documents', 'timeline', 'parties', 'statements', 'coverage'] as const;
export type LegalCaseTab = (typeof LEGAL_CASE_TABS)[number];

export function isLegalCaseTab(value: string | undefined): value is LegalCaseTab {
  return value !== undefined && (LEGAL_CASE_TABS as ReadonlyArray<string>).includes(value);
}
