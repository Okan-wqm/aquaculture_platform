// Legal adapter readiness — registered with the kernel by the console itself.
//
// WHY: the legal instance runs its inventory through `aria tool run`, which only
// runs a REGISTERED tool. MEASURED 2026-09-04: no image build step, compose file
// or seed script registered the legal adapter, so "Run inventory" in the shipped
// console answered `tool not found` until an operator typed `aria tool register`
// inside the container. A product that needs a shell command nobody documented
// is not deployed; it is demonstrated. The console is the one process that
// knows both the kernel and the pack, so it performs the registration at boot
// and reports the result where a lawyer can see it.
//
// WHAT: `registerLegalAdapter` registers the pack manifest with the kernel.
// MEASURED 2026-09-05: `aria tool register` on an empty tools root creates the
// root itself — registry, ledgers, integrity index and repo identity — while
// `integrity migrate-tools-bootstrap` refuses a workspace without git
// (`repo_resolution_failed`), which is exactly the shape the legal container
// has. So registration is the whole bootstrap here, and no bootstrap command is
// attempted. Re-registration at the same status is a no-op the kernel permits;
// a QUARANTINED tool is left alone, since the kernel refuses to re-register one
// and only an audited unquarantine may lift it. `readLegalReadiness` reads the
// kernel's registry on every health call, so the console reports what the
// kernel says NOW, not what boot found.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { AdapterReadinessState, PackReadiness } from '../../shared/api-contract.ts';
import { LEDGER_SOURCES } from '../../shared/api-contract.ts';
import type { ServerConfig } from './config.ts';
import { HttpError } from './errors.ts';
import { readJsonFile, resolveInside } from './fsafe.ts';
import { asRecord, asString } from './jsonl.ts';
import type { LedgerSigner } from './ledger.ts';
import type { PrincipalDirectory } from './principals.ts';

export const LEGAL_INVENTORY_TOOL_ID = 'legal-document-inventory';
/** The pack manifest, relative to the ARIA install the adapter runs in. */
export const LEGAL_ADAPTER_MANIFEST = 'packs/legal/adapters/legal-document-inventory.tool.json';

export type KernelRunner = (config: ServerConfig, argv: ReadonlyArray<string>, timeoutMs: number) => Promise<{ readonly exitCode: number | null; readonly stdout: string; readonly stderr: string; readonly timedOut: boolean }>;

/** The outcome of the boot-time registration attempt; readers overlay the live registry on it. */
export interface LegalReadiness extends PackReadiness {
  readonly checkedAt: string;
}

/** Holds the boot outcome so the health route can report it after the fact. */
export interface LegalReadinessHolder {
  boot: LegalReadiness;
  /** The console's ledger signing key, or null with the reason it could not be loaded. */
  signer: LedgerSigner | null;
  signerDetail: string | null;
  /** The people who may open this console, or null when only the shared token does. */
  principals: PrincipalDirectory | null;
}

function readiness(adapter: AdapterReadinessState, detail: string | null): LegalReadiness {
  return { toolId: LEGAL_INVENTORY_TOOL_ID, adapter, detail, checkedAt: new Date().toISOString() };
}

function tail(text: string, cap = 600): string {
  const trimmed = text.trim();
  return trimmed.length > cap ? trimmed.slice(trimmed.length - cap) : trimmed;
}

/** The registry's row for the legal tool, or null when the registry lacks it. */
async function registryStatus(toolsDir: string): Promise<string | null> {
  const registry = asRecord(await readJsonFile(resolveInside(toolsDir, LEDGER_SOURCES.tool_registry), 'registry_invalid'));
  const entries = registry === null || !Array.isArray(registry['tools']) ? [] : registry['tools'];
  for (const entry of entries) {
    const record = asRecord(entry);
    if (record !== null && asString(record['tool_id']) === LEGAL_INVENTORY_TOOL_ID) return asString(record['status']) ?? 'unknown';
  }
  return null;
}

/**
 * Registers the legal adapter with the kernel this console fronts.
 *
 * Every refusal is recorded with the kernel's own words rather than swallowed:
 * the console keeps serving its read-only surface, and the health endpoint and
 * the inventory route both say why an inventory cannot run.
 */
export async function registerLegalAdapter(config: ServerConfig, run: KernelRunner): Promise<LegalReadiness> {
  if (config.workspaceRoot === null) {
    return readiness('not_applicable', 'ARIA_WORKSPACE_ROOT is not configured, so no adapter can run');
  }
  const manifestPath = resolve(config.workspaceRoot, LEGAL_ADAPTER_MANIFEST);
  if (!existsSync(manifestPath)) {
    return readiness('not_applicable', `the workspace root carries no legal pack (${LEGAL_ADAPTER_MANIFEST} is absent)`);
  }
  const current = await registryStatus(config.toolsDir);
  if (current === 'QUARANTINED') {
    return readiness('quarantined', 'the kernel quarantined the adapter; only an audited unquarantine may lift it');
  }
  const registered = await run(config, ['tool', 'register', '--tools-dir', config.toolsDir, '--file', manifestPath], config.actionTimeoutMs);
  if (registered.exitCode !== 0 || registered.timedOut) {
    return readiness('unregistered', `aria tool register failed (exit ${registered.exitCode ?? 'killed'}): ${tail(registered.stderr) || tail(registered.stdout)}`);
  }
  return readiness('registered', null);
}

/**
 * What the kernel's registry says right now, with the boot outcome as the
 * explanation when the registry has no row. A tool the kernel quarantined after
 * boot is reported quarantined even though boot registered it.
 */
export async function readLegalReadiness(config: ServerConfig, boot: LegalReadiness): Promise<PackReadiness> {
  if (boot.adapter === 'not_applicable') return { toolId: boot.toolId, adapter: boot.adapter, detail: boot.detail };
  const status = await registryStatus(config.toolsDir);
  if (status === null) return { toolId: boot.toolId, adapter: 'unregistered', detail: boot.detail ?? 'the kernel registry has no row for the adapter' };
  if (status === 'QUARANTINED') return { toolId: boot.toolId, adapter: 'quarantined', detail: 'the kernel quarantined the adapter; only an audited unquarantine may lift it' };
  return { toolId: boot.toolId, adapter: 'registered', detail: null };
}

/** An inventory cannot start unless the kernel will run the tool; say so before spawning. */
export function requireLegalAdapter(state: PackReadiness): void {
  if (state.adapter === 'registered') return;
  throw new HttpError(409, `legal_adapter_${state.adapter}`, state.detail ?? undefined);
}
