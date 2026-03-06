/**
 * Automation Program Editor Page
 *
 * Create and edit IEC 61131-3 automation programs.
 * Features:
 * - Program metadata editing
 * - Step/transition management
 * - Variable configuration
 * - Deployment to edge devices
 */

import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Save,
  Upload,
  Settings,
  Plus,
  Trash2,
  CheckCircle,
  AlertCircle,
  Loader2,
  GitBranch,
  Variable,
  Server,
  Send,
  Code,
  XCircle,
  History,
  ArrowRightLeft,
  Undo2,
  Wifi,
  WifiOff,
} from 'lucide-react';
import StEditorPanel from '../../components/unified-editor/StEditorPanel';
import DeployTargetSelector, { DeployTarget } from '../../components/automation/DeployTargetSelector';
import { useEdgeDevices, useEdgeDevice, DeviceLifecycleState, getDeviceModelText } from '../../hooks/useEdgeDevices';
import type { EdgeDevice, DeviceIoConfig } from '../../hooks/useEdgeDevices';
import { graphqlFetch } from '../../config/api';
import { ProgramStatus, ProgramType, getStatusColor, getStatusText } from '../../utils/automation.utils';
import {
  AUTOMATION_PROGRAM_QUERY,
  CREATE_PROGRAM_MUTATION,
  UPDATE_PROGRAM_MUTATION,
  SUBMIT_FOR_REVIEW_MUTATION,
  DEPLOY_PROGRAM_MUTATION,
  APPROVE_PROGRAM_MUTATION,
  REJECT_PROGRAM_MUTATION,
  ADD_STEP_MUTATION,
  REMOVE_STEP_MUTATION,
  ADD_VARIABLE_MUTATION,
  REMOVE_VARIABLE_MUTATION,
  ADD_TRANSITION_MUTATION,
  REMOVE_TRANSITION_MUTATION,
  DEPLOYMENT_HISTORY_QUERY,
} from '../../graphql/automation.queries';

// ============================================================================
// Types
// ============================================================================

interface AutomationProgram {
  id: string;
  programCode: string;
  programName: string;
  description?: string;
  version: number;
  programType: ProgramType;
  status: ProgramStatus;
  structuredTextCode?: string;
  deployTarget?: string;
  targetPlcAddress?: string;
  targetPlcPort?: number;
  targetPlcModel?: string;
  targetPlcProtocol?: string;
  approvedBy?: string;
  createdAt: string;
  updatedAt: string;
}

interface DeploymentRecord {
  id: string;
  status: string;
  version: number;
  deployedBy: string;
  deployedAt: string;
  completedAt?: string;
  errorMessage?: string;
  deviceId: string;
  commandId?: string;
}

interface ProgramStep {
  id: string;
  stepName: string;
  stepCode: string;
  stepOrder: number;
  stepType: string;
  description?: string;
}

/** IEC 61131-3 variable scopes that map to physical I/O on an edge device */
type IoVariableScope = 'INPUT' | 'OUTPUT' | 'IN_OUT';
const IO_VARIABLE_SCOPES: readonly IoVariableScope[] = ['INPUT', 'OUTPUT', 'IN_OUT'] as const;

/**
 * Maps IoDataType (hardware-level types from DeviceIoConfig) to IEC 61131-3 PLC data types.
 * The PLC runtime only understands IEC types, so we translate when binding a variable
 * to a physical I/O tag -- e.g. a Modbus FLOAT32 register becomes a REAL variable.
 */
const IO_TO_IEC_DATA_TYPE: Record<string, string> = {
  BOOL: 'BOOL',
  INT16: 'INT',
  INT32: 'INT',
  UINT16: 'INT',
  UINT32: 'INT',
  FLOAT32: 'REAL',
  FLOAT64: 'REAL',
};

function isIoScope(scope: string): scope is IoVariableScope {
  return (IO_VARIABLE_SCOPES as readonly string[]).includes(scope);
}

interface ProgramVariable {
  id: string;
  varName: string;
  dataType: string;
  initialValue?: string;
  scope: string;
  description?: string;
  /** Physical I/O tag name bound to this variable (e.g. "water_temp") */
  ioTagName?: string;
  /** FK to DeviceIoConfig -- links this variable to a specific hardware channel */
  ioConfigId?: string;
}

interface ProgramTransition {
  id: string;
  transitionCode?: string;
  fromStepId: string;
  toStepId: string;
  conditionExpression: string;
  priority?: number;
}


// ============================================================================
// Components
// ============================================================================

const TabButton: React.FC<{
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count?: number;
}> = ({ active, onClick, icon, label, count }) => (
  <button
    onClick={onClick}
    className={`flex items-center gap-2 px-4 py-2 border-b-2 transition-colors ${
      active
        ? 'border-indigo-600 text-indigo-600'
        : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
    }`}
  >
    {icon}
    <span>{label}</span>
    {count !== undefined && (
      <span className="ml-1 px-2 py-0.5 text-xs rounded-full bg-gray-100 dark:bg-gray-700">
        {count}
      </span>
    )}
  </button>
);

