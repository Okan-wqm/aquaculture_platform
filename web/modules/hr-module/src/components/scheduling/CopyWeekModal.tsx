/**
 * CopyWeekModal Component
 * Modal for copying a weekly plan to another week
 */

import React, { useState, useMemo } from 'react';
import { Copy, Calendar, AlertTriangle } from 'lucide-react';
import { cn, Modal, Spinner } from '@aquaculture/shared-ui';
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

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      showCloseButton={!isLoading}
      closeOnEscape={!isLoading}
      closeOnOverlayClick={!isLoading}
      title={
        <span className="flex items-center gap-2">
          <Copy className="h-5 w-5 text-indigo-600" aria-hidden="true" />
          <span>Haftayi Kopyala</span>
        </span>
      }
      bodyClassName=""
    >
      <form onSubmit={handleSubmit} className="p-6 space-y-4">
        {/* Source info */}
        <div className="p-4 bg-gray-50 rounded-lg">
          <p className="text-sm text-gray-500 mb-1">Kaynak Hafta</p>
          <p className="font-medium text-gray-900">{employeeName}</p>
          <p className="text-sm text-gray-600">{formatWeekRange(new Date(sourceWeekStart))}</p>
        </div>

        {/* Target week selection */}
        <fieldset>
          <legend className="block text-sm font-medium text-gray-700 mb-2">Hedef Hafta</legend>
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Hedef hafta secimi">
            {[1, 2, 3, 4].map((offset) => {
              const target = new Date(sourceWeekStart);
              target.setDate(target.getDate() + offset * 7);
              const weekNum = Math.ceil(
                ((target.getTime() - new Date(target.getFullYear(), 0, 1).getTime()) / 86400000 +
                  1) /
                  7,
              );
              const isSelected = targetWeekOffset === offset;
              const dateStr = target.toLocaleDateString('tr-TR', {
                day: 'numeric',
                month: 'short',
              });

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
                      : 'border-gray-200 hover:bg-gray-50',
                  )}
                  aria-label={`Hafta ${weekNum}, ${dateStr}`}
                >
                  <div className="flex items-center gap-2">
                    <Calendar
                      className={cn('h-4 w-4', isSelected ? 'text-indigo-600' : 'text-gray-400')}
                      aria-hidden="true"
                    />
                    <span
                      className={cn(
                        'text-sm font-medium',
                        isSelected ? 'text-indigo-600' : 'text-gray-700',
                      )}
                    >
                      Hafta {weekNum}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 mt-1 ml-6">{dateStr}</p>
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
              'disabled:opacity-50 disabled:cursor-not-allowed',
            )}
            disabled={isLoading}
            aria-busy={isLoading}
          >
            {isLoading ? (
              <>
                <Spinner size="sm" color="white" />
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
    </Modal>
  );
}

export default CopyWeekModal;
