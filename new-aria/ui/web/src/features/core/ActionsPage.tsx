import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { ActionRequestControl, ActionResponse, JobResponse } from '../../../../shared/api-contract.ts';
import { getJob, postControl, postCycle, postDoctor, postIntegrityVerify } from '../../api/client.ts';
import { toError } from '../../api/errors.ts';
import { useHealth } from '../../app/HealthProvider.tsx';
import { Badge } from '../../design/Badge.tsx';
import { Callout } from '../../design/Callout.tsx';
import { Card } from '../../design/Card.tsx';
import { KeyValueList } from '../../design/KeyValueList.tsx';
import { MonoPanel } from '../../design/MonoPanel.tsx';
import { PageHeader } from '../../design/PageHeader.tsx';
import { Timestamp } from '../../design/Timestamp.tsx';
import { prettyJson } from '../../design/format.ts';
import { toneForStatus } from './tones.ts';

const JOB_POLL_MS = 2000;

type ActionRun =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly startedAt: string }
  | { readonly kind: 'done'; readonly response: ActionResponse }
  | { readonly kind: 'error'; readonly error: Error };

function ActionResult({ run }: { readonly run: ActionRun }): ReactNode {
  switch (run.kind) {
    case 'idle':
      return <p className="muted">Henüz çalıştırılmadı.</p>;
    case 'running':
      return (
        <p className="muted" role="status">
          Çalışıyor… (<Timestamp value={run.startedAt} />)
        </p>
      );
    case 'error':
      return (
        <Callout tone="danger" role="alert">
          <span className="mono">{run.error.message}</span>
        </Callout>
      );
    case 'done': {
      const response = run.response;
      return (
        <div className="stack">
          <div className="row">
            <Badge tone={response.ok ? 'success' : 'danger'}>{response.ok ? 'ok' : 'failed'}</Badge>
            <span className="mono">exit {response.exitCode ?? 'null'}</span>
            <span className="muted">
              <Timestamp value={response.startedAt} /> → <Timestamp value={response.finishedAt} />
            </span>
          </div>
          <MonoPanel label="command" text={response.command.join(' ')} maxHeight="sm" />
          <MonoPanel label="stdout" text={response.stdout} />
          <MonoPanel label="stderr" text={response.stderr} tone={response.stderr.trim() === '' ? 'default' : 'error'} />
          {response.parsed !== null && response.parsed !== undefined ? <MonoPanel label="parsed" text={prettyJson(response.parsed)} /> : null}
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
        subtitle="aria-kernel doctor — salt-okunur organ kontrolü"
        actions={
          <button type="button" className="button button--primary" onClick={doctor.trigger} disabled={doctor.run.kind === 'running'}>
            Çalıştır
          </button>
        }
      >
        <ActionResult run={doctor.run} />
      </Card>
      <Card
        title="Integrity verify"
        subtitle="aria-kernel integrity verify — hash zinciri doğrulaması"
        actions={
          <button type="button" className="button button--primary" onClick={integrity.trigger} disabled={integrity.run.kind === 'running'}>
            Çalıştır
          </button>
        }
      >
        <ActionResult run={integrity.run} />
      </Card>
    </div>
  );
}

function ControlAction(): ReactNode {
  const [verb, setVerb] = useState<ActionRequestControl['verb']>('pause');
  const [reason, setReason] = useState('');
  const [armed, setArmed] = useState(false);
  const control = useAction(() => postControl({ verb, reason: reason.trim() }));
  const canSubmit = armed && reason.trim().length >= 5 && control.run.kind !== 'running';

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    control.trigger();
    setArmed(false);
  };

  return (
    <Card title="Control" subtitle="aria-kernel control pause|resume — çekirdeğin döngü kapısını değiştirir">
      <form className="stack" onSubmit={handleSubmit}>
        <div className="toolbar">
          <label className="field" htmlFor="control-verb">
            <span>verb</span>
            <select id="control-verb" value={verb} onChange={(event) => setVerb(event.target.value === 'resume' ? 'resume' : 'pause')}>
              <option value="pause">pause</option>
              <option value="resume">resume</option>
            </select>
          </label>
          <label className="field" htmlFor="control-reason">
            <span>reason (ledger'a yazılır, en az 5 karakter)</span>
            <textarea id="control-reason" value={reason} onChange={(event) => setReason(event.target.value)} required minLength={5} />
          </label>
        </div>
        <label className="field field--inline" htmlFor="control-armed">
          <input id="control-armed" type="checkbox" checked={armed} onChange={(event) => setArmed(event.target.checked)} />
          <span>
            Bu eylemin çekirdeğin çalışma durumunu <strong>{verb}</strong> olarak değiştireceğini ve control/commands.jsonl'a kalıcı yazılacağını anlıyorum.
          </span>
        </label>
        <div>
          <button type="submit" className={`button ${verb === 'pause' ? 'button--danger' : 'button--primary'}`} disabled={!canSubmit}>
            {verb === 'pause' ? 'Duraklat (pause)' : 'Devam ettir (resume)'}
          </button>
        </div>
      </form>
      <div className="stack">
        <ActionResult run={control.run} />
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
    <div className="stack">
      <div className="row">
        <Badge tone={toneForStatus(job.state)}>{job.state}</Badge>
        <span className="mono">job {job.jobId}</span>
        {job.exitCode !== null ? <span className="mono">exit {job.exitCode}</span> : null}
        <span className="muted">
          <Timestamp value={job.startedAt} /> → {job.finishedAt === null ? '…' : <Timestamp value={job.finishedAt} />}
        </span>
        {!terminal ? (
          <span className="muted" role="status">
            her {JOB_POLL_MS / 1000} sn'de yenileniyor
          </span>
        ) : null}
      </div>
      <MonoPanel label="command" text={job.command.join(' ')} maxHeight="sm" />
      <MonoPanel label="stdout (kuyruk)" text={job.stdoutTail} />
      <MonoPanel label="stderr (kuyruk)" text={job.stderrTail} tone={job.stderrTail.trim() === '' ? 'default' : 'error'} />
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
    <Card title="Cycle run" subtitle="aria-kernel cycle run — arka plan işi; durum jobs/:jobId üzerinden izlenir">
      <form className="stack" onSubmit={handleSubmit}>
        <div className="toolbar">
          <label className="field" htmlFor="cycle-id">
            <span>cycleId (boş bırakılırsa çekirdek üretir)</span>
            <input id="cycle-id" type="text" value={cycleId} onChange={(event) => setCycleId(event.target.value)} autoComplete="off" spellCheck={false} />
          </label>
          <label className="field field--inline" htmlFor="cycle-discovery-only">
            <input id="cycle-discovery-only" type="checkbox" checked={discoveryOnly} onChange={(event) => setDiscoveryOnly(event.target.checked)} />
            <span>discoveryOnly</span>
          </label>
        </div>
        <label className="field field--inline" htmlFor="cycle-armed">
          <input id="cycle-armed" type="checkbox" checked={armed} onChange={(event) => setArmed(event.target.checked)} />
          <span>Yeni bir döngünün ledger'lara yazacağını anlıyorum.</span>
        </label>
        <div>
          <button type="submit" className="button button--primary" disabled={!armed || run.kind === 'submitting'}>
            Döngüyü başlat
          </button>
        </div>
      </form>
      <div className="stack">
        {run.kind === 'idle' ? <p className="muted">Henüz iş gönderilmedi.</p> : null}
        {run.kind === 'submitting' ? (
          <p className="muted" role="status">
            İş gönderiliyor…
          </p>
        ) : null}
        {run.kind === 'error' ? (
          <Callout tone="danger" role="alert">
            <span className="mono">{run.error.message}</span>
          </Callout>
        ) : null}
        {run.kind === 'tracking' ? <JobPanel job={run.job} /> : null}
      </div>
    </Card>
  );
}

export function ActionsPage(): ReactNode {
  const health = useHealth();
  return (
    <>
      <PageHeader
        title="Eylemler"
        subtitle="Her eylem sunucuda kernel CLI'yı çalıştırır; konsol yalnızca çıktıyı gösterir."
      />
      <div className="stack">
        <ReadOnlyActions />
        {health.state.status === 'loading' ? <p className="muted">Eylem izinleri sorgulanıyor…</p> : null}
        {health.state.status === 'error' ? (
          <Callout tone="warning" title="Sağlık ucu okunamadı">
            Mutasyon eylemleri, <code>actionsEnabled</code> doğrulanamadığı için gizlendi.
          </Callout>
        ) : null}
        {health.state.status === 'success' && !health.actionsEnabled ? (
          <Callout tone="neutral" title="Mutasyon eylemleri kapalı">
            Sunucu <code>ARIA_UI_ALLOW_ACTIONS=1</code> ile başlatılmadı; <code>control</code> ve <code>cycle run</code> bu konsoldan çalıştırılamaz.
          </Callout>
        ) : null}
        {health.actionsEnabled ? (
          <>
            <Callout tone="warning" title="Mutasyon eylemleri açık">
              Aşağıdaki eylemler çekirdeğin durumunu değiştirir ve ledger'lara kalıcı yazar.
            </Callout>
            <div className="grid-2">
              <ControlAction />
              <CycleAction />
            </div>
          </>
        ) : null}
        <Card title="Sözleşme" subtitle="ActionResponse / JobResponse alanları">
          <KeyValueList
            data={{
              'actions/doctor': 'POST → ActionResponse (her zaman)',
              'actions/integrity-verify': 'POST → ActionResponse (her zaman)',
              'actions/control': 'POST {verb, reason} → ActionResponse (actionsEnabled)',
              'actions/cycle': 'POST {cycleId?, discoveryOnly?} → JobResponse (actionsEnabled)',
              'jobs/:jobId': 'GET → JobResponse (queued|running|succeeded|failed)',
            }}
          />
        </Card>
      </div>
    </>
  );
}
