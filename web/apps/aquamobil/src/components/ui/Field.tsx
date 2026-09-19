/**
 * Field / Input / Select / Textarea — AquaMobil's one field vocabulary
 * (FE-MEDIUM-091).
 *
 * WHY: data entry was written two ways — Konsta `ListInput` on six record
 * pages, hand-rolled `<label>` + `<input>` everywhere else — and neither
 * bound the label to the control, so a screen reader announced unnamed
 * fields on the warehouse and record paths. One `Field` owns the contract:
 * label ↔ control through `useId`, the error under the field wired with
 * `aria-describedby` + `aria-invalid`, `required` on the control, the 44 px
 * touch floor, the focus ring (no global `!important` rule), and the dark
 * palette. A label may be visually hidden (`hideLabel`) when a section title
 * already names the field — it is never omitted.
 */
import { clsx } from 'clsx';
import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { twMerge } from 'tailwind-merge';

export interface FieldProps {
  label: ReactNode;
  /** Keep the label for assistive technology only (a section title is the visible name) */
  hideLabel?: boolean;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  className?: string;
}

interface FieldRenderProps {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
}

const CONTROL =
  'block w-full rounded-xl border bg-white text-base text-gray-900 placeholder:text-gray-400 transition-colors ' +
  'focus:outline-none focus:border-ocean-500 focus-visible:ring-2 focus-visible:ring-ocean-500/30 ' +
  'disabled:cursor-not-allowed disabled:opacity-60 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500';
const CONTROL_STATE = {
  valid: 'border-gray-200 dark:border-gray-700',
  invalid: 'border-red-500 dark:border-red-500',
};

export function Field({
  label,
  hideLabel = false,
  hint,
  error,
  required,
  className,
  children,
}: FieldProps & { children: (props: FieldRenderProps) => ReactNode }): ReactNode {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = error ? errorId : hint ? hintId : undefined;
  return (
    <div className={twMerge('block', className)}>
      <label
        htmlFor={id}
        className={clsx(
          hideLabel
            ? 'sr-only'
            : 'mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300',
        )}
      >
        {label}
        {required && (
          <span className="ml-1 text-red-500" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {error ? (
        <p id={errorId} role="alert" className="mt-1.5 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : (
        hint && (
          <p id={hintId} className="mt-1.5 text-sm text-gray-500 dark:text-gray-400">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'className'>,
    FieldProps {
  /** A lucide icon rendered inside the control's leading edge */
  leading?: ReactNode;
  inputClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hideLabel, hint, error, required, className, leading, inputClassName, ...rest },
  ref,
) {
  return (
    <Field
      label={label}
      hideLabel={hideLabel}
      hint={hint}
      error={error}
      required={required}
      className={className}
    >
      {({ id, describedBy, invalid }) => (
        <div className="relative">
          {leading && (
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500">
              {leading}
            </span>
          )}
          <input
            ref={ref}
            id={id}
            required={required}
            aria-required={required || undefined}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            className={twMerge(
              clsx(
                CONTROL,
                invalid ? CONTROL_STATE.invalid : CONTROL_STATE.valid,
                'min-h-touch px-4 py-3',
                leading && 'pl-10',
              ),
              inputClassName,
            )}
            {...rest}
          />
        </div>
      )}
    </Field>
  );
});

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id' | 'className'>,
    FieldProps {
  selectClassName?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hideLabel, hint, error, required, className, selectClassName, children, ...rest },
  ref,
) {
  return (
    <Field
      label={label}
      hideLabel={hideLabel}
      hint={hint}
      error={error}
      required={required}
      className={className}
    >
      {({ id, describedBy, invalid }) => (
        <select
          ref={ref}
          id={id}
          required={required}
          aria-required={required || undefined}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          className={twMerge(
            clsx(
              CONTROL,
              invalid ? CONTROL_STATE.invalid : CONTROL_STATE.valid,
              'min-h-touch px-4 py-3 pr-10 appearance-none bg-no-repeat bg-[right_0.75rem_center] bg-[length:1rem_1rem] bg-[url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 fill=%27none%27 viewBox=%270 0 20 20%27%3E%3Cpath stroke=%27%236b7280%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27 stroke-width=%271.5%27 d=%27M6 8l4 4 4-4%27/%3E%3C/svg%3E")]',
            ),
            selectClassName,
          )}
          {...rest}
        >
          {children}
        </select>
      )}
    </Field>
  );
});

export interface TextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id' | 'className'>,
    FieldProps {
  textareaClassName?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hideLabel, hint, error, required, className, textareaClassName, rows = 3, ...rest },
  ref,
) {
  return (
    <Field
      label={label}
      hideLabel={hideLabel}
      hint={hint}
      error={error}
      required={required}
      className={className}
    >
      {({ id, describedBy, invalid }) => (
        <textarea
          ref={ref}
          id={id}
          rows={rows}
          required={required}
          aria-required={required || undefined}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          className={twMerge(
            clsx(
              CONTROL,
              invalid ? CONTROL_STATE.invalid : CONTROL_STATE.valid,
              'px-4 py-3 resize-y',
            ),
            textareaClassName,
          )}
          {...rest}
        />
      )}
    </Field>
  );
});
