/**
 * LogSheet — log an entry standing at the unit, without leaving the screen.
 *
 * The v4 design's central interaction. Pick a unit, pick a type, enter a number,
 * hold to save. The sheet keeps the unit list or unit detail visible underneath,
 * so the worker can see what they are logging against while they log it.
 *
 * SCOPE, and why it is four types rather than the design's six:
 *
 * Mortality, cull, water quality and transfer all reduce to "a quantity (or a
 * set of readings) against a unit", which is exactly the shape this sheet is.
 * Harvest and feeding do not, and forcing them in would have meant shaping
 * irreversible farm records through a form that does not fit them:
 *
 *   - HARVEST needs five required fields (quantity, average weight, total
 *     biomass, quality class, harvest date). It is a form, not a number.
 *   - FEEDING is not a "type a number" flow at all: it is meal-centric, driven
 *     by `feedingDayPlans` with per-meal SCHEDULED / FED / PARTIALLY_FED /
 *     SKIPPED / MISSED state. Re-expressing that here would put the day-plan
 *     logic in a second place and let the two drift.
 *
 * Both keep their full pages. This is the approved "fast types in the sheet,
 * complex ones stay pages" split — reading the payloads is what moved harvest
 * and feeding across the line.
 *
 * NO NEW BACKEND CONTRACT. Every type enqueues through the same
 * `useOfflineQueue.addToQueue(operationType, payload)` path its page already
 * used, so the command envelope, payload hash and at-most-once dedup
 * (`farm_mobile_command_receipts`) are unchanged.
 */
import { ArrowLeftRight, Check, Droplets, QrCode, Scissors, Skull } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  Button,
  Card,
  Chip,
  EmptyState,
  HoldToConfirm,
  NumPad,
  Sheet,
  TypeTile,
} from '@/components/ui';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { useTanks } from '@/hooks/useTanks';
import type {
  AddToQueueResult,
  CullInput,
  CullReason,
  MortalityInput,
  MortalityReason,
  OperationType,
  Tank,
  TransferInput,
  CreateWaterQualityInput,
} from '@/types';
import { useFeatureAccess } from '@/utils/feature-access';

/** The four types this sheet covers. */
export type SheetType = 'mortality' | 'cull' | 'water' | 'transfer';

interface TypeMeta {
  type: SheetType;
  label: string;
  title: string;
  feature: 'mortality' | 'cull' | 'waterQuality' | 'transfer';
  operation: OperationType;
  icon: ReactElement;
  /** Field label above the numpad value. */
  field: string;
  unit: string;
  /** Quick-add chips beside the numpad. */
  chips: number[];
  /** Whole numbers only (fish counts) hide the decimal key. */
  integer: boolean;
}

const TYPES: TypeMeta[] = [
  {
    type: 'mortality',
    label: 'Mort',
    title: 'Record mortality',
    feature: 'mortality',
    operation: 'recordMortality',
    icon: <Skull size={17} />,
    field: 'Count',
    unit: 'fish',
    chips: [1, 5, 10, 25],
    integer: true,
  },
  {
    type: 'cull',
    label: 'Cull',
    title: 'Record cull',
    feature: 'cull',
    operation: 'recordCull',
    icon: <Scissors size={17} />,
    field: 'Fish culled',
    unit: 'fish',
    chips: [1, 5, 10, 25],
    integer: true,
  },
  {
    type: 'water',
    label: 'Water',
    title: 'Water reading',
    feature: 'waterQuality',
    operation: 'createWaterQuality',
    icon: <Droplets size={17} />,
    field: 'Dissolved oxygen',
    unit: 'mg/L',
    chips: [],
    integer: false,
  },
  {
    type: 'transfer',
    label: 'Move',
    title: 'Record transfer',
    feature: 'transfer',
    operation: 'recordTransfer',
    icon: <ArrowLeftRight size={17} />,
    field: 'Fish moved',
    unit: 'fish',
    chips: [500, 1000, 2500, 5000],
    integer: true,
  },
];

