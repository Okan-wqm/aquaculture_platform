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

import React, { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, createTenantQueryKey, createTenantInvalidationKey } from '@aquaculture/shared-ui';
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
  Variable,
  Server,
  Send,
  Code,
  XCircle,
  History,
  Undo2,
  Wifi,
  WifiOff,
  Play,
  Tag,
  X,
  Link2,
  Unlink,
  Zap,
} from 'lucide-react';
import StEditorPanel from '../../components/unified-editor/StEditorPanel';
import { setTags as setEditorTags } from '../../components/unified-editor/StCompletionProvider';
import SimulationPanel from '../../simulation/SimulationPanel';
import VariableSyncPanel from '../../components/automation/VariableSyncPanel';
import DeployTargetSelector, { DeployTarget } from '../../components/automation/DeployTargetSelector';
import { useEdgeDevices, useEdgeDevice, DeviceLifecycleState, getDeviceModelText } from '../../hooks/useEdgeDevices';
import type { EdgeDevice, DeviceIoConfig } from '../../hooks/useEdgeDevices';
import { graphqlFetch } from '../../config/api';
import { ProgramStatus, ProgramType, getStatusColor, getStatusText } from '../../utils/automation.utils';
import {
  extractIoVariables,
  analyzeBindings,
  suggestTagBindings,
  type ExtractedIoVariable,
  type IoVariableWithBinding,
  type TagBindingSuggestion,
  type TagExtractionResult,
  type DeviceTag,
} from '../../utils/st-tag-extractor';
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
  SYNC_PROGRAM_VARIABLES_MUTATION,
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
  executionMode?: string;
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
type IoVariableScope = 'INPUT' | 'OUTPUT' | 'INOUT';
const IO_VARIABLE_SCOPES: readonly IoVariableScope[] = ['INPUT', 'OUTPUT', 'INOUT'] as const;

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
  disabled?: boolean;
  disabledTooltip?: string;
}> = ({ active, onClick, icon, label, count, disabled, disabledTooltip }) => (
  <div className="relative group">
    <button
      onClick={disabled ? undefined : onClick}
      className={`flex items-center gap-2 px-4 py-2 border-b-2 transition-colors ${
        disabled
          ? 'border-transparent text-gray-500 cursor-not-allowed'
          : active
            ? 'border-indigo-600 text-indigo-600'
            : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
      }`}
    >
      {icon}
      <span>{label}</span>
      {count !== undefined && (
        <span className="ml-1 px-2 py-0.5 text-xs rounded-full bg-gray-100">
          {count}
        </span>
      )}
    </button>
    {disabled && disabledTooltip && (
      <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1 px-2 py-1 text-xs bg-gray-800 text-white rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-10">
        {disabledTooltip}
      </div>
    )}
  </div>
);

