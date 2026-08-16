import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../..');
const LIBRARY_ROOTS = ['libs', 'platform/libs'] as const;
const JEST_CONFIG = /^jest\.config\.(?:[cm]?[jt]s|json)$/;

interface NxProject {
  readonly name: string;
  readonly targets?: {
    readonly test?: {
      readonly executor?: string;
      readonly options?: { readonly jestConfig?: string };
    };
  };
}

interface AffectedTargetPolicy {
  readonly targets?: {
    readonly test?: {
      readonly knownUnstableProjects?: Readonly<Record<string, string>>;
    };
  };
}

function discoverJestConfigs(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : discoverJestConfigs(absolutePath);
    }
    return JEST_CONFIG.test(entry.name) ? [absolutePath] : [];
  });
}

describe('library test ownership', () => {
  const jestConfigs = LIBRARY_ROOTS.flatMap((root) => discoverJestConfigs(join(REPO_ROOT, root)));

  it('gives every library Jest suite an Nx test owner', () => {
    const violations: string[] = [];

    for (const configPath of jestConfigs) {
      const projectRoot = dirname(configPath);
      const projectPath = join(projectRoot, 'project.json');
      let project: NxProject;
      try {
        project = JSON.parse(readFileSync(projectPath, 'utf8')) as NxProject;
      } catch {
        violations.push(`${relative(REPO_ROOT, configPath)}: missing readable project.json`);
        continue;
      }

      const expectedConfig = relative(REPO_ROOT, configPath);
      if (project.targets?.test?.executor !== '@nx/jest:jest') {
        violations.push(`${project.name}: test target is not owned by @nx/jest:jest`);
      }
      if (project.targets?.test?.options?.jestConfig !== expectedConfig) {
        violations.push(`${project.name}: test target does not project ${basename(configPath)}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('routes every owned library test target through affected CI without project bypasses', () => {
    const workflow = readFileSync(join(REPO_ROOT, '.github/workflows/ci-affected.yml'), 'utf8');
    const policy = JSON.parse(
      readFileSync(join(REPO_ROOT, 'scripts/ci/affected-target-policy.json'), 'utf8'),
    ) as AffectedTargetPolicy;
    const quarantined = policy.targets?.test?.knownUnstableProjects ?? {};
    expect(workflow).toContain('affected-target-policy.sh --target test');

    for (const configPath of jestConfigs) {
      const project = JSON.parse(
        readFileSync(join(dirname(configPath), 'project.json'), 'utf8'),
      ) as NxProject;
      expect(quarantined).not.toHaveProperty(project.name);

      if (workflow.includes(`--exclude ${project.name}`)) {
        expect(workflow).toContain(`nx run ${project.name}:test`);
      }
    }
  });
});