/** Total lookup, so selecting a type can never fall back to the wrong meta. */
const TYPE_BY_KEY: Record<SheetType, TypeMeta> = Object.fromEntries(
  TYPES.map((t) => [t.type, t]),
) as Record<SheetType, TypeMeta>;

const MORTALITY_REASONS: Array<{ value: MortalityReason; label: string }> = [
  { value: 'WATER_QUALITY', label: 'Water quality' },
  { value: 'DISEASE', label: 'Disease' },
  { value: 'HANDLING', label: 'Handling' },
  { value: 'OXYGEN', label: 'Low oxygen' },
  { value: 'TEMPERATURE', label: 'Temperature' },
  { value: 'PREDATION', label: 'Predation' },
  { value: 'UNKNOWN', label: 'Unknown' },
];

const CULL_REASONS: Array<{ value: CullReason; label: string }> = [
  { value: 'POOR_GROWTH', label: 'Poor growth' },
  { value: 'DEFORMED', label: 'Deformity' },
  { value: 'SICK', label: 'Sick' },
  { value: 'SMALL_SIZE', label: 'Small size' },
  { value: 'GRADING', label: 'Grading' },
  { value: 'OTHER', label: 'Other' },
];

const TRANSFER_REASONS = ['Grading by size', 'Density relief', 'Health separation'];

/** Water parameters the sheet captures, mapped onto WaterQualityParameters. */
const WQ_PARAMS = [
  { key: 'dissolvedOxygen', label: 'Dissolved oxygen', unit: 'mg/L' },
  { key: 'temperature', label: 'Temperature', unit: '°C' },
  { key: 'pH', label: 'pH', unit: '' },
  { key: 'salinity', label: 'Salinity', unit: 'ppt' },
] as const;

type WqKey = (typeof WQ_PARAMS)[number]['key'];

/** Everything the submit gate needs, so it can be reasoned about and tested. */
export interface SubmitGateInput {
  type: SheetType;
  tank: Tank | undefined;
  qty: string;
  destTankId: string;
  reason: string;
  wqEnteredCount: number;
  integer: boolean;
}

/**
 * The submit gate — returns the reason saving is blocked, or null when the
 * entry is complete.
 *
 * Extracted as a pure function because it is the safety-critical part of this
 * screen. Every branch is a REAL requirement of the payload the backend
 * accepts; letting an incomplete record through would queue something that
 * fails on replay hours later, offline, with nobody watching. The stock ceiling
 * is here for the same reason — a fat-fingered mortality of 900000 against a
 * pen holding 92400 is a data-integrity event, not a validation nicety.
 */
export function submitBlocker({
  type,
  tank,
  qty,
  destTankId,
  reason,
  wqEnteredCount,
  integer,
}: SubmitGateInput): string | null {
  if (!tank) return 'Choose a unit';
  if (!tank.batchMetrics?.batchId) return 'This unit has no stocked batch';

  if (type === 'water') {
    return wqEnteredCount > 0 ? null : 'Enter at least one reading';
  }

  const numeric = Number(qty);
  if (qty.trim() === '' || Number.isNaN(numeric) || numeric <= 0) return 'Enter a quantity';
  if (integer && !Number.isInteger(numeric)) return 'Whole fish only';

  if (type === 'transfer') {
    if (!destTankId) return 'Choose a destination unit';
    if (destTankId === tank.id) return 'Destination must differ from source';
  }

  if ((type === 'mortality' || type === 'cull') && !reason) return 'Choose a reason';

  const stock = tank.batchMetrics.pieces ?? 0;
  if (stock > 0 && numeric > stock) {
    return `Only ${stock.toLocaleString()} fish in this unit`;
  }
  return null;
}

export interface LogSheetProps {
  open: boolean;
  onClose: () => void;
  /** Pre-selected unit — set when opened from a unit detail or a scan. */
  initialTankId?: string;
  /** Pre-selected type — set when opened from a shortcut or a deep link. */
  initialType?: SheetType;
}

