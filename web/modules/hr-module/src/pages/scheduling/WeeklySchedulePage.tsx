/**
 * WeeklySchedulePage
 * Main page for planning employee weekly schedules
 */

import React, { useState, useMemo } from 'react';
import {
  Calendar,
  Users,
  Plus,
  Copy,
  Send,
  Check,
  AlertCircle,
  ChevronDown,
} from 'lucide-react';
import { cn } from '@aquaculture/shared-ui';
import {
  WeeklyCalendarGrid,
  ShiftPalette,
  WeekNavigator,
  CopyWeekModal,
  SchedulingKeyboardProvider,
  SchedulingErrorBoundary,
} from '../../components/scheduling';
import {
  useWeeklyPlans,
  useCreateWeeklyPlan,
  useUpdatePlanEntry,
  useCopyWeeklyPlan,
  usePublishWeeklyPlan,
  getWeekMonday,
  formatDateISO,
} from '../../hooks/useScheduling';
import type { WeeklyPlan, WeeklyPlanFilter } from '../../types/scheduling.types';

// TODO: Replace with actual employee hook
const mockEmployees = [
  { id: 'emp-1', firstName: 'Ahmet', lastName: 'Yilmaz', position: 'Operator' },
  { id: 'emp-2', firstName: 'Mehmet', lastName: 'Demir', position: 'Teknisyen' },
  { id: 'emp-3', firstName: 'Ali', lastName: 'Kaya', position: 'Muhendis' },
];

