// The only screen that makes the kernel do something.
//
// WHY: two of these actions read (doctor, integrity verify) and two of them
// write to the kernel's own ledgers (control, cycle run). The write actions must
// be impossible to reach unless the server itself reports actionsEnabled, and
// the operator must see, before running anything, which class of action this
// console is currently permitted to perform — so the permission state is the
// first thing on the page, above the controls it governs. WHAT: each action
// posts to the API, and the console shows the command, exit code and streams
// verbatim; a cycle run is a background job whose state is polled until it ends.
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { ActionRequestControl, ActionResponse, JobResponse } from '../../../../shared/api-contract.ts';
import { getJob, postControl, postCycle, postDoctor, postIntegrityVerify } from '../../api/client.ts';
import { toError } from '../../api/errors.ts';
import { useHealth } from '../../app/HealthProvider.tsx';
import { LoadingBlock } from '../../design/AsyncState.tsx';
import { Badge } from '../../design/Badge.tsx';
import { Callout } from '../../design/Callout.tsx';
import { Card } from '../../design/Card.tsx';
import { KeyValueList } from '../../design/KeyValueList.tsx';
import { MonoPanel } from '../../design/MonoPanel.tsx';
import { PageHeader } from '../../design/PageHeader.tsx';
import { Timestamp } from '../../design/Timestamp.tsx';
import { formatDuration, parseIso, prettyJson } from '../../design/format.ts';
import { glossForProfile, toneForProfile, toneForStatus } from './tones.ts';

const JOB_POLL_MS = 2000;
/** A reason short enough to be meaningless is not evidence, so the form refuses it. */
const MIN_REASON_LENGTH = 5;

type ActionRun =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly startedAt: string }
  | { readonly kind: 'done'; readonly response: ActionResponse }
  | { readonly kind: 'error'; readonly error: Error };

/** Wall-clock duration of a finished run, in seconds, or null while it is open. */
function elapsedSeconds(startedAt: string | null, finishedAt: string | null): number | null {
  const start = parseIso(startedAt);
  const end = parseIso(finishedAt);
  if (start === null || end === null) {
    return null;
  }
  return (end.getTime() - start.getTime()) / 1000;
}

function RunDuration({ startedAt, finishedAt }: { readonly startedAt: string | null; readonly finishedAt: string | null }): ReactNode {
  const seconds = elapsedSeconds(startedAt, finishedAt);
  if (seconds === null) {
    return null;
  }
  return (
    <span className="muted tnum">
      Duration <span className="mono">{formatDuration(seconds)}</span>
    </span>
  );
}

function ActionResult({ run, label }: { readonly run: ActionRun; readonly label: string }): ReactNode {
  switch (run.kind) {
    case 'idle':
      return <p className="muted">{label} has not been run from this console yet.</p>;
    case 'running':
      return (
        <p className="muted" role="status">
          Running since <Timestamp value={run.startedAt} />
        </p>
      );
    case 'error':
      return (
        <Callout tone="danger" role="alert" title={`${label} could not be started`}>
          <span className="mono">{run.error.message}</span>
        </Callout>
      );
    case 'done': {
      const response = run.response;
      return (
        <div className="stack stack--tight">
          <div className="row">
            <Badge tone={response.ok ? 'success' : 'danger'} title={response.ok ? 'The command exited successfully' : 'The command exited with a failure'}>
              {response.ok ? 'ok' : 'failed'}
            </Badge>
            <span className="mono tnum" title="Process exit code">
              exit {response.exitCode ?? 'null'}
            </span>
            <RunDuration startedAt={response.startedAt} finishedAt={response.finishedAt} />
            <span className="muted">
              <Timestamp value={response.finishedAt} />
            </span>
          </div>
          <MonoPanel label="Command" text={response.command.join(' ')} maxHeight="sm" />
          <MonoPanel label="stdout" text={response.stdout} />
          <MonoPanel label="stderr" text={response.stderr} tone={response.stderr.trim() === '' ? 'default' : 'error'} />
          {response.parsed !== null && response.parsed !== undefined ? <MonoPanel label="Parsed result" text={prettyJson(response.parsed)} /> : null}
        </div>
      );
    }
    default:
      return null;
  }
}