export function LogSheet({
  open,
  onClose,
  initialTankId,
  initialType,
}: LogSheetProps): ReactElement | null {
  const navigate = useNavigate();
  const { data: tanks } = useTanks();
  const { addToQueue, isOnline } = useOfflineQueue();
  const { canReach } = useFeatureAccess();

  const available = useMemo(() => TYPES.filter((t) => canReach(t.feature)), [canReach]);

  const [type, setType] = useState<SheetType>(initialType ?? available[0]?.type ?? 'mortality');
  const [tankId, setTankId] = useState<string>(initialTankId ?? '');
  const [destTankId, setDestTankId] = useState<string>('');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState<string>('');
  const [wq, setWq] = useState<Record<WqKey, string>>({
    dissolvedOxygen: '',
    temperature: '',
    pH: '',
    salinity: '',
  });
  const [receipt, setReceipt] = useState<{ id: string; duplicate: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-seed when the sheet is opened from a new context (a different unit, a
  // different shortcut). Resetting on every render would fight the user's typing.
  useEffect(() => {
    if (!open) return;
    setTankId(initialTankId ?? '');
    if (initialType) setType(initialType);
    setQty('');
    setReason('');
    setDestTankId('');
    setWq({ dissolvedOxygen: '', temperature: '', pH: '', salinity: '' });
    setReceipt(null);
    setError(null);
  }, [open, initialTankId, initialType]);

  // Permissions resolve asynchronously, so the first render can compute an
  // `available` list that does not yet contain the seeded type. Falling back to
  // the first reachable type keeps the sheet from titling — and submitting —
  // an entry the worker is not allowed to make.
  const effectiveType: SheetType = available.some((t) => t.type === type)
    ? type
    : (available[0]?.type ?? type);
  const meta = TYPE_BY_KEY[effectiveType];
  const stocked = (tanks ?? []).filter((t) => t.batchMetrics?.batchId);
  const tank = stocked.find((t) => t.id === tankId);

  const reasons: Array<{ value: string; label: string }> =
    effectiveType === 'mortality'
      ? MORTALITY_REASONS
      : effectiveType === 'cull'
        ? CULL_REASONS
        : effectiveType === 'transfer'
          ? TRANSFER_REASONS.map((r) => ({ value: r, label: r }))
          : [];

  const numeric = Number(qty);
  const wqEntered = WQ_PARAMS.filter(
    (p) => wq[p.key].trim() !== '' && !Number.isNaN(Number(wq[p.key])),
  );

  const blocker = submitBlocker({
    type: effectiveType,
    tank,
    qty,
    destTankId,
    reason,
    wqEnteredCount: wqEntered.length,
    integer: meta.integer,
  });

  async function submit(): Promise<void> {
    if (blocker || !tank?.batchMetrics?.batchId) return;
    const batchId = tank.batchMetrics.batchId;
    setError(null);
    try {
      let result: AddToQueueResult;
      if (effectiveType === 'mortality') {
        const payload: MortalityInput = {
          batchId,
          tankId: tank.id,
          quantity: numeric,
          reason: reason as MortalityReason,
          observedAt: new Date().toISOString(),
        };
        result = await addToQueue('recordMortality', payload);
      } else if (effectiveType === 'cull') {
        const payload: CullInput = {
          batchId,
          tankId: tank.id,
          quantity: numeric,
          reason: reason as CullReason,
          culledAt: new Date().toISOString(),
        };
        result = await addToQueue('recordCull', payload);
      } else if (effectiveType === 'transfer') {
        const payload: TransferInput = {
          batchId,
          sourceTankId: tank.id,
          destinationTankId: destTankId,
          quantity: numeric,
          transferReason: reason || undefined,
          transferredAt: new Date().toISOString(),
        };
        result = await addToQueue('recordTransfer', payload);
      } else {
        const parameters: Record<string, number> = {};
        for (const p of wqEntered) parameters[p.key] = Number(wq[p.key]);
        const payload: CreateWaterQualityInput = {
          tankId: tank.id,
          batchId,
          measuredAt: new Date().toISOString(),
          // Typed by hand on this screen — a sensor value would arrive through
          // the ingestion path, never through a worker's numpad.
          source: 'MANUAL',
          parameters,
        };
        result = await addToQueue('createWaterQuality', payload);
      }
      // FE-HIGH-050: addToQueue returns a DISCRIMINATED result. `duplicate`
      // means the at-most-once ledger already holds this command — telling the
      // worker "saved" for a second time would invite them to log it again.
      setReceipt({ id: result.id, duplicate: result.status === 'duplicate' });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save this entry');
    }
  }

  if (!open) return null;

  if (available.length === 0) {
    return (
      <Sheet open={open} onClose={onClose} title="Log entry">
        <EmptyState
          title="No log types available"
          description="Your role does not include any of the entry types this sheet covers."
        />
      </Sheet>
    );
  }

  // ── Receipt ──────────────────────────────────────────────────────────────
  if (receipt) {
    return (
      <Sheet open={open} onClose={onClose} title="Saved">
        <div className="px-5 pb-6 flex flex-col gap-4">
          <div className="flex items-center gap-3.5">
            <span className="w-13 h-13 w-[52px] h-[52px] shrink-0 rounded-2xl bg-acc-dim text-acc inline-flex items-center justify-center animate-am-pop">
              <Check size={26} />
            </span>
            <div>
              <div className="text-head font-semibold text-ink-1">
                {receipt.duplicate ? 'Already recorded' : `${meta.title} saved`}
              </div>
              <div className="text-body text-ink-3">
                {receipt.duplicate
                  ? 'This exact entry was already logged — nothing was added.'
                  : isOnline
                    ? 'Sent to the farm.'
                    : 'Held on this device — it will send when there is signal.'}
              </div>
            </div>
          </div>
          <Card tone={2} elevated={false} className="divide-y divide-line">
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-body text-ink-3">Unit</span>
              <span className="text-body font-mono text-ink-1">{tank?.code ?? '—'}</span>
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-body text-ink-3">State</span>
              <span className="text-body font-mono text-acc">
                {receipt.duplicate ? 'DUPLICATE' : isOnline ? 'SENT' : 'QUEUED'}
              </span>
            </div>
          </Card>
          <div className="grid grid-cols-2 gap-2">
            <Button
              onClick={() => {
                setReceipt(null);
                setQty('');
                setReason('');
                setWq({ dissolvedOxygen: '', temperature: '', pH: '', salinity: '' });
              }}
            >
              Log another
            </Button>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      </Sheet>
    );
  }

  // ── Entry ────────────────────────────────────────────────────────────────
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={meta.title}
      footer={
        <div className="flex flex-col gap-2">
          {error !== null && (
            <span className="text-meta text-crit" role="alert">
              {error}
            </span>
          )}
          <span className="text-meta text-ink-3">
            {blocker ??
              (isOnline
                ? 'Sends to the farm immediately.'
                : 'Held on this device until there is signal.')}
          </span>
          <HoldToConfirm onConfirm={() => void submit()} disabled={blocker !== null}>
            {blocker !== null ? blocker : 'Hold to save'}
          </HoldToConfirm>
        </div>
      }
    >
      <div className="flex flex-col gap-4 pb-4">
        {/* Unit picker */}
        <div className="flex gap-2 overflow-x-auto px-5">
          <button
            type="button"
            onClick={() => navigate('/scan')}
            className="shrink-0 h-tap-chip min-h-touch px-3 rounded-xl border border-dashed border-acc bg-acc-dim text-acc inline-flex items-center gap-2 text-meta font-semibold touch-feedback"
          >
            <QrCode size={15} />
            Scan
          </button>
          {stocked.map((t) => (
            <UnitChip
              key={t.id}
              tank={t}
              selected={t.id === tankId}
              onSelect={() => setTankId(t.id)}
            />
          ))}
        </div>

        {/* Type picker — every tile carries its label, so type identity is never
            colour alone (TypeTile requires it). */}
        <div className="grid grid-cols-4 gap-2 px-5">
          {available.map((t) => (
            <TypeTile
              key={t.type}
              type={t.type === 'water' ? 'water' : t.type}
              label={t.label}
              icon={t.icon}
              selected={t.type === effectiveType}
              onSelect={() => {
                setType(t.type);
                setReason('');
                setQty('');
              }}
            />
          ))}
        </div>

        {effectiveType === 'water' ? (
          <div className="px-5 flex flex-col gap-2">
            <span className="text-meta text-ink-3">Parameters · {wqEntered.length} entered</span>
            {WQ_PARAMS.map((p) => (
              <label
                key={p.key}
                className="flex items-center gap-3 bg-surface-1 border border-line rounded-xl px-3 py-2"
              >
                <span className="flex-1 text-body text-ink-2">{p.label}</span>
                <input
                  inputMode="decimal"
                  value={wq[p.key]}
                  onChange={(e) => setWq((s) => ({ ...s, [p.key]: e.target.value }))}
                  placeholder="—"
                  className="w-20 bg-transparent text-right text-title font-mono text-ink-1 outline-none"
                />
                <span className="w-12 text-meta text-ink-3">{p.unit}</span>
              </label>
            ))}
          </div>
        ) : (
          <>
            {/* Value + numpad */}
            <div className="px-5 flex items-end justify-between gap-3 border-t border-line pt-4">
              <div>
                <div className="text-meta text-ink-3 mb-2">{meta.field}</div>
                <div className="flex items-baseline gap-2">
                  <span className="text-hero font-mono font-bold text-ink-1 tabular-nums">
                    {qty || '0'}
                  </span>
                  <span className="text-title text-ink-3">{meta.unit}</span>
                </div>
              </div>
              {tank?.batchMetrics && (
                <div className="text-right">
                  <div className="text-meta text-ink-3 mb-1">Stock in unit</div>
                  <div className="text-body font-mono text-ink-2 tabular-nums">
                    {(tank.batchMetrics.pieces ?? 0).toLocaleString()}
                  </div>
                </div>
              )}
            </div>

            {meta.chips.length > 0 && (
              <div className="px-5 flex gap-2">
                {meta.chips.map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setQty(String((Number(qty) || 0) + n))}
                    className="flex-1 h-tap-add min-h-touch rounded-xl bg-surface-2 border border-line text-title font-mono font-semibold text-ink-1 touch-feedback"
                  >
                    +{n}
                  </button>
                ))}
              </div>
            )}

            <div className="px-5">
              <NumPad value={qty} onChange={setQty} allowDecimal={!meta.integer} />
            </div>
          </>
        )}

        {/* Destination unit — transfer only. */}
        {effectiveType === 'transfer' && (
          <div className="px-5 flex flex-col gap-2">
            <span className="text-meta text-ink-3">Destination unit</span>
            <div className="flex gap-2 overflow-x-auto">
              {stocked
                .filter((t) => t.id !== tankId)
                .map((t) => (
                  <UnitChip
                    key={t.id}
                    tank={t}
                    selected={t.id === destTankId}
                    onSelect={() => setDestTankId(t.id)}
                  />
                ))}
            </div>
          </div>
        )}

        {reasons.length > 0 && (
          <div className="px-5 flex flex-col gap-2">
            <span className="text-meta text-ink-3">
              {effectiveType === 'transfer' ? 'Reason for the move' : 'Cause'}
            </span>
            <div className="flex gap-2 overflow-x-auto">
              {reasons.map((r) => (
                <Chip
                  key={r.value}
                  selected={reason === r.value}
                  onClick={() => setReason(r.value)}
                >
                  {r.label}
                </Chip>
              ))}
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}

function UnitChip({
  tank,
  selected,
  onSelect,
}: {
  tank: Tank;
  selected: boolean;
  onSelect: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`shrink-0 h-tap-chip min-h-touch px-3.5 rounded-xl border flex flex-col items-start justify-center touch-feedback ${
        selected ? 'border-acc bg-acc-dim' : 'border-line bg-surface-1'
      }`}
    >
      <span className={`text-meta font-mono font-semibold ${selected ? 'text-acc' : 'text-ink-1'}`}>
        {tank.code || tank.name}
      </span>
      <span className="text-meta text-ink-3">
        {((tank.batchMetrics?.pieces ?? 0) / 1000).toFixed(0)}k
      </span>
    </button>
  );
}
