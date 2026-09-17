/**
 * RecordEntityPage — shared scaffold for cull / mortality / harvest flows.
 *
 * WHY: Before AUDIT-MEDIUM-012 (cold audit 2026-04-22) three pages duplicated
 * ~600 lines of identical step machine, success flow, tank selector, header
 * shell, error banner, and submit/review buttons. The consumer-specific
 * surface is the entry body (fields) and the confirm summary (review rows);
 * the rest is harness. This module extracts the harness as <RecordEntityPage>
 * plus a small kit of body/summary helpers that cull+mortality share.
 *
 * Scope: domain-local under web/apps/aquamobil/src/pages/_shared — only
 * aquamobil consumes, so it deliberately does not live in a shared lib
 * (ADR-028 lib-creation rubric).
 */
import { clsx } from 'clsx';
import { ArrowLeft, AlertCircle, Minus, Plus, type LucideIcon } from 'lucide-react';
import type { JSX } from 'react';
import {
  type ChangeEvent,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useEffect,
  useId,
  useState,
} from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { QueuedStatusBadge } from '@/components/QueuedStatusBadge';
import { Button, Card, CardDivider, DataState, EmptyState, IconButton } from '@/components/ui';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { useTanks } from '@/hooks/useTanks';
import type { OperationPayload, OperationType } from '@/types';
import { toLoadable } from '@/utils/loadable';

/* ---------------------------------------------------------------- */
/*  Theme                                                            */
/* ---------------------------------------------------------------- */

/**
 * Theme tokens shared between entry header, confirm header, summary card,
 * review/submit buttons, and the stepper/reason-grid helpers. Each page
 * supplies one literal object.
 *
 * v4: every field is a plain class bag carrying BOTH the fill and the ink for
 * the surface it names. The shell deliberately adds no ink of its own — it used
 * to hardcode `text-white` on the header and the CTA, which meant a page that
 * had moved to the semantic tokens had to fight it with `!text-acc-on`. The
 * consumer's theme now owns the pairing, so fill and ink cannot disagree.
 * Pages still on the pre-v4 gradients keep working: their class strings simply
 * carry a gradient where a converted page carries `bg-acc text-acc-on`.
 */
export interface RecordEntityTheme {
  /** Header bar classes (fill + ink) for the entry + confirm pages. */
  headerGradient: string;
  /** Icon tint for the tank/batch info card + stepper arrows + reason-grid selection. */
  accentText: string;
  /** Summary-card heading row bg + border (confirm screen). */
  summaryHeaderBg: string;
  /** Summary-card heading text color (confirm screen). */
  summaryHeaderText: string;
  /** Tank/batch info card icon bubble bg. */
  iconBubbleBg: string;
  /** Background for stepper +/- buttons + reason-grid selected state. */
  surfaceSoftBg: string;
  /** Border color for stepper buttons + reason grid. */
  surfaceBorder: string;
  /** Review/submit CTA button classes (fill + ink) + its shadow. */
  ctaGradient: string;
  ctaShadow: string;
  /** Class applied to the selected reason/grade border + glow. */
  selectionBorder: string;
  selectionGlow: string;
}

/* ---------------------------------------------------------------- */
/*  Field surface                                                    */
/* ---------------------------------------------------------------- */

/**
 * The caption above a control, and the control itself.
 *
 * WHY two exported constants rather than a class string written per field:
 * these replace Konsta's <List>/<ListInput>, which used to own the look of
 * every input in the record family (cull, mortality, harvest, lice, escape,
 * welfare). Konsta also injected its own `ios-`/`md-` colour classes and its
 * own dark-mode handling, which is precisely why these pages could not adopt
 * the v4 tokens. Dropping it without a shared string would scatter the same
 * nine-class incantation across six pages and let it drift a little in each —
 * the pre-v4 mistake <Card> exists to end. One import now owns the field
 * surface, its 44px gloved-use floor and its focus ring.
 */
export const FIELD_LABEL_CLASS = 'block text-body font-semibold text-ink-1 mb-2';
export const FIELD_CONTROL_CLASS =
  'w-full min-h-touch px-4 py-3 rounded-xl border border-line bg-surface-1 text-ink-1 text-body focus:outline-none focus:ring-2 focus:ring-acc';

