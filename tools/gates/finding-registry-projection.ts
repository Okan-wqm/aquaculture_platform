/**
 * finding-registry-projection — the registry as every reader sees it, with
 * RESOLVED derived from merged history (MF-1, PROC-HIGH-039).
 *
 * ## Why
 *
 * `state: RESOLVED` in findings.jsonl copied a fact the merged `Closes:`
 * trailer already records, and the trailer is immutable and enforced by
 * commit-msg-validator. The copy lagged: a drift gate noticed the lag, a
 * `reconcile` command refreshed the copy, and a lane ran it and merged the
 * result, so every closer merge moved main twice and left the push run red
 * until the second move (63 of 157 merges, 64 red runs and a 121 h drift
 * window in 14 days; MF-DESIGN §1). A fact read where it is recorded cannot
 * lag, so no workflow writes RESOLVED any more: this module derives it when
 * the registry is read.
 *
 * ## What it owns
 *
 *   - the store layout (MF-2): `findings.jsonl` is the frozen genesis segment
 *     `genesis.json` pins, and every later change is an event in one file per
 *     finding, `findings/<PREFIX>/<ID>.jsonl` (`registryLayout`,
 *     `eventLogRelativePath`, `readRegistryStore`). This module is the one
 *     reader of that layout; the writer (finding-registry-events.ts) appends
 *     through it;
 *   - the fold: a genesis row, or a CREATED event's payload, with its events
 *     applied in version order (`foldRegistry`, `applyFindingEvent`), giving
 *     the rows as recorded (`readRegistryRows`);
 *   - closure derivation: the oldest commit reachable from the ref whose
 *     message closes the finding exactly (`messageClosesFinding`, aliases
 *     resolved by `withFindingAliases`), a closer an override reopen
 *     rejected excluded; `closed_at` is the committer date of the first
 *     first-parent commit of the ref that contains the closer — the merge that
 *     brought it into the ref (`projectRegistry`);
 *   - closure admission: the names a trailer may close each row by
 *     (`findingTrailerTargets`), the one predicate "does this message close
 *     this finding" (`messageClosesFinding`), the rejection decision
 *     (`applyClosureRejection`), the question "does this commit's own message
 *     name this finding" (`commitNamesFinding`) and the per-finding verdict of
 *     a snapshot (`closureVerdicts`).
 *
 * The admission helpers of finding-traceability.ts are consumed here and
 * nowhere else, so the commit-time gate (commit-msg-validator.ts, through
 * `findingTrailerTargets` and `messageClosesFinding`), the projection and the
 * reopen decision cannot disagree about what closes a finding.
 *
 * A row the registry records RESOLVED keeps its recorded closure (legacy
 * ceremony, seed and reconcile closures; MF-DESIGN §4.4 step 3), so the
 * projection never reopens a closure the registry already holds. Every other
 * row is RESOLVED exactly when merged history closes it.
 *
 * Cost: one `git log` over the ref plus an index of the trailer names each
 * commit carries, so a finding is matched against the few commits that name
 * it, not against every commit (MF-DESIGN T11: under 10 s on this repository,
 * ts-node start-up included).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { loadAliasReviewFiles, loadCanonicalToAliases } from './finding-id-aliases';
import { type Finding, parseRegistryJsonl } from './finding-registry-chain';
import type { FindingEventLine } from './finding-registry-events';
import { rowContractViolations } from './finding-registry-rows';
import {
  closureAdmissible,
  commitHasFindingCloseTrailer,
  commitMessageClosesFindingExactly,
  findingRejectsClosure,
  type FindingTrailerTarget,
  readCommitMessage,
  type TraceabilityResult,
} from './finding-traceability';
import { commitReachableFrom, repoPinnedEnv } from './git-reachability';

/** The registry directory, relative to the repository root. */
export const REGISTRY_DIR_RELATIVE_PATH = 'docs/reviews/_registry';
/** The frozen genesis segment, relative to the repository root. */
export const REGISTRY_RELATIVE_PATH = 'docs/reviews/_registry/findings.jsonl';
/** The pin of the genesis segment (`finding-registry genesis`), relative to the repository root. */
export const GENESIS_PIN_RELATIVE_PATH = 'docs/reviews/_registry/genesis.json';
/** The per-finding event store, relative to the repository root. */
export const EVENT_STORE_RELATIVE_PATH = 'docs/reviews/_registry/findings';
const GIT_LOG_MAX_BUFFER_BYTES = 512 * 1024 * 1024;
/** Unit and record separators: safe inside commit bodies, unlike newlines. */
const FIELD_SEP = '\x1f';
const RECORD_SEP = '\x1e';
const FULL_SHA = /^[0-9a-f]{40}$/;
/** `<PREFIX>/<ID>.jsonl` under the store: the prefix is the id's leading segment. */
const EVENT_LOG_PATH = /^([A-Z][A-Z0-9]*)\/([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\.jsonl$/;

/** Every file of one registry directory, by role. */
export interface RegistryLayout {
  readonly dir: string;
  /** findings.jsonl: the frozen genesis segment. */
  readonly genesisPath: string;
  /** genesis.json: the segment's pin. */
  readonly pinPath: string;
  /** findings/: one append-only event log per finding. */
  readonly storeDir: string;
  /** The row contract. */
  readonly rowSchemaPath: string;
  /** The event line contract. */
  readonly eventSchemaPath: string;
}

/** The layout of the registry directory `dir`. */
export function registryLayout(dir: string): RegistryLayout {
  return {
    dir,
    genesisPath: join(dir, 'findings.jsonl'),
    pinPath: join(dir, 'genesis.json'),
    storeDir: join(dir, 'findings'),
    rowSchemaPath: join(dir, 'findings.jsonl.schema.json'),
    eventSchemaPath: join(dir, 'finding-event.schema.json'),
  };
}

/** The absolute path of `repoRoot`'s registry directory. */
export function registryDir(repoRoot: string): string {
  return resolve(repoRoot, REGISTRY_DIR_RELATIVE_PATH);
}

/** The absolute path of the genesis segment in `repoRoot`'s working tree. */
export function registryPath(repoRoot: string): string {
  return resolve(repoRoot, REGISTRY_RELATIVE_PATH);
}

/** A finding's event log, relative to the store directory: `<PREFIX>/<ID>.jsonl`. */
export function eventLogRelativePath(findingId: string): string {
  const [prefix = ''] = findingId.split('-');
  return `${prefix}/${findingId}.jsonl`;
}

/** The finding id a store-relative path names, or null when it is not `<PREFIX>/<ID>.jsonl`. */
export function eventLogFindingId(storeRelativePath: string): string | null {
  const match = EVENT_LOG_PATH.exec(storeRelativePath);
  const [, prefix, id] = match ?? [];
  return prefix !== undefined && id !== undefined && id.split('-')[0] === prefix ? id : null;
}

/** One event log as stored: its store-relative path, its bytes and its lines. */
export interface EventLog {
  readonly path: string;
  readonly findingId: string;
  readonly bytes: Buffer;
  readonly events: readonly FindingEventLine[];
}

/** The registry as stored: the genesis rows and every event log, keyed by finding id. */
export interface RegistryStore {
  readonly genesis: readonly Finding[];
  readonly logs: ReadonlyMap<string, EventLog>;
}

/** Parse one event log strictly: a line that is not JSON fails the read. */
export function parseEventLog(path: string, bytes: Buffer): EventLog {
  const findingId = eventLogFindingId(path);
  if (findingId === null) {
    throw new Error(`registry store: ${path} is not <PREFIX>/<ID>.jsonl`);
  }
  const events = bytes
    .toString('utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, index) => {
      try {
        return JSON.parse(line) as FindingEventLine;
      } catch (error) {
        throw new Error(
          `registry store: ${path}:${index + 1} is not JSON (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    });
  return { path, findingId, bytes, events };
}

function walkFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walkFiles(full) : [full];
  });
}

/** The event logs under `storeDir` of a working tree; none when the store does not exist. */
export function readEventLogs(storeDir: string): Map<string, EventLog> {
  const logs = new Map<string, EventLog>();
  if (!existsSync(storeDir)) return logs;
  for (const full of walkFiles(storeDir).sort()) {
    const path = relative(storeDir, full).split(sep).join('/');
    const log = parseEventLog(path, readFileSync(full));
    logs.set(log.findingId, log);
  }
  return logs;
}

/** The registry stored in the registry directory `dir` of a working tree. */
export function readRegistryStoreIn(dir: string): RegistryStore {
  const layout = registryLayout(dir);
  const genesis = existsSync(layout.genesisPath)
    ? parseRegistryJsonl(readFileSync(layout.genesisPath, 'utf8'))
    : [];
  return { genesis, logs: readEventLogs(layout.storeDir) };
}

function git(repoRoot: string, args: readonly string[], input?: string | Buffer): Buffer {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    env: repoPinnedEnv(),
    maxBuffer: GIT_LOG_MAX_BUFFER_BYTES,
    ...(input === undefined ? {} : { input }),
  });
}

function gitText(repoRoot: string, args: readonly string[]): string {
  return git(repoRoot, args).toString('utf8');
}

/** The event logs the commit `ref` stores, read in one `git cat-file --batch`. */
function readEventLogsAt(repoRoot: string, ref: string): Map<string, EventLog> {
  const listed = gitText(repoRoot, [
    'ls-tree',
    '-r',
    '-z',
    '--name-only',
    ref,
    '--',
    `${EVENT_STORE_RELATIVE_PATH}/`,
  ])
    .split('\0')
    .filter(Boolean)
    .sort();
  const logs = new Map<string, EventLog>();
  if (listed.length === 0) return logs;
  const batch = git(
    repoRoot,
    ['cat-file', '--batch'],
    listed.map((path) => `${ref}:${path}\n`).join(''),
  );
  let offset = 0;
  for (const path of listed) {
    const headerEnd = batch.indexOf(0x0a, offset);
    const header = batch.subarray(offset, headerEnd).toString('utf8');
    const [, type, size] = header.split(' ');
    if (type !== 'blob' || size === undefined) {
      throw new Error(`registry store: ${ref}:${path} is not a blob (${header})`);
    }
    const start = headerEnd + 1;
    const end = start + Number.parseInt(size, 10);
    const log = parseEventLog(
      path.slice(EVENT_STORE_RELATIVE_PATH.length + 1),
      batch.subarray(start, end),
    );
    logs.set(log.findingId, log);
    offset = end + 1;
  }
  return logs;
}

/** The registry as the commit `ref` stores it. */
export function readRegistryStoreAt(repoRoot: string, ref: string): RegistryStore {
  return {
    genesis: parseRegistryJsonl(gitText(repoRoot, ['show', `${ref}:${REGISTRY_RELATIVE_PATH}`])),
    logs: readEventLogsAt(repoRoot, ref),
  };
}

/**
 * The fields an AMENDED event may change: non-identity, non-state, non-chain
 * (MF-DESIGN §4.2). The event schema admits exactly these.
 */
export const AMENDABLE_FIELDS = ['owner_user', 'evidence', 'notes', 'title', 'narrative'] as const;

function present(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * `row` after its closers `shas` are rejected (a CLOSURE_REJECTED event):
 * the rejected commits leave closing_commits, and a RESOLVED row no
 * remaining commit closes reopens. A rejection never refuses, so a writer
 * deciding what follows a rejection reads the row it leaves from here.
 */
export function rowAfterClosureRejection(row: Finding, shas: readonly string[]): Finding {
  const rejected = [...(row.rejected_closing_commits ?? []), ...shas];
  const target = { id: row.id, rejected_closing_commits: rejected };
  const closing = row.closing_commits.filter((sha) => !findingRejectsClosure(target, sha));
  const reopened = row.state === 'RESOLVED' && closing.length === 0;
  return {
    ...row,
    rejected_closing_commits: rejected,
    closing_commits: closing,
    ...(reopened ? { state: 'OPEN' as const, closed_at: null } : {}),
  };
}

/**
 * One finding's row after `event`. The fold refuses an event its row cannot
 * take (a transition from a state the row is not in, an assignment that would
 * change a value, a second CREATED): the store is append-only and its writer
 * checks every event against the fold before it appends, so such an event is
 * a store defect, and reading past it would hand every reader a row no writer
 * produced.
 */
export function applyFindingEvent(row: Finding, event: FindingEventLine): Finding {
  const next: Finding = { ...row, content_hash: event.content_hash };
  const refuse = (why: string): never => {
    throw new Error(
      `registry fold: ${event.finding_id} v${event.version} ${event.event_type}: ${why}`,
    );
  };
  switch (event.event_type) {
    case 'CREATED':
      return refuse('the finding already exists');
    case 'STATE_TRANSITIONED': {
      const { from_state: from, to_state: to } = event.payload;
      if (from !== row.state) refuse(`from_state ${from}, but the row is ${row.state}`);
      if (to === row.state) refuse(`to_state ${to} is the row's state`);
      if (row.closing_commits.length > 0) {
        refuse('a finding a commit closed leaves RESOLVED only by CLOSURE_REJECTED');
      }
      return { ...next, state: to, closed_at: null };
    }
    case 'CLOSURE_REJECTED':
      return {
        ...rowAfterClosureRejection(row, event.payload.shas),
        content_hash: event.content_hash,
      };
    case 'OWNER_ASSIGNED': {
      const filled: Partial<Finding> = {};
      for (const field of ['owner_user', 'deadline'] as const) {
        const value = event.payload[field];
        if (value === undefined) continue;
        if (present(row[field]) && row[field] !== value) {
          refuse(`${field} is already ${String(row[field])}; an assignment fills, never changes`);
        }
        filled[field] = value;
      }
      return { ...next, ...filled };
    }
    case 'AMENDED':
      return { ...next, ...event.payload.fields };
    case 'SUPERSEDED':
      // The successor carries `override_of`; the superseded row's fields stay
      // as they were, and the relation is the event itself.
      return next;
  }
}

/** A finding born after the freeze: its CREATED payload, chained where the event is. */
function createdRow(log: EventLog): Finding {
  const [created] = log.events;
  if (created?.event_type !== 'CREATED') {
    throw new Error(
      `registry fold: ${log.path} holds no genesis row and does not start with CREATED`,
    );
  }
  if (created.payload.id !== log.findingId) {
    throw new Error(`registry fold: ${log.path} creates ${created.payload.id}`);
  }
  // The payload is the row body the writer held to the row contract; the
  // chain fields are the event's own.
  return {
    ...created.payload,
    closing_commits: [...created.payload.closing_commits],
    prev_hash: created.prev_hash,
    content_hash: created.content_hash,
  } as Finding;
}

/**
 * The rows as recorded: every genesis row, then every finding born after the
 * freeze (in store order), each with its events applied in version order. A
 * folded row's `content_hash` is the head of its own chain: its last event's,
 * or the genesis row's when it has none. No closure is derived here.
 */
export function foldRegistry(store: RegistryStore): Finding[] {
  const ids = new Set(store.genesis.map((row) => row.id));
  const rows: Finding[] = store.genesis.map((row) => {
    const log = store.logs.get(row.id);
    return (log?.events ?? []).reduce(applyFindingEvent, { ...row });
  });
  for (const log of store.logs.values()) {
    if (ids.has(log.findingId)) continue;
    rows.push(log.events.slice(1).reduce(applyFindingEvent, createdRow(log)));
  }
  return rows;
}

/**
 * The rows as recorded in `repoRoot`'s working tree (genesis and events
 * folded); none when the checkout carries no registry. No closure is
 * derived: a reader that needs only the ids and their review files
 * (commit-msg-validator, banned-phrase-excuse) pays for no history walk.
 */
export function readRegistryRows(repoRoot: string): Finding[] {
  return foldRegistry(readRegistryStoreIn(registryDir(repoRoot)));
}

/**
 * Attach every alias the sidecar records for each candidate's canonical id.
 *
 * The ONE place aliases join a finding: the derivation and every admission
 * question resolve a trailer that names a renumbered finding's historical id
 * to the ledger row that tracks it. When only the derivation knew the aliases,
 * the reconcile lane planned a closure from an aliased trailer and then
 * refused the same commit at admission (PROC-MEDIUM-024).
 */
export function withFindingAliases<T extends FindingTrailerTarget>(
  repoRoot: string,
  candidates: readonly T[],
): T[] {
  const aliasesByCanonical = loadCanonicalToAliases(repoRoot);
  const reviewFiles = loadAliasReviewFiles(repoRoot);
  return candidates.map((candidate) => {
    const aliases = aliasesByCanonical.get(candidate.id);
    if (aliases === undefined) return candidate;
    const aliasReviewFiles = new Map<string, string>();
    for (const alias of aliases) {
      const file = reviewFiles.get(alias);
      if (file !== undefined) aliasReviewFiles.set(alias, file);
    }
    return { ...candidate, aliases, alias_review_files: aliasReviewFiles };
  });
}

/**
 * Every name a `Closes:` trailer may close a stored row by — its id and each
 * alias the sidecar records for it — mapped to that row as a trailer target
 * (its review file, its aliases with their review files, its rejected
 * closers). A later row of an id wins, as a re-registration does; an alias
 * resolves only to a row the registry holds, and wins over an id it shadows.
 * Existence and review files are recorded facts, so no history is read.
 *
 * The commit-time gate admits a trailer exactly when `messageClosesFinding`
 * holds for the target it names here — the target the derivation matches the
 * same trailer against once it is merged, so a commit the gate admits is a
 * commit the projection honours (PROC-MEDIUM-024, PR #1425's renumbering
 * smuggle).
 */
export function findingTrailerTargets(repoRoot: string): Map<string, FindingTrailerTarget> {
  const rows = withFindingAliases<FindingTrailerTarget>(repoRoot, readRegistryRows(repoRoot));
  const targets = new Map<string, FindingTrailerTarget>();
  for (const row of rows) targets.set(row.id, row);
  for (const row of rows) {
    for (const alias of row.aliases ?? []) targets.set(alias, row);
  }
  return targets;
}

/**
 * Does `message` carry a `Closes:` trailer that closes `target` — by its id
 * or an alias, anchored (if at all) on the review file that name belongs to?
 * The one admission predicate: the derivation, the snapshot verdict and the
 * commit-time gate all ask it.
 */
export function messageClosesFinding(message: string, target: FindingTrailerTarget): boolean {
  return commitMessageClosesFindingExactly(message, target);
}

interface MergedCommit {
  readonly sha: string;
  readonly parents: readonly string[];
  /** Committer date, strict ISO 8601 with offset (`%cI`). */
  readonly committedAt: string;
  readonly message: string;
}

/**
 * History read in this process, by repository and commit: the history of a
 * commit never changes, so a second projection at the same commit (a gate
 * spec, a sweep after its plan) does not walk it again.
 */
const historyByCommit = new Map<string, readonly MergedCommit[]>();

/**
 * Every commit reachable from `ref`, OLDEST first (the reverse of `git log`'s walk).
 *
 * A shallow clone is refused by name. Its history stops at a graft, so a
 * closer older than the graft is simply absent and the walk would report the
 * finding OPEN — a closed finding read as open, with nothing to say the read
 * was partial (MF-DESIGN §9 R1: reads fail closed). The reader that needs the
 * registry provisions full history (`fetch-depth: 0`) instead.
 */
function readMergedCommits(repoRoot: string, ref: string): readonly MergedCommit[] {
  const tip = gitText(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  const key = `${resolve(repoRoot)}\0${tip}`;
  const known = historyByCommit.get(key);
  if (known !== undefined) return known;
  const shallow = gitText(repoRoot, ['rev-parse', '--is-shallow-repository']).trim();
  if (shallow === 'true') {
    throw new Error(
      `projection: ${resolve(repoRoot)} is a shallow clone; closures cannot be derived from ` +
        'truncated history (fetch-depth: 0)',
    );
  }
  if (shallow !== 'false') {
    throw new Error(
      `projection: git did not say whether ${resolve(repoRoot)} is a shallow clone (${shallow})`,
    );
  }
  const raw = gitText(repoRoot, [
    'log',
    tip,
    `--format=%H${FIELD_SEP}%P${FIELD_SEP}%cI${FIELD_SEP}%B${RECORD_SEP}`,
  ]);
  const commits: MergedCommit[] = [];
  for (const record of raw.split(RECORD_SEP)) {
    const trimmed = record.replace(/^\n/, '');
    if (trimmed.trim() === '') continue;
    const [sha = '', parents = '', committedAt = '', ...message] = trimmed.split(FIELD_SEP);
    commits.push({
      sha: sha.trim(),
      parents: parents.trim() === '' ? [] : parents.trim().split(' '),
      committedAt: committedAt.trim(),
      message: message.join(FIELD_SEP),
    });
  }
  commits.reverse();
  historyByCommit.set(key, commits);
  return commits;
}

/**
 * The shape of every finding id and alias (findings.jsonl.schema.json `id`,
 * finding-id-aliases.yaml): upper-case alphanumeric segments joined by `-`.
 */
const FINDING_NAME = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;
const FINDING_NAME_RUN = /[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+/g;

/**
 * Every known name a trailer in `message` could close, as
 * `messageClosesFinding` reads one: a name follows `#` or
 * whitespace and ends at a word boundary, which inside a run of the name
 * alphabet falls only before a `-` or at the run's end. Each run's prefixes
 * at those boundaries are therefore a superset of the names the exact matcher
 * can accept; the exact matcher then decides.
 */
function trailerNameCandidates(message: string, known: ReadonlySet<string>): Set<string> {
  const names = new Set<string>();
  for (const [run] of message.matchAll(FINDING_NAME_RUN)) {
    if (known.has(run)) names.add(run);
    for (let dash = run.indexOf('-'); dash !== -1; dash = run.indexOf('-', dash + 1)) {
      const prefix = run.slice(0, dash);
      if (known.has(prefix)) names.add(prefix);
    }
  }
  return names;
}

/**
 * The commits of `ref`'s history whose trailers close each target, oldest
 * first, rejected closers excluded — keyed by target id.
 */
function closersByTarget(
  commits: readonly MergedCommit[],
  targets: readonly FindingTrailerTarget[],
): Map<string, string[]> {
  const byName = new Map<string, FindingTrailerTarget[]>();
  for (const target of targets) {
    for (const name of [target.id, ...(target.aliases ?? [])]) {
      const list = byName.get(name) ?? [];
      list.push(target);
      byName.set(name, list);
    }
  }
  const known = new Set(byName.keys());
  for (const name of known) {
    if (!FINDING_NAME.test(name)) {
      throw new Error(
        `projection: ${name} is not a finding id or alias the trailer index can read`,
      );
    }
  }
  const closers = new Map<string, string[]>();
  for (const commit of commits) {
    if (!FULL_SHA.test(commit.sha) || !commit.message.includes('Closes:')) continue;
    const named = new Set<FindingTrailerTarget>();
    for (const name of trailerNameCandidates(commit.message, known)) {
      for (const target of byName.get(name) ?? []) named.add(target);
    }
    for (const target of named) {
      // A closer an override reopen rejected is not evidence, however old it
      // is; the finding closes only through a commit made after the reopen.
      if (findingRejectsClosure(target, commit.sha)) continue;
      // Derivation is stricter than the commit-msg gate: a BACKLOG-* trailer
      // does not close every finding, and an anchored trailer closes a finding
      // only when it cites that finding's own review file.
      if (!messageClosesFinding(commit.message, target)) continue;
      const list = closers.get(target.id) ?? [];
      list.push(commit.sha);
      closers.set(target.id, list);
    }
  }
  return closers;
}

/** A merged commit that closes a finding, as read from git history. */
export interface MergedClosure {
  readonly findingId: string;
  /** Full SHA of the commit whose message carries the `Closes:` trailer. */
  readonly sha: string;
}

/**
 * The oldest unrejected commit reachable from `ref` that closes each
 * candidate: it is the one that made the finding true, and later commits are
 * follow-ups.
 */
export function collectMergedClosures(
  repoRoot: string,
  ref: string,
  candidates: readonly FindingTrailerTarget[],
): MergedClosure[] {
  const closers = closersByTarget(
    readMergedCommits(repoRoot, ref),
    withFindingAliases(repoRoot, candidates),
  );
  return candidates.flatMap((candidate) => {
    const sha = closers.get(candidate.id)?.[0];
    return sha === undefined ? [] : [{ findingId: candidate.id, sha }];
  });
}

/**
 * EVERY commit reachable from `ref` whose trailer closes `candidate`, oldest
 * first, rejected closers excluded. An override reopen must see all of them:
 * each one it leaves unrejected still closes the finding.
 */
export function listMergedClosers(
  repoRoot: string,
  ref: string,
  candidate: FindingTrailerTarget,
): string[] {
  const [target = candidate] = withFindingAliases(repoRoot, [candidate]);
  return closersByTarget(readMergedCommits(repoRoot, ref), [target]).get(candidate.id) ?? [];
}

/**
 * For every commit of the history, the first first-parent commit of the ref
 * that contains it: walking the first-parent chain oldest first, each commit
 * claims every ancestor no earlier one claimed.
 */
function introducingCommits(commits: readonly MergedCommit[]): Map<string, MergedCommit> {
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
  const tip = commits[commits.length - 1];
  const firstParentChain: MergedCommit[] = [];
  for (let at = tip; at !== undefined; at = bySha.get(at.parents[0] ?? '')) {
    firstParentChain.push(at);
  }
  const introducedBy = new Map<string, MergedCommit>();
  for (const mainline of firstParentChain.reverse()) {
    const pending = [mainline.sha];
    while (pending.length > 0) {
      const sha = pending.pop() as string;
      const commit = bySha.get(sha);
      if (commit === undefined || introducedBy.has(sha)) continue;
      introducedBy.set(sha, mainline);
      for (const parent of commit.parents) pending.push(parent);
    }
  }
  return introducedBy;
}

/** Which commit's history derives closures, and which store is projected. */
export interface ProjectionRequest {
  /**
   * The commit whose merged history closes findings; HEAD when absent. When
   * given, the store is the one the commit holds; when absent, the working
   * tree's (the tree under test).
   */
  readonly ref?: string;
  /**
   * A genesis segment the caller read from a Git tree (`project --stdin`): it
   * replaces the stored findings.jsonl, and the event logs are still read
   * where `ref` says.
   */
  readonly genesis?: readonly Finding[];
}

function requestedStore(repoRoot: string, request: ProjectionRequest): RegistryStore {
  const stored =
    request.ref === undefined
      ? readRegistryStoreIn(registryDir(repoRoot))
      : readRegistryStoreAt(repoRoot, request.ref);
  return request.genesis === undefined ? stored : { ...stored, genesis: request.genesis };
}

/**
 * The registry at `request.ref`: every row as recorded (genesis and events
 * folded), except that a row not recorded RESOLVED is RESOLVED when merged
 * history closes it, with `closing_commits: [closer]` and `closed_at` the
 * merge of the closer into the ref. Writes nothing. A derived row is held to
 * the row contract (findings.jsonl.schema.json), as every written row is.
 */
export function projectRegistry(repoRoot: string, request: ProjectionRequest = {}): Finding[] {
  const ref = request.ref ?? 'HEAD';
  const rows = foldRegistry(requestedStore(repoRoot, request));
  const open = rows.filter((row) => row.state !== 'RESOLVED');
  if (open.length === 0) return rows.map((row) => ({ ...row }));
  const commits = readMergedCommits(repoRoot, ref);
  const closers = closersByTarget(commits, withFindingAliases(repoRoot, open));
  const introducedBy = introducingCommits(commits);
  const schemaPath = registryLayout(registryDir(repoRoot)).rowSchemaPath;
  return rows.map((row) => {
    const closer = row.state === 'RESOLVED' ? undefined : closers.get(row.id)?.[0];
    if (closer === undefined) return { ...row };
    const merge = introducedBy.get(closer);
    if (merge === undefined) {
      throw new Error(`projection: closer ${closer} of ${row.id} is not in the history of ${ref}`);
    }
    const derived: Finding = {
      ...row,
      state: 'RESOLVED',
      closing_commits: [closer],
      closed_at: new Date(merge.committedAt).toISOString(),
    };
    const contract = rowContractViolations(derived, schemaPath, 'post-cutover');
    if (contract.schema.length > 0) {
      throw new Error(
        `projection: the derived row of ${row.id} breaks the row contract: ${contract.schema.join('; ')}`,
      );
    }
    return derived;
  });
}

/** One finding's closure in a projection, as of a commit. */
export interface ClosureVerdict {
  readonly id: string;
  readonly ok: boolean;
  /** Why the finding is not closed at the ref; empty when it is. */
  readonly reasons: readonly string[];
  /** The closers the projection records for it. */
  readonly closing_commits: readonly string[];
}

/**
 * Is each named finding closed in the projection `request` names? A
 * derived closure holds by construction. A recorded closure holds when every
 * closing commit is reachable from the ref, not rejected by an override
 * reopen, and carries the finding's exact `Closes:` trailer — so a snapshot
 * judged at a commit older than its closers is not closed there
 * (ARIA-HIGH-016, the autonomy closure verifier).
 */
export function closureVerdicts(
  repoRoot: string,
  request: ProjectionRequest,
  ids: readonly string[],
): ClosureVerdict[] {
  const ref = request.ref ?? 'HEAD';
  const projected = projectRegistry(repoRoot, request);
  return ids.map((id) => {
    const matching = projected.filter((row) => row.id === id);
    const [row] = withFindingAliases(repoRoot, matching);
    if (matching.length !== 1 || row === undefined) {
      return { id, ok: false, reasons: [`registry_rows:${matching.length}`], closing_commits: [] };
    }
    const reasons: string[] = [];
    if (row.state !== 'RESOLVED') reasons.push(`not_resolved:${row.state}`);
    if (row.closing_commits.length === 0) reasons.push('no_closing_commit');
    for (const sha of row.closing_commits) {
      if (!commitReachableFrom(repoRoot, sha, ref).ok) {
        reasons.push(`closing_commit_unreachable:${sha}`);
        continue;
      }
      if (!closureAdmissible(row, sha).ok) reasons.push(`closing_commit_rejected:${sha}`);
      let message: string;
      try {
        message = readCommitMessage(repoRoot, sha);
      } catch {
        reasons.push(`closing_commit_message_unreadable:${sha}`);
        continue;
      }
      if (!messageClosesFinding(message, row)) {
        reasons.push(`closing_commit_without_trailer:${sha}`);
      }
    }
    return { id, ok: reasons.length === 0, reasons, closing_commits: row.closing_commits };
  });
}

/**
 * Does commit `sha`'s own message carry a `Closes:` trailer naming `finding`,
 * by its id or an alias? The admission question an override reopen asks of
 * each closer it rejects.
 */
export function commitNamesFinding(
  repoRoot: string,
  sha: string,
  finding: FindingTrailerTarget,
): TraceabilityResult {
  const [target = finding] = withFindingAliases(repoRoot, [finding]);
  return commitHasFindingCloseTrailer(repoRoot, sha, target);
}

/** `reopen --reject-closure=<sha> --reason=<why>`: the override decision, made explicit. */
export interface ClosureRejection {
  readonly shas: readonly string[];
  readonly reason: string;
  /** ISO-8601 timestamp recorded in the note; injectable for tests. */
  readonly now?: string;
}

export interface ClosureRejectionOutcome {
  readonly ok: boolean;
  readonly reason?: string;
  /** The closers this decision rejects, in the order a CLOSURE_REJECTED event records them. */
  readonly rejected?: readonly string[];
}

/**
 * Override reopen — the inverse of a closure.
 *
 * A closing commit's trailer is permanent history, and the projection derives
 * RESOLVED from it on every read. Reopening a closed finding therefore cannot
 * mean "clear the fields": the same commit would close it again at the next
 * read (PLAT-MEDIUM-901, 2026-09-04). The override instead REJECTS the
 * closer: the SHA moves from `closing_commits` to `rejected_closing_commits`,
 * where the derivation and every admission question refuse it, and only a NEW
 * closing commit can resolve the finding again. Every current closer must be
 * rejected in the same decision — a finding still closed by another commit is
 * still closed.
 */
export function applyClosureRejection(
  entry: Finding,
  rejection: ClosureRejection,
): ClosureRejectionOutcome {
  if (rejection.reason.trim().length === 0) {
    return {
      ok: false,
      reason: 'override reopen requires --reason=<why the closer did not close it>',
    };
  }
  if (rejection.shas.length === 0) {
    return { ok: false, reason: 'override reopen requires at least one --reject-closure=<sha>' };
  }
  if (entry.state !== 'RESOLVED' && entry.state !== 'OPEN' && entry.state !== 'IN-PROGRESS') {
    return {
      ok: false,
      reason: `${entry.id} is ${entry.state}; reject its closers from OPEN/IN-PROGRESS/RESOLVED`,
    };
  }
  const rejects = (closer: string): boolean =>
    rejection.shas.some((sha) =>
      findingRejectsClosure({ id: entry.id, rejected_closing_commits: [sha] }, closer),
    );
  // A RESOLVED row is still closed by every closer the decision leaves standing.
  const remaining = entry.closing_commits.filter((closer) => !rejects(closer));
  if (remaining.length > 0) {
    return {
      ok: false,
      reason:
        `${entry.id} would still be closed by ${remaining.join(', ')}; reject every current closer ` +
        'in the same decision or leave the finding RESOLVED',
    };
  }

  const already = entry.rejected_closing_commits ?? [];
  const fromRow = entry.closing_commits.filter((closer) => !already.includes(closer));
  const extra = rejection.shas.filter(
    (sha) =>
      !fromRow.some((closer) =>
        findingRejectsClosure({ id: entry.id, rejected_closing_commits: [sha] }, closer),
      ) &&
      !already.some((closer) =>
        findingRejectsClosure({ id: entry.id, rejected_closing_commits: [sha] }, closer),
      ),
  );
  const rejected = [...fromRow, ...extra];
  entry.rejected_closing_commits = [...already, ...rejected];
  entry.closing_commits = [];
  entry.state = entry.state === 'RESOLVED' ? 'OPEN' : entry.state;
  entry.closed_at = null;
  const stamp = (rejection.now ?? new Date().toISOString()).slice(0, 10);
  entry.notes =
    String(entry.notes ?? '') +
    ` [override reopen ${stamp}: closer ${rejected.map((sha) => sha.slice(0, 12)).join(', ')} rejected — ${rejection.reason.trim()}]`;
  return { ok: true, rejected };
}
