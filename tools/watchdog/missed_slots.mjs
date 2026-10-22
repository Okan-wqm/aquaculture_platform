#!/usr/bin/env node
/**
 * Data-Flow Integrity Watchdog — lane cadence accounting (ARIA-MEDIUM-277).
 *
 * The probe that finally runs again reports only its own fresh result,
 * never how many hourly slots passed since the previous run — the measured
 * starvation (3-7 runs/day against a 24-slot cadence) therefore read as a
 * healthy lane. A lane either runs at its declared cadence or REPORTS the
 * gap: this tool counts every cron slot between the previous run and this
 * one that produced no run, and writes the count to the probe textfile
 * (`probe_missed_slots`, Prometheus textfile format, appended beside the
 * probe_* series probe-runner.mjs owns) and to an evidence JSON the lane
 * uploads next to probe-evidence.json.
 *
 * A gap is a REPORT, not a probe failure: the exit code is 0 even with
 * missed slots (the CRITICAL classification belongs to the probes
 * themselves). Only a usage or input error exits non-zero.
 *
 * Run by the lane step (credential-free inputs only — the gh run list is
 * fetched by the workflow step, which holds the token):
 *
 *   node tools/watchdog/missed_slots.mjs \
 *     --runs "$RUNNER_TEMP/missed-slots-runs.json" \
 *     --textfile "$RUNNER_TEMP/aqua_probes.prom" \
 *     --evidence missed-slots.json \
 *     --cron '40 * * * *' \
 *     --current-run-id "$GITHUB_RUN_ID"
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] ?? ''] : []))
    .filter(Boolean),
);

function fail(message) {
  console.error(`missed_slots: ${message}`);
  process.exit(1);
}

if (!args.runs || !args.textfile || !args.evidence) {
  fail('--runs, --textfile and --evidence are required');
}

// The lane's cadence: an hourly cron with a fixed minute ('40 * * * *').
// Anything else refuses rather than guessing slot boundaries.
const CRON_MINUTE_MATCH = /^(\d{1,2}) \* \* \* \*$/;
const cron = args.cron ?? '40 * * * *';
const minuteMatch = CRON_MINUTE_MATCH.exec(cron);
if (!minuteMatch) {
  fail(`unsupported cron '${cron}' — only '<m> * * * *' (hourly, fixed minute) is priced`);
}
const cronMinute = Number(minuteMatch[1]);
if (cronMinute > 59) fail(`minute ${cronMinute} out of range`);

const workflowLabel = args.workflow ?? 'dataflow-integrity-watchdog';

let runs;
try {
  runs = JSON.parse(readFileSync(args.runs, 'utf8'));
} catch (e) {
  fail(`cannot read --runs ${args.runs}: ${String(e.message ?? e)}`);
}
if (!Array.isArray(runs)) fail('--runs must hold a JSON array of runs');

// slotOf(t): the newest cron instant at or before t (UTC — scheduled runs
// and run timestamps are both UTC).
function slotOf(at) {
  const slot = new Date(at);
  slot.setUTCSeconds(0, 0);
  if (slot.getUTCMinutes() >= cronMinute) {
    slot.setUTCMinutes(cronMinute);
  } else {
    slot.setUTCMinutes(cronMinute);
    slot.setUTCHours(slot.getUTCHours() - 1);
  }
  return slot.getTime();
}

const now = args.now ? new Date(args.now).getTime() : Date.now();
if (Number.isNaN(now)) fail(`--now ${args.now} is not a date`);

const currentRunId = args['current-run-id'] ? Number(args['current-run-id']) : null;
let current = (currentRunId !== null && runs.find((r) => r.databaseId === currentRunId)) || null;
let currentSource = 'by-id';
if (!current) {
  // The id is absent from the fetched window (a busy hour, a short limit):
  // the newest run in the list is this lane's newest fact either way.
  current = [...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null;
  currentSource = 'newest-fallback';
}

const others = runs
  .filter((r) => r !== current)
  .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
const previous = others[0] ?? null;

const currentSlot = current ? slotOf(new Date(current.createdAt)) : slotOf(new Date(now));
const previousSlot = previous ? slotOf(new Date(previous.createdAt)) : null;
const hourMs = 60 * 60 * 1000;
const missedSlots =
  previousSlot === null ? 0 : Math.max(0, Math.round((currentSlot - previousSlot) / hourMs) - 1);

// The textfile is owned by probe-runner.mjs during the probe phase; this
// appends the lane-level series after it, in the same format.
appendFileSync(
  args.textfile,
  [
    '# TYPE probe_missed_slots gauge',
    `probe_missed_slots{workflow="${workflowLabel}"} ${missedSlots}`,
  ].join('\n') + '\n',
);

writeFileSync(
  args.evidence,
  JSON.stringify(
    {
      computed_at: new Date(now).toISOString(),
      workflow: workflowLabel,
      cron,
      current_run_id: current?.databaseId ?? null,
      current_run_source: current ? currentSource : 'none',
      current_slot: new Date(currentSlot).toISOString(),
      previous_run_id: previous?.databaseId ?? null,
      previous_run_created_at: previous?.createdAt ?? null,
      previous_run_conclusion: previous?.conclusion ?? null,
      missed_slots: missedSlots,
    },
    null,
    2,
  ) + '\n',
);

console.log(
  `probe_missed_slots{workflow="${workflowLabel}"} ${missedSlots}` +
    (previous
      ? ` (previous run ${previous.databaseId} at ${previous.createdAt})`
      : ' (no previous run)'),
);