function useAction(execute: () => Promise<ActionResponse>): { readonly run: ActionRun; readonly trigger: () => void } {
  const [run, setRun] = useState<ActionRun>({ kind: 'idle' });
  const trigger = (): void => {
    setRun({ kind: 'running', startedAt: new Date().toISOString() });
    execute()
      .then((response) => setRun({ kind: 'done', response }))
      .catch((reason: unknown) => setRun({ kind: 'error', error: toError(reason) }));
  };
  return { run, trigger };
}

function ReadOnlyActions(): ReactNode {
  const doctor = useAction(postDoctor);
  const integrity = useAction(postIntegrityVerify);
  return (
    <div className="grid-2">
      <Card
        title="Doctor"
        subtitle="aria-kernel doctor — reads every organ and writes nothing"
        actions={
          <button type="button" className="button button--primary" onClick={doctor.trigger} disabled={doctor.run.kind === 'running'}>
            Run
          </button>
        }
      >
        <ActionResult run={doctor.run} label="Doctor" />
      </Card>
      <Card
        title="Integrity verify"
        subtitle="aria-kernel integrity verify — re-walks the ledger hash chains"
        actions={
          <button type="button" className="button button--primary" onClick={integrity.trigger} disabled={integrity.run.kind === 'running'}>
            Verify
          </button>
        }
      >
        <ActionResult run={integrity.run} label="Integrity verify" />
      </Card>
    </div>
  );
}

function ControlAction(): ReactNode {
  const [verb, setVerb] = useState<ActionRequestControl['verb']>('pause');
  const [reason, setReason] = useState('');
  const [armed, setArmed] = useState(false);
  const control = useAction(() => postControl({ verb, reason: reason.trim() }));
  const canSubmit = armed && reason.trim().length >= MIN_REASON_LENGTH && control.run.kind !== 'running';

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    control.trigger();
    setArmed(false);
  };

  return (
    <Card title="Control" subtitle="aria-kernel control pause|resume — opens or closes the kernel's cycle gate">
      <form className="stack" onSubmit={handleSubmit}>
        <div className="toolbar">
          <label className="field" htmlFor="control-verb">
            {/* The verb is the kernel's own word and is sent unchanged. */}
            <span>Verb</span>
            <select id="control-verb" value={verb} onChange={(event) => setVerb(event.target.value === 'resume' ? 'resume' : 'pause')}>
              <option value="pause">pause</option>
              <option value="resume">resume</option>
            </select>
          </label>
          <label className="field" htmlFor="control-reason">
            <span>Reason (appended to control/commands.jsonl, at least {MIN_REASON_LENGTH} characters)</span>
            <textarea id="control-reason" value={reason} onChange={(event) => setReason(event.target.value)} required minLength={MIN_REASON_LENGTH} />
          </label>
        </div>
        <label className="field field--inline" htmlFor="control-armed">
          <input id="control-armed" type="checkbox" checked={armed} onChange={(event) => setArmed(event.target.checked)} />
          <span>
            I understand this sets the kernel run state to <strong className="mono">{verb}</strong> and is written permanently to control/commands.jsonl.
          </span>
        </label>
        <div>
          <button type="submit" className={`button ${verb === 'pause' ? 'button--danger' : 'button--primary'}`} disabled={!canSubmit}>
            {verb === 'pause' ? 'Pause' : 'Resume'}
          </button>
        </div>
      </form>
      <div className="stack">
        <ActionResult run={control.run} label="Control" />
      </div>
    </Card>
  );
}