export function WeeklySchedulePage() {
  const [currentWeekStart, setCurrentWeekStart] = useState(() => getWeekMonday(new Date()));
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<WeeklyPlan | null>(null);
  const [showCopyModal, setShowCopyModal] = useState(false);
  const [copySourcePlan, setCopySourcePlan] = useState<WeeklyPlan | null>(null);

  const weekStartStr = formatDateISO(currentWeekStart);

  // Fetch plans for current week
  const filter: WeeklyPlanFilter = {
    weekStartDate: weekStartStr,
    employeeId: selectedEmployeeId || undefined,
  };
  const { data: plansData, isLoading } = useWeeklyPlans(filter, 50, 0);

  const createPlanMutation = useCreateWeeklyPlan();
  const updateEntryMutation = useUpdatePlanEntry();
  const copyPlanMutation = useCopyWeeklyPlan();
  const publishMutation = usePublishWeeklyPlan();

  // Get employees without plans for this week
  const employeesWithoutPlans = useMemo(() => {
    const planEmployeeIds = new Set(plansData?.items.map((p) => p.employeeId) || []);
    return mockEmployees.filter((e) => !planEmployeeIds.has(e.id));
  }, [plansData?.items]);

  const handleCreatePlan = (employeeId: string) => {
    createPlanMutation.mutate({
      employeeId,
      weekStartDate: weekStartStr,
    });
  };

  const handleUpdateEntry = (entryId: string, shiftId: string | null, isOffDay: boolean) => {
    updateEntryMutation.mutate({
      entryId,
      shiftId: shiftId || undefined,
      isOffDay,
      entryType: isOffDay ? 'off' : 'work',
    });
  };

  const handleCopyPlan = (sourceId: string, targetWeekStartDate: string) => {
    copyPlanMutation.mutate(
      { sourceId, targetWeekStartDate },
      {
        onSuccess: () => {
          setShowCopyModal(false);
          setCopySourcePlan(null);
        },
      }
    );
  };

  const handlePublishPlan = (planId: string) => {
    publishMutation.mutate(planId);
  };

  const openCopyModal = (plan: WeeklyPlan) => {
    setCopySourcePlan(plan);
    setShowCopyModal(true);
  };

  return (
    <SchedulingErrorBoundary>
    <SchedulingKeyboardProvider>
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
              <Calendar className="h-6 w-6 text-indigo-600" />
              Haftalik Is Cizelgesi
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              Calisanlarin haftalik programlarini planlama ve yonetim
            </p>
          </div>

          <WeekNavigator
            currentWeekStart={currentWeekStart}
            onChange={setCurrentWeekStart}
          />
        </div>
      </div>

      <div className="flex">
        {/* Left Sidebar - Shift Palette */}
        <div className="w-64 bg-white border-r border-gray-200 p-4 min-h-[calc(100vh-73px)]">
          <ShiftPalette />

          {/* Add new plan */}
          {employeesWithoutPlans.length > 0 && (
            <div className="mt-6 pt-4 border-t border-gray-200">
              <h4 className="text-sm font-medium text-gray-700 mb-3">
                Plan Olustur
              </h4>
              <div className="space-y-2">
                {employeesWithoutPlans.slice(0, 5).map((emp) => (
                  <button
                    key={emp.id}
                    onClick={() => handleCreatePlan(emp.id)}
                    disabled={createPlanMutation.isPending}
                    className={cn(
                      'w-full flex items-center gap-2 px-3 py-2 text-left',
                      'text-sm text-gray-700 bg-gray-50 rounded-lg',
                      'hover:bg-gray-100 transition-colors',
                      'disabled:opacity-50 disabled:cursor-not-allowed'
                    )}
                  >
                    <Plus className="h-4 w-4 text-gray-400" />
                    <div className="flex-1 min-w-0 truncate">
                      {emp.firstName} {emp.lastName}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Main Content */}
        <div className="flex-1 p-6">
          {isLoading ? (
            <div className="space-y-4" role="status" aria-label="Planlar yukleniyor" aria-busy="true">
              <span className="sr-only">Planlar yukleniyor, lutfen bekleyin...</span>
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="bg-white rounded-xl shadow-sm p-6 animate-pulse"
                  aria-hidden="true"
                >
                  <div className="h-6 bg-gray-200 rounded w-1/4 mb-4" />
                  <div className="h-20 bg-gray-100 rounded" />
                </div>
              ))}
            </div>
          ) : !plansData?.items.length ? (
            <div className="bg-white rounded-xl shadow-sm p-12 text-center">
              <Users className="h-12 w-12 text-gray-300 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">
                Bu hafta icin plan yok
              </h3>
              <p className="text-gray-500 mb-6">
                Soldaki listeden calisan secin ve plan olusturun.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {plansData.items.map((plan) => (
                <div
                  key={plan.id}
                  className={cn(
                    'bg-white rounded-xl shadow-sm overflow-hidden',
                    selectedPlan?.id === plan.id && 'ring-2 ring-indigo-500'
                  )}
                >
                  {/* Plan Header */}
                  <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-full bg-indigo-100 flex items-center justify-center">
                        <span className="text-indigo-600 font-medium">
                          {plan.employee?.firstName?.[0]}
                          {plan.employee?.lastName?.[0]}
                        </span>
                      </div>
                      <div>
                        <h3 className="font-semibold text-gray-900">
                          {plan.employee?.firstName} {plan.employee?.lastName}
                        </h3>
                        <p className="text-sm text-gray-500">
                          {plan.employee?.position || 'Pozisyon belirtilmemis'}
                        </p>
                      </div>
                    </div>

                    {/* Plan Actions */}
                    <div className="flex items-center gap-2" role="group" aria-label="Plan islemleri">
                      <button
                        onClick={() => openCopyModal(plan)}
                        className="p-2 text-gray-500 hover:bg-gray-100 rounded-lg transition-colors"
                        aria-label={`${plan.employee?.firstName} ${plan.employee?.lastName} icin haftayi kopyala`}
                      >
                        <Copy className="h-4 w-4" aria-hidden="true" />
                      </button>

                      {plan.status === 'draft' && (
                        <button
                          onClick={() => handlePublishPlan(plan.id)}
                          disabled={publishMutation.isPending}
                          aria-label={`${plan.employee?.firstName} ${plan.employee?.lastName} planini yayinla`}
                          className={cn(
                            'flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium',
                            'text-white bg-green-600 rounded-lg',
                            'hover:bg-green-700 transition-colors',
                            'disabled:opacity-50'
                          )}
                        >
                          <Send className="h-4 w-4" aria-hidden="true" />
                          Yayinla
                        </button>
                      )}

                      {plan.status === 'published' && (
                        <span
                          className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-green-700 bg-green-100 rounded-lg"
                          role="status"
                          aria-label="Plan durumu: Yayinlandi"
                        >
                          <Check className="h-4 w-4" aria-hidden="true" />
                          Yayinlandi
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Calendar Grid */}
                  <div className="p-6">
                    <WeeklyCalendarGrid
                      plan={plan}
                      isEditable={plan.status === 'draft'}
                      onUpdateEntry={(entryId, shiftId, isOffDay) =>
                        handleUpdateEntry(entryId, shiftId, isOffDay)
                      }
                    />
                  </div>

                  {/* Notes */}
                  {plan.notes && (
                    <div className="px-6 pb-4">
                      <div className="p-3 bg-amber-50 rounded-lg text-sm text-amber-800">
                        <strong>Not:</strong> {plan.notes}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Pagination info */}
          {plansData && plansData.total > plansData.items.length && (
            <div className="mt-4 text-center text-sm text-gray-500">
              {plansData.items.length} / {plansData.total} plan gosteriliyor
            </div>
          )}
        </div>
      </div>

      {/* Copy Modal */}
      {showCopyModal && copySourcePlan && (
        <CopyWeekModal
          isOpen={showCopyModal}
          onClose={() => {
            setShowCopyModal(false);
            setCopySourcePlan(null);
          }}
          onConfirm={(targetWeekStart) =>
            handleCopyPlan(copySourcePlan.id, targetWeekStart)
          }
          sourcePlanId={copySourcePlan.id}
          sourceWeekStart={copySourcePlan.weekStartDate}
          employeeName={`${copySourcePlan.employee?.firstName} ${copySourcePlan.employee?.lastName}`}
          isLoading={copyPlanMutation.isPending}
        />
      )}

      {/* Error toast - ARIA live region for screen readers */}
      {(createPlanMutation.error ||
        updateEntryMutation.error ||
        copyPlanMutation.error ||
        publishMutation.error) && (
        <div
          className="fixed bottom-4 right-4 bg-red-50 border border-red-200 rounded-lg p-4 shadow-lg max-w-md"
          role="alert"
          aria-live="assertive"
        >
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-red-600 flex-shrink-0" aria-hidden="true" />
            <div>
              <h4 className="font-medium text-red-800">Hata</h4>
              <p className="text-sm text-red-600 mt-1">
                {createPlanMutation.error?.message ||
                  updateEntryMutation.error?.message ||
                  copyPlanMutation.error?.message ||
                  publishMutation.error?.message}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
    </SchedulingKeyboardProvider>
    </SchedulingErrorBoundary>
  );
}

export default WeeklySchedulePage;