/* ---------------------------------------------------------------- */
/*  Shared form-error shape                                          */
/* ---------------------------------------------------------------- */

export interface BaseFormErrors {
  tank?: string;
  quantity?: string;
  general?: string;
}

/* ---------------------------------------------------------------- */
/*  Props                                                            */
/* ---------------------------------------------------------------- */

/**
 * What the page controls: form values and validation over them. The shell
 * owns step + success + submit, but validation runs whatever the consumer
 * passes so page-specific fields (avgWeight, grade, etc.) can surface.
 *
 * The `TErrors` generic lets consumers widen BaseFormErrors with page-specific
 * keys (e.g. `avgWeight` on harvest). The shell only reads/writes `tank`,
 * `quantity`, and `general` on it.
 */
export interface RecordEntityPageProps<
  TPayload extends OperationPayload,
  TErrors extends BaseFormErrors = BaseFormErrors,
> {
  /** Theme tokens (see {@link RecordEntityTheme}). */
  theme: RecordEntityTheme;

  /** Entry header title, e.g. "Record Cull". */
  entryTitle: string;
  /** Confirm header title, e.g. "Confirm Cull". */
  confirmTitle: string;
  /** Icon shown in entry + confirm header + tank info card. */
  icon: LucideIcon;

  /** Summary card heading, e.g. "Cull Summary". */
  summaryHeading: string;

  /** Offline-queue operation type the submit will enqueue. */
  operationName: OperationType;

  /** Word used in the "Stock fish into a tank before recording X" prompt. */
  tankEmptyActionWord: string;

  /** Selected tank id value, managed by the consuming page. */
  selectedTankId: string;
  onTankChange: Dispatch<SetStateAction<string>>;

  /**
   * Validation errors (consumer-owned state). Shell only reads `tank`,
   * `quantity`, `general`. Additional keys carried by `TErrors` pass
   * through untouched.
   */
  errors: TErrors;
  setErrors: Dispatch<SetStateAction<TErrors>>;

  /**
   * Runs before every review + submit. Returns true when valid. Consumers
   * are responsible for populating `errors` inside this callback.
   */
  validate: () => boolean;

  /** Builds the typed payload dispatched to the offline queue. */
  buildPayload: () => TPayload;

  /** Disables the Review CTA (cheap prereq check before full validate). */
  canReview: boolean;

  /**
   * Review button inner content, e.g. <>Review {quantity} Culled Fish <ChevronRight/></>.
   * Shell wraps with the gradient CTA shell and adds the icon automatically.
   */
  reviewLabel: ReactNode;
  /** Confirm & submit button inner content, e.g. "Confirm & Record". */
  submitLabel: ReactNode;
  /** Submitting label text, default "Recording..." */
  submittingLabel?: ReactNode;

  /** Entry body JSX rendered between tank selector and review button. */
  children: ReactNode;
  /** Confirm summary JSX rendered inside the summary card. */
  confirmSummary: ReactNode;

  /**
   * Optional path to navigate to after success (post-sync delay).
   * Default: '/' (home).
   */
  successRedirectPath?: string;
}

/* ---------------------------------------------------------------- */
/*  Shell                                                            */
/* ---------------------------------------------------------------- */

type FormStep = 'entry' | 'confirm';

export function RecordEntityPage<
  TPayload extends OperationPayload,
  TErrors extends BaseFormErrors = BaseFormErrors,