type JobRun =
  | { readonly kind: 'idle' }
  | { readonly kind: 'submitting' }
  | { readonly kind: 'tracking'; readonly job: JobResponse }
  | { readonly kind: 'error'; readonly error: Error };

function JobPanel({ job }: { readonly job: JobResponse }): ReactNode {
  const terminal = job.state === 'succeeded' || job.state === 'failed';
  return (
    <div className="stack stack--tight">
      <div className="row">
        {/* job.state is a kernel value (queued|running|succeeded|failed) and renders verbatim. */}
        <Badge tone={toneForStatus(job.state)} title="State of the background job, as the server reports it">
          {job.state}
        </Badge>
        <span className="mono" title="Job identifier">
          job {job.jobId}
        </span>
        {job.exitCode !== null ? (
          <span className="mono tnum" title="Process exit code">
            exit {job.exitCode}
          </span>
        ) : null}
        <RunDuration startedAt={job.startedAt} finishedAt={job.finishedAt} />
        <span className="muted">
          Started <Timestamp value={job.startedAt} />
        </span>
        {!terminal ? (
          <span className="muted tnum" role="status">
            Refreshing every {formatDuration(JOB_POLL_MS / 1000)}
          </span>
        ) : null}
      </div>
      <MonoPanel label="Command" text={job.command.join(' ')} maxHeight="sm" />
      <MonoPanel label="stdout (tail)" text={job.stdoutTail} />
      <MonoPanel label="stderr (tail)" text={job.stderrTail} tone={job.stderrTail.trim() === '' ? 'default' : 'error'} />
    </div>
  );
}

function CycleAction(): ReactNode {
  const [cycleId, setCycleId] = useState('');
  const [discoveryOnly, setDiscoveryOnly] = useState(false);
  const [armed, setArmed] = useState(false);
  const [run, setRun] = useState<JobRun>({ kind: 'idle' });
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (run.kind !== 'tracking' || run.job.state === 'succeeded' || run.job.state === 'failed') {
      return;
    }
    const controller = new AbortController();
    pollTimer.current = setTimeout(() => {
      getJob(run.job.jobId, controller.signal)
        .then((job) => setRun({ kind: 'tracking', job }))
        .catch((reason: unknown) => {
          if (!controller.signal.aborted) {
            setRun({ kind: 'error', error: toError(reason) });
          }
        });
    }, JOB_POLL_MS);
    return () => {
      controller.abort();
      if (pollTimer.current !== null) {
        clearTimeout(pollTimer.current);
      }
    };
  }, [run]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!armed || run.kind === 'submitting') {
      return;
    }
    setRun({ kind: 'submitting' });
    setArmed(false);
    const body = {
      ...(cycleId.trim() === '' ? {} : { cycleId: cycleId.trim() }),
      ...(discoveryOnly ? { discoveryOnly: true } : {}),
    };
    postCycle(body)
      .then((job) => setRun({ kind: 'tracking', job }))
      .catch((reason: unknown) => setRun({ kind: 'error', error: toError(reason) }));
  };

  return (
    <Card title="Cycle run" subtitle="aria-kernel cycle run — a background job; its state is polled from jobs/:jobId">
      <form className="stack" onSubmit={handleSubmit}>
        <div className="toolbar">
          <label className="field" htmlFor="cycle-id">
            <span>cycleId (the kernel generates one when this is empty)</span>
            <input id="cycle-id" type="text" value={cycleId} onChange={(event) => setCycleId(event.target.value)} autoComplete="off" spellCheck={false} />
          </label>
          <label className="field field--inline" htmlFor="cycle-discovery-only">
            <input id="cycle-discovery-only" type="checkbox" checked={discoveryOnly} onChange={(event) => setDiscoveryOnly(event.target.checked)} />
            <span>
              <span className="mono">discoveryOnly</span> — discover, apply nothing
            </span>
          </label>
        </div>
        <label className="field field--inline" htmlFor="cycle-armed">
          <input id="cycle-armed" type="checkbox" checked={armed} onChange={(event) => setArmed(event.target.checked)} />
          <span>I understand a new cycle writes to the ledgers.</span>
        </label>
        <div>
          <button type="submit" className="button button--primary" disabled={!armed || run.kind === 'submitting'}>
            Run cycle
          </button>
        </div>
      </form>
      <div className="stack">
        {run.kind === 'idle' ? <p className="muted">No cycle job has been submitted from this console yet.</p> : null}
        {run.kind === 'submitting' ? (
          <p className="muted" role="status">
            Submitting the job…
          </p>
        ) : null}
        {run.kind === 'error' ? (
          <Callout tone="danger" role="alert" title="The cycle job could not be tracked">
            <span className="mono">{run.error.message}</span>
          </Callout>
        ) : null}
        {run.kind === 'tracking' ? <JobPanel job={run.job} /> : null}
      </div>
    </Card>
  );
}

