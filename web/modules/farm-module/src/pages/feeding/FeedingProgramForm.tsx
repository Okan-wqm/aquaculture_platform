/**
 * Feeding Program Form
 *
 * Multi-step form for creating and editing feeding programs.
 * Steps:
 * 1. Basic Information (Name, Code, Description, Start Date)
 * 2. Tank Selection (MultiSelect with optional temperature sensor)
 * 3. Feed Assignments (Weight ranges with feed selection)
 * 4. FCR Table (Optional custom FCR matrix)
 * 5. Settings (Auto-transition, notifications)
 */
import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, Button, Input, Textarea, Alert, Switch, DatePicker, MultiSelect, MultiSelectOption, useAuth, createTenantQueryKey, createTenantInvalidationKey, graphqlClient } from '@aquaculture/shared-ui';
import { useEquipmentList } from '../../hooks/useEquipment';
import { useFeedList, FeedingMatrix2D, Feed } from '../../hooks/useFeeds';
import { FeedingMatrixEditor } from '../../components/feeding';
import {
  CREATE_FEEDING_PROGRAM,
  UPDATE_FEEDING_PROGRAM,
} from '../../graphql/feedingProgram.mutations';
import { FEEDING_PROGRAM_QUERY } from '../../graphql/feedingProgram.queries';

// ============================================================================
// Constants
// ============================================================================

const MAX_NAME_LENGTH = 100;
const MAX_CODE_LENGTH = 50;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_TRANSITION_BUFFER = 100;
const MIN_WEIGHT = 0;
const MAX_WEIGHT = 100000;

// ============================================================================
// Types
// ============================================================================

interface TankWithSensor {
  tankId: string;
  tankName: string;
  tankCode: string;
  temperatureSensorId?: string;
}

interface FeedAssignment {
  id: string;
  minWeight: number;
  maxWeight: number;
  feedId: string;
  priority: number;
}

interface FeedingProgramFormData {
  // Step 1: Basic Info
  name: string;
  code: string;
  description: string;
  startDate: Date | null;
  endDate: Date | null;

  // Step 2: Tank Selection
  selectedTanks: TankWithSensor[];

  // Step 3: Feed Assignments
  feedAssignments: FeedAssignment[];

  // Step 4: FCR Table
  useFeedFCR: boolean;
  customFCRMatrix: FeedingMatrix2D | null;

  // Step 5: Settings
  autoTransition: boolean;
  transitionBuffer: number;
  notifyOnTransition: boolean;
  mealsPerDay: number;
}

// GraphQL Input Types
interface CreateFeedingProgramInput {
  name: string;
  code?: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  tankIds: Array<{
    equipmentId: string;
    temperatureSensorId?: string;
  }>;
  feedAssignments: Array<{
    feedId: string;
    minWeightG: number;
    maxWeightG: number;
    priority: number;
  }>;
  fcrTable?: {
    temperatures: number[];
    weights: number[];
    fcrValues: number[][];
  };
  settings: {
    autoTransition: boolean;
    transitionBuffer: number;
    notifyOnTransition: boolean;
    fcrSource: 'PROGRAM' | 'FEED';
    defaultMealsPerDay: number;
  };
}

interface UpdateFeedingProgramInput extends Partial<CreateFeedingProgramInput> {
  id: string;
}

interface FeedingProgram {
  id: string;
  name: string;
  code: string;
  description?: string;
  status: string;
  startDate?: string;
  endDate?: string;
  feedAssignments: Array<{
    feedId: string;
    minWeightG: number;
    maxWeightG: number;
    priority: number;
  }>;
  fcrTable?: {
    temperatures: number[];
    weights: number[];
    fcrValues: number[][];
  };
  settings?: {
    autoTransition: boolean;
    transitionBuffer: number;
    notifyOnTransition: boolean;
    fcrSource: 'PROGRAM' | 'FEED';
    defaultMealsPerDay: number;
  };
  tanks?: Array<{
    id: string;
    equipmentId: string;
    equipmentName: string;
    equipmentCode: string;
    temperatureSensorId?: string;
  }>;
}

interface ValidationErrors {
  [key: string]: string;
}

const initialFormData: FeedingProgramFormData = {
  name: '',
  code: '',
  description: '',
  startDate: null,
  endDate: null,
  selectedTanks: [],
  feedAssignments: [],
  useFeedFCR: true,
  customFCRMatrix: null,
  autoTransition: true,
  transitionBuffer: 5,
  notifyOnTransition: true,
  mealsPerDay: 3,
};

// Default FCR matrix for custom FCR mode
const getDefaultFCRMatrix = (): FeedingMatrix2D => ({
  temperatures: [14, 16, 18, 20, 22, 24],
  weights: [50, 100, 200, 400, 800, 1500],
  rates: [
    [2.5, 2.8, 3.0, 3.2, 3.0, 2.8],
    [2.2, 2.5, 2.8, 3.0, 2.8, 2.5],
    [1.8, 2.0, 2.3, 2.5, 2.3, 2.0],
    [1.5, 1.7, 2.0, 2.2, 2.0, 1.7],
    [1.2, 1.4, 1.6, 1.8, 1.6, 1.4],
    [1.0, 1.2, 1.4, 1.5, 1.4, 1.2],
  ],
  fcrMatrix: [
    [1.3, 1.25, 1.2, 1.15, 1.2, 1.25],
    [1.25, 1.2, 1.15, 1.1, 1.15, 1.2],
    [1.2, 1.15, 1.1, 1.05, 1.1, 1.15],
    [1.15, 1.1, 1.05, 1.0, 1.05, 1.1],
    [1.1, 1.05, 1.0, 0.95, 1.0, 1.05],
    [1.05, 1.0, 0.95, 0.9, 0.95, 1.0],
  ],
  temperatureUnit: 'celsius',
  weightUnit: 'gram',
});

// ============================================================================
// GraphQL Hooks
// ============================================================================

/**
 * Hook to fetch a feeding program by ID
 */
function useFeedingProgram(id: string | undefined) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'feeding-program', id),
    queryFn: async () => {
      if (!id) throw new Error('Program ID required');
      const data = await graphqlClient.request<{ feedingProgram: FeedingProgram }>(
        FEEDING_PROGRAM_QUERY,
        { id }
      );
      return data.feedingProgram;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId && !!id,
  });
}

/**
 * Hook to create a feeding program
 */
function useCreateFeedingProgram() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateFeedingProgramInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }

      const data = await graphqlClient.request<{ createFeedingProgram: FeedingProgram }>(
        CREATE_FEEDING_PROGRAM,
        { input }
      );
      return data.createFeedingProgram;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'feeding-programs') });
    },
  });
}

/**
 * Hook to update a feeding program
 */
function useUpdateFeedingProgram() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: Partial<CreateFeedingProgramInput> }) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }

      const data = await graphqlClient.request<{ updateFeedingProgram: FeedingProgram }>(
        UPDATE_FEEDING_PROGRAM,
        { id, input }
      );
      return data.updateFeedingProgram;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'feeding-programs') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'feeding-program', variables.id) });
    },
  });
}

// ============================================================================
// Data Transformation Functions
// ============================================================================

/**
 * Transform form data to API input format
 */
function transformFormDataToInput(formData: FeedingProgramFormData): CreateFeedingProgramInput {
  return {
    name: formData.name.trim(),
    code: formData.code?.trim() || undefined,
    description: formData.description?.trim() || undefined,
    startDate: formData.startDate?.toISOString().split('T')[0],
    endDate: formData.endDate?.toISOString().split('T')[0],
    tankIds: formData.selectedTanks.map((tank) => ({
      equipmentId: tank.tankId,
      equipmentType: 'TANK',
      temperatureSensorId: tank.temperatureSensorId || undefined,
    })),
    feedAssignments: formData.feedAssignments.map((fa) => ({
      feedId: fa.feedId,
      minWeightG: fa.minWeight,
      maxWeightG: fa.maxWeight,
      priority: fa.priority,
    })),
    fcrTable:
      !formData.useFeedFCR && formData.customFCRMatrix
        ? (() => {
            // Frontend builds matrix as [weight][temperature] but backend expects [temperature][weight]
            const srcMatrix = formData.customFCRMatrix.fcrMatrix || formData.customFCRMatrix.rates;
            const temps = formData.customFCRMatrix.temperatures;
            const wts = formData.customFCRMatrix.weights;
            // Transpose: srcMatrix[w][t] → fcrValues[t][w]
            const fcrValues = srcMatrix && temps && wts
              ? temps.map((_: number, tIdx: number) => wts.map((_: number, wIdx: number) => srcMatrix[wIdx]?.[tIdx] ?? 0))
              : srcMatrix;
            return {
              temperatures: temps,
              weights: wts,
              fcrValues,
            };
          })()
        : undefined,
    settings: {
      autoTransition: formData.autoTransition,
      transitionBuffer: formData.transitionBuffer,
      notifyOnTransition: formData.notifyOnTransition,
      fcrSource: formData.useFeedFCR ? 'FEED' : 'PROGRAM',
      defaultMealsPerDay: formData.mealsPerDay,
    },
  };
}