>(props: RecordEntityPageProps<TPayload, TErrors>): JSX.Element {
  const {
    theme,
    entryTitle,
    confirmTitle,
    icon: Icon,
    summaryHeading,
    operationName,
    tankEmptyActionWord,
    selectedTankId,
    onTankChange,
    errors,
    setErrors,
    validate,
    buildPayload,
    canReview,
    reviewLabel,
    submitLabel,
    submittingLabel = 'Recording...',
    children,
    confirmSummary,
    successRedirectPath = '/',
  } = props;

  const navigate = useNavigate();
  const { tankId } = useParams<{ tankId?: string }>();
  const tanksQuery = useTanks();
  const tanks = tanksQuery.data;
  // The tank selector picks WHICH batch the entry is written against, so a
  // failed unit fetch rendering an empty picker says "you have no stocked
  // tanks" when the truth is "we could not read them" — the defect this app
  // has now been bitten by six times. Loadable keeps the two apart.
  const tanksView = toLoadable(tanksQuery);
  const { addToQueue, isOnline } = useOfflineQueue();

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [queuedOperationId, setQueuedOperationId] = useState('');
  // FE-HIGH-050: when the queue collapses a double-tap onto an existing op, the
  // submit must NOT read as a fresh success. We track the dedup outcome and the
  // success screen renders "Already recorded" instead of the queued badge.
  const [wasDuplicate, setWasDuplicate] = useState(false);
  const [step, setStep] = useState<FormStep>('entry');

  useEffect(() => {
    if (tankId) onTankChange(tankId);
  }, [tankId, onTankChange]);

  const selectedTank = tanks?.find((t) => t.id === selectedTankId);
  const metrics = selectedTank?.batchMetrics;

  const handleReview = (): void => {
    if (!validate()) return;
    setStep('confirm');
  };

  const handleSubmit = async (): Promise<void> => {
    if (!validate() || !metrics?.batchId) return;

    setIsSubmitting(true);
    setErrors((prev) => ({ ...prev, general: undefined, tank: undefined, quantity: undefined }));

    try {
      const payload = buildPayload();
      const result = await addToQueue(operationName, payload);
      setQueuedOperationId(result.id);
      setWasDuplicate(result.status === 'duplicate');
      setShowSuccess(true);
      setTimeout(() => navigate(successRedirectPath), 2000);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to record';
      setErrors((prev) => ({ ...prev, general: message }));
      setStep('entry');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleTankChange = (e: ChangeEvent<HTMLSelectElement>): void => {
    onTankChange(e.target.value);
    setErrors((prev) => ({ ...prev, tank: undefined }));
  };

  /* Two-phase success UX — surface real queue status via QueuedStatusBadge
     instead of a premature green checkmark. (C7)
     FE-HIGH-050: a deduped double-tap is NOT a fresh record — show an honest
     "Already recorded" notice so the operator is not led to believe a second
     entry was created. */
  if (showSuccess) {
    return (
      // No page tint: the ground is the <body>'s, so the notice below is the
      // only thing carrying colour and it can be read in every theme.
      <div className="flex flex-col items-center justify-center min-h-screen">
        {wasDuplicate ? (
          <AlreadyRecordedNotice />
        ) : (
          <QueuedStatusBadge operationId={queuedOperationId} />
        )}
      </div>
    );
  }

  if (step === 'confirm') {
    return (
      <div className="min-h-screen">
        <div className={theme.headerGradient}>
          <div className="flex items-center gap-3 px-4 py-4 pt-safe-top">
            {/* The back arrow was a 38px icon-only <button> with no accessible
                name. IconButton bakes in the 44px floor and forces the label. */}
            <IconButton
              aria-label="Back"
              onClick={() => setStep('entry')}
              className="-ml-2 rounded-xl hover:bg-surface-2"
            >
              <ArrowLeft size={22} />
            </IconButton>
            <div className="flex items-center gap-2.5">
              <Icon size={22} />
              <h1 className="text-head font-bold">{confirmTitle}</h1>
            </div>
          </div>
        </div>

        <div className="px-4 mt-5">
          <Card className="overflow-hidden">
            <div className={clsx('p-4 border-b', theme.summaryHeaderBg)}>
              <h3
                className={clsx(
                  'text-body font-bold uppercase tracking-wider',
                  theme.summaryHeaderText,
                )}
              >
                {summaryHeading}
              </h3>
            </div>
            <div className="p-4 space-y-4">{confirmSummary}</div>
          </Card>
        </div>

        {errors.general && <ErrorBanner message={errors.general} />}

        <div className="px-4 mt-6 space-y-3 pb-28">
          {/* Fill AND ink come from the theme — see RecordEntityTheme. The
              button primitive supplies the density-aware height and the floor. */}
          <Button
            size="save"
            block
            onClick={() => {
              void handleSubmit();
            }}
            disabled={isSubmitting}
            className={clsx('font-bold', theme.ctaGradient, theme.ctaShadow)}
          >
            {isSubmitting ? (
              <>
                <span className="animate-spin rounded-full h-5 w-5 border-2 border-current border-t-transparent" />
                {submittingLabel}
              </>
            ) : (
              <>
                <Icon size={20} />
                {submitLabel}
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
      <div className={theme.headerGradient}>
        <div className="flex items-center gap-3 px-4 py-4 pt-safe-top">
          {/* Same story as the confirm header: named, and above the floor. */}
          <IconButton
            aria-label="Back"
            onClick={() => navigate(-1)}
            className="-ml-2 rounded-xl hover:bg-surface-2"
          >
            <ArrowLeft size={22} />
          </IconButton>
          <div className="flex items-center gap-2.5">
            <Icon size={22} />
            <h1 className="text-head font-bold">{entryTitle}</h1>
          </div>
        </div>
      </div>

      {/* Tank/Batch info card. NOT a <ListRow>: the row primitive picks its icon
          tile from a fixed tone set, and this tile's hue is the consuming page's
          identity (theme.iconBubbleBg + theme.accentText), which no RowTone
          reproduces. Forcing it would flatten six pages to one colour. */}
      {selectedTank && metrics && (
        <Card className="mx-4 mt-4 p-4">
          <div className="flex items-center gap-3">
            <div
              className={clsx(
                'w-11 h-11 rounded-xl flex items-center justify-center',
                theme.iconBubbleBg,
              )}
            >
              <Icon className={theme.accentText} size={22} />
            </div>
            <div className="flex-1">
              <h3 className="font-semibold text-ink-1">{selectedTank.name}</h3>
              <p className="text-body text-ink-3">
                {metrics.batchNumber ?? '--'} &middot; {(metrics.pieces ?? 0).toLocaleString()} fish
              </p>
            </div>
          </div>
        </Card>
      )}

      {errors.general && <ErrorBanner message={errors.general} />}

      {/* Tank Selector — only when tankId not prefilled via URL param.
          WHY: Only tanks with active batches are selectable — recording without
          a batch context corrupts inventory. Batchless tanks render disabled
          with their real id so the user understands the tank exists but is
          not selectable. */}
      {!tankId && (
        <div className="px-4 mt-5">
          <DataState
            value={tanksView}
            label="your units"
            skeleton="row"
            skeletonCount={1}
            empty={
              <EmptyState
                title="No units"
                description="No units are assigned to this tenant yet, so there is nothing to record against."
              />
            }
          >
            {(units) => (
              <>
                {/* WHY a wrapping <label> where Konsta had a <BlockTitle> above
                    a <ListInput>: the block title was a heading with no
                    association to the control under it, so the combobox was
                    announced unlabelled. Wrapping IS the association, and it
                    cannot come apart the way a heading and a control two
                    elements away can. */}
                <label className="block">
                  <span className={FIELD_LABEL_CLASS}>Select Tank</span>
                  <select
                    value={selectedTankId}
                    onChange={handleTankChange}
                    aria-invalid={errors.tank ? true : undefined}
                    aria-describedby={errors.tank ? 'record-entity-tank-error' : undefined}
                    className={FIELD_CONTROL_CLASS}
                  >
                    <option value="">-- Select Tank --</option>
                    {units
                      .filter((t) => t.batchMetrics)
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} - {t.batchMetrics?.batchNumber ?? '--'}
                        </option>
                      ))}
                    {units
                      .filter((t) => !t.batchMetrics)
                      .map((t) => (
                        <option key={t.id} value={t.id} disabled>
                          {t.name} (No active batch)
                        </option>
                      ))}
                  </select>
                </label>
                {errors.tank && (
                  <p id="record-entity-tank-error" className="text-crit text-body mt-2">
                    {errors.tank}
                  </p>
                )}
                {units.length > 0 && units.every((t) => !t.batchMetrics) && (
                  <Card className="mt-3 p-3 border-warn">
                    <p className="text-warn text-body font-medium">
                      All tanks currently have no active batches.
                    </p>
                    <p className="text-ink-2 text-meta mt-1">
                      Stock fish into a tank before recording {tankEmptyActionWord}.
                    </p>
                  </Card>
                )}
              </>
            )}
          </DataState>
        </div>
      )}

      {/* Page-specific body (stepper/reason/notes/harvest fields) */}
      {children}

      {/* Review CTA */}
      <div className="px-4 pt-5 pb-28">
        <Button
          size="save"
          block
          onClick={handleReview}
          disabled={!canReview}
          className={clsx('font-bold', theme.ctaGradient, theme.ctaShadow)}
        >
          <Icon size={20} />
          {reviewLabel}
        </Button>
        {!isOnline && (
          <p className="text-center text-warn text-body mt-3 font-medium">
            Offline -- will sync when connected
          </p>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/*  Reusable helpers                                                 */
/* ---------------------------------------------------------------- */

function ErrorBanner({ message }: { message: string }): JSX.Element {
  return (
    <Card className="mx-4 mt-3 p-3 flex items-center gap-2 border-crit">
      <AlertCircle size={18} className="text-crit flex-shrink-0" />
      <span className="text-crit text-body">{message}</span>
    </Card>
  );
}

function OfflineNotice(): JSX.Element {
  return (
    <p className="text-center text-warn text-body font-medium">
      Offline -- will sync when connected
    </p>
  );
}

/**
 * FE-HIGH-050: shown when a submit was collapsed onto an existing queued op by
 * the dedup window (double-tap). It deliberately does NOT use the success
 * checkmark or the queued badge — the operator already recorded this entry, so
 * the honest message is "Already recorded", not a second confirmation.
 */
function AlreadyRecordedNotice(): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="w-20 h-20 bg-warn-dim rounded-full flex items-center justify-center">
        <AlertCircle size={48} className="text-warn" />
      </div>
      <h2 className="text-head font-bold text-warn">Already recorded</h2>
      <p className="text-body text-ink-2">
        This entry was already submitted moments ago -- no duplicate was created.
      </p>
    </div>
  );
}

/**
 * Shared +/- stepper used by cull + mortality. WHY: 56px hit target exceeds
 * WCAG 2.2 minimum of 44px — field workers tap with wet/gloved hands.
 */
export function QuantityStepper(props: {
  label: string;
  value: number;
  onChange: (next: number) => void;
  max: number;
  error?: string;
  theme: Pick<RecordEntityTheme, 'surfaceSoftBg' | 'surfaceBorder' | 'accentText'>;
}): JSX.Element {
  const { label, value, onChange, max, error, theme } = props;
  const clamp = (n: number): number => Math.floor(Math.max(1, Math.min(n, max)));
  return (
    <div className="px-4 mt-5">
      <h3 className="text-meta font-bold text-ink-3 uppercase tracking-wider mb-3">{label}</h3>
      <Card className="p-5">
        <div className="flex items-center justify-center gap-5">
          {/* The two arrows were icon-only buttons with no accessible name —
              a screen reader announced "button, button" either side of a
              number. The label the section already carries names them. */}
          <button
            type="button"
            aria-label={`Decrease ${label}`}
            onClick={() => onChange(clamp(value - 1))}
            disabled={value <= 1}
            className={clsx(
              'w-14 h-14 min-h-touch min-w-touch rounded-2xl flex items-center justify-center disabled:opacity-30 touch-feedback border',
              theme.surfaceSoftBg,
              theme.surfaceBorder,
            )}
          >
            <Minus size={22} className={theme.accentText} />
          </button>
          <div className="text-hero font-mono font-bold text-ink-1 min-w-[90px] text-center tabular-nums">
            {value}
          </div>
          <button
            type="button"
            aria-label={`Increase ${label}`}
            onClick={() => onChange(clamp(value + 1))}
            disabled={value >= max}
            className={clsx(
              'w-14 h-14 min-h-touch min-w-touch rounded-2xl flex items-center justify-center disabled:opacity-30 touch-feedback border',
              theme.surfaceSoftBg,
              theme.surfaceBorder,
            )}
          >
            <Plus size={22} className={theme.accentText} />
          </button>
        </div>
        <p className="text-center text-meta text-ink-3 mt-3 font-medium">
          Max: {max.toLocaleString()} fish in tank
        </p>
        {error && <p className="text-crit text-body text-center mt-2">{error}</p>}
      </Card>
    </div>
  );
}

/**
 * Shared 4-column emoji+label grid used by cull + mortality reason pickers.
 */
export function ReasonGrid<TValue extends string>(props: {
  label: string;
  value: TValue;
  onChange: (next: TValue) => void;
  options: ReadonlyArray<{ value: TValue; label: string; emoji: string }>;
  theme: Pick<RecordEntityTheme, 'selectionBorder' | 'selectionGlow' | 'surfaceSoftBg'>;
}): JSX.Element {
  const { label, value, onChange, options, theme } = props;
  return (
    <div className="px-4 mt-5">
      <h3 className="text-meta font-bold text-ink-3 uppercase tracking-wider mb-3">{label}</h3>
      <div className="grid grid-cols-4 gap-2">
        {options.map((r) => {
          const selected = value === r.value;
          return (
            <button
              key={r.value}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(r.value)}
              className={clsx(
                'flex flex-col items-center p-3 min-h-touch rounded-2xl border-2 transition-all duration-150 ease-out touch-feedback bg-surface-1',
                selected
                  ? clsx(
                      theme.selectionBorder,
                      theme.surfaceSoftBg,
                      theme.selectionGlow,
                      'scale-[1.02]',
                    )
                  : 'border-line',
              )}
            >
              <span className="text-xl mb-1">{r.emoji}</span>
              {/* Was a 10px label — unreadable at arm's length in sunlight, and
                  one of the last entries on the sub-12px ratchet. */}
              <span className="text-meta font-semibold text-ink-2 text-center leading-tight">
                {r.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Numeric field (decimal-capable) — used by the regulatory field-capture pages
 * (FARM-HIGH-214): lice-stage averages are decimals (e.g. 0.15 adult females
 * per fish), which the integer QuantityStepper cannot express. Empty input
 * surfaces as null so "not entered" is distinguishable from 0 (a real,
 * meaningful lice count).
 *
 * v4: a native input on the token surface. The `error` text is now rendered
 * here — Konsta's <ListInput error> used to draw it, so dropping Konsta without
 * this would have silently swallowed every validation message on these fields.
 */
export function NumberField(props: {
  label: string;
  value: number | null;
  onChange: (next: number | null) => void;
  placeholder?: string;
  step?: string;
  min?: number;
  error?: string;
}): JSX.Element {
  const { label, value, onChange, placeholder = '0', step = '0.01', min = 0, error } = props;
  // Several of these stack on one page (three lice stages), so the error's id
  // has to be per-instance or aria-describedby would point at a sibling's text.
  const errorId = useId();
  return (
    <div className="px-4 mt-3">
      <label className="block">
        <span className={FIELD_LABEL_CLASS}>{label}</span>
        <input
          type="number"
          inputMode="decimal"
          step={step}
          min={min}
          placeholder={placeholder}
          value={value ?? ''}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={FIELD_CONTROL_CLASS}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            const raw = e.target.value;
            if (raw === '') {
              onChange(null);
              return;
            }
            const parsed = Number(raw);
            onChange(Number.isFinite(parsed) ? parsed : null);
          }}
        />
      </label>
      {error && (
        <p id={errorId} className="text-crit text-body mt-2">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Notes textarea — used by cull + mortality + the regulatory pages.
 *
 * The Konsta block title that sat above it was a heading pointing at nothing;
 * it is now the textarea's own caption, so the control is named.
 */
export function NotesInput(props: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}): JSX.Element {
  const { value, onChange, placeholder = 'Additional observations...' } = props;
  return (
    <div className="px-4 mt-5">
      <label className="block">
        <span className={FIELD_LABEL_CLASS}>Notes (Optional)</span>
        <textarea
          placeholder={placeholder}
          value={value}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
          className={clsx(FIELD_CONTROL_CLASS, 'h-24 resize-none')}
        />
      </label>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/*  Summary primitives (confirm screen)                              */
/* ---------------------------------------------------------------- */

export function SummaryRow(props: {
  label: string;
  value: ReactNode;
  valueClass?: string;
}): JSX.Element {
  const { label, value, valueClass = 'font-semibold text-ink-1' } = props;
  return (
    <div className="flex justify-between items-center">
      <span className="text-body text-ink-2">{label}</span>
      <span className={valueClass}>{value}</span>
    </div>
  );
}

/** The divider between summary rows — the card's own hairline, nothing else. */
export function SummaryDivider(): JSX.Element {
  return <CardDivider />;
}

export function SummaryNotesBlock({ notes }: { notes: string }): JSX.Element {
  return (
    <div>
      <span className="text-body text-ink-2">Notes</span>
      <p className="text-body text-ink-1 mt-1">{notes}</p>
    </div>
  );
}
