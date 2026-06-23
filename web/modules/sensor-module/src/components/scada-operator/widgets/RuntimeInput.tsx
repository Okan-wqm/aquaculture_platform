/**
 * RuntimeInput — Operator input widget for tag writes.
 *
 * Supports: text, number, date, time, datetime, password
 * - Displays current tag value
 * - On Enter (or confirm button): write value to tag via useTagWrite
 * - Numeric: min/max validation, decimal format
 * - Disabled state when isEnabled=false
 * - PIN protection prompt if requiresPin is set in config
 * - Accessible with proper aria-labels
 */

import React, { memo, useState, useCallback, useRef, useEffect } from 'react';
import { CheckCircle, AlertCircle, Lock, Loader2 } from 'lucide-react';
import { useTagWrite } from '../../../hooks/useTagWrite';
import type { RuntimeWidgetProps } from '../../../types/scada-runtime.types';

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

type InputType = 'text' | 'number' | 'date' | 'time' | 'datetime' | 'password';

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

const RuntimeInput: React.FC<RuntimeWidgetProps> = ({
  value,
  config,
  tagValues,
  isEnabled,
  onCommand,
}) => {
  /* ---- config ---- */
  const label = (config.label ?? 'Input') as string;
  const inputType = (config.inputType ?? 'text') as InputType;
  const tagId = (config.tagId ?? '') as string;
  const minVal = config.min !== undefined ? Number(config.min) : undefined;
  const maxVal = config.max !== undefined ? Number(config.max) : undefined;
  const decimals = (config.decimals ?? 2) as number;
  const placeholder = (config.placeholder ?? '') as string;
  const showConfirmButton = Boolean(config.showConfirmButton ?? false);
  const requirePin = Boolean(config.requirePin ?? false);
  const unit = (config.unit ?? '') as string;

  /* ---- current tag value ---- */
  const tagChange = tagId ? tagValues?.[tagId] : undefined;
  const currentTagValue = tagChange?.value ?? value;

  /* ---- local state ---- */
  const [inputVal, setInputVal] = useState('');
  const [isDirty, setIsDirty] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [writeSuccess, setWriteSuccess] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [showPinDialog, setShowPinDialog] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { writeTag, isWriting, lastError } = useTagWrite();

  /* ---- sync displayed value from tag when not dirty ---- */
  useEffect(() => {
    if (!isDirty) {
      const formatted = formatValueForInput(currentTagValue, inputType, decimals);
      setInputVal(formatted);
    }
  }, [currentTagValue, inputType, decimals, isDirty]);

  /* ---- cleanup success timer ---- */
  useEffect(() => {
    return () => {
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
    };
  }, []);

  /* ---- helpers ---- */
  function formatValueForInput(
    val: unknown,
    type: InputType,
    dec: number,
  ): string {
    if (val === null || val === undefined) return '';
    if (type === 'number') {
      const n = Number(val);
      return isNaN(n) ? '' : n.toFixed(dec);
    }
    return String(val);
  }

  function validate(rawVal: string): string | null {
    if (inputType === 'number') {
      const n = Number(rawVal);
      if (isNaN(n)) return 'Must be a number';
      if (minVal !== undefined && n < minVal) return `Min: ${minVal}`;
      if (maxVal !== undefined && n > maxVal) return `Max: ${maxVal}`;
    }
    return null;
  }

  const doWrite = useCallback(
    async (valToWrite: string) => {
      if (!tagId) return;
      const error = validate(valToWrite);
      if (error) {
        setValidationError(error);
        return;
      }
      setValidationError(null);

      let coerced: unknown = valToWrite;
      if (inputType === 'number') coerced = Number(valToWrite);

      try {
        await writeTag(tagId, coerced);
        setIsDirty(false);
        setWriteSuccess(true);
        onCommand?.('write', coerced);
        if (successTimerRef.current) clearTimeout(successTimerRef.current);
        successTimerRef.current = setTimeout(() => setWriteSuccess(false), 2000);
      } catch {
        // lastError from useTagWrite is displayed
      }
    },
     
    [tagId, inputType, minVal, maxVal, writeTag, onCommand],
  );

  const handleCommit = useCallback(() => {
    if (!isDirty || !isEnabled) return;
    if (requirePin) {
      setShowPinDialog(true);
      return;
    }
    void doWrite(inputVal);
  }, [isDirty, isEnabled, requirePin, doWrite, inputVal]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') handleCommit();
      if (e.key === 'Escape') {
        setIsDirty(false);
        setValidationError(null);
        const formatted = formatValueForInput(currentTagValue, inputType, decimals);
        setInputVal(formatted);
      }
    },
    [handleCommit, currentTagValue, inputType, decimals],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setInputVal(e.target.value);
      setIsDirty(true);
      setWriteSuccess(false);
      setValidationError(null);
    },
    [],
  );

  const handlePinConfirm = useCallback(() => {
    const expectedPin = (config.pin ?? '') as string;
    if (pinInput !== expectedPin) {
      setPinInput('');
      return;
    }
    setShowPinDialog(false);
    setPinInput('');
    void doWrite(inputVal);
  }, [pinInput, config.pin, doWrite, inputVal]);

  /* ---- HTML input type ---- */
  const htmlInputType =
    inputType === 'datetime' ? 'datetime-local' : inputType;

  /* ---- quality indicator color ---- */
  const quality = tagChange?.quality ?? 'good';
  const qualityClass =
    quality === 'bad'
      ? 'text-red-500'
      : quality === 'uncertain'
        ? 'text-yellow-500'
        : 'text-green-500';

  return (
    <div className="w-full h-full flex flex-col gap-1 p-2 min-w-0" role="group" aria-label={label}>
      {/* Label row */}
      <div className="flex items-center justify-between gap-1">
        <span className="text-xs font-medium text-gray-600 truncate">{label}</span>
        <span className={`text-xs font-mono ${qualityClass}`}>{unit}</span>
      </div>

      {/* Input row */}
      <div className="flex items-center gap-1 relative">
        <input
          ref={inputRef}
          type={htmlInputType}
          value={inputVal}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          disabled={!isEnabled || isWriting}
          placeholder={placeholder}
          aria-label={`${label} input`}
          aria-invalid={!!validationError}
          aria-describedby={validationError ? 'input-error' : undefined}
          className={[
            'flex-1 min-w-0 px-2 py-1 text-sm rounded border bg-white',
            'focus:outline-hidden focus:ring-2 focus:ring-blue-400',
            'disabled:bg-gray-100 disabled:cursor-not-allowed disabled:text-gray-400',
            isDirty ? 'border-blue-400' : 'border-gray-300',
            validationError ? 'border-red-400 focus:ring-red-400' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        />

        {/* Status icons */}
        {isWriting && (
          <Loader2 className="w-4 h-4 text-blue-500 animate-spin flex-shrink-0" aria-label="Writing..." />
        )}
        {writeSuccess && !isWriting && (
          <CheckCircle className="w-4 h-4 text-green-500 flex-shrink-0" aria-label="Write successful" />
        )}
        {(lastError || validationError) && !isWriting && (
          <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" aria-label="Write error" />
        )}
        {requirePin && (
          <Lock className="w-3 h-3 text-gray-400 flex-shrink-0" aria-label="PIN protected" />
        )}
      </div>

      {/* Validation error */}
      {validationError && (
        <p id="input-error" role="alert" className="text-xs text-red-500">
          {validationError}
        </p>
      )}
      {lastError && !validationError && (
        <p role="alert" className="text-xs text-red-500 truncate">
          {lastError}
        </p>
      )}

      {/* Confirm button */}
      {showConfirmButton && isDirty && isEnabled && (
        <button
          type="button"
          onClick={handleCommit}
          disabled={isWriting || !!validationError}
          aria-label="Confirm write"
          className={[
            'w-full py-1 text-xs rounded font-medium transition-colors',
            'bg-blue-500 text-white hover:bg-blue-600',
            'disabled:bg-gray-300 disabled:cursor-not-allowed',
          ].join(' ')}
        >
          {isWriting ? 'Writing...' : 'Confirm'}
        </button>
      )}

      {/* PIN dialog */}
      {showPinDialog && (
        <div
          role="dialog"
          aria-label="Enter PIN"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
        >
          <div className="bg-white rounded-lg shadow-xl p-6 w-72 flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <Lock className="w-5 h-5 text-gray-600" />
              <h3 className="text-sm font-semibold text-gray-800">Enter PIN</h3>
            </div>
            <input
              type="password"
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handlePinConfirm()}
              placeholder="PIN"
              autoFocus
              aria-label="PIN"
              className="px-3 py-2 border border-gray-300 rounded text-sm focus:outline-hidden focus:ring-2 focus:ring-blue-400"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowPinDialog(false);
                  setPinInput('');
                }}
                className="flex-1 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handlePinConfirm}
                className="flex-1 py-1.5 text-sm bg-blue-500 text-white rounded hover:bg-blue-600"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

RuntimeInput.displayName = 'RuntimeInput';
export default memo(RuntimeInput);
