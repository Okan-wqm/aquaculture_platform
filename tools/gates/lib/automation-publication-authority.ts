import { hasOwn } from './json-contract';

export const AUTOMATION_PUBLICATION_AUTHORITY_SCHEMA =
  'aqua/github-automation-publication-authority/v2' as const;
export const AUTOMATION_PUBLICATION_AUTHORITY_SCHEMA_VERSION = 2 as const;

export interface AutomationPublicationBranchRule {
  readonly name: string;
  readonly type: 'branch';
}

export interface AutomationPublicationDeploymentBranchPolicy {
  readonly mode: 'CUSTOM_BRANCH_POLICIES';
  readonly rules: readonly AutomationPublicationBranchRule[];
}

export const EXPECTED_AUTOMATION_PUBLICATION_BRANCH_POLICY = {
  mode: 'CUSTOM_BRANCH_POLICIES',
  rules: [{ name: 'main', type: 'branch' }],
} as const satisfies AutomationPublicationDeploymentBranchPolicy;

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  field: string,
): void {
  const expectedSet = new Set(expected);
  const missing = expected.filter((key) => !hasOwn(record, key));
  const extra = Object.keys(record).filter((key) => !expectedSet.has(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${field} keys differ (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`,
    );
  }
}

export function parseAutomationPublicationDeploymentBranchPolicy(
  value: unknown,
): AutomationPublicationDeploymentBranchPolicy {
  const record = requireRecord(value, 'deployment_branch_policy');
  assertExactKeys(record, ['mode', 'rules'], 'deployment_branch_policy');
  if (record.mode !== 'CUSTOM_BRANCH_POLICIES') {
    throw new Error('deployment_branch_policy.mode must be CUSTOM_BRANCH_POLICIES');
  }
  if (!Array.isArray(record.rules) || record.rules.length === 0) {
    throw new Error('deployment_branch_policy.rules must be a non-empty array');
  }
  const rules = record.rules.map((value, index): AutomationPublicationBranchRule => {
    const rule = requireRecord(value, `deployment_branch_policy.rules[${index}]`);
    assertExactKeys(rule, ['name', 'type'], `deployment_branch_policy.rules[${index}]`);
    if (typeof rule.name !== 'string' || rule.name.length === 0 || rule.type !== 'branch') {
      throw new Error(`deployment_branch_policy.rules[${index}] is invalid`);
    }
    return { name: rule.name, type: rule.type };
  });
  if (new Set(rules.map((rule) => `${rule.type}:${rule.name}`)).size !== rules.length) {
    throw new Error('deployment_branch_policy.rules contains a duplicate');
  }
  if (
    rules.length !== EXPECTED_AUTOMATION_PUBLICATION_BRANCH_POLICY.rules.length ||
    rules.some((rule, index) => {
      const expected = EXPECTED_AUTOMATION_PUBLICATION_BRANCH_POLICY.rules[index];
      return rule.name !== expected?.name || rule.type !== expected.type;
    })
  ) {
    throw new Error('deployment_branch_policy must grant only the exact protected main branch');
  }
  return EXPECTED_AUTOMATION_PUBLICATION_BRANCH_POLICY;
}
