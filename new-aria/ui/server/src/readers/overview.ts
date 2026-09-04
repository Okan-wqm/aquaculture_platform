// Overview — the operator's landing card, assembled from the other readers.
//
// WHY: one request answers "is ARIA frozen, what did it last do, how much is
// pending" without the SPA fanning out a dozen calls on every page load.
// WHAT: profile state file, kill switch sentinel, breaker ledgers, budget state,
// last cycle, counts across ledgers, gateway heartbeat.

import type { OverviewResponse, RuntimeProfile } from '../../../shared/api-contract.ts';
import { LEDGER_SOURCES } from '../../../shared/api-contract.ts';
import type { ServerConfig } from '../config.ts';
import { existsInside, listDirectory, readJsonFile, resolveInside } from '../fsafe.ts';
import { asRecord, asString, countJsonlRows, foldLatest, tailJsonl } from '../jsonl.ts';
import { readCycles } from './cycles.ts';
import { readHumanRequired } from './human-required.ts';
import { readPressures } from './pressures.ts';

const PROFILES: ReadonlySet<RuntimeProfile> = new Set(['observe', 'standard', 'strict', 'frozen', 'autonomous']);

function asProfile(value: unknown): RuntimeProfile | null {
  return typeof value === 'string' && PROFILES.has(value as RuntimeProfile) ? (value as RuntimeProfile) : null;
}

async function readBreakers(toolsDir: string): Promise<OverviewResponse['breakers']> {
  const dir = resolveInside(toolsDir, LEDGER_SOURCES.breakers_dir);
  const out: { name: string; state: string; rows: number }[] = [];
  for (const name of await listDirectory(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const path = resolveInside(dir, name);
    const last = (await tailJsonl<Record<string, unknown>>(path, { maxBytes: 256 * 1024, limit: 1 })).rows[0];
    out.push({
      name: name.slice(0, -'.jsonl'.length),
      state: last === undefined ? 'empty' : asString(last['state']) ?? asString(last['status']) ?? asString(last['event']) ?? 'unknown',
      rows: (await countJsonlRows(path)) ?? 0,
    });
  }
  return out;
}

export async function readOverview(config: ServerConfig): Promise<OverviewResponse> {
  const toolsDir = config.toolsDir;
  const profileState = asRecord(await readJsonFile(resolveInside(toolsDir, LEDGER_SOURCES.runtime_profile_state), 'runtime_profile_invalid'));
  const budgetState = asRecord(await readJsonFile(resolveInside(toolsDir, LEDGER_SOURCES.budget_breaker_state), 'budget_state_invalid'));
  const heartbeat = asRecord(await readJsonFile(resolveInside(toolsDir, LEDGER_SOURCES.gateway_heartbeat), 'gateway_heartbeat_invalid'));
  const cycles = await readCycles(toolsDir, 1);
  const beliefRows = (await tailJsonl<Record<string, unknown>>(resolveInside(toolsDir, LEDGER_SOURCES.memory_beliefs), { maxBytes: 16 * 1024 * 1024 })).rows;
  const beliefs = foldLatest(beliefRows, (row) => asString(row['belief_id'])).size;
  const pressures = (await readPressures(toolsDir, 1)).total;
  const humanRequired = await readHumanRequired(toolsDir);
  const agentRequests = (await tailJsonl<Record<string, unknown>>(resolveInside(toolsDir, LEDGER_SOURCES.agent_requests), { maxBytes: 16 * 1024 * 1024 })).rows;
  const inboxRows = (await tailJsonl<Record<string, unknown>>(resolveInside(toolsDir, LEDGER_SOURCES.gateway_inbox), { maxBytes: 4 * 1024 * 1024 })).rows;
  return {
    generatedAt: new Date().toISOString(),
    toolsDir,
    workspaceRoot: config.workspaceRoot,
    profile: {
      // The kernel documents `standard` as the profile of a store nobody has set;
      // a missing state file therefore means standard, never "unknown".
      current: profileState === null ? 'standard' : asProfile(profileState['profile']) ?? asProfile(profileState['current']),
      schedulerCeiling: profileState === null ? 'standard' : asProfile(profileState['scheduler_profile_ceiling']),
      setBy: profileState === null ? null : asString(profileState['set_by']),
      setAt: profileState === null ? null : asString(profileState['set_at']) ?? asString(profileState['at']),
    },
    killSwitch: { engaged: await existsInside(resolveInside(toolsDir, LEDGER_SOURCES.kill_switch)) },
    breakers: await readBreakers(toolsDir),
    budget: {
      tripped: budgetState !== null && (budgetState['tripped'] === true || asString(budgetState['state']) === 'tripped'),
      detail: budgetState,
    },
    lastCycle: cycles.cycles[0] ?? null,
    counts: {
      cycles: cycles.total,
      rawFindings: (await countJsonlRows(resolveInside(toolsDir, LEDGER_SOURCES.raw_findings))) ?? 0,
      beliefs,
      pressures,
      humanRequiredOpen: humanRequired.open,
      agentRequests: foldLatest(agentRequests, (row) => asString(row['request_id'])).size,
      governanceRows: (await countJsonlRows(resolveInside(toolsDir, LEDGER_SOURCES.governance))) ?? 0,
    },
    gateway:
      heartbeat === null
        ? null
        : {
            heartbeatAt: asString(heartbeat['at']) ?? asString(heartbeat['recorded_at']) ?? asString(heartbeat['ts']),
            inboxPending: inboxRows.filter((row) => asString(row['status']) === 'pending').length,
          },
  };
}
