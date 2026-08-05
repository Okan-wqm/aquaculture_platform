/**
 * Platform-wide invariant — every scheduled lane that monitors a production
 * disaster-recovery capability must resolve that capability through
 * `.github/manifests/dr-activation.json`.
 *
 * # Why this exists
 *
 * `database-wal-archive-freshness.yml` runs every five minutes and is the
 * platform's only alarm for the five-minute PostgreSQL RPO. It asserted its
 * secret preconditions rigorously and then ran the healthcheck — but it had no
 * RUNTIME precondition, so when production was still running the bare Timescale
 * base image (no WAL-G, `archive_mode=off`), the lane discovered that as a bare
 * shell `exit 127` from `docker exec`.
 *
 * That made two completely different emergencies indistinguishable:
 *
 *   A. the archiver is deployed and has STALLED  → production is losing data
 *   B. the archiver was never deployed           → known backlog, plan phase BR-3
 *
 * The lane sat in state B for three weeks at 288 runs a day. A monitor that
 * cries wolf 288 times a day has stopped being a monitor, so if it ever entered
 * state A nobody would have reacted.
 *
 * The manifest is the declared state; each lane proves it against the live
 * runtime on every run and fails on drift in BOTH directions. This test pins
 * the wiring so a new DR lane cannot be scheduled without saying how its
 * not-yet-activated state is told apart from its broken state.
 *
 * # What a failure means
 *
 * - Undeclared capability: the lane resolves a capability nobody declared —
 *   add it to the manifest, or stop referencing it.
 * - Orphaned declaration: the last lane that resolved this capability is gone —
 *   delete the entry so the manifest keeps describing reality.
 * - A `not-activated` capability with no unlock phase or tracked finding: an
 *   unprotected production capability with no owner and no deadline is exactly
 *   the drift this file exists to prevent.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(__dirname, '../..');
const workflowsDir = join(repoRoot, '.github/workflows');
const manifestPath = join(repoRoot, '.github/manifests/dr-activation.json');
const watchdogManifestPath = join(repoRoot, '.github/manifests/scheduled-workflows.json');

type ActivationState = 'active' | 'not-activated';

interface Capability {
  readonly state: ActivationState;
  readonly summary: string;
  readonly activationEvidence: string;
  readonly whyNotActivated: string;
  readonly unlockPhase: string;
  readonly unlockPlan: string;
  readonly finding: string;
  readonly lanes: readonly string[];
}

interface Manifest {
  readonly schemaVersion: number;
  readonly capabilities: Readonly<Record<string, Capability>>;
}

function manifest(): Manifest {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
}

function watchedWorkflows(): Set<string> {
  const parsed = JSON.parse(readFileSync(watchdogManifestPath, 'utf8')) as {
    workflows: { workflow: string }[];
  };
  return new Set(parsed.workflows.map((entry) => entry.workflow));
}

/** Capability keys each workflow resolves, keyed by workflow filename. */
function resolvedCapabilities(): Map<string, string[]> {
  const resolved = new Map<string, string[]>();
  const files = new Set<string>();
  for (const capability of Object.values(manifest().capabilities)) {
    for (const lane of capability.lanes) files.add(lane);
  }
  for (const file of files) {
    const path = join(workflowsDir, file);
    if (!existsSync(path)) continue;
    const contents = readFileSync(path, 'utf8');
    const keys: string[] = [];
    for (const match of contents.matchAll(/DR_CAPABILITY:\s*([a-z0-9-]+)/g)) {
      const [, key] = match;
      if (key !== undefined && !keys.includes(key)) keys.push(key);
    }
    resolved.set(file, keys);
  }
  return resolved;
}

describe('DR activation manifest', () => {
  it('declares a capability for every lane that resolves one', () => {
    const declared = new Set(Object.keys(manifest().capabilities));
    const undeclared: string[] = [];
    for (const [file, keys] of resolvedCapabilities()) {
      for (const key of keys) {
        if (!declared.has(key)) undeclared.push(`${key} (resolved by ${file})`);
      }
    }

    expect(undeclared).toEqual([]);
  });

  it('names a lane that actually resolves each declared capability', () => {
    const resolved = resolvedCapabilities();
    const drifted: string[] = [];
    for (const [key, capability] of Object.entries(manifest().capabilities)) {
      for (const lane of capability.lanes) {
        if (!existsSync(join(workflowsDir, lane))) {
          drifted.push(`${key}: declares lane ${lane}, which does not exist`);
          continue;
        }
        if (!(resolved.get(lane) ?? []).includes(key)) {
          drifted.push(`${key}: declares lane ${lane}, but that workflow never resolves it`);
        }
      }
    }

    expect(drifted).toEqual([]);
  });

  it('gives every not-activated capability an unlock phase and a tracked finding', () => {
    const unowned: string[] = [];
    for (const [key, capability] of Object.entries(manifest().capabilities)) {
      if (capability.state !== 'not-activated') continue;
      if (!/^BR-\d+$/.test(capability.unlockPhase)) {
        unowned.push(`${key}: unlockPhase "${capability.unlockPhase}" is not a plan phase`);
      }
      if (!/^[A-Z][A-Z0-9-]+-\d+$/.test(capability.finding)) {
        unowned.push(`${key}: finding "${capability.finding}" is not a tracked finding ID`);
      }
      if (!existsSync(join(repoRoot, capability.unlockPlan))) {
        unowned.push(`${key}: unlockPlan "${capability.unlockPlan}" does not exist`);
      }
      if (capability.whyNotActivated.trim().length < 40) {
        unowned.push(`${key}: whyNotActivated does not explain what is missing`);
      }
    }

    expect(unowned).toEqual([]);
  });

  it('states how each capability is proven against the live runtime', () => {
    for (const [key, capability] of Object.entries(manifest().capabilities)) {
      expect(['active', 'not-activated']).toContain(capability.state);
      expect(`${key}: ${capability.activationEvidence}`.length).toBeGreaterThan(key.length + 30);
      expect(capability.lanes.length).toBeGreaterThan(0);
    }
  });

  it('keeps every declared lane under the scheduled-workflow watchdog', () => {
    const watched = watchedWorkflows();
    const unwatched: string[] = [];
    for (const [key, capability] of Object.entries(manifest().capabilities)) {
      for (const lane of capability.lanes) {
        if (!watched.has(lane)) unwatched.push(`${key}: lane ${lane} is not watched`);
      }
    }

    expect(unwatched).toEqual([]);
  });
});
