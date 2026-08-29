import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AUTOMATION_PUBLICATION_BRANCH_STRATEGY,
  AUTOMATION_PUBLICATION_COMMIT_TRAILER_ORDER,
  AUTOMATION_PUBLICATION_COMMIT_TRAILERS,
  automationPublicationBranch,
  automationPublicationCommandIdentityHash,
  automationPublicationCommandIdentityPayload,
  automationPublicationEvidenceArtifactName,
  automationPublicationInputArtifact,
  automationPublicationResultArtifact,
  automationPublicationResultBasename,
  automationPublicationRetryIdentityHash,
  automationPublicationRetryIdentityPayload,
  isAutomationPublicationResultBasename,
  isManagedAutomationPublicationPath,
  resolveAutomationPublicationPolicy,
  selectAutomationPublicationPolicy,
  type AutomationPublicationPolicyInput,
  type AutomationPublicationRetryIdentityFields,
  type ResolvedAutomationPublicationPolicy,
} from './automation-publication-policy';
import { hasOwn } from './json-contract';

const BASE_SHA = '1'.repeat(40);
const OTHER_SHA = '2'.repeat(40);
const REGISTRY_PATH = 'docs/reviews/_registry/findings.jsonl';

function resolve(input: AutomationPublicationPolicyInput): ResolvedAutomationPublicationPolicy {
  return resolveAutomationPublicationPolicy(input);
}

function registryInput(operation: 'add' | 'close'): AutomationPublicationPolicyInput {
  const headline = `chore(findings): canonical ${operation} mutation`;
  return {
    operation,
    commandId: `finding-request:TEST-${operation}`,
    baseSha: BASE_SHA,
    workflowRef:
      'Okan-wqm/aquaculture_platform/.github/workflows/finding-registry-authority.yml@refs/heads/main',
    branch: 'automation/finding-registry-active',
    changedPath: REGISTRY_PATH,
    commitHeadline: headline,
    pullRequestTitle: headline,
  };
}

function dailyInput(date: string): AutomationPublicationPolicyInput {
  return {
    operation: 'report',
    commandId: `aria-daily-report:${date}`,
    baseSha: BASE_SHA,
    workflowRef:
      'Okan-wqm/aquaculture_platform/.github/workflows/aria-daily-report.yml@refs/heads/main',
    branch: `automation/aria-daily-report-${date}`,
    changedPath: `aria-tools/reports/daily/${date}.md`,
    commitHeadline: `chore(aria-reports): daily ${date}`,
    pullRequestTitle: `chore(aria-reports): daily ${date}`,
  };
}

function ruleHealthInput(reportMonth: string, pathDate: string): AutomationPublicationPolicyInput {
  return {
    operation: 'report',
    commandId: `rule-health-report:${reportMonth}:${BASE_SHA}`,
    baseSha: BASE_SHA,
    workflowRef:
      'Okan-wqm/aquaculture_platform/.github/workflows/rule-health-report.yml@refs/heads/main',
    branch: `automation/rule-health-${reportMonth}`,
    changedPath: `docs/reviews/rule-health/${pathDate}-rule-health-${reportMonth}.md`,
    commitHeadline: `chore(report): rule-health ${reportMonth}`,
    pullRequestTitle: `chore(report): monthly rule-health report - ${reportMonth}`,
  };
}

