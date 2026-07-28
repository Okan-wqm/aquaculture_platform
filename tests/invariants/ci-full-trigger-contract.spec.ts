import * as fs from 'node:fs';
import * as path from 'node:path';

import * as YAML from 'yaml';

interface Workflow {
  on?: {
    push?: {
      branches?: string[];
      tags?: string[];
    };
    pull_request?: {
      branches?: string[];
    };
  };
  concurrency?: {
    group?: string;
    'cancel-in-progress'?: string | boolean;
  };
  jobs?: Record<
    string,
    {
      name?: string;
      needs?: string[];
      if?: string;
      steps?: Array<{
        name?: string;
        uses?: string;
        run?: string;
        with?: Record<string, string>;
        env?: Record<string, string>;
      }>;
    }
  >;
}

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'ci-full.yml');

function readWorkflow(): Workflow {
  return YAML.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8')) as Workflow;
}

describe('CI Full protected-main and PR contract', () => {
  it('runs for pull requests and pushes to main while retaining release tags', () => {
    const workflow = readWorkflow();

    expect(workflow.on?.pull_request?.branches).toContain('main');
    expect(workflow.on?.push?.branches).toContain('main');
    expect(workflow.on?.push?.tags).toEqual(expect.arrayContaining(['v*', 'release-*']));
  });

  it('cancels superseded PR runs but gives every non-PR SHA an independent group', () => {
    const workflow = readWorkflow();

    expect(workflow.concurrency?.group).toBe(
      '${{ github.workflow }}-${{ github.event.pull_request.number || github.sha }}',
    );
    expect(workflow.concurrency?.['cancel-in-progress']).toBe(
      "${{ github.event_name == 'pull_request' }}",
    );
  });

  it('uses build-status as the canonical summary of every full-CI job', () => {
    const workflow = readWorkflow();
    const jobs = workflow.jobs ?? {};
    const summary = jobs['build-status'];
    const expectedDependencies = Object.keys(jobs)
      .filter((jobId) => jobId !== 'build-status')
      .sort();

    expect(summary?.name).toBe('build-status');
    expect(summary?.if).toBe('always()');
    expect([...(summary?.needs ?? [])].sort()).toEqual(expectedDependencies);

    const summaryScript = summary?.steps?.map((step) => step.run ?? '').join('\n') ?? '';
    for (const dependency of expectedDependencies) {
      expect(summaryScript).toContain(`needs.${dependency}.result`);
    }
  });

  it('installs the pinned Rust toolchain before every parallel full-surface command', () => {
    const jobsAndCommands = {
      'lint-and-typecheck': 'npm run lint:all -- --max-warnings=0',
      test: 'npm run test:all -- --coverage',
      build: 'npm run build:all',
    };

    for (const [jobId, command] of Object.entries(jobsAndCommands)) {
      const steps = readWorkflow().jobs?.[jobId]?.steps ?? [];
      const toolchainIndex = steps.findIndex(
        (step) => step.uses === 'dtolnay/rust-toolchain@67ef31d5b988238dd797d409d6f9574278e20537',
      );
      const commandIndex = steps.findIndex((step) => step.run?.includes(command));
      const toolchain = steps[toolchainIndex];

      expect(toolchainIndex).toBeGreaterThan(-1);
      expect(commandIndex).toBeGreaterThan(-1);
      expect(toolchainIndex).toBeLessThan(commandIndex);
      expect(toolchain?.with).toEqual({
        toolchain: '1.88.0',
        components: 'rustfmt,clippy,rust-src',
        targets: 'x86_64-unknown-linux-musl,aarch64-unknown-linux-musl',
      });
    }
  });

  it('ratchets formatting against the PR or push base instead of historical debt', () => {
    const steps = readWorkflow().jobs?.['lint-and-typecheck']?.steps ?? [];
    const format = steps.find((step) => step.name === 'Check formatting of changed files');

    expect(format?.run).toBe('node tools/quality/quality.mjs format check-changed');
    expect(format?.env).toEqual({
      FORMAT_BASE_SHA: '${{ github.event.pull_request.base.sha || github.event.before }}',
    });
    expect(steps.some((step) => step.run === 'npm run format:check')).toBe(false);
  });
});