/**
 * Transform API response to form data format
 */
function transformProgramToFormData(
  program: FeedingProgram,
  equipmentData?: { id: string; name: string; code: string }[]
): FeedingProgramFormData {
  const tanks: TankWithSensor[] = (program.tanks || []).map((tank) => ({
    tankId: tank.equipmentId,
    tankName: tank.equipmentName,
    tankCode: tank.equipmentCode,
    temperatureSensorId: tank.temperatureSensorId,
  }));

  const feedAssignments: FeedAssignment[] = (program.feedAssignments || []).map((fa, index) => ({
    id: crypto.randomUUID(),
    minWeight: fa.minWeightG,
    maxWeight: fa.maxWeightG,
    feedId: fa.feedId,
    priority: fa.priority || index + 1,
  }));

  const useFeedFCR = program.settings?.fcrSource !== 'PROGRAM';
  const customFCRMatrix: FeedingMatrix2D | null = program.fcrTable
    ? {
        temperatures: program.fcrTable.temperatures,
        weights: program.fcrTable.weights,
        rates: program.fcrTable.fcrValues,
        fcrMatrix: program.fcrTable.fcrValues,
        temperatureUnit: 'celsius',
        weightUnit: 'gram',
      }
    : null;

  return {
    name: program.name || '',
    code: program.code || '',
    description: program.description || '',
    startDate: program.startDate ? new Date(program.startDate) : null,
    endDate: program.endDate ? new Date(program.endDate) : null,
    selectedTanks: tanks,
    feedAssignments,
    useFeedFCR,
    customFCRMatrix,
    autoTransition: program.settings?.autoTransition ?? true,
    transitionBuffer: program.settings?.transitionBuffer ?? 5,
    notifyOnTransition: program.settings?.notifyOnTransition ?? true,
    mealsPerDay: program.settings?.defaultMealsPerDay ?? 3,
  };
}

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Consolidated validation function for all steps
 */
function validateFormData(
  formData: FeedingProgramFormData,
  step?: number
): ValidationErrors {
  const errors: ValidationErrors = {};

  // Step 1: Basic Info validation
  if (step === undefined || step === 1) {
    if (!formData.name.trim()) {
      errors.name = 'Program adi zorunludur';
    } else if (formData.name.trim().length > MAX_NAME_LENGTH) {
      errors.name = `Program adi en fazla ${MAX_NAME_LENGTH} karakter olabilir`;
    }

    if (!formData.code.trim()) {
      errors.code = 'Kod zorunludur';
    } else if (formData.code.trim().length > MAX_CODE_LENGTH) {
      errors.code = `Kod en fazla ${MAX_CODE_LENGTH} karakter olabilir`;
    } else if (!/^[A-Z0-9-_]+$/.test(formData.code.trim())) {
      errors.code = 'Kod sadece buyuk harf, rakam, tire ve alt cizgi icerebilir';
    }

    if (!formData.startDate) {
      errors.startDate = 'Baslangic tarihi zorunludur';
    }

    if (formData.description && formData.description.length > MAX_DESCRIPTION_LENGTH) {
      errors.description = `Aciklama en fazla ${MAX_DESCRIPTION_LENGTH} karakter olabilir`;
    }

    if (formData.startDate && formData.endDate && formData.endDate < formData.startDate) {
      errors.endDate = 'Bitis tarihi baslangic tarihinden sonra olmalidir';
    }
  }

  // Step 2: Tank Selection validation
  if (step === undefined || step === 2) {
    if (formData.selectedTanks.length === 0) {
      errors.selectedTanks = 'En az bir tank secmelisiniz';
    }
  }

  // Step 3: Feed Assignments validation
  if (step === undefined || step === 3) {
    if (formData.feedAssignments.length === 0) {
      errors.feedAssignments = 'En az bir yem atamasi eklemelisiniz';
    } else {
      // Validate each assignment
      for (let i = 0; i < formData.feedAssignments.length; i++) {
        const assignment = formData.feedAssignments[i];
        if (!assignment) continue;

        if (assignment.minWeight < MIN_WEIGHT) {
          errors.feedAssignments = `Satir ${i + 1}: Minimum agirlik ${MIN_WEIGHT} veya daha buyuk olmalidir`;
          break;
        }

        if (assignment.maxWeight > MAX_WEIGHT) {
          errors.feedAssignments = `Satir ${i + 1}: Maksimum agirlik ${MAX_WEIGHT} veya daha kucuk olmalidir`;
          break;
        }

        if (assignment.minWeight >= assignment.maxWeight) {
          errors.feedAssignments = `Satir ${i + 1}: Minimum agirlik maksimum agirliktan kucuk olmalidir`;
          break;
        }

        if (!assignment.feedId) {
          errors.feedAssignments = 'Tum yem atamalari icin yem secmelisiniz';
          break;
        }
      }

      // Check for overlaps with improved algorithm
      if (!errors.feedAssignments) {
        const overlapError = checkWeightRangeOverlaps(formData.feedAssignments);
        if (overlapError) {
          errors.feedAssignments = overlapError;
        }
      }
    }
  }

  // Step 4: FCR Table validation (optional - matrix auto-generated from feeds)
  if (step === undefined || step === 4) {
    // Matrix is auto-generated from feed assignments, so no strict requirement
    // But if assignments exist and no matrix could be built, warn
    if (formData.feedAssignments.length > 0 && formData.feedAssignments.some((a) => a.feedId) && !formData.customFCRMatrix) {
      errors.customFCRMatrix = 'Matris hesaplanamadi. Yem atamalarini kontrol edin.';
    }
  }

  // Step 5: Settings validation
  if (step === undefined || step === 5) {
    if (formData.autoTransition) {
      if (formData.transitionBuffer < 0) {
        errors.transitionBuffer = 'Tampon degeri 0 veya daha buyuk olmalidir';
      }
      if (formData.transitionBuffer > MAX_TRANSITION_BUFFER) {
        errors.transitionBuffer = `Tampon degeri en fazla ${MAX_TRANSITION_BUFFER} gram olabilir`;
      }
    }

    if (formData.mealsPerDay < 1 || formData.mealsPerDay > 10) {
      errors.mealsPerDay = 'Gunluk ogun sayisi 1-10 arasinda olmalidir';
    }
  }

  return errors;
}

/**
 * Check for weight range overlaps with fixed algorithm
 * Handles edge cases: adjacent ranges, same min/max values
 */
function checkWeightRangeOverlaps(assignments: FeedAssignment[]): string | null {
  if (assignments.length < 2) return null;

  // Sort by minWeight for easier comparison
  const sorted = [...assignments].sort((a, b) => a.minWeight - b.minWeight);

  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i];
    const next = sorted[i + 1];

    if (!current || !next) continue;

    // Two ranges overlap if: current.max > next.min
    // Adjacent ranges (current.max === next.min) are allowed
    if (current.maxWeight > next.minWeight) {
      // Find original indices for error message
      const currentOrigIdx = assignments.findIndex((a) => a.id === current.id) + 1;
      const nextOrigIdx = assignments.findIndex((a) => a.id === next.id) + 1;
      return `Satir ${currentOrigIdx} ve ${nextOrigIdx} arasinda aralik cakismasi var (${current.minWeight}-${current.maxWeight}g ve ${next.minWeight}-${next.maxWeight}g)`;
    }
  }

  return null;
}

/**
 * Parse GraphQL error response for field-level errors
 */
function parseGraphQLErrors(error: unknown): { message: string; fieldErrors: ValidationErrors } {
  const fieldErrors: ValidationErrors = {};
  let message = 'Beklenmeyen bir hata olustu';

  if (error instanceof Error) {
    message = error.message;

    // Try to parse GraphQL validation errors
    try {
      const errorObj = error as { response?: { errors?: Array<{ message: string; extensions?: { field?: string } }> } };
      if (errorObj.response?.errors) {
        for (const err of errorObj.response.errors) {
          if (err.extensions?.field) {
            fieldErrors[err.extensions.field] = err.message;
          }
        }
        if (errorObj.response.errors[0]) {
          message = errorObj.response.errors[0].message;
        }
      }
    } catch {
      // Ignore parsing errors
    }
  }

  return { message, fieldErrors };
}

// ============================================================================
// Stepper Component
// ============================================================================

interface StepperProps {
  steps: { id: number; title: string; description?: string }[];
  currentStep: number;
  onStepClick?: (step: number) => void;
  completedSteps?: Set<number>;
  validateStep?: (step: number) => boolean;
}

