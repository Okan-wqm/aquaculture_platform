/**
 * RecordTransferPage — move fish between two units, with a confirm step.
 *
 * ORPHAN-MEDIUM-578: this path is superseded by the log sheet and scheduled for
 * retirement, but it is still routed and still writes real records, so it is
 * converted rather than left looking broken. Deleting a live record path means
 * exercising the sheet against a running backend first — a separate, deliberate
 * step, not a side effect of a restyle.
 *
 * v4 conversion: Konsta's <List>/<ListInput>/<BlockTitle> are gone and the
 * colours moved to the semantic tokens (src/styles/tokens.css). The two are ONE
 * pass, not two: Konsta injected its own `ios-`/`md-` colour classes and its own
 * dark-mode handling into every control on this page, so the page could not be
 * theme-correct while it was still drawing the inputs. The blue gradient chrome
 * was page identity rather than meaning; what identity the screen keeps is the
 * transfer hue from the per-log-type token set, while teal carries the actions,
 * as it does everywhere in v4.
 *
 * Field logic — the queries, the offline-queue call, validation, the payload
 * contract and the step machine — is deliberately UNTOUCHED. The fields are
 * the app's Field primitives (label bound to control, error wired under it).
 */
import { clsx } from 'clsx';
import { ArrowLeftRight, AlertCircle, ChevronRight } from 'lucide-react';
import type { JSX } from 'react';
import { useState, useEffect, ChangeEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { QueuedStatusBadge } from '@/components/QueuedStatusBadge';
import {
  Button,
  Card,
  CardDivider,
  DataState,
  Input,
  PageHeader,
  Select,
  Spinner,
  Textarea,
} from '@/components/ui';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { useTanks } from '@/hooks/useTanks';
import type { QueuedPayload } from '@/types';
import { toLoadable } from '@/utils/loadable';

interface FormErrors {
  sourceTank?: string;
  destinationTank?: string;
  quantity?: string;
  general?: string;
}

// WHY: Confirmation step prevents accidental transfers — moving fish between tanks
// is operationally significant and cannot be easily reversed.
type FormStep = 'entry' | 'confirm';

export function RecordTransferPage(): JSX.Element {
  const navigate = useNavigate();
  const { tankId } = useParams<{ tankId?: string }>();
  const tanksQuery = useTanks();
  const tanks = tanksQuery.data;
  // A failed unit fetch used to render as two empty dropdowns, which reads as
  // "this tenant has no units" — the same defect src/utils/loadable.ts was
  // written for after it was found six times. The Loadable makes the failure a
  // state the selectors cannot be rendered during.
  const tanksLoadable = toLoadable(tanksQuery);
  const { addToQueue, isOnline } = useOfflineQueue();

  const [sourceTankId, setSourceTankId] = useState(tankId || '');
  const [destinationTankId, setDestinationTankId] = useState('');
  const [quantity, setQuantity] = useState('');
  // FARM-MEDIUM-050: the backend TransferBatchInput SSoT is `avgWeightG`
  // (average weight per fish, grams). It computes total biomass itself. We
  // collect avg weight here — NOT total biomass — so the field name and the
  // value semantics both match the backend contract.
  const [avgWeightG, setAvgWeightG] = useState('');
  const [transferReason, setTransferReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  // C7: Track the operationId for two-phase success UX
  const [queuedOperationId, setQueuedOperationId] = useState('');
  const [errors, setErrors] = useState<FormErrors>({});
  const [step, setStep] = useState<FormStep>('entry');

  useEffect(() => {
    if (tankId) setSourceTankId(tankId);
  }, [tankId]);

  const sourceTank = tanks?.find((t) => t.id === sourceTankId);
  const sourceMetrics = sourceTank?.batchMetrics;
  const destTank = tanks?.find((t) => t.id === destinationTankId);

  // FARM-MEDIUM-050: pre-fill average weight from the source batch's known
  // avgWeight (same backend SSoT field surfaced via useTanks). This makes the
  // correct value the zero-effort default — the user only edits it when the
  // transferred sub-population weighs differently from the batch average. We
  // only seed an empty field so a manual override is never clobbered.
  useEffect(() => {
    const batchAvgWeight = sourceMetrics?.avgWeight;
    if (avgWeightG === '' && batchAvgWeight != null && batchAvgWeight > 0) {
      setAvgWeightG(String(batchAvgWeight));
    }
  }, [sourceMetrics, avgWeightG]);

  const validateForm = (): boolean => {
    const newErrors: FormErrors = {};
    if (!sourceTankId) newErrors.sourceTank = 'Please select source tank';
    if (!sourceMetrics) newErrors.sourceTank = 'Selected tank has no active batch';
    if (!destinationTankId) newErrors.destinationTank = 'Please select destination tank';
    if (sourceTankId === destinationTankId)
      newErrors.destinationTank = 'Source and destination tank cannot be the same';
    const qty = parseInt(quantity, 10);
    if (!qty || qty < 1) newErrors.quantity = 'Quantity must be at least 1';
    if (sourceMetrics && qty > (sourceMetrics.pieces ?? 0)) {
      newErrors.quantity = `Quantity cannot exceed ${sourceMetrics.pieces} pieces`;
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleReview = (): void => {
    if (!validateForm()) return;
    setStep('confirm');
  };

  // FARM-MEDIUM-050 (tier-1): the enqueued payload is the wire body for the
  // backend `TransferBatchInput` (useOfflineQueue wraps it as `{ input }`).
  // Binding it to the `TransferInput` SSoT type makes excess-property checking
  // reject any field the backend does not whitelist at COMPILE time — e.g. a
  // re-introduced `biomassKg` becomes a tsc error here, not a runtime 400. This
  // mirrors the buildPayload(): MortalityInput / CullInput pattern on the
  // mortality and cull pages.
  const buildPayload = (batchId: string): QueuedPayload<'recordTransfer'> => ({
    batchId,
    sourceTankId,
    destinationTankId,
    quantity: parseInt(quantity, 10),
    avgWeightG: avgWeightG ? parseFloat(avgWeightG) : undefined,
    transferReason: transferReason.trim() || undefined,
    transferredAt: new Date().toISOString(),
  });

  const handleSubmit = async (): Promise<void> => {
    if (!validateForm()) return;
    if (!sourceMetrics?.batchId) return;

    setIsSubmitting(true);
    setErrors({});

    try {
      // FE-HIGH-050: addToQueue returns a discriminated result; .id tracks the
      // queued (or, on dedup, existing) op for QueuedStatusBadge.
      const { id: opId } = await addToQueue('recordTransfer', buildPayload(sourceMetrics.batchId));

      // C7: Store operationId for QueuedStatusBadge tracking
      setQueuedOperationId(opId);
      setShowSuccess(true);
      setTimeout(() => navigate(-1), 2000);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save transfer';
      setErrors({ general: message });
      setStep('entry');
    } finally {
      setIsSubmitting(false);
    }
  };

  // C7: Two-phase success UX -- show honest sync status via QueuedStatusBadge
  // instead of premature "Saved!" green checkmark. The watch tone (amber before
  // v4, `warn` now) is the point: the record is QUEUED, not confirmed.
  if (showSuccess) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-warn-dim">
        <QueuedStatusBadge operationId={queuedOperationId} />
      </div>
    );
  }

  // WHY: Confirmation screen shows source, destination, and quantity in a clear summary card.
  // This is critical for transfers because wrong tank assignments cause inventory confusion.
  if (step === 'confirm') {
    const qty = parseInt(quantity, 10);
    return (
      // No page tint: the ground is the <body>'s in every theme.
      <div className="min-h-screen">
        <PageHeader icon={ArrowLeftRight} title="Confirm Transfer" back={() => setStep('entry')} />

        <div className="px-4 mt-5">
          <Card className="overflow-hidden">
            <div className="bg-type-transfer-dim p-4 border-b border-line">
              <h2 className="text-body font-bold text-type-transfer uppercase tracking-wider">
                Transfer Summary
              </h2>
            </div>
            <div className="p-4 space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-body text-ink-2">From</span>
                <span className="font-semibold text-ink-1">{sourceTank?.name}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-body text-ink-2">Batch</span>
                <span className="font-semibold text-ink-1">
                  {sourceMetrics?.batchNumber ?? '--'}
                </span>
              </div>
              <div className="flex justify-center">
                <div className="w-8 h-8 rounded-full bg-type-transfer-dim flex items-center justify-center">
                  <ArrowLeftRight size={16} className="text-type-transfer" />
                </div>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-body text-ink-2">To</span>
                <span className="font-semibold text-ink-1">
                  {destTank?.name}
                  {!destTank?.batchMetrics ? ' (Empty)' : ''}
                </span>
              </div>
              <CardDivider />
              <div className="flex justify-between items-center">
                {/* The headline figure is a machine value, so it is set in mono
                    and carries the transfer hue — the same hue the summary
                    heading and the direction glyph wear. */}
                <span className="text-body text-ink-2">Quantity</span>
                <span className="text-head font-mono font-bold tabular-nums text-type-transfer">
                  {qty.toLocaleString()} pcs
                </span>
              </div>
              {avgWeightG && (
                <div className="flex justify-between items-center">
                  <span className="text-body text-ink-2">Avg weight</span>
                  <span className="font-semibold font-mono tabular-nums text-ink-1">
                    {parseFloat(avgWeightG).toFixed(1)} g/fish
                  </span>
                </div>
              )}
              {transferReason.trim() && (
                <>
                  <CardDivider />
                  <div>
                    <span className="text-body text-ink-2">Reason</span>
                    <p className="text-body text-ink-1 mt-1">{transferReason}</p>
                  </div>
                </>
              )}
            </div>
          </Card>
        </div>

        {errors.general && <ErrorBanner message={errors.general} />}

        <div className="px-4 mt-6 space-y-3">
          <Button
            variant="primary"
            size="save"
            block
            onClick={() => {
              void handleSubmit();
            }}
            disabled={isSubmitting}
            className="font-bold"
          >
            {isSubmitting ? (
              <>
                <Spinner size="md" color="inherit" />
                Saving...
              </>
            ) : (
              <>
                <ArrowLeftRight size={20} />
                Confirm Transfer
              </>
            )}
          </Button>
          <Button
            variant="ghost"
            block
            onClick={() => setStep('entry')}
            disabled={isSubmitting}
            className="border border-line"
          >
            Go Back & Edit
          </Button>
          {!isOnline && <OfflineNotice />}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      {/* Header */}
      <PageHeader icon={ArrowLeftRight} title="Transfer Record" />

      {/* Source tank info */}
      {sourceTank && sourceMetrics && (
        <Card className="mx-4 mt-4 p-4">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 bg-type-transfer-dim rounded-xl flex items-center justify-center">
              <ArrowLeftRight className="text-type-transfer" size={22} />
            </div>
            <div>
              <h2 className="font-semibold text-ink-1">{sourceTank.name}</h2>
              <p className="text-body text-ink-3">
                {sourceMetrics.batchNumber ?? '--'} &middot;{' '}
                {(sourceMetrics.pieces ?? 0).toLocaleString()} pcs
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* Error banner */}
      {errors.general && <ErrorBanner message={errors.general} />}

      {/* Tank selectors.
          "Could not read the unit list" and "this tenant has no units" are
          different facts, and a worker about to move fish must not be shown the
          second when the first happened — so the pickers are rendered from the
          Loadable's ready arm only. */}
      <DataState value={tanksLoadable} label="units" skeleton="row" skeletonCount={2}>
        {(unitList) => (
          <>
            {/* Source tank selector */}
            {/* WHY: Source must have an active batch — you can only transfer fish that exist in a batch context */}
            {!tankId && (
              <div className="px-4 mt-5">
                <Select
                  label="Source Tank"
                  value={sourceTankId}
                  onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                    setSourceTankId(e.target.value);
                    setErrors((prev) => ({ ...prev, sourceTank: undefined }));
                  }}
                  error={errors.sourceTank}
                >
                  <option value="">-- Select Tank --</option>
                  {unitList
                    .filter((t) => t.batchMetrics)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} - {t.batchMetrics?.batchNumber ?? '--'}
                      </option>
                    ))}
                  {/* WHY: Show batchless tanks as disabled options with their real ID so users know
                      the tank exists but has no fish to transfer. Using the actual tank ID (not
                      empty string) prevents the browser from treating disabled selection as valid. */}
                  {unitList
                    .filter((t) => !t.batchMetrics)
                    .map((t) => (
                      <option key={t.id} value={t.id} disabled>
                        {t.name} (No active batch)
                      </option>
                    ))}
                </Select>
                {/* FIX: Inform user when all tanks lack active batches — prevents confusion when
                    every dropdown option is disabled and no selection is possible. */}
                {unitList.length > 0 && unitList.every((t) => !t.batchMetrics) && (
                  <Card className="mt-3 p-3 border-warn">
                    <p className="text-warn text-body font-medium">
                      All tanks currently have no active batches.
                    </p>
                    <p className="text-ink-2 text-meta mt-1">
                      Stock fish into a tank before recording transfers.
                    </p>
                  </Card>
                )}
              </div>
            )}

            {/* Destination tank selector */}
            {/* WHY: Destination tanks are sorted — empty tanks first (ideal transfer targets), then tanks with
                batches. The source tank is excluded to prevent self-transfer. Capacity info helps users choose. */}
            <div className="px-4 mt-5">
              <Select
                label="Destination Tank"
                value={destinationTankId}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                  setDestinationTankId(e.target.value);
                  setErrors((prev) => ({ ...prev, destinationTank: undefined }));
                }}
                error={errors.destinationTank}
              >
                <option value="">-- Select Tank --</option>
                {/* WHY: Empty tanks appear first — they are the preferred transfer destination (no mixing risk) */}
                {unitList
                  .filter((t) => t.id !== sourceTankId && !t.batchMetrics)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} (Empty{t.maxBiomass > 0 ? ` - ${t.maxBiomass}kg capacity` : ''})
                    </option>
                  ))}
                {/* WHY: Tanks with batches are shown below — user may want to merge batches, but with a clear label */}
                {unitList
                  .filter((t) => t.id !== sourceTankId && t.batchMetrics)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} - {t.batchMetrics?.batchNumber} (
                      {(t.batchMetrics?.pieces ?? 0).toLocaleString()} fish)
                    </option>
                  ))}
              </Select>
            </div>
          </>
        )}
      </DataState>

      {/* Quantity */}
      <div className="px-4 mt-5">
        <Input
          label="Quantity"
          type="number"
          inputMode="numeric"
          placeholder="Number of pieces to transfer"
          value={quantity}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            setQuantity(e.target.value);
            setErrors((prev) => ({ ...prev, quantity: undefined }));
          }}
          error={errors.quantity}
        />
      </div>

      {/* Average weight per fish (grams) */}
      {/* WHY: the backend derives total biomass from quantity x avgWeightG, so we
          ask for average weight, not total biomass. Pre-filled from the source
          batch average; override only if the transferred fish differ in size. */}
      <div className="px-4 mt-5">
        <Input
          label="Average Weight (g/fish) - Optional"
          type="number"
          inputMode="decimal"
          placeholder="Average weight per fish in grams"
          value={avgWeightG}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setAvgWeightG(e.target.value)}
        />
      </div>

      {/* Transfer reason */}
      <div className="px-4 mt-5">
        <Textarea
          label="Transfer Reason (Optional)"
          placeholder="Transfer reason..."
          value={transferReason}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setTransferReason(e.target.value)}
          textareaClassName="h-20 resize-none"
        />
      </div>

      {/* WHY: "Review" button triggers confirmation step — transfer operations affect two tanks simultaneously */}
      <div className="px-4 pt-5">
        <Button
          variant="primary"
          size="save"
          block
          onClick={handleReview}
          disabled={!sourceTankId || !destinationTankId || !quantity}
          className="font-bold"
        >
          <ArrowLeftRight size={20} />
          Review Transfer
          <ChevronRight size={18} className="ml-1" />
        </Button>
        {!isOnline && <OfflineNotice className="mt-3" />}
      </div>
    </div>
  );
}

/**
 * The submit-failure banner. `role="alert"` so a worker using a screen reader
 * hears that the transfer did not go through — the pre-v4 banner was a silent
 * red box.
 */
function ErrorBanner({ message }: { message: string }): JSX.Element {
  return (
    <Card role="alert" className="mx-4 mt-3 p-3 flex items-center gap-2 border-crit">
      <AlertCircle size={18} className="text-crit flex-shrink-0" />
      <span className="text-crit text-body">{message}</span>
    </Card>
  );
}

/** Amber is the watch tone: the record will be kept, just not sent yet. */
function OfflineNotice({ className }: { className?: string }): JSX.Element {
  return (
    <p className={clsx('text-center text-warn text-body font-medium', className)}>
      Offline -- will sync when connected
    </p>
  );
}