void describe('automation publication policy selection', () => {
  void it('selects registry add, close, and sweep through exact workflow authority', () => {
    const add = resolve(registryInput('add'));
    const close = resolve(registryInput('close'));
    const sweep = resolve({
      operation: 'sweep',
      commandId: 'finding-sweep:9001',
      baseSha: BASE_SHA,
      workflowRef:
        'Okan-wqm/aquaculture_platform/.github/workflows/finding-state-sweep.yml@refs/heads/main',
      branch: 'automation/finding-registry-active',
      changedPath: REGISTRY_PATH,
      commitHeadline: 'chore(findings): automated state sweep',
      pullRequestTitle:
        'chore(findings): daily state sweep - OPEN to STALE, past-deadline to BLOCKED',
    });

    assert.equal(add.key, 'registry-add');
    assert.equal(close.key, 'registry-close');
    assert.equal(sweep.key, 'registry-sweep');
    assert.equal(add.evidenceArtifactPrefix, 'finding-registry-authority');
    assert.equal(close.evidenceArtifactPrefix, 'finding-registry-authority');
    assert.equal(sweep.evidenceArtifactPrefix, 'finding-state-sweep');
    assert.deepEqual(add.workflowEvents, ['workflow_dispatch']);
    assert.deepEqual(sweep.workflowEvents, ['schedule', 'workflow_dispatch']);
  });

  void it('binds daily reports to a real date and their evidence artifact prefix', () => {
    const policy = resolve(dailyInput('2026-07-30'));

    assert.equal(policy.key, 'aria-daily-report');
    assert.equal(policy.inputDigestKind, 'content');
    assert.equal(policy.evidenceArtifactPrefix, 'aria-daily-report');
    assert.equal(
      automationPublicationEvidenceArtifactName(policy, 91, 2),
      'aria-daily-report-input-91-2',
    );
    assert.throws(() => resolve(dailyInput('2026-02-30')), /real UTC calendar date/);
  });

  void it('allows the rule-health path stamp to differ from its report month', () => {
    const policy = resolve(ruleHealthInput('2026-06', '2026-07-30'));

    assert.equal(policy.key, 'rule-health-report');
    assert.equal(policy.changedPath, 'docs/reviews/rule-health/2026-07-30-rule-health-2026-06.md');
    assert.equal(policy.evidenceArtifactPrefix, 'rule-health-report');
    assert.equal(
      automationPublicationEvidenceArtifactName(policy, 92, 3),
      'rule-health-report-input-92-3',
    );
  });

  void it('rejects a rule-health month, protected base, or report suffix mismatch', () => {
    assert.throws(
      () => resolve(ruleHealthInput('2026-13', '2026-07-30')),
      /select exactly one|real YYYY-MM month/,
    );
    assert.throws(
      () =>
        resolve({
          ...ruleHealthInput('2026-06', '2026-07-30'),
          commandId: `rule-health-report:2026-06:${OTHER_SHA}`,
        }),
      /command base/,
    );
    assert.throws(
      () =>
        resolve({
          ...ruleHealthInput('2026-06', '2026-07-30'),
          changedPath: 'docs/reviews/rule-health/2026-07-30-rule-health-2026-05.md',
        }),
      /bound to its command month/,
    );
  });

  void it('fails closed when workflow, branch, path, headline, or title differs', () => {
    const canonical = registryInput('add');
    for (const candidate of [
      {
        ...canonical,
        workflowRef:
          'Okan-wqm/aquaculture_platform/.github/workflows/finding-state-sweep.yml@refs/heads/main',
      },
      { ...canonical, branch: 'automation/unmanaged' },
      { ...canonical, changedPath: 'docs/reviews/other.jsonl' },
      { ...canonical, commitHeadline: 'chore(findings): drift' },
      { ...canonical, pullRequestTitle: 'chore(findings): drift' },
    ]) {
      assert.throws(() => resolve(candidate), /differs from policy/);
    }
  });
});

