/**
 * CopyWeekModal Component
 * Modal for copying a weekly plan to another week
 */

import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { X, Copy, Calendar, AlertTriangle } from 'lucide-react';
import { cn } from '@aquaculture/shared-ui';
import { getWeekMonday, formatDateISO } from '../../hooks/useScheduling';

interface CopyWeekModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (targetWeekStart: string) => void;
  sourcePlanId: string;
  sourceWeekStart: string;
  employeeName: string;
  isLoading?: boolean;
}

export function CopyWeekModal({
  isOpen,
  onClose,
  onConfirm,
  sourcePlanId,
  sourceWeekStart,
  employeeName,
  isLoading = false,
}: CopyWeekModalProps) {
  const [targetWeekOffset, setTargetWeekOffset] = useState(1); // Default: next week
  const modalRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousActiveElement = useRef<Element | null>(null);

  // Focus trap and keyboard handling
  useEffect(() => {
    if (!isOpen) return;

    // Store the previously focused element
    previousActiveElement.current = document.activeElement;

    // Focus the close button when modal opens
    closeButtonRef.current?.focus();

    // Handle Escape key
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isLoading) {
        onClose();
      }

      // Focus trap
      if (e.key === 'Tab' && modalRef.current) {
        const focusableElements = modalRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];

        if (e.shiftKey && document.activeElement === firstElement) {
          e.preventDefault();
          lastElement?.focus();
        } else if (!e.shiftKey && document.activeElement === lastElement) {
          e.preventDefault();
          firstElement?.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      // Return focus to previously focused element
      if (previousActiveElement.current instanceof HTMLElement) {
        previousActiveElement.current.focus();
      }
    };
  }, [isOpen, isLoading, onClose]);

  const targetWeekStart = useMemo(() => {
    const source = new Date(sourceWeekStart);
    const target = new Date(source);
    target.setDate(target.getDate() + targetWeekOffset * 7);
    return target;
  }, [sourceWeekStart, targetWeekOffset]);

  const targetWeekEnd = useMemo(() => {
    const end = new Date(targetWeekStart);
    end.setDate(end.getDate() + 6);
    return end;
  }, [targetWeekStart]);

  const formatWeekRange = (start: Date) => {
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    return `${start.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' })} - ${end.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' })}`;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onConfirm(formatDateISO(targetWeekStart));
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="copy-week-modal-title"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={isLoading ? undefined : onClose}
        aria-hidden="true"
      />

      {/* Modal */}
      <div
        ref={modalRef}
        className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <Copy className="h-5 w-5 text-indigo-600" aria-hidden="true" />
            <h3 id="copy-week-modal-title" className="text-lg font-semibold text-gray-900">
              Haftayi Kopyala
            </h3>
          </div>
          <button
            ref={closeButtonRef}
            onClick={onClose}
            disabled={isLoading}
            className="p-1 rounded-lg hover:bg-gray-100 transition-colors disabled:opacity-50"
            aria-label="Modali kapat"
          >
            <X className="h-5 w-5 text-gray-500" aria-hidden="true" />
          </button>
        </div>

        {/* Content */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* Source info */}
          <div className="p-4 bg-gray-50 rounded-lg">
            <p className="text-sm text-gray-500 mb-1">Kaynak Hafta</p>
            <p className="font-medium text-gray-900">
              {employeeName}
            </p>
            <p className="text-sm text-gray-600">
              {formatWeekRange(new Date(sourceWeekStart))}
            </p>
          </div>

          {/* Target week selection */}
          <fieldset>
            <legend className="block text-sm font-medium text-gray-700 mb-2">
              Hedef Hafta
            </legend>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Hedef hafta secimi">
              {[1, 2, 3, 4].map((offset) => {
                const target = new Date(sourceWeekStart);
                target.setDate(target.getDate() + offset * 7);
                const weekNum = Math.ceil(
                  ((target.getTime() - new Date(target.getFullYear(), 0, 1).getTime()) / 86400000 + 1) / 7
                );
                const isSelected = targetWeekOffset === offset;
                const dateStr = target.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });

                return (
                  <button
                    key={offset}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    onClick={() => setTargetWeekOffset(offset)}
                    className={cn(
                      'p-3 rounded-lg border text-left transition-colors',
                      isSelected
                        ? 'border-indigo-500 bg-indigo-50'
                        : 'border-gray-200 hover:bg-gray-50'
                    )}
                    aria-label={`Hafta ${weekNum}, ${dateStr}`}
                  >
                    <div className="flex items-center gap-2">
                      <Calendar
                        className={cn(
                          'h-4 w-4',
                          isSelected ? 'text-indigo-600' : 'text-gray-400'
                        )}
                        aria-hidden="true"
                      />
                      <span className={cn(
                        'text-sm font-medium',
                        isSelected ? 'text-indigo-600' : 'text-gray-700'
                      )}>
                        Hafta {weekNum}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 mt-1 ml-6">
                      {dateStr}
                    </p>
                  </button>
                );
              })}
            </div>
          </fieldset>

          {/* Selected target summary */}
          <div className="p-4 bg-indigo-50 rounded-lg border border-indigo-100" role="status">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-indigo-600 mt-0.5" aria-hidden="true" />
              <div>
                <p className="text-sm font-medium text-indigo-900">
                  Hedef: {formatWeekRange(targetWeekStart)}
                </p>
                <p className="text-xs text-indigo-700 mt-1">
                  Bu hafta icin yeni plan olusturulacak ve kaynak haftadaki vardiyalar kopyalanacak.
                </p>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors font-medium"
              disabled={isLoading}
            >
              Iptal
            </button>
            <button
              type="submit"
              className={cn(
                'flex-1 px-4 py-2 text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors font-medium',
                'flex items-center justify-center gap-2',
                'disabled:opacity-50 disabled:cursor-not-allowed'
              )}
              disabled={isLoading}
              aria-busy={isLoading}
            >
              {isLoading ? (
                <>
                  <div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" aria-hidden="true" />
                  Kopyalaniyor...
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4" aria-hidden="true" />
                  Kopyala
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default CopyWeekModal;