const Stepper: React.FC<StepperProps> = ({
  steps,
  currentStep,
  onStepClick,
  completedSteps = new Set(),
  validateStep,
}) => {
  const handleStepClick = (stepId: number) => {
    if (!onStepClick) return;

    // Allow going to any previous step
    if (stepId < currentStep) {
      onStepClick(stepId);
      return;
    }

    // For forward navigation, validate current step first
    if (stepId > currentStep && validateStep) {
      if (!validateStep(currentStep)) {
        return; // Don't navigate if current step is invalid
      }
    }

    // Only allow one step forward
    if (stepId === currentStep + 1 || stepId <= currentStep) {
      onStepClick(stepId);
    }
  };

  return (
    <nav aria-label="Progress" className="mb-8">
      <ol className="flex items-center" role="list">
        {steps.map((step, index) => {
          const isCompleted = completedSteps.has(step.id) || currentStep > step.id;
          const isCurrent = currentStep === step.id;
          const isClickable = onStepClick && (step.id <= currentStep || step.id === currentStep + 1);

          return (
            <li
              key={step.id}
              className={`relative ${index !== steps.length - 1 ? 'pr-8 sm:pr-20 flex-1' : ''}`}
            >
              {/* Connector line */}
              {index !== steps.length - 1 && (
                <div className="absolute top-4 left-7 -ml-px w-full" aria-hidden="true">
                  <div
                    className={`h-0.5 ${isCompleted ? 'bg-blue-600' : 'bg-gray-200'}`}
                    style={{ width: 'calc(100% - 2rem)' }}
                  />
                </div>
              )}

              {/* Step indicator */}
              <div className="relative flex items-start group">
                <span className="h-9 flex items-center" aria-hidden="true">
                  <button
                    type="button"
                    onClick={() => handleStepClick(step.id)}
                    disabled={!isClickable}
                    aria-current={isCurrent ? 'step' : undefined}
                    aria-label={`${step.title}${isCompleted ? ' (tamamlandi)' : isCurrent ? ' (mevcut)' : ''}`}
                    className={`
                      relative z-10 w-8 h-8 flex items-center justify-center rounded-full
                      transition-colors duration-200 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500
                      ${
                        isCompleted
                          ? 'bg-blue-600 group-hover:bg-blue-800'
                          : isCurrent
                          ? 'bg-white border-2 border-blue-600'
                          : 'bg-white border-2 border-gray-300'
                      }
                      ${isClickable ? 'cursor-pointer' : 'cursor-not-allowed'}
                    `}
                  >
                    {isCompleted ? (
                      <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 20 20">
                        <path
                          fillRule="evenodd"
                          d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                          clipRule="evenodd"
                        />
                      </svg>
                    ) : (
                      <span
                        className={`text-sm font-medium ${isCurrent ? 'text-blue-600' : 'text-gray-500'}`}
                      >
                        {step.id}
                      </span>
                    )}
                  </button>
                </span>
                <span className="ml-3 min-w-0 flex flex-col">
                  <span
                    className={`text-sm font-medium ${
                      isCurrent ? 'text-blue-600' : isCompleted ? 'text-gray-900' : 'text-gray-500'
                    }`}
                  >
                    {step.title}
                  </span>
                  {step.description && <span className="text-xs text-gray-500">{step.description}</span>}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </nav>
  );
};

// ============================================================================
// Loading Skeleton Component
// ============================================================================

const FormSkeleton: React.FC = () => (
  <div className="animate-pulse space-y-6">
    <div className="h-8 bg-gray-200 rounded w-1/4"></div>
    <div className="space-y-4">
      <div className="h-10 bg-gray-200 rounded"></div>
      <div className="h-10 bg-gray-200 rounded w-3/4"></div>
      <div className="h-24 bg-gray-200 rounded"></div>
    </div>
  </div>
);

// ============================================================================
// Cancel Confirmation Dialog
// ============================================================================

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  title,
  message,
  onConfirm,
  onCancel,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto" aria-labelledby="modal-title" role="dialog" aria-modal="true">
      <div className="flex items-end justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
        {/* Background overlay */}
        <div
          className="fixed inset-0 bg-gray-500/75 transition-opacity"
          aria-hidden="true"
          onClick={onCancel}
        ></div>

        {/* Center modal */}
        <span className="hidden sm:inline-block sm:align-middle sm:h-screen" aria-hidden="true">
          &#8203;
        </span>

        <div className="inline-block align-bottom bg-white rounded-lg px-4 pt-5 pb-4 text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-lg sm:w-full sm:p-6">
          <div className="sm:flex sm:items-start">
            <div className="mx-auto flex-shrink-0 flex items-center justify-center h-12 w-12 rounded-full bg-yellow-100 sm:mx-0 sm:h-10 sm:w-10">
              <svg
                className="h-6 w-6 text-yellow-600"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
            </div>
            <div className="mt-3 text-center sm:mt-0 sm:ml-4 sm:text-left">
              <h3 className="text-lg leading-6 font-medium text-gray-900" id="modal-title">
                {title}
              </h3>
              <div className="mt-2">
                <p className="text-sm text-gray-500">{message}</p>
              </div>
            </div>
          </div>
          <div className="mt-5 sm:mt-4 sm:flex sm:flex-row-reverse">
            <button
              type="button"
              className="w-full inline-flex justify-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-red-600 text-base font-medium text-white hover:bg-red-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-red-500 sm:ml-3 sm:w-auto sm:text-sm"
              onClick={onConfirm}
            >
              Evet, Iptal Et
            </button>
            <button
              type="button"
              className="mt-3 w-full inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-base font-medium text-gray-700 hover:bg-gray-50 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 sm:mt-0 sm:w-auto sm:text-sm"
              onClick={onCancel}
            >
              Devam Et
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Step Components
// ============================================================================

// Step 1: Basic Information
interface Step1Props {
  data: FeedingProgramFormData;
  onChange: (data: Partial<FeedingProgramFormData>) => void;
  errors: ValidationErrors;
}

const Step1BasicInfo: React.FC<Step1Props> = ({ data, onChange, errors }) => {
  const nameInputId = 'feeding-program-name';
  const codeInputId = 'feeding-program-code';
  const startDateInputId = 'feeding-program-start-date';
  const descriptionInputId = 'feeding-program-description';

  return (
    <div className="space-y-6">
      <h3 className="text-lg font-medium text-gray-900">Temel Bilgiler</h3>
      <p className="text-sm text-gray-500">Besleme programinin temel bilgilerini girin.</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2">
          <label htmlFor={nameInputId} className="block text-sm font-medium text-gray-700 mb-1">
            Program Adi <span className="text-red-500">*</span>
          </label>
          <Input
            id={nameInputId}
            name="name"
            value={data.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="Orn: Levrek Buyutme Programi"
            error={errors.name}
            maxLength={MAX_NAME_LENGTH}
            aria-describedby={errors.name ? `${nameInputId}-error` : undefined}
            aria-invalid={!!errors.name}
            required
          />
          {errors.name && (
            <p id={`${nameInputId}-error`} className="mt-1 text-sm text-red-600">
              {errors.name}
            </p>
          )}
          <p className="mt-1 text-xs text-gray-500">
            {data.name.length}/{MAX_NAME_LENGTH} karakter
          </p>
        </div>

        <div>
          <label htmlFor={codeInputId} className="block text-sm font-medium text-gray-700 mb-1">
            Kod <span className="text-red-500">*</span>
          </label>
          <Input
            id={codeInputId}
            name="code"
            value={data.code}
            onChange={(e) => onChange({ code: e.target.value.toUpperCase() })}
            placeholder="Orn: FP-2024-001"
            error={errors.code}
            maxLength={MAX_CODE_LENGTH}
            aria-describedby={errors.code ? `${codeInputId}-error` : undefined}
            aria-invalid={!!errors.code}
            required
          />
          {errors.code && (
            <p id={`${codeInputId}-error`} className="mt-1 text-sm text-red-600">
              {errors.code}
            </p>
          )}
        </div>

        <div>
          <label htmlFor={startDateInputId} className="block text-sm font-medium text-gray-700 mb-1">
            Baslangic Tarihi <span className="text-red-500">*</span>
          </label>
          <DatePicker
            value={data.startDate}
            onChange={(date) => onChange({ startDate: date })}
            placeholder="Tarih secin"
            error={errors.startDate}
            required
          />
          {errors.startDate && (
            <p id={`${startDateInputId}-error`} className="mt-1 text-sm text-red-600">
              {errors.startDate}
            </p>
          )}
        </div>

        <div className="sm:col-span-2">
          <label htmlFor={descriptionInputId} className="block text-sm font-medium text-gray-700 mb-1">
            Aciklama
          </label>
          <Textarea
            id={descriptionInputId}
            name="description"
            value={data.description}
            onChange={(e) => onChange({ description: e.target.value })}
            placeholder="Program hakkinda aciklama..."
            rows={3}
            maxLength={MAX_DESCRIPTION_LENGTH}
            aria-describedby={errors.description ? `${descriptionInputId}-error` : undefined}
            aria-invalid={!!errors.description}
          />
          {errors.description && (
            <p id={`${descriptionInputId}-error`} className="mt-1 text-sm text-red-600">
              {errors.description}
            </p>
          )}
          <p className="mt-1 text-xs text-gray-500">
            {data.description.length}/{MAX_DESCRIPTION_LENGTH} karakter
          </p>
        </div>
      </div>
    </div>
  );
};

// Step 2: Tank Selection
interface Step2Props {
  data: FeedingProgramFormData;
  onChange: (data: Partial<FeedingProgramFormData>) => void;
  errors: ValidationErrors;
}

const Step2TankSelection: React.FC<Step2Props> = ({ data, onChange, errors }) => {
  // Fetch equipment (tanks, ponds, cages)
  const { data: equipmentData, isLoading: equipmentLoading, error: equipmentError } = useEquipmentList();

  // Filter to get only tanks/ponds/cages
  const tankEquipment = useMemo(() => {
    if (!equipmentData?.items) return [];
    return equipmentData.items.filter((eq) => {
      const category = eq.equipmentType?.category?.toLowerCase() || '';
      const code = eq.equipmentType?.code?.toLowerCase() || '';
      return (
        category.includes('tank') ||
        category.includes('pond') ||
        category.includes('cage') ||
        code.includes('tank') ||
        code.includes('pond') ||
        code.includes('cage')
      );
    });
  }, [equipmentData]);

  // Filter to get temperature sensors
  const temperatureSensors = useMemo(() => {
    if (!equipmentData?.items) return [];
    return equipmentData.items.filter((eq) => {
      const category = eq.equipmentType?.category?.toLowerCase() || '';
      const code = eq.equipmentType?.code?.toLowerCase() || '';
      const name = eq.name?.toLowerCase() || '';
      return (
        category.includes('sensor') ||
        code.includes('temp') ||
        name.includes('temperature') ||
        name.includes('sicaklik')
      );
    });
  }, [equipmentData]);

  // Convert to MultiSelect options
  const tankOptions: MultiSelectOption[] = tankEquipment.map((eq) => ({
    value: eq.id,
    label: `${eq.name} (${eq.code})`,
  }));

  const sensorOptions = [
    { value: '', label: 'Sensor secilmedi' },
    ...temperatureSensors.map((s) => ({
      value: s.id,
      label: `${s.name} (${s.code})`,
    })),
  ];

  // Get selected tank IDs
  const selectedTankIds = data.selectedTanks.map((t) => t.tankId);

  // Handle tank selection change
  const handleTankChange = (values: string[]) => {
    const newTanks: TankWithSensor[] = values.map((tankId) => {
      // Keep existing sensor selection if tank was already selected
      const existing = data.selectedTanks.find((t) => t.tankId === tankId);
      if (existing) return existing;

      // Find tank info
      const tank = tankEquipment.find((eq) => eq.id === tankId);
      return {
        tankId,
        tankName: tank?.name || '',
        tankCode: tank?.code || '',
        temperatureSensorId: undefined,
      };
    });
    onChange({ selectedTanks: newTanks });
  };

  // Handle sensor selection for a tank
  const handleSensorChange = (tankId: string, sensorId: string) => {
    const newTanks = data.selectedTanks.map((t) =>
      t.tankId === tankId ? { ...t, temperatureSensorId: sensorId || undefined } : t
    );
    onChange({ selectedTanks: newTanks });
  };

  const tankSelectId = 'tank-selection';
  const sensorSelectPrefix = 'sensor-select-';

  // Show error state for equipment fetch
  if (equipmentError) {
    return (
      <div className="space-y-6">
        <h3 className="text-lg font-medium text-gray-900">Tank Secimi</h3>
        <Alert type="error">
          Ekipman verileri yuklenirken bir hata olustu. Lutfen sayfayi yenileyin.
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h3 className="text-lg font-medium text-gray-900">Tank Secimi</h3>
      <p className="text-sm text-gray-500">
        Besleme programina dahil edilecek tanklari secin. Her tank icin opsiyonel olarak sicaklik
        sensoru atayabilirsiniz.
      </p>

      {/* Tank MultiSelect */}
      <div>
        <label htmlFor={tankSelectId} className="block text-sm font-medium text-gray-700 mb-1">
          Tanklar / Havuzlar / Kafesler <span className="text-red-500">*</span>
        </label>
        <MultiSelect
          id={tankSelectId}
          options={tankOptions}
          value={selectedTankIds}
          onChange={handleTankChange}
          placeholder={equipmentLoading ? 'Yukleniyor...' : 'Tank secin...'}
          error={errors.selectedTanks}
          disabled={equipmentLoading}
          aria-describedby={errors.selectedTanks ? `${tankSelectId}-error` : undefined}
          aria-invalid={!!errors.selectedTanks}
          required
        />
        {errors.selectedTanks && (
          <p id={`${tankSelectId}-error`} className="mt-1 text-sm text-red-600">
            {errors.selectedTanks}
          </p>
        )}
      </div>

      {/* Selected tanks with sensor selection */}
      {data.selectedTanks.length > 0 && (
        <div className="mt-4">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Sicaklik Sensoru Atamalari (Opsiyonel)
          </label>
          <div className="space-y-3 bg-gray-50 rounded-lg p-4">
            {data.selectedTanks.map((tank) => (
              <div
                key={tank.tankId}
                className="flex items-center gap-4 bg-white p-3 rounded-lg border border-gray-200"
              >
                <div className="flex-1">
                  <span className="text-sm font-medium text-gray-900">{tank.tankName}</span>
                  <span className="text-xs text-gray-500 ml-2">({tank.tankCode})</span>
                </div>
                <div className="w-64">
                  <label htmlFor={`${sensorSelectPrefix}${tank.tankId}`} className="sr-only">
                    {tank.tankName} icin sicaklik sensoru
                  </label>
                  <select
                    id={`${sensorSelectPrefix}${tank.tankId}`}
                    value={tank.temperatureSensorId || ''}
                    onChange={(e) => handleSensorChange(tank.tankId, e.target.value)}
                    className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                  >
                    {sensorOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Loading state */}
      {equipmentLoading && (
        <div className="text-center py-8">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          <p className="mt-2 text-sm text-gray-500">Ekipman yukleniyor...</p>
        </div>
      )}

      {/* Empty state */}
      {!equipmentLoading && tankOptions.length === 0 && (
        <div className="text-center py-8 bg-gray-50 rounded-lg border border-dashed border-gray-300">
          <svg
            className="mx-auto h-12 w-12 text-gray-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
            />
          </svg>
          <h3 className="mt-2 text-sm font-medium text-gray-900">Tank bulunamadi</h3>
          <p className="mt-1 text-sm text-gray-500">Oncelikle ekipman ayarlarindan tank ekleyin.</p>
        </div>
      )}
    </div>
  );
};

// Step 3: Feed Assignments
interface Step3Props {
  data: FeedingProgramFormData;
  onChange: (data: Partial<FeedingProgramFormData>) => void;
  errors: ValidationErrors;
}

/**
 * Controlled number input that allows typing decimal values like "0.1"
 * without the browser clearing "0" before you can type the dot.
 */
const WeightInput: React.FC<{
  id: string;
  value: number;
  onChange: (val: number) => void;
  readOnly?: boolean;
  placeholder?: string;
  title?: string;
  className?: string;
}> = ({ id, value, onChange, readOnly, placeholder, title, className }) => {
  const [localValue, setLocalValue] = useState(String(value));
  const prevValue = useRef(value);

  // Sync from parent when value changes externally (e.g. chaining)
  useEffect(() => {
    if (value !== prevValue.current) {
      setLocalValue(String(value));
      prevValue.current = value;
    }
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setLocalValue(raw);
    const num = parseFloat(raw);
    if (!isNaN(num)) {
      prevValue.current = num;
      onChange(num);
    }
  };

  const handleBlur = () => {
    // On blur, normalize: empty or invalid → 0
    const num = parseFloat(localValue);
    const final = isNaN(num) ? 0 : num;
    setLocalValue(String(final));
    if (final !== value) {
      prevValue.current = final;
      onChange(final);
    }
  };

  return (
    <input
      id={id}
      type="number"
      min={MIN_WEIGHT}
      max={MAX_WEIGHT}
      step="0.1"
      value={localValue}
      onChange={handleChange}
      onBlur={handleBlur}
      readOnly={readOnly}
      className={className}
      placeholder={placeholder}
      title={title}
    />
  );
};

const Step3FeedAssignments: React.FC<Step3Props> = ({ data, onChange, errors }) => {
  const { data: feedsData, isLoading: feedsLoading, error: feedsError } = useFeedList();

  // All active feeds for dropdown
  const activeFeeds = useMemo(() => {
    if (!feedsData?.items) return [];
    return feedsData.items.filter((f) => f.isActive);
  }, [feedsData]);

  // Build a map for quick feed lookup
  const feedsById = useMemo(() => {
    const map = new Map<string, Feed>();
    if (feedsData?.items) {
      for (const f of feedsData.items) {
        map.set(f.id, f);
      }
    }
    return map;
  }, [feedsData]);

  // Check if a feed is suitable for a given weight range
  // Feed is suitable if its minFishWeightG <= assignment's minWeight AND maxFishWeightG >= assignment's maxWeight
  // meaning the feed covers the entire assignment range
  const isFeedInRange = useCallback((feed: Feed, minWeight: number, maxWeight: number): boolean => {
    // If feed has no weight constraints, always ok
    if (feed.minFishWeightG == null && feed.maxFishWeightG == null) return true;
    // Check min: feed must cover from the start of range
    if (feed.minFishWeightG != null && feed.minFishWeightG > minWeight) return false;
    // Check max: feed must cover to the end of range (only if maxWeight > 0)
    if (feed.maxFishWeightG != null && maxWeight > 0 && feed.maxFishWeightG < maxWeight) return false;
    return true;
  }, []);

  // Add new assignment row, auto-chain minWeight from previous row's maxWeight
  const handleAddRow = () => {
    const lastAssignment = data.feedAssignments[data.feedAssignments.length - 1];
    const newMinWeight = lastAssignment ? lastAssignment.maxWeight : 0;

    const newAssignment: FeedAssignment = {
      id: crypto.randomUUID(),
      minWeight: newMinWeight,
      maxWeight: 0,
      feedId: '',
      priority: data.feedAssignments.length + 1,
    };
    onChange({ feedAssignments: [...data.feedAssignments, newAssignment] });
  };

  // Remove assignment row and re-chain weights
  const handleRemoveRow = (id: string) => {
    const newAssignments = data.feedAssignments
      .filter((a) => a.id !== id)
      .map((a, idx, arr) => {
        // Re-chain: if not first row, set minWeight to previous row's maxWeight
        if (idx > 0 && arr[idx - 1]) {
          return { ...a, priority: idx + 1, minWeight: arr[idx - 1].maxWeight };
        }
        return { ...a, priority: idx + 1 };
      });
    onChange({ feedAssignments: newAssignments });
  };

  // Update assignment with weight chaining
  const handleUpdateAssignment = (id: string, field: keyof FeedAssignment, value: number | string) => {
    const idx = data.feedAssignments.findIndex((a) => a.id === id);
    if (idx === -1) return;

    const newAssignments = [...data.feedAssignments];
    newAssignments[idx] = { ...newAssignments[idx], [field]: value };

    // When maxWeight changes, auto-update next row's minWeight to maintain chain
    if (field === 'maxWeight' && idx < newAssignments.length - 1) {
      newAssignments[idx + 1] = { ...newAssignments[idx + 1], minWeight: value as number };
    }

    onChange({ feedAssignments: newAssignments });
  };

  // Show error state for feeds fetch
  if (feedsError) {
    return (
      <div className="space-y-6">
        <h3 className="text-lg font-medium text-gray-900">Yem Atamalari</h3>
        <Alert type="error">
          Yem verileri yuklenirken bir hata olustu. Lutfen sayfayi yenileyin.
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h3 className="text-lg font-medium text-gray-900">Yem Atamalari</h3>
      <p className="text-sm text-gray-500">
        Balik agirlik araligina gore kullanilacak yemleri tanimlayin. Araliklar cakismamalidir.
        Yeni satir eklendiginde min agirlik otomatik olarak onceki satirin max agirligina esitlenir.
      </p>

      {errors.feedAssignments && (
        <Alert type="error">{errors.feedAssignments}</Alert>
      )}

      {/* Feed Assignments Table */}
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 border border-gray-200 rounded-lg">
          <thead className="bg-gray-50">
            <tr>
              <th
                scope="col"
                className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
              >
                Oncelik
              </th>
              <th
                scope="col"
                className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
              >
                Min Agirlik (g)
              </th>
              <th
                scope="col"
                className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
              >
                Max Agirlik (g)
              </th>
              <th
                scope="col"
                className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
              >
                Yem
              </th>
              <th
                scope="col"
                className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider"
              >
                Islem
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">{data.feedAssignments.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                  Henuz yem atamasi eklenmedi. Asagidaki butonu kullanarak ekleyin.
                </td>
              </tr>
            ) : (
              data.feedAssignments.map((assignment, rowIndex) => {
                const selectedFeed = assignment.feedId ? feedsById.get(assignment.feedId) : undefined;
                const hasValidRange = assignment.minWeight < assignment.maxWeight && assignment.maxWeight > 0;
                const selectedFeedOutOfRange = !!(selectedFeed && hasValidRange &&
                  !isFeedInRange(selectedFeed, assignment.minWeight, assignment.maxWeight));
                const isMinWeightChained = rowIndex > 0;

                return (
                  <React.Fragment key={assignment.id}>
                    <tr className="hover:bg-gray-50">
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className="inline-flex items-center justify-center w-8 h-8 bg-blue-100 text-blue-800 text-sm font-medium rounded-full">
                          {assignment.priority}
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <label htmlFor={`min-weight-${assignment.id}`} className="sr-only">
                          Minimum agirlik
                        </label>
                        <WeightInput
                          id={`min-weight-${assignment.id}`}
                          value={assignment.minWeight}
                          onChange={(val) => handleUpdateAssignment(assignment.id, 'minWeight', val)}
                          readOnly={isMinWeightChained}
                          className={`w-24 border rounded-md shadow-sm px-3 py-2 text-sm focus:ring-blue-500 focus:border-blue-500 ${
                            isMinWeightChained
                              ? 'border-gray-200 bg-gray-50 text-gray-500 cursor-not-allowed'
                              : 'border-gray-300'
                          }`}
                          placeholder="0"
                          title={isMinWeightChained ? 'Onceki satirin max agirligina zincirlenmis' : undefined}
                        />
                        {isMinWeightChained && (
                          <div className="flex items-center mt-1">
                            <svg className="w-3 h-3 text-gray-400 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101" />
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.172 13.828a4 4 0 015.656 0l4 4a4 4 0 01-5.656 5.656l-1.102-1.101" />
                            </svg>
                            <span className="text-xs text-gray-400">zincirli</span>
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <label htmlFor={`max-weight-${assignment.id}`} className="sr-only">
                          Maksimum agirlik
                        </label>
                        <WeightInput
                          id={`max-weight-${assignment.id}`}
                          value={assignment.maxWeight}
                          onChange={(val) => handleUpdateAssignment(assignment.id, 'maxWeight', val)}
                          className="w-24 border border-gray-300 rounded-md shadow-sm px-3 py-2 text-sm focus:ring-blue-500 focus:border-blue-500"
                          placeholder="0"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <label htmlFor={`feed-${assignment.id}`} className="sr-only">
                          Yem secimi
                        </label>
                        <select
                          id={`feed-${assignment.id}`}
                          value={assignment.feedId}
                          onChange={(e) => handleUpdateAssignment(assignment.id, 'feedId', e.target.value)}
                          className={`w-full border rounded-md shadow-sm px-3 py-2 text-sm focus:ring-blue-500 focus:border-blue-500 ${
                            selectedFeedOutOfRange ? 'border-red-300 bg-red-50 text-red-900' : 'border-gray-300'
                          }`}
                          disabled={feedsLoading}
                        >
                          <option value="">Yem secin...</option>
                          {activeFeeds.map((feed) => {
                            const inRange = !hasValidRange || isFeedInRange(feed, assignment.minWeight, assignment.maxWeight);
                            return (
                              <option
                                key={feed.id}
                                value={feed.id}
                                style={!inRange ? { backgroundColor: '#FEE2E2', color: '#991B1B' } : undefined}
                              >
                                {`${feed.name} (${feed.code})${feed.minFishWeightG != null || feed.maxFishWeightG != null ? ` [${feed.minFishWeightG ?? '?'}-${feed.maxFishWeightG ?? '\u221E'}g]` : ''}${!inRange ? ' \u26A0' : ''}`}
                              </option>
                            );
                          })}
                        </select>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-right">
                        <button
                          type="button"
                          onClick={() => handleRemoveRow(assignment.id)}
                          className="text-red-600 hover:text-red-800 p-1"
                          title="Satiri sil"
                          aria-label={`${assignment.priority}. yem atamasini sil`}
                        >
                          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                            />
                          </svg>
                        </button>
                      </td>
                    </tr>
                    {selectedFeedOutOfRange && (
                      <tr>
                        <td colSpan={5} className="px-4 py-2">
                          <div className="flex items-center gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-md text-sm text-red-800">
                            <svg className="w-4 h-4 text-red-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                            </svg>
                            <span>
                              {`Uyari: ${selectedFeed!.name} yemi ${selectedFeed!.minFishWeightG ?? '?'}-${selectedFeed!.maxFishWeightG ?? '\u221E'}g balik icin tasarlanmistir, ancak bu atama ${assignment.minWeight}-${assignment.maxWeight}g araliginda. Yine de kullanmak istiyorsaniz kayit edebilirsiniz.`}
                            </span>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })
            )}</tbody>
        </table>
      </div>

      {/* Add Row Button */}
      <button
        type="button"
        onClick={handleAddRow}
        disabled={feedsLoading}
        className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <svg className="w-5 h-5 mr-2 -ml-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
        </svg>
        Yem Atamasi Ekle
      </button>

      {/* Feed coverage reference - 4 per row, sorted by minFishWeightG */}
      {activeFeeds.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium text-gray-500 mb-1.5">Yem Araliklari (kucukten buyuge)</p>
          <div className="grid grid-cols-4 gap-1.5">
            {activeFeeds
              .filter((f) => f.minFishWeightG != null || f.maxFishWeightG != null)
              .sort((a, b) => (a.minFishWeightG ?? 0) - (b.minFishWeightG ?? 0))
              .map((feed) => {
                const min = feed.minFishWeightG != null ? `${feed.minFishWeightG}g` : '?';
                const max = feed.maxFishWeightG != null ? `${feed.maxFishWeightG}g` : '\u221E';
                return (
                  <div key={feed.id} className="text-xs px-2 py-1 bg-gray-50 rounded border border-gray-200 truncate" title={feed.name}>
                    <span className="font-semibold text-gray-700">{`${min}-${max}`}</span>
                    <span className="text-gray-400 ml-1">{feed.code}</span>
                  </div>
                );
              })}
          </div>
        </div>
      )}
    </div>
  );
};

// Step 4: FCR Table
interface Step4Props {
  data: FeedingProgramFormData;
  onChange: (data: Partial<FeedingProgramFormData>) => void;
  errors: ValidationErrors;
}

/**
 * Bilinear interpolation for a feed's 2D matrix.
 * Given a temperature and weight, returns the interpolated value.
 */
function interpolateFromFeedMatrix(
  temps: number[],
  weights: number[],
  values: number[][],
  temp: number,
  weight: number,
): number {
  if (!temps.length || !weights.length || !values.length) return 0;

  // Clamp to matrix bounds
  const clampedTemp = Math.max(temps[0]!, Math.min(temp, temps[temps.length - 1]!));
  const clampedWeight = Math.max(weights[0]!, Math.min(weight, weights[weights.length - 1]!));

  // Find bounding temperature indices
  let ti = 0;
  for (let i = 0; i < temps.length - 1; i++) {
    if (clampedTemp >= temps[i]!) ti = i;
  }
  const ti2 = Math.min(ti + 1, temps.length - 1);

  // Find bounding weight indices
  let wi = 0;
  for (let i = 0; i < weights.length - 1; i++) {
    if (clampedWeight >= weights[i]!) wi = i;
  }
  const wi2 = Math.min(wi + 1, weights.length - 1);

  const t1 = temps[ti]!, t2 = temps[ti2]!;
  const w1 = weights[wi]!, w2 = weights[wi2]!;
  const f11 = values[wi]?.[ti] ?? 0;
  const f21 = values[wi]?.[ti2] ?? f11;
  const f12 = values[wi2]?.[ti] ?? f11;
  const f22 = values[wi2]?.[ti2] ?? f11;

  if (t1 === t2 && w1 === w2) return f11;
  if (t1 === t2) return f11 + (f12 - f11) * (clampedWeight - w1) / (w2 - w1);
  if (w1 === w2) return f11 + (f21 - f11) * (clampedTemp - t1) / (t2 - t1);

  const denom = (t2 - t1) * (w2 - w1);
  return (
    f11 * (t2 - clampedTemp) * (w2 - clampedWeight) +
    f21 * (clampedTemp - t1) * (w2 - clampedWeight) +
    f12 * (t2 - clampedTemp) * (clampedWeight - w1) +
    f22 * (clampedTemp - t1) * (clampedWeight - w1)
  ) / denom;
}

/**
 * Result of merging multiple feed matrices.
 * coverageMap[wi][ti] = true if the responsible feed covers that temperature for that weight.
 */
interface MergedMatrixResult {
  matrix: FeedingMatrix2D;
  coverageMap: boolean[][];
}

/**
 * Merge multiple feed matrices into a single combined matrix.
 * Each feed covers its assigned weight range [minWeight, maxWeight).
 * The combined temperature axis is the union of all feeds' temps.
 * The combined weight axis spans the full range with points from each feed.
 * Cells outside a feed's temperature range are marked as uncovered in coverageMap.
 */
function buildMergedMatrix(
  assignments: FeedAssignment[],
  feedsById: Map<string, Feed>,
): MergedMatrixResult | null {
  // Filter valid assignments with feeds that have 2D matrices
  const validAssignments = assignments
    .filter((a) => a.feedId && a.minWeight < a.maxWeight)
    .sort((a, b) => a.minWeight - b.minWeight);

  if (validAssignments.length === 0) return null;

  // Collect all temperature points (union, deduplicated, sorted)
  const tempSet = new Set<number>();
  for (const a of validAssignments) {
    const feed = feedsById.get(a.feedId);
    const matrix = feed?.feedingMatrix2D;
    if (matrix?.temperatures) {
      for (const t of matrix.temperatures) tempSet.add(t);
    }
  }
  if (tempSet.size === 0) return null;
  const temperatures = Array.from(tempSet).sort((a, b) => a - b);

  // Build weight axis: collect relevant weight points from each feed's matrix
  // within its assigned range, plus assignment boundaries
  const weightSet = new Set<number>();
  for (const a of validAssignments) {
    weightSet.add(a.minWeight);
    weightSet.add(a.maxWeight);
    const feed = feedsById.get(a.feedId);
    const matrix = feed?.feedingMatrix2D;
    if (matrix?.weights) {
      for (const w of matrix.weights) {
        if (w >= a.minWeight && w <= a.maxWeight) weightSet.add(w);
      }
    }
  }
  const weights = Array.from(weightSet).sort((a, b) => a - b);
  if (weights.length < 2) return null;

  // Build rate and FCR matrices by interpolating from the responsible feed
  const rates: number[][] = [];
  const fcrMatrix: number[][] = [];
  const coverageMap: boolean[][] = [];

  for (const weight of weights) {
    const rateRow: number[] = [];
    const fcrRow: number[] = [];
    const coverageRow: boolean[] = [];

    // Find which assignment covers this weight
    let responsible = validAssignments[0]!;
    for (const a of validAssignments) {
      if (weight >= a.minWeight && weight <= a.maxWeight) {
        responsible = a;
        break;
      }
      if (weight >= a.minWeight) responsible = a;
    }

    const feed = feedsById.get(responsible.feedId);
    const matrix = feed?.feedingMatrix2D;

    // Determine the responsible feed's temperature range
    const feedTempMin = matrix?.temperatures?.[0];
    const feedTempMax = matrix?.temperatures?.[matrix.temperatures.length - 1];

    for (const temp of temperatures) {
      // Check if this temperature is within the responsible feed's range
      const isCovered = matrix?.temperatures && matrix?.weights && matrix?.rates &&
        feedTempMin != null && feedTempMax != null &&
        temp >= feedTempMin && temp <= feedTempMax;

      coverageRow.push(!!isCovered);

      if (isCovered) {
        const rate = interpolateFromFeedMatrix(
          matrix!.temperatures, matrix!.weights, matrix!.rates, temp, weight,
        );
        rateRow.push(+rate.toFixed(2));

        if (matrix!.fcrMatrix) {
          const fcr = interpolateFromFeedMatrix(
            matrix!.temperatures, matrix!.weights, matrix!.fcrMatrix, temp, weight,
          );
          fcrRow.push(+fcr.toFixed(3));
        } else {
          fcrRow.push(1.0);
        }
      } else {
        // Out of range - put 0 as placeholder (will be shown as "×")
        rateRow.push(0);
        fcrRow.push(0);
      }
    }

    rates.push(rateRow);
    fcrMatrix.push(fcrRow);
    coverageMap.push(coverageRow);
  }

  return {
    matrix: {
      temperatures,
      weights,
      rates,
      fcrMatrix,
      temperatureUnit: 'celsius',
      weightUnit: 'gram',
    },
    coverageMap,
  };
}

const Step4FCRTable: React.FC<Step4Props> = ({ data, onChange, errors }) => {
  const { data: feedsData } = useFeedList();
  const [hasUserEdited, setHasUserEdited] = useState(false);

  // Build feeds map
  const feedsById = useMemo(() => {
    const map = new Map<string, Feed>();
    if (feedsData?.items) {
      for (const f of feedsData.items) map.set(f.id, f);
    }
    return map;
  }, [feedsData]);

  // Compute merged matrix from feed assignments
  const mergedResult = useMemo(() => {
    return buildMergedMatrix(data.feedAssignments, feedsById);
  }, [data.feedAssignments, feedsById]);

  const mergedMatrix = mergedResult?.matrix ?? null;
  const coverageMap = mergedResult?.coverageMap ?? null;

  // Auto-initialize customFCRMatrix from merged matrix when assignments change
  // (only if user hasn't manually edited yet)
  useEffect(() => {
    if (mergedMatrix && !hasUserEdited) {
      onChange({ customFCRMatrix: mergedMatrix, useFeedFCR: false });
    }
  }, [mergedMatrix, hasUserEdited]);

  // Handle recalculate button
  const handleRecalculate = () => {
    if (mergedMatrix) {
      onChange({ customFCRMatrix: mergedMatrix });
      setHasUserEdited(false);
    }
  };

  // Handle manual edits
  const handleMatrixChange = (matrix: FeedingMatrix2D) => {
    setHasUserEdited(true);
    onChange({ customFCRMatrix: matrix });
  };

  // Check how many feeds have 2D matrices
  const feedsWithMatrix = data.feedAssignments.filter((a) => {
    const feed = feedsById.get(a.feedId);
    return feed?.feedingMatrix2D?.rates;
  });
  const feedsWithoutMatrix = data.feedAssignments.filter((a) => {
    if (!a.feedId) return false;
    const feed = feedsById.get(a.feedId);
    return !feed?.feedingMatrix2D?.rates;
  });

  const hasAssignments = data.feedAssignments.length > 0 && data.feedAssignments.some((a) => a.feedId);

  return (
    <div className="space-y-6">
      <h3 className="text-lg font-medium text-gray-900">Besleme & FCR Matrisi</h3>
      <p className="text-sm text-gray-500">
        Yem atamalarindaki yemlerin besleme egrilerinden otomatik olarak birlesmis matris hesaplandi.
        Degerler, her agirlik araligindaki yemin 2D matrisinden interpolasyon ile elde edilmistir.
        Gerekirse degerleri duzenleyebilirsiniz.
      </p>

      {/* Feed matrix summary */}
      {hasAssignments && (
        <div className="bg-gray-50 rounded-lg p-4">
          <h4 className="text-sm font-medium text-gray-900 mb-2">Yem Matrisi Durumu</h4>
          <div className="space-y-1">
            {data.feedAssignments.filter((a) => a.feedId).map((a) => {
              const feed = feedsById.get(a.feedId);
              const hasMatrix = !!feed?.feedingMatrix2D?.rates;
              return (
                <div key={a.id} className="flex items-center gap-2 text-sm">
                  <span className={`inline-block w-2 h-2 rounded-full ${hasMatrix ? 'bg-green-500' : 'bg-yellow-500'}`} />
                  <span className="text-gray-700">
                    {a.minWeight}-{a.maxWeight}g: {feed?.name || 'Secilmedi'}
                  </span>
                  {hasMatrix ? (
                    <span className="text-xs text-green-600">
                      {`2D matris mevcut (${feed!.feedingMatrix2D!.temperatures[0]}°C - ${feed!.feedingMatrix2D!.temperatures[feed!.feedingMatrix2D!.temperatures.length - 1]}°C)`}
                    </span>
                  ) : (
                    <span className="text-xs text-yellow-600">
                      Matris yok (varsayilan kullanildi)
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Warning for feeds without matrix */}
      {feedsWithoutMatrix.length > 0 && (
        <Alert type="warning">
          {feedsWithoutMatrix.length} yem icin 2D besleme matrisi tanimlanmamis. Bu araliklar icin
          varsayilan degerler kullanildi (oran: 2.0%, FCR: 1.0).
        </Alert>
      )}

      {/* No assignments warning */}
      {!hasAssignments && (
        <div className="text-center py-8 bg-gray-50 rounded-lg border border-dashed border-gray-300">
          <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
          </svg>
          <h3 className="mt-2 text-sm font-medium text-gray-900">Matris hesaplanamadi</h3>
          <p className="mt-1 text-sm text-gray-500">
            Onceki adimda yem atamalari tanimlayin. Matris otomatik hesaplanacaktir.
          </p>
        </div>
      )}

      {/* Matrix editor */}
      {data.customFCRMatrix && hasAssignments && (
        <>
          {/* Recalculate button */}
          {hasUserEdited && mergedMatrix && (
            <div className="flex items-center gap-3 p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <svg className="w-5 h-5 text-amber-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              <span className="text-sm text-amber-800 flex-1">
                Matrisi manuel olarak duzenlediniz. Yem atamalarindan yeniden hesaplamak ister misiniz?
              </span>
              <button
                type="button"
                onClick={handleRecalculate}
                className="px-3 py-1.5 text-sm font-medium text-amber-800 bg-amber-100 border border-amber-300 rounded-md hover:bg-amber-200"
              >
                Yeniden Hesapla
              </button>
            </div>
          )}

          {errors.customFCRMatrix && (
            <Alert type="error">{errors.customFCRMatrix}</Alert>
          )}

          <div className="border border-gray-200 rounded-lg p-4">
            <FeedingMatrixEditor
              matrix={data.customFCRMatrix}
              onChange={handleMatrixChange}
              showFCR={true}
              coverageMap={coverageMap ?? undefined}
            />
          </div>
        </>
      )}
    </div>
  );
};

// Step 5: Settings
interface Step5Props {
  data: FeedingProgramFormData;
  onChange: (data: Partial<FeedingProgramFormData>) => void;
  errors: ValidationErrors;
}

const Step5Settings: React.FC<Step5Props> = ({ data, onChange, errors }) => {
  const transitionBufferId = 'transition-buffer';
  const mealsPerDayId = 'meals-per-day';

  return (
    <div className="space-y-6">
      <h3 className="text-lg font-medium text-gray-900">Ayarlar</h3>
      <p className="text-sm text-gray-500">Besleme programi davranislarini yapilandirin.</p>

      <div className="space-y-4">
        {/* Auto Transition */}
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <h4 id="auto-transition-label" className="text-sm font-medium text-gray-900">
                Otomatik Gecis
              </h4>
              <p className="text-sm text-gray-500 mt-1">
                Baliklar bir sonraki agirlik araligina ulastiginda otomatik olarak yem degisikligi
                yapilsin.
              </p>
            </div>
            <Switch
              checked={data.autoTransition}
              onChange={(e) => onChange({ autoTransition: e.target.checked })}
              aria-labelledby="auto-transition-label"
            />
          </div>
        </div>

        {/* Transition Buffer - Only show if auto transition is enabled */}
        {data.autoTransition && (
          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <label htmlFor={transitionBufferId} className="block text-sm font-medium text-gray-900 mb-2">
              Gecis Tampon Bolgesi (gram)
            </label>
            <p className="text-sm text-gray-500 mb-3">
              Yem degisikligi yapilmadan once agirlik araliginin ne kadar asildigi. Bu deger ani
              gecisleri onler ve daha yumusak bir gecis saglar.
            </p>
            <div className="flex items-center gap-2">
              <input
                id={transitionBufferId}
                type="number"
                min="0"
                max={MAX_TRANSITION_BUFFER}
                value={data.transitionBuffer}
                onChange={(e) => onChange({ transitionBuffer: parseFloat(e.target.value) || 0 })}
                className="w-24 border border-gray-300 rounded-md shadow-sm px-3 py-2 text-sm focus:ring-blue-500 focus:border-blue-500"
                aria-describedby={errors.transitionBuffer ? `${transitionBufferId}-error` : undefined}
                aria-invalid={!!errors.transitionBuffer}
              />
              <span className="text-sm text-gray-500">gram</span>
            </div>
            {errors.transitionBuffer && (
              <p id={`${transitionBufferId}-error`} className="mt-1 text-sm text-red-600">
                {errors.transitionBuffer}
              </p>
            )}
          </div>
        )}

        {/* Meals per Day */}
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <label htmlFor={mealsPerDayId} className="block text-sm font-medium text-gray-900 mb-2">
            Gunluk Ogun Sayisi
          </label>
          <p className="text-sm text-gray-500 mb-3">
            Varsayilan gunluk yemleme ogun sayisi.
          </p>
          <div className="flex items-center gap-2">
            <input
              id={mealsPerDayId}
              type="number"
              min="1"
              max="10"
              value={data.mealsPerDay}
              onChange={(e) => onChange({ mealsPerDay: parseInt(e.target.value, 10) || 3 })}
              className="w-24 border border-gray-300 rounded-md shadow-sm px-3 py-2 text-sm focus:ring-blue-500 focus:border-blue-500"
              aria-describedby={errors.mealsPerDay ? `${mealsPerDayId}-error` : undefined}
              aria-invalid={!!errors.mealsPerDay}
            />
            <span className="text-sm text-gray-500">ogun/gun</span>
          </div>
          {errors.mealsPerDay && (
            <p id={`${mealsPerDayId}-error`} className="mt-1 text-sm text-red-600">
              {errors.mealsPerDay}
            </p>
          )}
        </div>

        {/* Notify on Transition */}
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <h4 id="notify-transition-label" className="text-sm font-medium text-gray-900">
                Gecis Bildirimi
              </h4>
              <p className="text-sm text-gray-500 mt-1">
                Yem gecisi gerceklestiginde bildirim gonderilsin.
              </p>
            </div>
            <Switch
              checked={data.notifyOnTransition}
              onChange={(e) => onChange({ notifyOnTransition: e.target.checked })}
              aria-labelledby="notify-transition-label"
            />
          </div>
        </div>
      </div>

      {/* Summary Card */}
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mt-6">
        <h4 className="text-sm font-medium text-gray-900 mb-3">Program Ozeti</h4>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <dt className="text-gray-500">Program Adi:</dt>
          <dd className="text-gray-900 font-medium">{data.name || '-'}</dd>

          <dt className="text-gray-500">Kod:</dt>
          <dd className="text-gray-900">{data.code || '-'}</dd>

          <dt className="text-gray-500">Baslangic:</dt>
          <dd className="text-gray-900">{data.startDate?.toLocaleDateString('tr-TR') || '-'}</dd>

          <dt className="text-gray-500">Tank Sayisi:</dt>
          <dd className="text-gray-900">{data.selectedTanks.length}</dd>

          <dt className="text-gray-500">Yem Atamasi:</dt>
          <dd className="text-gray-900">{data.feedAssignments.length}</dd>

          <dt className="text-gray-500">FCR Kaynagi:</dt>
          <dd className="text-gray-900">{data.useFeedFCR ? 'Yem FCR' : 'Ozel Matris'}</dd>

          <dt className="text-gray-500">Gunluk Ogun:</dt>
          <dd className="text-gray-900">{data.mealsPerDay}</dd>
        </dl>
      </div>
    </div>
  );
};

// ============================================================================
// Main Component
// ============================================================================

const STEPS = [
  { id: 1, title: 'Temel Bilgiler', description: 'Ad, kod, tarih' },
  { id: 2, title: 'Tank Secimi', description: 'Tank ve sensor' },
  { id: 3, title: 'Yem Atamalari', description: 'Agirlik araliklari' },
  { id: 4, title: 'FCR Tablosu', description: 'Opsiyonel' },
  { id: 5, title: 'Ayarlar', description: 'Gecis ayarlari' },
];

const FeedingProgramForm: React.FC = () => {
  const { programId } = useParams<{ programId: string }>();
  const navigate = useNavigate();
  const isEdit = Boolean(programId);

  const [currentStep, setCurrentStep] = useState(1);
  const [formData, setFormData] = useState<FeedingProgramFormData>(initialFormData);
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(new Set());

  // Track initial form data for dirty checking
  const initialFormDataRef = useRef<FeedingProgramFormData>(initialFormData);
  const [isDirty, setIsDirty] = useState(false);

  // GraphQL hooks
  const { data: programData, isLoading: programLoading, error: programError } = useFeedingProgram(programId);
  const createMutation = useCreateFeedingProgram();
  const updateMutation = useUpdateFeedingProgram();

  // Load existing program data in edit mode
  useEffect(() => {
    if (programId && programData) {
      const loadedFormData = transformProgramToFormData(programData);
      setFormData(loadedFormData);
      initialFormDataRef.current = loadedFormData;
      setIsDirty(false);
    }
  }, [programId, programData]);

  // Track form dirty state
  useEffect(() => {
    const hasChanges = JSON.stringify(formData) !== JSON.stringify(initialFormDataRef.current);
    setIsDirty(hasChanges);
  }, [formData]);

  // Handle form data change
  const handleChange = useCallback((updates: Partial<FeedingProgramFormData>) => {
    setFormData((prev) => ({ ...prev, ...updates }));
    // Clear related errors
    const errorKeys = Object.keys(updates);
    setErrors((prev) => {
      const newErrors = { ...prev };
      errorKeys.forEach((key) => delete newErrors[key]);
      return newErrors;
    });
    setSubmitError(null);
  }, []);

  // Validate current step
  const validateStep = useCallback(
    (step: number): boolean => {
      const stepErrors = validateFormData(formData, step);
      setErrors((prev) => ({ ...prev, ...stepErrors }));
      return Object.keys(stepErrors).length === 0;
    },
    [formData]
  );

  // Validate all steps
  const validateAllSteps = useCallback((): boolean => {
    const allErrors = validateFormData(formData);
    setErrors(allErrors);
    return Object.keys(allErrors).length === 0;
  }, [formData]);

  // Navigation handlers
  const handleNext = () => {
    if (validateStep(currentStep)) {
      setCompletedSteps((prev) => new Set([...prev, currentStep]));
      setCurrentStep((prev) => Math.min(prev + 1, STEPS.length));
    }
  };

  const handlePrev = () => {
    setCurrentStep((prev) => Math.max(prev - 1, 1));
  };

  const handleStepClick = (step: number) => {
    // Only allow going back or to next step if current is valid
    if (step < currentStep) {
      setCurrentStep(step);
    } else if (step === currentStep + 1 && validateStep(currentStep)) {
      setCompletedSteps((prev) => new Set([...prev, currentStep]));
      setCurrentStep(step);
    }
  };

  // Cancel handler with dirty check
  const handleCancel = () => {
    if (isDirty) {
      setShowCancelDialog(true);
    } else {
      navigate('/sites/feeding?tab=protocols');
    }
  };

  const confirmCancel = () => {
    setShowCancelDialog(false);
    navigate('/sites/feeding?tab=protocols');
  };

  // Submit handler with actual API call
  const handleSubmit = async () => {
    // Validate all steps
    if (!validateAllSteps()) {
      // Find first step with errors and navigate to it
      for (let step = 1; step <= STEPS.length; step++) {
        const stepErrors = validateFormData(formData, step);
        if (Object.keys(stepErrors).length > 0) {
          setCurrentStep(step);
          break;
        }
      }
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const input = transformFormDataToInput(formData);

      if (isEdit && programId) {
        await updateMutation.mutateAsync({ id: programId, input });
      } else {
        await createMutation.mutateAsync(input);
      }

      navigate('/sites/feeding?tab=protocols');
    } catch (error) {
      const { message, fieldErrors } = parseGraphQLErrors(error);
      setSubmitError(message);

      // Apply field-level errors
      if (Object.keys(fieldErrors).length > 0) {
        setErrors((prev) => ({ ...prev, ...fieldErrors }));
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  // Render current step content
  const renderStepContent = () => {
    // Show loading skeleton for edit mode
    if (isEdit && programLoading) {
      return <FormSkeleton />;
    }

    // Show error state for edit mode data fetch failure
    if (isEdit && programError) {
      return (
        <Alert type="error">
          Program verileri yuklenirken bir hata olustu. Lutfen sayfayi yenileyin veya daha sonra
          tekrar deneyin.
        </Alert>
      );
    }

    switch (currentStep) {
      case 1:
        return <Step1BasicInfo data={formData} onChange={handleChange} errors={errors} />;
      case 2:
        return <Step2TankSelection data={formData} onChange={handleChange} errors={errors} />;
      case 3:
        return <Step3FeedAssignments data={formData} onChange={handleChange} errors={errors} />;
      case 4:
        return <Step4FCRTable data={formData} onChange={handleChange} errors={errors} />;
      case 5:
        return <Step5Settings data={formData} onChange={handleChange} errors={errors} />;
      default:
        return null;
    }
  };

  return (
    <div className="max-w-4xl mx-auto">
      {/* Page Header */}
      <div className="mb-6">
        <div className="flex items-center space-x-3">
          <Link
            to="/sites/feeding?tab=protocols"
            className="text-gray-400 hover:text-gray-600"
            aria-label="Besleme programlari listesine don"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </Link>
          <h1 className="text-2xl font-bold text-gray-900">
            {isEdit ? 'Besleme Programini Duzenle' : 'Yeni Besleme Programi'}
          </h1>
        </div>
        <p className="mt-1 text-sm text-gray-500">
          {isEdit ? 'Besleme programi bilgilerini guncelleyin' : 'Yeni bir besleme programi olusturun'}
        </p>
      </div>

      {/* Stepper */}
      <Stepper
        steps={STEPS}
        currentStep={currentStep}
        onStepClick={handleStepClick}
        completedSteps={completedSteps}
        validateStep={validateStep}
      />

      {/* Form Content */}
      <Card>
        <div className="p-6">
          {submitError && (
            <Alert type="error" dismissible onDismiss={() => setSubmitError(null)} className="mb-6">
              {submitError}
            </Alert>
          )}

          {renderStepContent()}
        </div>

        {/* Form Actions */}
        <div className="px-6 py-4 bg-gray-50 border-t border-gray-200 flex items-center justify-between">
          <div>
            {currentStep > 1 && (
              <Button type="button" variant="outline" onClick={handlePrev} disabled={isSubmitting}>
                <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
                Geri
              </Button>
            )}
          </div>
          <div className="flex items-center space-x-3">
            <Button variant="outline" type="button" onClick={handleCancel} disabled={isSubmitting}>
              Iptal
            </Button>
            {currentStep < STEPS.length ? (
              <Button type="button" onClick={handleNext} disabled={isSubmitting}>
                Ileri
                <svg className="w-4 h-4 ml-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </Button>
            ) : (
              <Button type="button" onClick={handleSubmit} loading={isSubmitting}>
                {isEdit ? 'Guncelle' : 'Olustur'}
              </Button>
            )}
          </div>
        </div>
      </Card>

      {/* Cancel Confirmation Dialog */}
      <ConfirmDialog
        isOpen={showCancelDialog}
        title="Degisiklikleri Iptal Et"
        message="Kaydedilmemis degisiklikleriniz var. Iptal etmek istediginizden emin misiniz?"
        onConfirm={confirmCancel}
        onCancel={() => setShowCancelDialog(false)}
      />
    </div>
  );
};

export default FeedingProgramForm;