const StepCard: React.FC<{
  step: ProgramStep;
  onRemove: () => void;
}> = ({ step, onRemove }) => (
  <div className="bg-white rounded-lg border border-gray-200 p-4">
    <div className="flex items-start justify-between">
      <div className="flex items-center gap-3">
        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
          step.stepType === 'initial' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-700'
        }`}>
          {step.stepOrder}
        </div>
        <div>
          <h4 className="font-medium text-gray-900">{step.stepName}</h4>
          {step.description && (
            <p className="text-sm text-gray-500">{step.description}</p>
          )}
        </div>
      </div>
      <button
        onClick={onRemove}
        className="p-1.5 rounded hover:bg-red-100 text-red-500"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
    {step.stepType === 'initial' && (
      <span className="mt-2 inline-block text-xs text-green-600 bg-green-50 px-2 py-0.5 rounded">
        Initial Step
      </span>
    )}
  </div>
);

const VariableRow: React.FC<{
  variable: ProgramVariable;
  onRemove: () => void;
}> = ({ variable, onRemove }) => (
  <tr className="hover:bg-gray-50">
    <td className="px-4 py-3 font-mono text-sm">{variable.varName}</td>
    <td className="px-4 py-3 text-sm">{variable.dataType}</td>
    <td className="px-4 py-3 text-sm font-mono">{variable.initialValue || '-'}</td>
    <td className="px-4 py-3 text-sm">{variable.scope}</td>
    {/* Show bound I/O tag name -- helps operators verify correct physical wiring */}
    <td className="px-4 py-3 text-sm">
      {variable.ioTagName ? (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-50 text-blue-700 text-xs font-mono">
          {variable.ioTagName}
        </span>
      ) : (
        <span className="text-gray-500">-</span>
      )}
    </td>
    <td className="px-4 py-3 text-sm text-gray-500">{variable.description || '-'}</td>
    <td className="px-4 py-3">
      <button
        onClick={onRemove}
        className="p-1.5 rounded hover:bg-red-100 text-red-500"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </td>
  </tr>
);

// ============================================================================
// I/O Tag Analysis Panel
// ============================================================================

/** Direction badge color */
const directionBadge: Record<string, string> = {
  input: 'bg-blue-100 text-blue-700',
  output: 'bg-orange-100 text-orange-700',
  inout: 'bg-purple-100 text-purple-700',
};

const directionLabel: Record<string, string> = {
  input: 'INPUT',
  output: 'OUTPUT',
  inout: 'IN_OUT',
};

/** Status badge styling */
const statusBadgeStyle: Record<string, string> = {
  bound: 'bg-green-100 text-green-700',
  unbound: 'bg-red-100 text-red-700',
  mismatch: 'bg-yellow-100 text-yellow-700',
};

const statusLabel: Record<string, string> = {
  bound: 'Bound',
  unbound: 'Unbound',
  mismatch: 'Type Mismatch',
};

const IoTagAnalysisPanel: React.FC<{
  analysisResult: TagExtractionResult;
  bindings: IoVariableWithBinding[];
  suggestions: TagBindingSuggestion[];
  onApplySuggestion: (variableName: string, tag: DeviceTag) => void;
  hasDevice: boolean;
}> = ({ analysisResult, bindings, suggestions, onApplySuggestion, hasDevice }) => {
  const { ioVariables, inputCount, outputCount, inoutCount, parseErrors } = analysisResult;

  if (ioVariables.length === 0 && parseErrors.length === 0) {
    return (
      <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
        <div className="flex items-center gap-2 text-gray-500 text-sm">
          <Unlink className="h-4 w-4" />
          <span>
            No VAR_INPUT / VAR_OUTPUT / VAR_IN_OUT variables found in ST code.
            I/O variables are required for binding to physical device tags.
          </span>
        </div>
      </div>
    );
  }

  const unboundCount = bindings.filter((b) => b.status === 'unbound').length;
  const mismatchCount = bindings.filter((b) => b.status === 'mismatch').length;
  const boundCount = bindings.filter((b) => b.status === 'bound').length;

  return (
    <div className="space-y-3">
      {/* Summary bar */}
      <div className="bg-white rounded-lg border border-gray-200 p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-indigo-600" />
            <span className="text-sm font-medium text-gray-700">
              I/O Tag Analysis
            </span>
          </div>
          <div className="flex items-center gap-3 text-xs">
            <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-blue-50 text-blue-700">
              {inputCount} Input
            </span>
            <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-orange-50 text-orange-700">
              {outputCount} Output
            </span>
            {inoutCount > 0 && (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-purple-50 text-purple-700">
                {inoutCount} In/Out
              </span>
            )}
            <span className="mx-1 text-gray-500">|</span>
            <span className={`flex items-center gap-1 px-2 py-0.5 rounded ${boundCount > 0 ? 'bg-green-50 text-green-700' : 'bg-gray-50 text-gray-500'}`}>
              <Link2 className="h-3 w-3" />
              {boundCount} Bound
            </span>
            {unboundCount > 0 && (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-red-50 text-red-700">
                <Unlink className="h-3 w-3" />
                {unboundCount} Unbound
              </span>
            )}
            {mismatchCount > 0 && (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-yellow-50 text-yellow-700">
                <AlertCircle className="h-3 w-3" />
                {mismatchCount} Mismatched
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Parse errors */}
      {parseErrors.length > 0 && (
        <div className="bg-red-50 rounded-lg border border-red-200 p-3">
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 text-red-500 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-red-700">
              <p className="font-medium mb-1">ST Parse Errors:</p>
              {parseErrors.map((err, i) => (
                <div key={i} className="text-xs font-mono">
                  Line {err.line}, Column {err.col}: {err.message}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Unbound warnings */}
      {unboundCount > 0 && (
        <div className="bg-amber-50 rounded-lg border border-amber-200 p-3">
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-amber-700">
              <p className="font-medium">
                {unboundCount} I/O variables are not bound to a physical tag
              </p>
              <p className="text-xs mt-0.5">
                These variables need to be bound to a device I/O tag to access hardware.
                You can bind each one to a tag from the Variables tab below.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Binding suggestions */}
      {suggestions.length > 0 && hasDevice && (
        <div className="bg-indigo-50 rounded-lg border border-indigo-200 p-3">
          <div className="flex items-start gap-2 mb-2">
            <Zap className="h-4 w-4 text-indigo-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-indigo-700 font-medium">
              Auto-Binding Suggestions
            </div>
          </div>
          <div className="space-y-1">
            {suggestions.map((s) => (
              <div
                key={s.variableName}
                className="flex items-center justify-between bg-white rounded px-3 py-1.5 border border-indigo-100"
              >
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-medium text-gray-900">{s.variableName}</span>
                  <span className="text-gray-500">&#8594;</span>
                  <span className="font-mono text-indigo-700">{s.suggestedTag.tagName}</span>
                  <span className="text-gray-500">({s.suggestedTag.ioType} {s.suggestedTag.dataType})</span>
                  {s.matchType === 'exact' && (
                    <span className="px-1.5 py-0.5 rounded bg-green-100 text-green-700 text-[10px]">Exact Match</span>
                  )}
                  {s.matchType === 'normalized' && (
                    <span className="px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 text-[10px]">Similar</span>
                  )}
                  {s.matchType === 'partial' && (
                    <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 text-[10px]">Partial</span>
                  )}
                </div>
                <button
                  onClick={() => onApplySuggestion(s.variableName, s.suggestedTag)}
                  className="px-2 py-0.5 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700"
                >
                  Apply
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* I/O variable binding table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Variable</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Direction</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Bound Tag</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Line</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {bindings.map((b) => (
              <tr key={`${b.name}-${b.line}`} className="hover:bg-gray-50">
                <td className="px-4 py-2 font-mono text-sm text-gray-900">{b.name}</td>
                <td className="px-4 py-2 text-xs text-gray-600">{b.dataType}</td>
                <td className="px-4 py-2">
                  <span className={`text-xs px-1.5 py-0.5 rounded ${directionBadge[b.direction] || 'bg-gray-100 text-gray-600'}`}>
                    {directionLabel[b.direction] || b.direction}
                  </span>
                </td>
                <td className="px-4 py-2">
                  <span className={`text-xs px-1.5 py-0.5 rounded ${statusBadgeStyle[b.status]}`}>
                    {statusLabel[b.status]}
                  </span>
                </td>
                <td className="px-4 py-2">
                  {b.boundTagName ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-50 text-blue-700 text-xs font-mono">
                      <Link2 className="h-3 w-3" />
                      {b.boundTagName}
                    </span>
                  ) : (
                    <span className="text-gray-500 text-xs">-</span>
                  )}
                </td>
                <td className="px-4 py-2 text-xs text-gray-500 font-mono">L{b.line}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Warnings list */}
      {bindings.some((b) => b.warning) && (
        <div className="space-y-1">
          {bindings.filter((b) => b.warning).map((b) => (
            <div key={`warn-${b.name}-${b.line}`} className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 rounded px-3 py-1.5">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
              <span>
                <span className="font-mono font-medium">{b.name}</span>: {b.warning}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Main Component
// ============================================================================

const AutomationProgramEditorPage: React.FC = () => {
  const { programId } = useParams<{ programId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();
  const isNew = !programId || programId === 'new';

  // State
  const [activeTab, setActiveTab] = useState<'info' | 'steps' | 'variables' | 'code' | 'simulation' | 'transitions' | 'deploy'>('info');
  const [formData, setFormData] = useState({
    programCode: '',
    name: '',
    description: '',
    programType: ProgramType.ST,
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
  const [syncResult, setSyncResult] = useState<{ added: number; removed: number; updated: number; unchanged: number } | null>(null);
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

  // Wire I/O tags from the selected device into the Monaco editor autocompletion.
  useEffect(() => {
    if (!ioDeviceId || ioTags.length === 0) {
      setEditorTags([]);
      return;
    }
    setEditorTags(
      ioTags.map((io) => ({
        name: io.tagName,
        ioType: io.ioType,
        dataType: io.dataType,
        description: io.description,
      })),
    );
    return () => { setEditorTags([]); };
  }, [ioDeviceId, ioTags]);

  // Query
  const { data, isLoading } = useQuery({
    queryKey: createTenantQueryKey(tenantId, 'automationProgram', programId),
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
      setStCode(prog.structuredTextCode ?? '');
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
    const message = `${context}: ${error.message || 'Unknown error'}`;
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
      showSuccess('Program created successfully');
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'automationPrograms') });
      navigate(`/sensor/automation/${result.createAutomationProgram.id}`, { replace: true });
    },
    onError: (error: Error) => handleMutationError(error, 'Failed to create program'),
  });

  const updateMutation = useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      graphqlFetch(UPDATE_PROGRAM_MUTATION, { id: programId, input }),
    onSuccess: () => {
      showSuccess('Program updated successfully');
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'automationProgram', programId) });
    },
    onError: (error: Error) => handleMutationError(error, 'Failed to save program'),
  });

  const submitForReviewMutation = useMutation({
    mutationFn: () => graphqlFetch(SUBMIT_FOR_REVIEW_MUTATION, { id: programId }),
    onSuccess: () => {
      setErrorMessage(null);
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'automationProgram', programId) });
    },
    onError: (error: Error) => handleMutationError(error, 'Failed to submit for review'),
  });

  const addStepMutation = useMutation({
    mutationFn: (input: typeof newStep & { programId: string }) =>
      graphqlFetch(ADD_STEP_MUTATION, { input }),
    onSuccess: () => {
      setErrorMessage(null);
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'automationProgram', programId) });
      setShowAddStep(false);
      setNewStep({ stepName: '', stepCode: '', stepOrder: (data?.programSteps?.length ?? 0) + 1, stepType: 'normal' });
    },
    onError: (error: Error) => handleMutationError(error, 'Failed to add step'),
  });

  const removeStepMutation = useMutation({
    mutationFn: (id: string) => graphqlFetch(REMOVE_STEP_MUTATION, { id }),
    onSuccess: () => {
      setErrorMessage(null);
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'automationProgram', programId) });
    },
    onError: (error: Error) => handleMutationError(error, 'Failed to delete step'),
  });

  const addVariableMutation = useMutation({
    mutationFn: (input: typeof newVariable & { programId: string }) =>
      graphqlFetch(ADD_VARIABLE_MUTATION, { input }),
    onSuccess: () => {
      setErrorMessage(null);
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'automationProgram', programId) });
      setShowAddVariable(false);
      setNewVariable({ varName: '', dataType: 'BOOL', initialValue: '', scope: 'LOCAL', ioTagName: '', ioConfigId: '' });
      setIoDeviceId('');
    },
    onError: (error: Error) => handleMutationError(error, 'Failed to add variable'),
  });

  const removeVariableMutation = useMutation({
    mutationFn: (id: string) => graphqlFetch(REMOVE_VARIABLE_MUTATION, { id }),
    onSuccess: () => {
      setErrorMessage(null);
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'automationProgram', programId) });
    },
    onError: (error: Error) => handleMutationError(error, 'Failed to delete variable'),
  });

  const syncVariablesMutation = useMutation({
    mutationFn: (input: { programId: string; variables: { varName: string; dataType: string; initialValue?: string; scope: string }[] }) =>
      graphqlFetch<{ syncProgramVariables: { added: number; removed: number; updated: number; unchanged: number } }>(
        SYNC_PROGRAM_VARIABLES_MUTATION,
        { input },
      ),
    onSuccess: (result) => {
      setErrorMessage(null);
      setSyncResult(result.syncProgramVariables);
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'automationProgram', programId) });
      // Auto-clear sync result after 5 seconds
      setTimeout(() => setSyncResult(null), 5000);
    },
    onError: (error: Error) => handleMutationError(error, 'Variable sync failed'),
  });

  const deployMutation = useMutation({
    mutationFn: (input: { programId: string; deviceId: string }) =>
      graphqlFetch<{ deployProgram: { success: boolean; programId: string; deviceId: string; error?: string } }>(
        DEPLOY_PROGRAM_MUTATION,
        { input },
      ),
    onSuccess: (result) => {
      if (result.deployProgram.success) {
        showSuccess('Deployment started successfully');
        queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'automationProgram', programId) });
        queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'deploymentHistory') });
      } else {
        handleMutationError(new Error(result.deployProgram.error || 'Unknown error'), 'Deployment failed');
      }
    },
    onError: (error: Error) => handleMutationError(error, 'Failed to start deployment'),
  });

  const approveMutation = useMutation({
    mutationFn: () => graphqlFetch(APPROVE_PROGRAM_MUTATION, { id: programId }),
    onSuccess: () => {
      showSuccess('Program approved');
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'automationProgram', programId) });
    },
    onError: (error: Error) => handleMutationError(error, 'Failed to approve program'),
  });

  const rejectMutation = useMutation({
    mutationFn: (reason: string) => graphqlFetch(REJECT_PROGRAM_MUTATION, { id: programId, reason }),
    onSuccess: () => {
      showSuccess('Program rejected');
      setShowRejectModal(false);
      setRejectReason('');
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'automationProgram', programId) });
    },
    onError: (error: Error) => handleMutationError(error, 'Failed to reject program'),
  });

  const addTransitionMutation = useMutation({
    mutationFn: (input: typeof newTransition & { programId: string }) =>
      graphqlFetch(ADD_TRANSITION_MUTATION, { input }),
    onSuccess: () => {
      setErrorMessage(null);
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'automationProgram', programId) });
      setShowAddTransition(false);
      setNewTransition({ transitionCode: '', fromStepId: '', toStepId: '', conditionExpression: '', priority: 1 });
    },
    onError: (error: Error) => handleMutationError(error, 'Failed to add transition'),
  });

  const removeTransitionMutation = useMutation({
    mutationFn: (id: string) => graphqlFetch(REMOVE_TRANSITION_MUTATION, { id }),
    onSuccess: () => {
      setErrorMessage(null);
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'automationProgram', programId) });
    },
    onError: (error: Error) => handleMutationError(error, 'Failed to delete transition'),
  });

  // Deployment history query
  const { data: deploymentHistoryData } = useQuery({
    queryKey: createTenantQueryKey(tenantId, 'deploymentHistory', selectedDeviceId),
    queryFn: () =>
      graphqlFetch<{ deploymentHistory: { items: DeploymentRecord[]; total: number; hasNextPage: boolean; hasPreviousPage: boolean; totalPages: number } }>(
        DEPLOYMENT_HISTORY_QUERY,
        { deviceId: selectedDeviceId, page: 1, limit: 10 },
      ),
    enabled: !isNew && !!selectedDeviceId && activeTab === 'deploy',
  });
  const deploymentHistory = deploymentHistoryData?.deploymentHistory?.items ?? [];

  // Handlers
  const handleSave = () => {
    // Prevent saving stale/empty data while the program is still loading
    if (!isNew && isLoading) {
      setErrorMessage('Program is loading, please wait');
      return;
    }
    if (isNew) {
      if (!formData.programCode?.trim()) {
        setErrorMessage('Program code is required');
        setActiveTab('info');
        return;
      }
      if (!formData.name?.trim()) {
        setErrorMessage('Program name is required');
        setActiveTab('info');
        return;
      }
      // Sanitize plcConfig: convert empty strings to undefined so that
      // @IsOptional() in the backend DTO correctly skips validation.
      // Without this, "" passes the @IsOptional() check (only null/undefined
      // are treated as missing) and then fails @IsIP() / @IsIn() validators.
      const sanitizedPlcConfig = {
        targetPlcAddress: plcConfig.targetPlcAddress || undefined,
        targetPlcPort: plcConfig.targetPlcPort || undefined,
        targetPlcModel: plcConfig.targetPlcModel || undefined,
        targetPlcProtocol: plcConfig.targetPlcProtocol || undefined,
      };
      createMutation.mutate({
        programCode: formData.programCode,
        programName: formData.name,
        description: formData.description || undefined,
        programType: formData.programType,
        executionMode: 'MANUAL',
        structuredTextCode: stCode,
        deployTarget,
        ...sanitizedPlcConfig,
      });
    } else {
      const sanitizedPlcConfig = {
        targetPlcAddress: plcConfig.targetPlcAddress || undefined,
        targetPlcPort: plcConfig.targetPlcPort || undefined,
        targetPlcModel: plcConfig.targetPlcModel || undefined,
        targetPlcProtocol: plcConfig.targetPlcProtocol || undefined,
      };
      updateMutation.mutate({
        programName: formData.name,
        description: formData.description || undefined,
        structuredTextCode: stCode,
        deployTarget,
        ...sanitizedPlcConfig,
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
      // Sanitize: convert empty strings to undefined so backend @IsOptional()
      // correctly skips validation for unneeded fields (e.g. ioConfigId, ioTagName).
      const sanitized: Record<string, unknown> = {
        varName: newVariable.varName,
        dataType: newVariable.dataType,
        scope: newVariable.scope,
        programId,
      };
      if (newVariable.initialValue) sanitized.initialValue = newVariable.initialValue;
      if (newVariable.ioTagName) sanitized.ioTagName = newVariable.ioTagName;
      if (newVariable.ioConfigId) sanitized.ioConfigId = newVariable.ioConfigId;
      addVariableMutation.mutate(sanitized as typeof newVariable & { programId: string });
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

  // ── I/O Tag Analysis ──────────────────────────────────────────────────
  const tagAnalysis: TagExtractionResult = useMemo(
    () => extractIoVariables(stCode),
    [stCode],
  );

  const ioBindings: IoVariableWithBinding[] = useMemo(
    () => analyzeBindings(tagAnalysis.ioVariables, variables),
    [tagAnalysis.ioVariables, variables],
  );

  const deviceTagsForSuggestion: DeviceTag[] = useMemo(() => {
    return ioTags.map((io) => ({
      id: io.id,
      tagName: io.tagName,
      ioType: io.ioType,
      dataType: io.dataType,
      description: io.description,
    }));
  }, [ioTags]);

  const unboundVars = useMemo(
    () => tagAnalysis.ioVariables.filter((v) => {
      const binding = ioBindings.find((b) => b.name === v.name && b.line === v.line);
      return binding && binding.status !== 'bound';
    }),
    [tagAnalysis.ioVariables, ioBindings],
  );

  const tagSuggestions: TagBindingSuggestion[] = useMemo(
    () => suggestTagBindings(unboundVars, deviceTagsForSuggestion),
    [unboundVars, deviceTagsForSuggestion],
  );

  const handleApplySuggestion = (variableName: string, tag: DeviceTag) => {
    if (!programId || isNew) return;
    const existingVar = variables.find((v) => v.varName.toLowerCase() === variableName.toLowerCase());
    const extracted = tagAnalysis.ioVariables.find((v) => v.name === variableName);
    if (!extracted) return;

    if (existingVar) {
      setSuccessMessage(`Please bind variable "${variableName}" to tag "${tag.tagName}" from the Variables tab.`);
    } else {
      const scopeMap: Record<string, string> = { input: 'INPUT', output: 'OUTPUT', inout: 'INOUT' };
      const scope = scopeMap[extracted.direction] || 'INPUT';
      addVariableMutation.mutate({
        varName: variableName,
        dataType: extracted.dataType || 'REAL',
        scope,
        initialValue: extracted.initialValue || '',
        ioTagName: tag.tagName,
        ioConfigId: tag.id,
        programId,
      });
    }
  };

  // Add a detected variable from ST code sync panel
  const handleAddDetectedVariable = (variable: {
    varName: string;
    dataType: string;
    initialValue?: string;
    scope: string;
  }) => {
    if (!isNew && programId && variable.varName) {
      // GraphQL VariableScope enum expects UPPERCASE keys (INPUT, OUTPUT, etc.)
      // The ST parser should already return uppercase, but normalize as safety net.
      const sanitized: Record<string, unknown> = {
        varName: variable.varName,
        dataType: variable.dataType,
        scope: variable.scope.toUpperCase(),
        programId,
      };
      if (variable.initialValue) sanitized.initialValue = variable.initialValue;
      addVariableMutation.mutate(sanitized as typeof newVariable & { programId: string });
    }
  };

  // Bulk sync all detected variables with the backend in a single call
  const handleSyncAllVariables = (variables: { varName: string; dataType: string; initialValue?: string; scope: string }[]) => {
    if (!isNew && programId) {
      const sanitized = variables.map((v) => ({
        varName: v.varName,
        dataType: v.dataType,
        scope: v.scope.toUpperCase(),
        ...(v.initialValue ? { initialValue: v.initialValue } : {}),
      }));
      syncVariablesMutation.mutate({ programId, variables: sanitized });
    }
  };

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
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-center justify-between" role="alert">
          <div className="flex items-center gap-2 text-red-700">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span className="text-sm">{errorMessage}</span>
          </div>
          <button
            onClick={() => setErrorMessage(null)}
            className="text-red-500 hover:text-red-700 text-sm font-medium px-2"
            aria-label="Dismiss error"
          >
            Close
          </button>
        </div>
      )}

      {/* Success Toast */}
      {successMessage && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg flex items-center justify-between" role="status">
          <div className="flex items-center gap-2 text-green-700">
            <CheckCircle className="h-4 w-4 flex-shrink-0" />
            <span className="text-sm">{successMessage}</span>
          </div>
          <button
            onClick={() => setSuccessMessage(null)}
            className="text-green-500 hover:text-green-700 text-sm font-medium px-2"
            aria-label="Dismiss success"
          >
            Close
          </button>
        </div>
      )}

      {/* Reject Modal */}
      {showRejectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium text-gray-900">Reject Program</h3>
              <button
                onClick={() => { setShowRejectModal(false); setRejectReason(''); }}
                className="p-1 rounded hover:bg-gray-100"
              >
                <XCircle className="h-5 w-5 text-gray-500" />
              </button>
            </div>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Enter rejection reason..."
              rows={4}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg bg-white mb-4"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setShowRejectModal(false); setRejectReason(''); }}
                className="px-4 py-2 border border-gray-200 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => rejectReason.trim() && rejectMutation.mutate(rejectReason.trim())}
                disabled={!rejectReason.trim() || rejectMutation.isPending}
                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
              >
                {rejectMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin inline mr-1" /> : null}
                Reject
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
            className="p-2 rounded-lg hover:bg-gray-100"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              {isNew ? 'New Automation Program' : formData.name || 'Program'}
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
              className="flex items-center gap-2 px-4 py-2 border border-gray-200 rounded-lg hover:bg-gray-50"
            >
              <Send className="h-4 w-4" />
              Submit for Review
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
                Approve
              </button>
              <button
                onClick={() => setShowRejectModal(true)}
                className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
              >
                <XCircle className="h-4 w-4" />
                Reject
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
            Save
          </button>
        </div>
      </div>

      {/* Approval/Rejection Info */}
      {program?.approvedBy && (
        <div className="mb-4 px-3 py-2 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
          Approveyan: {program.approvedBy}
        </div>
      )}
      {program?.status === ProgramStatus.DRAFT && !program?.approvedBy && program?.version > 1 && (
        <div className="mb-4 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          Program rejected
        </div>
      )}

      {/* Status Pipeline Stepper */}
      {program && (
        <div className="mb-6">
          <div className="flex items-center justify-between">
            {([
              { key: ProgramStatus.DRAFT, label: 'Draft' },
              { key: ProgramStatus.PENDING_REVIEW, label: 'Pending Review' },
              { key: ProgramStatus.APPROVED, label: 'Approved' },
              { key: ProgramStatus.DEPLOYING, label: 'Deploying' },
              { key: ProgramStatus.DEPLOYED, label: 'Deployed' },
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
                            ? 'bg-indigo-600 text-white ring-4 ring-indigo-100'
                            : 'bg-gray-200 text-gray-500'
                      }`}
                    >
                      {isCompleted ? <CheckCircle className="h-4 w-4" /> : index + 1}
                    </div>
                    <span
                      className={`mt-1 text-xs ${
                        isCurrent ? 'font-semibold text-indigo-600' : 'text-gray-500'
                      }`}
                    >
                      {step.label}
                    </span>
                  </div>
                  {index < arr.length - 1 && (
                    <div
                      className={`flex-1 h-0.5 mx-1 mt-[-12px] ${
                        stepIndex < currentIndex ? 'bg-green-500' : 'bg-gray-200'
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
      <div className="flex border-b border-gray-200 mb-6">
        <TabButton
          active={activeTab === 'info'}
          onClick={() => setActiveTab('info')}
          icon={<Settings className="h-4 w-4" />}
          label="Info"
        />
        <TabButton
          active={activeTab === 'variables'}
          onClick={() => setActiveTab('variables')}
          icon={
            ioBindings.some((b) => b.status === 'unbound')
              ? <AlertCircle className="h-4 w-4 text-amber-500" />
              : <Variable className="h-4 w-4" />
          }
          label="Variables"
          count={isNew ? undefined : variables.length}
          disabled={isNew}
          disabledTooltip="Save the program first"
        />
        <TabButton
          active={activeTab === 'code'}
          onClick={() => setActiveTab('code')}
          icon={<Code className="h-4 w-4" />}
          label="ST Code"
        />
        <TabButton
          active={activeTab === 'simulation'}
          onClick={() => setActiveTab('simulation')}
          icon={<Play className="h-4 w-4" />}
          label="Simulation"
        />
        <TabButton
          active={activeTab === 'deploy'}
          onClick={() => setActiveTab('deploy')}
          icon={<Upload className="h-4 w-4" />}
          label="Deploy"
          disabled={isNew}
          disabledTooltip="Save the program first"
        />
      </div>

      {/* Info Tab / New Form */}
      {activeTab === 'info' && (
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <div className="grid grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Program Code *
              </label>
              <input
                type="text"
                value={formData.programCode}
                onChange={(e) => setFormData({ ...formData, programCode: e.target.value })}
                disabled={!isNew}
                placeholder="PRG_001"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg bg-white disabled:bg-gray-100"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Program Name *
              </label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="Feeding Automation"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg bg-white"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Program Type
              </label>
              <div className="w-full px-3 py-2 border border-gray-200 rounded-lg bg-gray-100 text-gray-700">
                Structured Text (ST)
              </div>
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Description
              </label>
              <textarea
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                rows={3}
                placeholder="Program description..."
                className="w-full px-3 py-2 border border-gray-200 rounded-lg bg-white"
              />
            </div>
          </div>
        </div>
      )}

      {/* Variables Tab */}
      {activeTab === 'variables' && isNew && (
        <div className="bg-white rounded-lg border border-gray-200 p-12 text-center text-gray-500">
          <Variable className="h-12 w-12 mx-auto mb-3 opacity-50" />
          <p>Save the program first to use this tab.</p>
        </div>
      )}
      {activeTab === 'variables' && !isNew && (
        <div className="space-y-4">
          {/* Auto-detected variables from ST code */}
          <VariableSyncPanel
            stCode={stCode}
            registeredVariables={variables}
            onAddVariable={handleAddDetectedVariable}
            onRemoveVariable={(id) => removeVariableMutation.mutate(id)}
            onSyncAll={handleSyncAllVariables}
            isAdding={addVariableMutation.isPending}
            isRemoving={removeVariableMutation.isPending}
            isSyncing={syncVariablesMutation.isPending}
            syncResult={syncResult}
          />

          {/* I/O Tag Analysis Panel */}
          {stCode && stCode.trim().length > 0 && (
            <IoTagAnalysisPanel
              analysisResult={tagAnalysis}
              bindings={ioBindings}
              suggestions={tagSuggestions}
              onApplySuggestion={handleApplySuggestion}
              hasDevice={!!ioDeviceId && ioTags.length > 0}
            />
          )}

          <div className="flex justify-end">
            <button
              onClick={() => setShowAddVariable(true)}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
            >
              <Plus className="h-4 w-4" />
              Add Variable
            </button>
          </div>

          {showAddVariable && (
            <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
              <h3 className="font-medium mb-3">New Variable</h3>
              <div className="grid grid-cols-4 gap-4">
                <input
                  type="text"
                  value={newVariable.varName}
                  onChange={(e) => setNewVariable({ ...newVariable, varName: e.target.value })}
                  placeholder="Variable name"
                  className="px-3 py-2 border border-gray-200 rounded-lg"
                />
                <select
                  value={newVariable.dataType}
                  onChange={(e) => setNewVariable({ ...newVariable, dataType: e.target.value })}
                  className="px-3 py-2 border border-gray-200 rounded-lg"
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
                  placeholder="Initial value"
                  className="px-3 py-2 border border-gray-200 rounded-lg"
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
                  className="px-3 py-2 border border-gray-200 rounded-lg"
                >
                  <option value="LOCAL">LOCAL</option>
                  <option value="INPUT">INPUT</option>
                  <option value="OUTPUT">OUTPUT</option>
                  <option value="INOUT">INOUT</option>
                  <option value="RETAIN">RETAIN</option>
                  <option value="CONSTANT">CONSTANT</option>
                </select>
              </div>
              {/* I/O Tag Binding -- only INPUT/OUTPUT/IN_OUT variables can be bound to physical tags */}
              {showIoTagPicker && (
                <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                  <h4 className="text-sm font-medium text-blue-700 mb-3">I/O Tag Binding</h4>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Edge Device</label>
                      <select
                        value={ioDeviceId}
                        onChange={(e) => {
                          setIoDeviceId(e.target.value);
                          setNewVariable({ ...newVariable, ioTagName: '', ioConfigId: '' });
                        }}
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg bg-white text-sm"
                      >
                        <option value="">Select device...</option>
                        {allActiveDevices.map((device: EdgeDevice) => (
                          <option key={device.id} value={device.id}>
                            {device.deviceName} ({device.deviceCode}) - {getDeviceModelText(device.deviceModel)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">I/O Tag</label>
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
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg bg-white text-sm disabled:bg-gray-100"
                      >
                        <option value="">{!ioDeviceId ? 'Select device first...' : ioTags.length === 0 ? 'No I/O tags found' : 'Select tag...'}</option>
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
                    <div className="mt-2 text-xs text-blue-600">
                      Bound tag: <span className="font-mono font-medium">{newVariable.ioTagName}</span>
                      {' | Data type auto-set: '}<span className="font-medium">{newVariable.dataType}</span>
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
                  Cancel
                </button>
                <button
                  onClick={handleAddVariable}
                  disabled={addVariableMutation.isPending}
                  className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
                >
                  Add
                </button>
              </div>
            </div>
          )}

          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Value</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Scope</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">I/O Tag</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Description</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {variables.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                      No variables added yet
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
      {activeTab === 'code' && (
        <div className="flex flex-col" style={{ height: 'calc(100vh - 320px)', minHeight: 400 }}>
          {/* I/O Tag status bar */}
          {tagAnalysis.ioVariables.length > 0 && (
            <div className="flex items-center gap-3 px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-t-lg text-xs flex-shrink-0">
              <span className="flex items-center gap-1 text-gray-600">
                <Zap className="h-3.5 w-3.5" />
                I/O Variables:
              </span>
              <span className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700">{tagAnalysis.inputCount} Input</span>
              <span className="px-1.5 py-0.5 rounded bg-orange-50 text-orange-700">{tagAnalysis.outputCount} Output</span>
              {tagAnalysis.inoutCount > 0 && (
                <span className="px-1.5 py-0.5 rounded bg-purple-50 text-purple-700">{tagAnalysis.inoutCount} In/Out</span>
              )}
              {ioBindings.filter((b) => b.status === 'unbound').length > 0 && (
                <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">
                  <AlertCircle className="h-3 w-3" />
                  {ioBindings.filter((b) => b.status === 'unbound').length} unbound tags
                </span>
              )}
              {ioBindings.filter((b) => b.status === 'unbound').length === 0 && tagAnalysis.ioVariables.length > 0 && (
                <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-green-50 text-green-700">
                  <CheckCircle className="h-3 w-3" />
                  All tags bound
                </span>
              )}
            </div>
          )}
          <StEditorPanel
            embedded
            value={stCode}
            onChange={setStCode}
            hideActions={['save', 'deploy']}
            onSave={handleSave}
          />
        </div>
      )}

      {/* Simulation Tab */}
      {activeTab === 'simulation' && (
        <div className="flex flex-col" style={{ height: 'calc(100vh - 320px)', minHeight: 400 }}>
          <SimulationPanel code={stCode} />
        </div>
      )}

      {/* Deploy Tab */}
      {activeTab === 'deploy' && isNew && (
        <div className="bg-white rounded-lg border border-gray-200 p-12 text-center text-gray-500">
          <Upload className="h-12 w-12 mx-auto mb-3 opacity-50" />
          <p>Save the program first to use this tab.</p>
        </div>
      )}
      {activeTab === 'deploy' && !isNew && (
        <div className="space-y-6">
          {/* Deploy Target Selection */}
          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <h3 className="text-sm font-medium text-gray-700 mb-4">
              Target Platform
            </h3>
            <DeployTargetSelector
              value={deployTarget}
              onChange={setDeployTarget}
              plcConfig={plcConfig}
              onPlcConfigChange={setPlcConfig}
            />
          </div>

          {/* Edge Device Selector */}
          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <h3 className="text-sm font-medium text-gray-700 mb-4">
              Select Edge Device
            </h3>
            {onlineDevices.length === 0 ? (
              <div className="text-center py-4 text-gray-500 text-sm">
                <WifiOff className="h-8 w-8 mx-auto text-gray-500 mb-2" />
                No active and online devices found
              </div>
            ) : (
              <select
                value={selectedDeviceId}
                onChange={(e) => setSelectedDeviceId(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg bg-white"
              >
                <option value="">Select device...</option>
                {onlineDevices.map((device: EdgeDevice) => (
                  <option key={device.id} value={device.id}>
                    {device.deviceName} ({device.deviceCode}) - {getDeviceModelText(device.deviceModel)}
                    {device.isOnline ? ' [Online]' : ' [Offline]'}
                  </option>
                ))}
              </select>
            )}
            {selectedDeviceId && onlineDevices.find((d: EdgeDevice) => d.id === selectedDeviceId) && (
              <div className="mt-3 flex items-center gap-2 text-sm text-green-600">
                <Wifi className="h-4 w-4" />
                <span>
                  {onlineDevices.find((d: EdgeDevice) => d.id === selectedDeviceId)?.deviceName} - Online
                </span>
              </div>
            )}
          </div>

          {/* Deploy Action */}
          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <div className="text-center py-4">
              <Server className="h-12 w-12 mx-auto text-gray-500 mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">
                Deploy to Edge Device
              </h3>
              <p className="text-gray-500 mb-4 text-sm">
                {program?.status === ProgramStatus.APPROVED
                  ? `Will deploy to ${deployTarget === DeployTarget.RUST_ENGINE ? 'Rust Engine' : deployTarget === DeployTarget.CODESYS_PLC ? 'Codesys PLC' : 'PLC Setpoint'} target`
                  : 'Program must be approved before deployment'}
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
                Start Deployment
              </button>
              {program?.status !== ProgramStatus.APPROVED && (
                <p className="mt-2 text-xs text-amber-600">
                  Program must be approved for deployment.
                </p>
              )}
              {program?.status === ProgramStatus.APPROVED && !selectedDeviceId && (
                <p className="mt-2 text-xs text-amber-600">
                  Please select an edge device.
                </p>
              )}
            </div>
          </div>

          {/* Deployment History */}
          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <div className="flex items-center gap-2 mb-4">
              <History className="h-4 w-4 text-gray-500" />
              <h3 className="text-sm font-medium text-gray-700">
                Deployment History
              </h3>
            </div>
            {deploymentHistory.length === 0 ? (
              <div className="text-center py-6 text-gray-500 text-sm">
                No deployments yet
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Version</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Deployed By</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Command ID</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {deploymentHistory.map((dep, idx) => {
                      const statusBadge: Record<string, string> = {
                        success: 'bg-green-100 text-green-700',
                        failed: 'bg-red-100 text-red-700',
                        pending: 'bg-yellow-100 text-yellow-700',
                        in_progress: 'bg-blue-100 text-blue-700',
                        rolled_back: 'bg-gray-100 text-gray-700',
                      };
                      return (
                        <tr key={dep.id} className="hover:bg-gray-50">
                          <td className="px-3 py-2">
                            <span className={`text-xs px-2 py-0.5 rounded ${statusBadge[dep.status] || 'bg-gray-100 text-gray-600'}`}>
                              {dep.status}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-sm">v{dep.version}</td>
                          <td className="px-3 py-2 text-sm text-gray-600">{dep.deployedBy}</td>
                          <td className="px-3 py-2 text-sm text-gray-500">{new Date(dep.deployedAt).toLocaleString('en-US')}</td>
                          <td className="px-3 py-2 text-xs font-mono text-gray-500">{dep.commandId || '-'}</td>
                          <td className="px-3 py-2">
                            {idx === 0 && dep.status === 'success' && (
                              <button
                                className="inline-flex items-center gap-1 text-xs px-2 py-1 text-indigo-600 hover:bg-indigo-50 rounded"
                                title="Roll back to this version"
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
              <div className="mt-3 p-2 bg-red-50 border border-red-200 rounded text-sm text-red-600">
                Last error: {deploymentHistory[deploymentHistory.length - 1].errorMessage}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default AutomationProgramEditorPage;