void describe('automation publication shared contract helpers', () => {
  void it('recognizes only policy-managed registry and report paths', () => {
    assert.equal(isManagedAutomationPublicationPath(REGISTRY_PATH), true);
    assert.equal(
      isManagedAutomationPublicationPath('aria-tools/reports/daily/2026-07-30.md'),
      true,
    );
    assert.equal(
      isManagedAutomationPublicationPath(
        'docs/reviews/rule-health/2026-07-30-rule-health-2026-06.md',
      ),
      true,
    );
    assert.equal(
      isManagedAutomationPublicationPath('aria-tools/reports/daily/2026-02-30.md'),
      false,
    );
    assert.equal(isManagedAutomationPublicationPath('docs/reviews/arbitrary.md'), false);
  });

  void it('owns every exact durable result basename through one mapping', () => {
    assert.equal(
      automationPublicationResultBasename('registry-add'),
      'finding-registry-publication.json',
    );
    assert.equal(
      automationPublicationResultBasename('registry-close'),
      'finding-registry-publication.json',
    );
    assert.equal(
      automationPublicationResultBasename('registry-sweep'),
      'finding-state-sweep-publication.json',
    );
    assert.equal(
      automationPublicationResultBasename('aria-daily-report'),
      'aria-daily-report-publication.json',
    );
    assert.equal(
      automationPublicationResultBasename('rule-health-report'),
      'rule-health-report-publication.json',
    );
    for (const basename of [
      'finding-registry-publication.json',
      'finding-state-sweep-publication.json',
      'aria-daily-report-publication.json',
      'rule-health-report-publication.json',
    ]) {
      assert.equal(isAutomationPublicationResultBasename(basename), true);
    }
    assert.equal(isAutomationPublicationResultBasename('result.json'), false);
    assert.equal(
      isAutomationPublicationResultBasename('../finding-registry-publication.json'),
      false,
    );
  });

  void it('builds a canonical stable retry payload and binds the base PR body', () => {
    const fields: AutomationPublicationRetryIdentityFields = {
      baseSha: BASE_SHA,
      branch: 'automation/finding-registry-active',
      commandId: 'finding-request:TEST-add',
      operation: 'add',
      inputSha256: '3'.repeat(64),
      changedPath: REGISTRY_PATH,
      changedPathSha256: '4'.repeat(64),
      commitHeadline: 'chore(findings): canonical add mutation',
      pullRequestTitle: 'chore(findings): canonical add mutation',
      basePullRequestBodySha256: '5'.repeat(64),
      workflowRef:
        'Okan-wqm/aquaculture_platform/.github/workflows/finding-registry-authority.yml@refs/heads/main',
      workflowSha: BASE_SHA,
    };
    const payload = automationPublicationRetryIdentityPayload(fields);

    assert.equal(payload.repository, 'Okan-wqm/aquaculture_platform');
    assert.equal(payload.repository_id, '1132698735');
    assert.equal(payload.base_pull_request_body_sha256, fields.basePullRequestBodySha256);
    assert.equal(
      hasOwn(payload, 'workflow_run_id'),
      false,
      'attempt provenance must not enter the stable retry identity',
    );
    assert.equal(hasOwn(payload, 'evidence_artifact'), false);
    assert.equal(
      automationPublicationRetryIdentityHash(fields),
      automationPublicationRetryIdentityHash({ ...fields }),
    );
    assert.notEqual(
      automationPublicationRetryIdentityHash(fields),
      automationPublicationRetryIdentityHash({
        ...fields,
        basePullRequestBodySha256: '6'.repeat(64),
      }),
    );
  });

  void it('derives one immutable physical branch from the repository-global command identity', () => {
    const policy = resolve(registryInput('add'));
    const commandId = 'finding-request:TEST-add';
    const identity = automationPublicationCommandIdentityHash(policy, commandId);
    const payload = automationPublicationCommandIdentityPayload(policy, commandId);

    assert.equal(policy.branchStrategy, AUTOMATION_PUBLICATION_BRANCH_STRATEGY);
    assert.deepEqual(payload, {
      schema: 'aqua/automation-publication-command-identity/v1',
      repository: 'Okan-wqm/aquaculture_platform',
      repository_id: '1132698735',
      logical_branch: 'automation/finding-registry-active',
      command_id: commandId,
    });
    assert.equal(hasOwn(payload, 'base_sha'), false);
    assert.equal(hasOwn(payload, 'input_sha256'), false);
    assert.equal(hasOwn(payload, 'workflow_run_id'), false);
    assert.equal(
      automationPublicationBranch(policy, commandId),
      `automation/finding-registry-active--${identity}`,
    );
    assert.throws(() => automationPublicationBranch(policy, 'short'), /command ID/i);
  });

  void it('selects logical policy authority before binding the live physical branch', () => {
    const { branch: _branch, ...authorityInput } = registryInput('close');
    const selected = selectAutomationPublicationPolicy(authorityInput);

    assert.equal(selected.key, 'registry-close');
    assert.equal(selected.branch, 'automation/finding-registry-active');
  });

  void it('owns exact input and result artifact members for every policy', () => {
    const registry = resolve(registryInput('add'));
    const daily = resolve(dailyInput('2026-07-30'));
    const ruleHealth = resolve(ruleHealthInput('2026-06', '2026-07-30'));

    assert.deepEqual(automationPublicationInputArtifact(registry, 91, 2), {
      name: 'finding-registry-authority-input-91-2',
      exactFiles: [
        'finding-registry-authority-preflight.json',
        'finding-registry-request-receipt.json',
      ],
    });
    assert.deepEqual(automationPublicationInputArtifact(daily, 92, 3), {
      name: 'aria-daily-report-input-92-3',
      exactFiles: ['2026-07-30.md'],
    });
    assert.deepEqual(automationPublicationInputArtifact(ruleHealth, 93, 4), {
      name: 'rule-health-report-input-93-4',
      exactFiles: ['rule-health-report-preflight.json', '2026-07-30-rule-health-2026-06.md'],
    });
    assert.deepEqual(automationPublicationResultArtifact(registry), {
      resultJsonBasename: 'finding-registry-publication.json',
      exactFiles: ['finding-registry-publication.json'],
    });
    assert.deepEqual(automationPublicationResultArtifact(daily), {
      resultJsonBasename: 'aria-daily-report-publication.json',
      exactFiles: ['aria-daily-report-preflight.json', 'aria-daily-report-publication.json'],
    });
  });

  void it('publishes one ordered, duplicate-free commit trailer vocabulary', () => {
    assert.equal(
      new Set(AUTOMATION_PUBLICATION_COMMIT_TRAILER_ORDER).size,
      AUTOMATION_PUBLICATION_COMMIT_TRAILER_ORDER.length,
    );
    assert.deepEqual(AUTOMATION_PUBLICATION_COMMIT_TRAILER_ORDER, [
      AUTOMATION_PUBLICATION_COMMIT_TRAILERS.commandId,
      AUTOMATION_PUBLICATION_COMMIT_TRAILERS.operation,
      AUTOMATION_PUBLICATION_COMMIT_TRAILERS.inputSha256,
      AUTOMATION_PUBLICATION_COMMIT_TRAILERS.baseSha,
      AUTOMATION_PUBLICATION_COMMIT_TRAILERS.retryIdentity,
      AUTOMATION_PUBLICATION_COMMIT_TRAILERS.changedPath,
      AUTOMATION_PUBLICATION_COMMIT_TRAILERS.changedPathSha256,
      AUTOMATION_PUBLICATION_COMMIT_TRAILERS.workflowRef,
      AUTOMATION_PUBLICATION_COMMIT_TRAILERS.workflowSha,
      AUTOMATION_PUBLICATION_COMMIT_TRAILERS.workflowRunId,
      AUTOMATION_PUBLICATION_COMMIT_TRAILERS.workflowRunAttempt,
      AUTOMATION_PUBLICATION_COMMIT_TRAILERS.evidenceArtifactId,
      AUTOMATION_PUBLICATION_COMMIT_TRAILERS.evidenceArtifact,
      AUTOMATION_PUBLICATION_COMMIT_TRAILERS.evidenceSha256,
    ]);
  });
});