const StepCard: React.FC<{
  step: ProgramStep;
  onRemove: () => void;
}> = ({ step, onRemove }) => (
  <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
    <div className="flex items-start justify-between">
      <div className="flex items-center gap-3">
        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
          step.stepType === 'initial' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-700'
        }`}>
          {step.stepOrder}
        </div>
        <div>
          <h4 className="font-medium text-gray-900 dark:text-white">{step.stepName}</h4>
          {step.description && (
            <p className="text-sm text-gray-500">{step.description}</p>
          )}
        </div>
      </div>
      <button
        onClick={onRemove}
        className="p-1.5 rounded hover:bg-red-100 dark:hover:bg-red-900/20 text-red-500"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
    {step.stepType === 'initial' && (
      <span className="mt-2 inline-block text-xs text-green-600 bg-green-50 px-2 py-0.5 rounded">
        Baslangic Adimi
      </span>
    )}
  </div>
);

const VariableRow: React.FC<{
  variable: ProgramVariable;
  onRemove: () => void;
}> = ({ variable, onRemove }) => (
  <tr className="hover:bg-gray-50 dark:hover:bg-gray-800">
    <td className="px-4 py-3 font-mono text-sm">{variable.varName}</td>
    <td className="px-4 py-3 text-sm">{variable.dataType}</td>
    <td className="px-4 py-3 text-sm font-mono">{variable.initialValue || '-'}</td>
    <td className="px-4 py-3 text-sm">{variable.scope}</td>
    {/* Show bound I/O tag name -- helps operators verify correct physical wiring */}
    <td className="px-4 py-3 text-sm">
      {variable.ioTagName ? (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400 text-xs font-mono">
          {variable.ioTagName}
        </span>
      ) : (
        <span className="text-gray-400">-</span>
      )}
    </td>
    <td className="px-4 py-3 text-sm text-gray-500">{variable.description || '-'}</td>
    <td className="px-4 py-3">
      <button
        onClick={onRemove}
        className="p-1.5 rounded hover:bg-red-100 dark:hover:bg-red-900/20 text-red-500"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </td>
  </tr>
);

// ============================================================================
// Main Component
// ============================================================================

const AutomationProgramEditorPage: React.FC = () => {
  const { programId } = useParams<{ programId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isNew = !programId || programId === 'new';

  // State
  const [activeTab, setActiveTab] = useState<'info' | 'steps' | 'variables' | 'code' | 'transitions' | 'deploy'>('info');
  const [formData, setFormData] = useState({
    programCode: '',
    name: '',
    description: '',
    programType: ProgramType.SFC,
  });
  const [stCode, setStCode] = useState('');
  const [deployTarget, setDeployTarget] = useState<DeployTarget>(DeployTarget.RUST_ENGINE);
  const [plcConfig, setPlcConfig] = useState<{
    targetPlcAddress?: string;
    targetPlcPort?: number;
    targetPlcModel?: string;
    targetPlcProtocol?: string;
  }>({});
  const [showAddStep, setShowAddStep] = useState(false);
  const [showAddVariable, setShowAddVariable] = useState(false);
  const [newStep, setNewStep] = useState({ stepName: '', stepCode: '', stepOrder: 1, stepType: 'normal' });
  // Variable form state -- ioTagName/ioConfigId are only populated when scope is INPUT/OUTPUT/IN_OUT
  const [newVariable, setNewVariable] = useState({ varName: '', dataType: 'BOOL', initialValue: '', scope: 'LOCAL', ioTagName: '', ioConfigId: '' });
  // Tracks which device the user selected in the I/O picker (separate from deploy device)
  const [ioDeviceId, setIoDeviceId] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [showAddTransition, setShowAddTransition] = useState(false);
  const [newTransition, setNewTransition] = useState({
    transitionCode: '',
    fromStepId: '',
    toStepId: '',
    conditionExpression: '',
    priority: 1,
  });

  // Edge devices query - only active + online devices for deploy
  const { data: edgeDevicesData } = useEdgeDevices({
    lifecycleState: DeviceLifecycleState.ACTIVE,
    isOnline: true,
    limit: 100,
  });
  const onlineDevices = edgeDevicesData?.items ?? [];

  // Whether the I/O tag picker should be visible -- avoids unnecessary queries
  // when the user isn't working with I/O-bound variables
  const showIoTagPicker = showAddVariable && isIoScope(newVariable.scope);

  // Fetch full device with ioConfig for the selected device in the I/O picker.
  // Only fires when a device is actually selected (useEdgeDevice checks !!id internally).
  const { data: ioDeviceData } = useEdgeDevice(ioDeviceId);
  const ioTags: DeviceIoConfig[] = ioDeviceData?.ioConfig?.filter((io) => io.isActive) ?? [];

  // All active devices (including offline) for the I/O binding device selector.
  // Offline devices still have valid I/O configs; excluding them would prevent
  // binding variables during device maintenance windows.
  const { data: allDevicesData } = useEdgeDevices({
    lifecycleState: DeviceLifecycleState.ACTIVE,
    limit: 100,
  });
  const allActiveDevices = allDevicesData?.items ?? [];

  // Query
  const { data, isLoading } = useQuery({
    queryKey: ['automationProgram', programId],
    queryFn: () =>
      graphqlFetch<{
        automationProgram: AutomationProgram;
        programSteps: ProgramStep[];
        programVariables: ProgramVariable[];
        programTransitions: ProgramTransition[];
      }>(AUTOMATION_PROGRAM_QUERY, { id: programId }),
    enabled: !isNew,
  });

  // Update form when data loads
  useEffect(() => {
    if (data?.automationProgram) {
      const prog = data.automationProgram;
      setFormData({
        programCode: prog.programCode,
        name: prog.programName,
        description: prog.description || '',
        programType: prog.programType,
      });
      if (prog.structuredTextCode) {
        setStCode(prog.structuredTextCode);
      }
      if (prog.deployTarget) {
        setDeployTarget(prog.deployTarget as DeployTarget);
      }
      if (prog.targetPlcAddress || prog.targetPlcPort) {
        setPlcConfig({
          targetPlcAddress: prog.targetPlcAddress,
          targetPlcPort: prog.targetPlcPort,
          targetPlcModel: prog.targetPlcModel,
          targetPlcProtocol: prog.targetPlcProtocol,
        });
      }
    }
  }, [data]);

  // Mutations
  const handleMutationError = (error: Error, context: string) => {
    const message = `${context}: ${error.message || 'Bilinmeyen hata'}`;
    setErrorMessage(message);
    setTimeout(() => setErrorMessage((prev) => (prev === message ? null : prev)), 8000);
  };

  const showSuccess = (message: string) => {
    setSuccessMessage(message);
    setErrorMessage(null);
    setTimeout(() => setSuccessMessage((prev) => (prev === message ? null : prev)), 5000);
  };

  const createMutation = useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      graphqlFetch<{ createAutomationProgram: { id: string } }>(CREATE_PROGRAM_MUTATION, { input }),
    onSuccess: (result) => {
      setErrorMessage(null);
      navigate(`/sensor/automation/${result.createAutomationProgram.id}`);
    },
    onError: (error: Error) => handleMutationError(error, 'Program olusturulamadi'),
  });

  const updateMutation = useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      graphqlFetch(UPDATE_PROGRAM_MUTATION, { id: programId, input }),
    onSuccess: () => {
      setErrorMessage(null);
      queryClient.invalidateQueries({ queryKey: ['automationProgram', programId] });
    },
    onError: (error: Error) => handleMutationError(error, 'Program kaydedilemedi'),
  });

  const submitForReviewMutation = useMutation({
    mutationFn: () => graphqlFetch(SUBMIT_FOR_REVIEW_MUTATION, { id: programId }),
    onSuccess: () => {
      setErrorMessage(null);
      queryClient.invalidateQueries({ queryKey: ['automationProgram', programId] });
    },
    onError: (error: Error) => handleMutationError(error, 'Incelemeye gonderilemedi'),
  });

  const addStepMutation = useMutation({
    mutationFn: (input: typeof newStep & { programId: string }) =>
      graphqlFetch(ADD_STEP_MUTATION, { input }),
    onSuccess: () => {
      setErrorMessage(null);
      queryClient.invalidateQueries({ queryKey: ['automationProgram', programId] });
      setShowAddStep(false);
      setNewStep({ stepName: '', stepCode: '', stepOrder: (data?.programSteps?.length ?? 0) + 1, stepType: 'normal' });
    },
    onError: (error: Error) => handleMutationError(error, 'Adim eklenemedi'),
  });

  const removeStepMutation = useMutation({
    mutationFn: (id: string) => graphqlFetch(REMOVE_STEP_MUTATION, { id }),
    onSuccess: () => {
      setErrorMessage(null);
      queryClient.invalidateQueries({ queryKey: ['automationProgram', programId] });
    },
    onError: (error: Error) => handleMutationError(error, 'Adim silinemedi'),
  });

  const addVariableMutation = useMutation({
    mutationFn: (input: typeof newVariable & { programId: string }) =>
      graphqlFetch(ADD_VARIABLE_MUTATION, { input }),
    onSuccess: () => {
      setErrorMessage(null);
      queryClient.invalidateQueries({ queryKey: ['automationProgram', programId] });
      setShowAddVariable(false);
      setNewVariable({ varName: '', dataType: 'BOOL', initialValue: '', scope: 'LOCAL', ioTagName: '', ioConfigId: '' });
      setIoDeviceId('');
    },
    onError: (error: Error) => handleMutationError(error, 'Degisken eklenemedi'),
  });

  const removeVariableMutation = useMutation({
    mutationFn: (id: string) => graphqlFetch(REMOVE_VARIABLE_MUTATION, { id }),
    onSuccess: () => {
      setErrorMessage(null);
      queryClient.invalidateQueries({ queryKey: ['automationProgram', programId] });
    },
    onError: (error: Error) => handleMutationError(error, 'Degisken silinemedi'),
  });

  const deployMutation = useMutation({
    mutationFn: (input: { programId: string; deviceId: string }) =>
      graphqlFetch<{ deployProgram: { success: boolean; programId: string; deviceId: string; error?: string } }>(
        DEPLOY_PROGRAM_MUTATION,
        { input },
      ),
    onSuccess: (result) => {
      if (result.deployProgram.success) {
        showSuccess('Dagitim basariyla baslatildi');
        queryClient.invalidateQueries({ queryKey: ['automationProgram', programId] });
        queryClient.invalidateQueries({ queryKey: ['deploymentHistory'] });
      } else {
        handleMutationError(new Error(result.deployProgram.error || 'Bilinmeyen hata'), 'Dagitim basarisiz');
      }
    },
    onError: (error: Error) => handleMutationError(error, 'Dagitim baslatilmadi'),
  });

  const approveMutation = useMutation({
    mutationFn: () => graphqlFetch(APPROVE_PROGRAM_MUTATION, { id: programId }),
    onSuccess: () => {
      showSuccess('Program onaylandi');
      queryClient.invalidateQueries({ queryKey: ['automationProgram', programId] });
    },
    onError: (error: Error) => handleMutationError(error, 'Program onaylanamadi'),
  });

  const rejectMutation = useMutation({
    mutationFn: (reason: string) => graphqlFetch(REJECT_PROGRAM_MUTATION, { id: programId, reason }),
    onSuccess: () => {
      showSuccess('Program reddedildi');
      setShowRejectModal(false);
      setRejectReason('');
      queryClient.invalidateQueries({ queryKey: ['automationProgram', programId] });
    },
    onError: (error: Error) => handleMutationError(error, 'Program reddedilemedi'),
  });

  const addTransitionMutation = useMutation({
    mutationFn: (input: typeof newTransition & { programId: string }) =>
      graphqlFetch(ADD_TRANSITION_MUTATION, { input }),
    onSuccess: () => {
      setErrorMessage(null);
      queryClient.invalidateQueries({ queryKey: ['automationProgram', programId] });
      setShowAddTransition(false);
      setNewTransition({ transitionCode: '', fromStepId: '', toStepId: '', conditionExpression: '', priority: 1 });
    },
    onError: (error: Error) => handleMutationError(error, 'Gecis eklenemedi'),
  });

  const removeTransitionMutation = useMutation({
    mutationFn: (id: string) => graphqlFetch(REMOVE_TRANSITION_MUTATION, { id }),
    onSuccess: () => {
      setErrorMessage(null);
      queryClient.invalidateQueries({ queryKey: ['automationProgram', programId] });
    },
    onError: (error: Error) => handleMutationError(error, 'Gecis silinemedi'),
  });

  // Deployment history query
  const { data: deploymentHistoryData } = useQuery({
    queryKey: ['deploymentHistory', selectedDeviceId],
    queryFn: () =>
      graphqlFetch<{ deploymentHistory: { items: DeploymentRecord[]; total: number; hasMore: boolean } }>(
        DEPLOYMENT_HISTORY_QUERY,
        { deviceId: selectedDeviceId, page: 1, limit: 10 },
      ),
    enabled: !isNew && !!selectedDeviceId && activeTab === 'deploy',
  });
  const deploymentHistory = deploymentHistoryData?.deploymentHistory?.items ?? [];

  // Handlers
  const handleSave = () => {
    if (isNew) {
      createMutation.mutate({
        programCode: formData.programCode,
        programName: formData.name,
        description: formData.description,
        programType: formData.programType,
        structuredTextCode: stCode || undefined,
        deployTarget,
        ...plcConfig,
      });
    } else {
      updateMutation.mutate({
        programName: formData.name,
        description: formData.description,
        structuredTextCode: stCode || undefined,
        deployTarget,
        ...plcConfig,
      });
    }
  };

  const handleAddStep = () => {
    if (!isNew && programId && newStep.stepName) {
      addStepMutation.mutate({ ...newStep, programId });
    }
  };

  const handleAddVariable = () => {
    if (!isNew && programId && newVariable.varName) {
      addVariableMutation.mutate({ ...newVariable, programId });
    }
  };

  const handleDeploy = () => {
    if (programId && selectedDeviceId) {
      deployMutation.mutate({ programId, deviceId: selectedDeviceId });
    }
  };

  const handleAddTransition = () => {
    if (!isNew && programId && newTransition.fromStepId && newTransition.toStepId && newTransition.conditionExpression) {
      addTransitionMutation.mutate({ ...newTransition, programId });
    }
  };

  const program = data?.automationProgram;
  const steps = data?.programSteps || [];
  const variables = data?.programVariables || [];
  const transitions = data?.programTransitions || [];

  if (!isNew && isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-indigo-600" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Error Toast */}
      {errorMessage && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg flex items-center justify-between" role="alert">
          <div className="flex items-center gap-2 text-red-700 dark:text-red-400">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span className="text-sm">{errorMessage}</span>
          </div>
          <button
            onClick={() => setErrorMessage(null)}
            className="text-red-500 hover:text-red-700 text-sm font-medium px-2"
            aria-label="Dismiss error"
          >
            Kapat
          </button>
        </div>
      )}

      {/* Success Toast */}
      {successMessage && (
        <div className="mb-4 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg flex items-center justify-between" role="status">
          <div className="flex items-center gap-2 text-green-700 dark:text-green-400">
            <CheckCircle className="h-4 w-4 flex-shrink-0" />
            <span className="text-sm">{successMessage}</span>
          </div>
          <button
            onClick={() => setSuccessMessage(null)}
            className="text-green-500 hover:text-green-700 text-sm font-medium px-2"
            aria-label="Dismiss success"
          >
            Kapat
          </button>
        </div>
      )}

      {/* Reject Modal */}
      {showRejectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium text-gray-900 dark:text-white">Programi Reddet</h3>
              <button
                onClick={() => { setShowRejectModal(false); setRejectReason(''); }}
                className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                <XCircle className="h-5 w-5 text-gray-400" />
              </button>
            </div>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Red sebebini yaziniz..."
              rows={4}
              className="w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 mb-4"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setShowRejectModal(false); setRejectReason(''); }}
                className="px-4 py-2 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                Iptal
              </button>
              <button
                onClick={() => rejectReason.trim() && rejectMutation.mutate(rejectReason.trim())}
                disabled={!rejectReason.trim() || rejectMutation.isPending}
                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
              >
                {rejectMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin inline mr-1" /> : null}
                Reddet
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Link
            to="/sensor/automation"
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
              {isNew ? 'Yeni Otomasyon Programi' : formData.name || 'Program'}
            </h1>
            {program && (
              <div className="flex items-center gap-2 mt-1">
                <span className="text-sm text-gray-500 font-mono">{program.programCode}</span>
                <span className={`text-xs px-2 py-0.5 rounded ${getStatusColor(program.status)}`}>
                  {getStatusText(program.status)}
                </span>
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {program?.status === ProgramStatus.DRAFT && (
            <button
              onClick={() => submitForReviewMutation.mutate()}
              disabled={submitForReviewMutation.isPending}
              className="flex items-center gap-2 px-4 py-2 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              <Send className="h-4 w-4" />
              Incelemeye Gonder
            </button>
          )}
          {program?.status === ProgramStatus.PENDING_REVIEW && (
            <>
              <button
                onClick={() => approveMutation.mutate()}
                disabled={approveMutation.isPending}
                className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
              >
                {approveMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle className="h-4 w-4" />
                )}
                Onayla
              </button>
              <button
                onClick={() => setShowRejectModal(true)}
                className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
              >
                <XCircle className="h-4 w-4" />
                Reddet
              </button>
            </>
          )}
          <button
            onClick={handleSave}
            disabled={createMutation.isPending || updateMutation.isPending}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
          >
            {(createMutation.isPending || updateMutation.isPending) ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Kaydet
          </button>
        </div>
      </div>

      {/* Approval/Rejection Info */}
      {program?.approvedBy && (
        <div className="mb-4 px-3 py-2 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg text-sm text-green-700 dark:text-green-400">
          Onaylayan: {program.approvedBy}
        </div>
      )}
      {program?.status === ProgramStatus.DRAFT && !program?.approvedBy && program?.version > 1 && (
        <div className="mb-4 px-3 py-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-400">
          Program reddedildi
        </div>
      )}

      {/* Status Pipeline Stepper */}
      {program && (
        <div className="mb-6">
          <div className="flex items-center justify-between">
            {([
              { key: ProgramStatus.DRAFT, label: 'Taslak' },
              { key: ProgramStatus.PENDING_REVIEW, label: 'Inceleniyor' },
              { key: ProgramStatus.APPROVED, label: 'Onaylandi' },
              { key: ProgramStatus.DEPLOYING, label: 'Yukleniyor' },
              { key: ProgramStatus.DEPLOYED, label: 'Devrede' },
            ] as const).map((step, index, arr) => {
              const statusOrder = [ProgramStatus.DRAFT, ProgramStatus.PENDING_REVIEW, ProgramStatus.APPROVED, ProgramStatus.DEPLOYING, ProgramStatus.DEPLOYED];
              const currentIndex = statusOrder.indexOf(program.status);
              const stepIndex = statusOrder.indexOf(step.key);
              const isCompleted = stepIndex < currentIndex;
              const isCurrent = stepIndex === currentIndex;

              return (
                <React.Fragment key={step.key}>
                  <div className="flex flex-col items-center flex-1">
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium ${
                        isCompleted
                          ? 'bg-green-500 text-white'
                          : isCurrent
                            ? 'bg-indigo-600 text-white ring-4 ring-indigo-100 dark:ring-indigo-900'
                            : 'bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400'
                      }`}
                    >
                      {isCompleted ? <CheckCircle className="h-4 w-4" /> : index + 1}
                    </div>
                    <span
                      className={`mt-1 text-xs ${
                        isCurrent ? 'font-semibold text-indigo-600 dark:text-indigo-400' : 'text-gray-500 dark:text-gray-400'
                      }`}
                    >
                      {step.label}
                    </span>
                  </div>
                  {index < arr.length - 1 && (
                    <div
                      className={`flex-1 h-0.5 mx-1 mt-[-12px] ${
                        stepIndex < currentIndex ? 'bg-green-500' : 'bg-gray-200 dark:bg-gray-700'
                      }`}
                    />
                  )}
                </React.Fragment>
              );
            })}
          </div>
        </div>
      )}

      {/* Tabs */}
      {!isNew && (
        <div className="flex border-b border-gray-200 dark:border-gray-700 mb-6">
          <TabButton
            active={activeTab === 'info'}
            onClick={() => setActiveTab('info')}
            icon={<Settings className="h-4 w-4" />}
            label="Bilgiler"
          />
          <TabButton
            active={activeTab === 'steps'}
            onClick={() => setActiveTab('steps')}
            icon={<GitBranch className="h-4 w-4" />}
            label="Adimlar"
            count={steps.length}
          />
          <TabButton
            active={activeTab === 'variables'}
            onClick={() => setActiveTab('variables')}
            icon={<Variable className="h-4 w-4" />}
            label="Degiskenler"
            count={variables.length}
          />
          <TabButton
            active={activeTab === 'code'}
            onClick={() => setActiveTab('code')}
            icon={<Code className="h-4 w-4" />}
            label="ST Kodu"
          />
          <TabButton
            active={activeTab === 'transitions'}
            onClick={() => setActiveTab('transitions')}
            icon={<ArrowRightLeft className="h-4 w-4" />}
            label="Gecisler"
            count={transitions.length}
          />
          <TabButton
            active={activeTab === 'deploy'}
            onClick={() => setActiveTab('deploy')}
            icon={<Upload className="h-4 w-4" />}
            label="Dagitim"
          />
        </div>
      )}

      {/* Info Tab / New Form */}
      {(activeTab === 'info' || isNew) && (
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
          <div className="grid grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Program Kodu *
              </label>
              <input
                type="text"
                value={formData.programCode}
                onChange={(e) => setFormData({ ...formData, programCode: e.target.value })}
                disabled={!isNew}
                placeholder="PRG_001"
                className="w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 disabled:bg-gray-100"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Program Adi *
              </label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="Yemleme Otomasyonu"
                className="w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Program Tipi
              </label>
              <select
                value={formData.programType}
                onChange={(e) => setFormData({ ...formData, programType: e.target.value as ProgramType })}
                disabled={!isNew}
                className="w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 disabled:bg-gray-100"
              >
                <option value={ProgramType.SFC}>Sequential Function Chart (SFC)</option>
                <option value={ProgramType.LD}>Ladder Diagram (LD)</option>
                <option value={ProgramType.FBD}>Function Block Diagram (FBD)</option>
                <option value={ProgramType.ST}>Structured Text (ST)</option>
              </select>
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Aciklama
              </label>
              <textarea
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                rows={3}
                placeholder="Program aciklamasi..."
                className="w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900"
              />
            </div>
          </div>
        </div>
      )}

      {/* Steps Tab */}
      {activeTab === 'steps' && !isNew && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button
              onClick={() => setShowAddStep(true)}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
            >
              <Plus className="h-4 w-4" />
              Adim Ekle
            </button>
          </div>

          {showAddStep && (
            <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
              <h3 className="font-medium mb-3">Yeni Adim</h3>
              <div className="grid grid-cols-3 gap-4">
                <input
                  type="text"
                  value={newStep.stepName}
                  onChange={(e) => setNewStep({ ...newStep, stepName: e.target.value })}
                  placeholder="Adim adi"
                  className="px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg"
                />
                <input
                  type="text"
                  value={newStep.stepCode}
                  onChange={(e) => setNewStep({ ...newStep, stepCode: e.target.value })}
                  placeholder="Adim kodu (S001)"
                  className="px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg"
                />
                <input
                  type="number"
                  value={newStep.stepOrder}
                  onChange={(e) => setNewStep({ ...newStep, stepOrder: parseInt(e.target.value) || 1 })}
                  placeholder="Sira no"
                  className="px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg"
                />
                <select
                  value={newStep.stepType}
                  onChange={(e) => setNewStep({ ...newStep, stepType: e.target.value })}
                  className="px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg"
                >
                  <option value="normal">Normal</option>
                  <option value="initial">Baslangic</option>
                  <option value="final">Bitis</option>
                </select>
              </div>
              <div className="flex justify-end gap-2 mt-4">
                <button
                  onClick={() => setShowAddStep(false)}
                  className="px-4 py-2 border border-gray-200 rounded-lg hover:bg-gray-100"
                >
                  Iptal
                </button>
                <button
                  onClick={handleAddStep}
                  disabled={addStepMutation.isPending}
                  className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
                >
                  Ekle
                </button>
              </div>
            </div>
          )}

          <div className="grid gap-3">
            {steps.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                Henuz adim eklenmemis
              </div>
            ) : (
              steps.map((step) => (
                <StepCard
                  key={step.id}
                  step={step}
                  onRemove={() => removeStepMutation.mutate(step.id)}
                />
              ))
            )}
          </div>
        </div>
      )}

      {/* Variables Tab */}
      {activeTab === 'variables' && !isNew && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button
              onClick={() => setShowAddVariable(true)}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
            >
              <Plus className="h-4 w-4" />
              Degisken Ekle
            </button>
          </div>

          {showAddVariable && (
            <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
              <h3 className="font-medium mb-3">Yeni Degisken</h3>
              <div className="grid grid-cols-4 gap-4">
                <input
                  type="text"
                  value={newVariable.varName}
                  onChange={(e) => setNewVariable({ ...newVariable, varName: e.target.value })}
                  placeholder="Degisken adi"
                  className="px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg"
                />
                <select
                  value={newVariable.dataType}
                  onChange={(e) => setNewVariable({ ...newVariable, dataType: e.target.value })}
                  className="px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg"
                >
                  <option value="BOOL">BOOL</option>
                  <option value="INT">INT</option>
                  <option value="REAL">REAL</option>
                  <option value="TIME">TIME</option>
                  <option value="STRING">STRING</option>
                </select>
                <input
                  type="text"
                  value={newVariable.initialValue}
                  onChange={(e) => setNewVariable({ ...newVariable, initialValue: e.target.value })}
                  placeholder="Baslangic degeri"
                  className="px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg"
                />
                <select
                  value={newVariable.scope}
                  onChange={(e) => {
                    const scope = e.target.value;
                    // Clear I/O binding when switching away from an I/O-capable scope
                    setNewVariable({ ...newVariable, scope, ioTagName: '', ioConfigId: '' });
                    if (!isIoScope(scope)) {
                      setIoDeviceId('');
                    }
                  }}
                  className="px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg"
                >
                  <option value="LOCAL">LOCAL</option>
                  <option value="INPUT">INPUT</option>
                  <option value="OUTPUT">OUTPUT</option>
                  <option value="IN_OUT">IN_OUT</option>
                  <option value="GLOBAL">GLOBAL</option>
                </select>
              </div>
              {/* I/O Tag Binding -- only INPUT/OUTPUT/IN_OUT variables can be bound to physical tags */}
              {showIoTagPicker && (
                <div className="mt-4 p-3 bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800 rounded-lg">
                  <h4 className="text-sm font-medium text-blue-700 dark:text-blue-400 mb-3">I/O Tag Baglama</h4>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Edge Cihazi</label>
                      <select
                        value={ioDeviceId}
                        onChange={(e) => {
                          setIoDeviceId(e.target.value);
                          setNewVariable({ ...newVariable, ioTagName: '', ioConfigId: '' });
                        }}
                        className="w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-sm"
                      >
                        <option value="">Cihaz seciniz...</option>
                        {allActiveDevices.map((device: EdgeDevice) => (
                          <option key={device.id} value={device.id}>
                            {device.deviceName} ({device.deviceCode}) - {getDeviceModelText(device.deviceModel)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">I/O Tag</label>
                      <select
                        value={newVariable.ioConfigId}
                        onChange={(e) => {
                          const selectedTag = ioTags.find((t) => t.id === e.target.value);
                          if (selectedTag) {
                            // Auto-map hardware data type to IEC 61131-3 type so the
                            // PLC variable matches the physical I/O channel width
                            setNewVariable({
                              ...newVariable,
                              ioConfigId: selectedTag.id,
                              ioTagName: selectedTag.tagName,
                              dataType: IO_TO_IEC_DATA_TYPE[selectedTag.dataType] || newVariable.dataType,
                            });
                          } else {
                            setNewVariable({ ...newVariable, ioConfigId: '', ioTagName: '' });
                          }
                        }}
                        disabled={!ioDeviceId || ioTags.length === 0}
                        className="w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-sm disabled:bg-gray-100 dark:disabled:bg-gray-800"
                      >
                        <option value="">{!ioDeviceId ? 'Once cihaz seciniz...' : ioTags.length === 0 ? 'I/O tag bulunamadi' : 'Tag seciniz...'}</option>
                        {ioTags.map((tag) => (
                          <option key={tag.id} value={tag.id}>
                            {tag.tagName} ({tag.ioType} - {tag.dataType})
                            {tag.modbusRegister != null ? ` Modbus R${tag.modbusRegister}` : ''}
                            {tag.gpioPin != null ? ` GPIO ${tag.gpioPin}` : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {newVariable.ioTagName && (
                    <div className="mt-2 text-xs text-blue-600 dark:text-blue-400">
                      Bagli tag: <span className="font-mono font-medium">{newVariable.ioTagName}</span>
                      {' | Veri tipi otomatik ayarlandi: '}<span className="font-medium">{newVariable.dataType}</span>
                    </div>
                  )}
                </div>
              )}
              <div className="flex justify-end gap-2 mt-4">
                <button
                  onClick={() => {
                    setShowAddVariable(false);
                    setIoDeviceId('');
                  }}
                  className="px-4 py-2 border border-gray-200 rounded-lg hover:bg-gray-100"
                >
                  Iptal
                </button>
                <button
                  onClick={handleAddVariable}
                  disabled={addVariableMutation.isPending}
                  className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
                >
                  Ekle
                </button>
              </div>
            </div>
          )}

          <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50 dark:bg-gray-900">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Adi</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Tip</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Deger</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Kapsam</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">I/O Tag</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Aciklama</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {variables.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                      Henuz degisken eklenmemis
                    </td>
                  </tr>
                ) : (
                  variables.map((variable) => (
                    <VariableRow
                      key={variable.id}
                      variable={variable}
                      onRemove={() => removeVariableMutation.mutate(variable.id)}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Code Tab - ST Editor */}
      {activeTab === 'code' && !isNew && (
        <StEditorPanel
          embedded
          value={stCode}
          onChange={setStCode}
          hideActions={['save', 'deploy']}
        />
      )}

      {/* Transitions Tab */}
      {activeTab === 'transitions' && !isNew && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button
              onClick={() => setShowAddTransition(true)}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
            >
              <Plus className="h-4 w-4" />
              Gecis Ekle
            </button>
          </div>

          {showAddTransition && (
            <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
              <h3 className="font-medium mb-3">Yeni Gecis</h3>
              <div className="grid grid-cols-2 gap-4">
                <input
                  type="text"
                  value={newTransition.transitionCode}
                  onChange={(e) => setNewTransition({ ...newTransition, transitionCode: e.target.value })}
                  placeholder="Gecis kodu (T001)"
                  className="px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg"
                />
                <select
                  value={newTransition.fromStepId}
                  onChange={(e) => setNewTransition({ ...newTransition, fromStepId: e.target.value })}
                  className="px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg"
                >
                  <option value="">Kaynak adim sec...</option>
                  {steps.map((s) => (
                    <option key={s.id} value={s.id}>{s.stepName} ({s.stepCode})</option>
                  ))}
                </select>
                <select
                  value={newTransition.toStepId}
                  onChange={(e) => setNewTransition({ ...newTransition, toStepId: e.target.value })}
                  className="px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg"
                >
                  <option value="">Hedef adim sec...</option>
                  {steps.map((s) => (
                    <option key={s.id} value={s.id}>{s.stepName} ({s.stepCode})</option>
                  ))}
                </select>
                <input
                  type="number"
                  value={newTransition.priority}
                  onChange={(e) => setNewTransition({ ...newTransition, priority: parseInt(e.target.value) || 1 })}
                  placeholder="Oncelik"
                  className="px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg"
                />
                <div className="col-span-2">
                  <input
                    type="text"
                    value={newTransition.conditionExpression}
                    onChange={(e) => setNewTransition({ ...newTransition, conditionExpression: e.target.value })}
                    placeholder="Kosul ifadesi (ornegin: temperature > 30)"
                    className="w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg font-mono text-sm"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 mt-4">
                <button
                  onClick={() => setShowAddTransition(false)}
                  className="px-4 py-2 border border-gray-200 rounded-lg hover:bg-gray-100"
                >
                  Iptal
                </button>
                <button
                  onClick={handleAddTransition}
                  disabled={addTransitionMutation.isPending}
                  className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                >
                  Ekle
                </button>
              </div>
            </div>
          )}

          <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50 dark:bg-gray-900">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Kod</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Kaynak Adim</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Hedef Adim</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Kosul</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Oncelik</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {transitions.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                      Henuz gecis eklenmemis
                    </td>
                  </tr>
                ) : (
                  transitions.map((t) => {
                    const fromStep = steps.find((s) => s.id === t.fromStepId);
                    const toStep = steps.find((s) => s.id === t.toStepId);
                    return (
                      <tr key={t.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                        <td className="px-4 py-3 text-sm font-mono">{t.transitionCode || '-'}</td>
                        <td className="px-4 py-3 text-sm">{fromStep?.stepName || t.fromStepId}</td>
                        <td className="px-4 py-3 text-sm">{toStep?.stepName || t.toStepId}</td>
                        <td className="px-4 py-3 text-sm font-mono text-gray-600 dark:text-gray-400">{t.conditionExpression}</td>
                        <td className="px-4 py-3 text-sm">{t.priority ?? '-'}</td>
                        <td className="px-4 py-3">
                          <button
                            onClick={() => removeTransitionMutation.mutate(t.id)}
                            className="p-1.5 rounded hover:bg-red-100 dark:hover:bg-red-900/20 text-red-500"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Deploy Tab */}
      {activeTab === 'deploy' && !isNew && (
        <div className="space-y-6">
          {/* Deploy Target Selection */}
          <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-4">
              Hedef Platform
            </h3>
            <DeployTargetSelector
              value={deployTarget}
              onChange={setDeployTarget}
              plcConfig={plcConfig}
              onPlcConfigChange={setPlcConfig}
            />
          </div>

          {/* Edge Device Selector */}
          <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-4">
              Edge Cihazi Sec
            </h3>
            {onlineDevices.length === 0 ? (
              <div className="text-center py-4 text-gray-500 text-sm">
                <WifiOff className="h-8 w-8 mx-auto text-gray-400 mb-2" />
                Aktif ve cevrimici cihaz bulunamadi
              </div>
            ) : (
              <select
                value={selectedDeviceId}
                onChange={(e) => setSelectedDeviceId(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900"
              >
                <option value="">Cihaz seciniz...</option>
                {onlineDevices.map((device: EdgeDevice) => (
                  <option key={device.id} value={device.id}>
                    {device.deviceName} ({device.deviceCode}) - {getDeviceModelText(device.deviceModel)}
                    {device.isOnline ? ' [Cevrimici]' : ' [Cevrimdisi]'}
                  </option>
                ))}
              </select>
            )}
            {selectedDeviceId && onlineDevices.find((d: EdgeDevice) => d.id === selectedDeviceId) && (
              <div className="mt-3 flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
                <Wifi className="h-4 w-4" />
                <span>
                  {onlineDevices.find((d: EdgeDevice) => d.id === selectedDeviceId)?.deviceName} - Cevrimici
                </span>
              </div>
            )}
          </div>

          {/* Deploy Action */}
          <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
            <div className="text-center py-4">
              <Server className="h-12 w-12 mx-auto text-gray-400 mb-4" />
              <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
                Edge Cihazina Dagit
              </h3>
              <p className="text-gray-500 dark:text-gray-400 mb-4 text-sm">
                {program?.status === ProgramStatus.APPROVED
                  ? `${deployTarget === DeployTarget.RUST_ENGINE ? 'Rust Engine' : deployTarget === DeployTarget.CODESYS_PLC ? 'Codesys PLC' : 'PLC Setpoint'} hedefine dagitim yapilacak`
                  : 'Program dagitilmadan once onaylanmalidir'}
              </p>
              <button
                onClick={handleDeploy}
                disabled={
                  program?.status !== ProgramStatus.APPROVED ||
                  !selectedDeviceId ||
                  deployMutation.isPending
                }
                className="inline-flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {deployMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4" />
                )}
                Dagitim Baslat
              </button>
              {program?.status !== ProgramStatus.APPROVED && (
                <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                  Dagitim icin programin onaylanmis olmasi gerekir.
                </p>
              )}
              {program?.status === ProgramStatus.APPROVED && !selectedDeviceId && (
                <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                  Lutfen bir edge cihazi seciniz.
                </p>
              )}
            </div>
          </div>

          {/* Deployment History */}
          <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
            <div className="flex items-center gap-2 mb-4">
              <History className="h-4 w-4 text-gray-500" />
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Dagitim Gecmisi
              </h3>
            </div>
            {deploymentHistory.length === 0 ? (
              <div className="text-center py-6 text-gray-500 text-sm">
                Henuz dagitim yapilmamis
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50 dark:bg-gray-900">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Durum</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Versiyon</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Dagitan</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Tarih</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Komut ID</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                    {deploymentHistory.map((dep, idx) => {
                      const statusBadge: Record<string, string> = {
                        success: 'bg-green-100 text-green-700',
                        failed: 'bg-red-100 text-red-700',
                        pending: 'bg-yellow-100 text-yellow-700',
                        in_progress: 'bg-blue-100 text-blue-700',
                        rolled_back: 'bg-gray-100 text-gray-700',
                      };
                      return (
                        <tr key={dep.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                          <td className="px-3 py-2">
                            <span className={`text-xs px-2 py-0.5 rounded ${statusBadge[dep.status] || 'bg-gray-100 text-gray-600'}`}>
                              {dep.status}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-sm">v{dep.version}</td>
                          <td className="px-3 py-2 text-sm text-gray-600 dark:text-gray-400">{dep.deployedBy}</td>
                          <td className="px-3 py-2 text-sm text-gray-500">{new Date(dep.deployedAt).toLocaleString('tr-TR')}</td>
                          <td className="px-3 py-2 text-xs font-mono text-gray-400">{dep.commandId || '-'}</td>
                          <td className="px-3 py-2">
                            {idx === 0 && dep.status === 'success' && (
                              <button
                                className="inline-flex items-center gap-1 text-xs px-2 py-1 text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 rounded"
                                title="Bu versiyona geri don"
                              >
                                <Undo2 className="h-3 w-3" />
                                Rollback
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {deploymentHistory.length > 0 && deploymentHistory[deploymentHistory.length - 1]?.errorMessage && (
              <div className="mt-3 p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-sm text-red-600 dark:text-red-400">
                Son hata: {deploymentHistory[deploymentHistory.length - 1].errorMessage}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default AutomationProgramEditorPage;