/**
 * The permission notice that governs the write actions below it.
 *
 * WHY: whether this console may change kernel state is the first fact the
 * operator needs, and it is a server decision (ARIA_UI_ALLOW_ACTIONS), not a UI
 * preference — so it is stated in words before any control is shown, and the
 * write controls themselves are not rendered at all unless it says yes.
 */
function PermissionNotice(): ReactNode {
  const health = useHealth();
  if (health.state.status === 'loading') {
    return <LoadingBlock label="Reading whether this console may run mutating actions" shape="text" rows={1} />;
  }
  if (health.state.status === 'error') {
    return (
      <Callout tone="warning" title="The health endpoint could not be read">
        <div className="stack stack--tight">
          <p>
            Control and Cycle run stay hidden because <span className="mono">actionsEnabled</span> could not be confirmed.
          </p>
          <div>
            <button type="button" className="button button--sm" onClick={health.reload}>
              Try again
            </button>
          </div>
        </div>
      </Callout>
    );
  }
  if (!health.actionsEnabled) {
    return (
      <Callout tone="neutral" title="Mutating actions are disabled">
        The server was not started with <span className="mono">ARIA_UI_ALLOW_ACTIONS=1</span>, so <span className="mono">control</span> and{' '}
        <span className="mono">cycle run</span> cannot be executed from this console. Doctor and Integrity verify read only and remain available.
      </Callout>
    );
  }
  return (
    <Callout tone="warning" title="Mutating actions are enabled">
      Control and Cycle run change what the kernel does next and append permanently to its ledgers. Doctor and Integrity verify read only.
    </Callout>
  );
}

export function ActionsPage(): ReactNode {
  const health = useHealth();
  return (
    <>
      <PageHeader
        title="Actions"
        subtitle="Every action runs the kernel CLI on the server; this console shows only what that command printed."
        actions={
          health.profile === null ? undefined : (
            <span className="row">
              <span className="label">Profile</span>
              <Badge tone={toneForProfile(health.profile)} title={glossForProfile(health.profile)} mono>
                {health.profile}
              </Badge>
            </span>
          )
        }
      />
      <div className="stack">
        <PermissionNotice />
        <ReadOnlyActions />
        {health.actionsEnabled ? (
          <div className="grid-2">
            <ControlAction />
            <CycleAction />
          </div>
        ) : null}
        <Card title="Endpoints" subtitle="What each control posts, and what the server returns">
          <KeyValueList
            data={{
              'POST /api/v1/actions/doctor': 'ActionResponse — always available, reads only',
              'POST /api/v1/actions/integrity-verify': 'ActionResponse — always available, reads only',
              'POST /api/v1/actions/control': 'ActionResponse — requires actionsEnabled; body {verb, reason}',
              'POST /api/v1/actions/cycle': 'JobResponse — requires actionsEnabled; body {cycleId?, discoveryOnly?}',
              'GET /api/v1/jobs/:jobId': 'JobResponse — job state: queued, running, succeeded or failed',
            }}
          />
        </Card>
      </div>
    </>
  );
}
