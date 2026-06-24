import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const REPO_ROOT = process.cwd();
const MANIFEST_PATH = 'docs/plans/2026-06-19-root-ssot-stabilization/stabilization-manifest.json';

type GeneratedOutput = {
  path: string;
  source: string;
  command: string;
  manual_edits_allowed: boolean;
};

type Wave = {
  id: string;
  commit_group: number;
  title: string;
  finding_ids: string[];
  touched_globs: string[];
  generated_outputs: GeneratedOutput[];
  deletion_targets: string[];
  tombstone_queries: string[];
  gate_commands: string[];
  producer_file_refs: string[];
};

type StabilizationManifest = {
  plan_id: string;
  created_at: string;
  base_commit: string;
  scope_policy: {
    finding_scope_must_be_explicit: boolean;
    forbidden_finding_scope_tokens: string[];
    wildcard_scope_allowed_only_for: string;
    producer_files_must_land_before_or_with_consumers: boolean;
    generated_outputs_manual_edits_allowed: boolean;
  };
  regeneration_order: string[];
  producer_files: string[];
  waves: Wave[];
  final_registry_sweep: {
    id: string;
    pattern_scope_allowed: boolean;
    allowed_patterns: string[];
    gate_commands: string[];
  };
  commit_order: string[];
};

function readManifest(): StabilizationManifest {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, MANIFEST_PATH), 'utf8')) as StabilizationManifest;
}

function hasForbiddenScopeToken(value: string): boolean {
  return value === 'ALL' || value.includes('*') || value.includes('..');
}

function packageScripts(): Record<string, string> {
  const packageJson = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  return packageJson.scripts;
}

function scriptPathFromNodeCommand(command: string): string | undefined {
  const match = command.match(/^node\s+([^\s]+\.mjs)\b/);
  return match?.[1];
}

describe('root SSoT stabilization manifest', () => {
  const manifest = readManifest();

  it('is present, machine-readable, and tied to explicit scope rules', () => {
    expect(existsSync(resolve(REPO_ROOT, MANIFEST_PATH))).toBe(true);
    expect(manifest.plan_id).toBe('2026-06-19-root-ssot-stabilization');
    expect(manifest.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(manifest.base_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.scope_policy.finding_scope_must_be_explicit).toBe(true);
    expect(manifest.scope_policy.producer_files_must_land_before_or_with_consumers).toBe(true);
    expect(manifest.scope_policy.generated_outputs_manual_edits_allowed).toBe(false);
    expect(manifest.scope_policy.wildcard_scope_allowed_only_for).toBe('final-registry-sweep');
  });

  it('keeps every implementation wave auditable before it can be claimed complete', () => {
    expect(manifest.waves.map((wave) => wave.commit_group)).toEqual([1, 2, 3, 4, 5, 6]);

    for (const wave of manifest.waves) {
      expect(wave.id).toMatch(/^wave-\d+-[a-z0-9-]+$/);
      expect(wave.title).toBeTruthy();
      expect(wave.finding_ids.length).toBeGreaterThan(0);
      expect(wave.touched_globs.length).toBeGreaterThan(0);
      expect(wave.tombstone_queries.length).toBeGreaterThan(0);
      expect(wave.gate_commands.length).toBeGreaterThan(0);
      expect(wave.producer_file_refs.length).toBeGreaterThan(0);
      expect(wave.finding_ids.filter(hasForbiddenScopeToken)).toEqual([]);
      expect(wave.tombstone_queries.every((query) => query.startsWith('rg -n '))).toBe(true);
    }
  });

  it('keeps generated outputs source-owned and non-editable by hand', () => {
    const generatedOutputs = manifest.waves.flatMap((wave) => wave.generated_outputs);

    expect(generatedOutputs.length).toBeGreaterThan(0);
    for (const output of generatedOutputs) {
      expect(output.path).toBeTruthy();
      expect(output.source).toBeTruthy();
      expect(output.command).toBeTruthy();
      expect(output.manual_edits_allowed).toBe(false);
      expect(existsSync(resolve(REPO_ROOT, output.path))).toBe(true);
      expect(existsSync(resolve(REPO_ROOT, output.source))).toBe(true);

      const commandScript = scriptPathFromNodeCommand(output.command);
      if (commandScript) {
        expect(existsSync(resolve(REPO_ROOT, commandScript))).toBe(true);
      }
    }
  });

  it('keeps control-plane producer files real and wired to package gates', () => {
    const scripts = packageScripts();

    for (const producer of manifest.producer_files) {
      expect(existsSync(resolve(REPO_ROOT, producer))).toBe(true);
    }
    expect(scripts['toolchain:check']).toBe('node tools/toolchain/check-versions.mjs');
    expect(scripts['gates:root-ssot-stabilization']).toContain(
      'tests/invariants/stabilization-manifest.spec.ts',
    );
    expect(scripts['gates:all']).toContain('npm run toolchain:check');
    expect(scripts['gates:all']).toContain('npm run gates:root-ssot-stabilization');
  });

  it('keeps manifest gate commands backed by real package scripts', () => {
    const scripts = packageScripts();
    const gateCommands = [
      ...manifest.waves.flatMap((wave) => wave.gate_commands),
      ...manifest.final_registry_sweep.gate_commands,
    ];

    for (const command of gateCommands) {
      const npmRun = command.match(/^npm run ([^\s]+)$/);
      if (npmRun) {
        expect(scripts[npmRun[1]!]).toBeTruthy();
      }
    }
  });

  it('keeps the final registry sweep as the only pattern-scope escape hatch', () => {
    expect(manifest.final_registry_sweep.id).toBe('final-registry-sweep');
    expect(manifest.final_registry_sweep.pattern_scope_allowed).toBe(true);
    expect(manifest.final_registry_sweep.allowed_patterns).toEqual(['registry sweep only']);
    expect(manifest.waves.flatMap((wave) => wave.finding_ids).some(hasForbiddenScopeToken)).toBe(
      false,
    );
  });
});
