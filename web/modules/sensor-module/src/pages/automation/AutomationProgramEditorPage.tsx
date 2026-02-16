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
  Workflow,
  ArrowLeft,
  Save,
  Play,
  Pause,
  Upload,
  Settings,
  Plus,
  Trash2,
  Edit,
  ChevronRight,
  CheckCircle,
  Clock,
  AlertCircle,
  Loader2,
  GitBranch,
  Variable,
  Zap,
  Server,
  Send,
  Code,
  Target,
} from 'lucide-react';
import { useAuth } from '@aquaculture/shared-ui';
import STEditor from '../../components/automation/STEditor';
import DeployTargetSelector, { DeployTarget } from '../../components/automation/DeployTargetSelector';
import CompileResultPanel, { type ValidationResult } from '../../components/automation/CompileResultPanel';

// ============================================================================
// GraphQL Fetch Helper
// ============================================================================

async function graphqlFetch<T>(
  query: string,
  variables: Record<string, unknown>,
  token?: string
): Promise<T> {
  const response = await fetch('/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });

  const result = await response.json();

  if (result.errors) {
    throw new Error(result.errors[0]?.message || 'GraphQL Error');
  }

  return result.data;
}

// ============================================================================
// Types
// ============================================================================

enum ProgramStatus {
  DRAFT = 'draft',
  PENDING_REVIEW = 'pending_review',
  APPROVED = 'approved',
  DEPLOYING = 'deploying',
  DEPLOYED = 'deployed',
  ARCHIVED = 'archived',
}

enum ProgramType {
  SFC = 'sfc',
  FBD = 'fbd',
  ST = 'st',
  LD = 'ld',
}

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
  createdAt: string;
  updatedAt: string;
}

interface ProgramStep {
  id: string;
  stepName: string;
  stepCode: string;
  stepOrder: number;
  stepType: string;
  description?: string;
}

interface ProgramVariable {
  id: string;
  varName: string;
  dataType: string;
  initialValue?: string;
  scope: string;
  description?: string;
}

interface ProgramTransition {
  id: string;
  transitionCode?: string;
  fromStepId: string;
  toStepId: string;
  conditionExpression: string;
}

// ============================================================================
// GraphQL
// ============================================================================

const PROGRAM_QUERY = `
  query AutomationProgram($id: ID!) {
    automationProgram(id: $id) {
      id
      programCode
      programName
      description
      version
      programType
      status
      structuredTextCode
      deployTarget
      targetPlcAddress
      targetPlcPort
      targetPlcModel
      targetPlcProtocol
      createdAt
      updatedAt
    }
    programSteps(programId: $id) {
      id
      stepCode
      stepName
      stepOrder
      stepType
      description
    }
    programVariables(programId: $id) {
      id
      varName
      dataType
      initialValue
      scope
      description
    }
    programTransitions(programId: $id) {
      id
      transitionCode
      fromStepId
      toStepId
      conditionExpression
    }
  }
`;

const CREATE_PROGRAM = `
  mutation CreateAutomationProgram($input: CreateProgramInput!) {
    createAutomationProgram(input: $input) {
      id
      programCode
    }
  }
`;

const UPDATE_PROGRAM = `
  mutation UpdateAutomationProgram($id: ID!, $input: UpdateProgramInput!) {
    updateAutomationProgram(id: $id, input: $input) {
      id
      programName
    }
  }
`;

const SUBMIT_FOR_REVIEW = `
  mutation SubmitProgramForReview($id: ID!) {
    submitProgramForReview(id: $id) {
      id
      status
    }
  }
`;

const DEPLOY_PROGRAM = `
  mutation DeployProgram($input: DeployProgramInput!) {
    deployProgram(input: $input) {
      success
      programId
      deviceId
      error
    }
  }
`;

const ADD_STEP = `
  mutation AddProgramStep($input: CreateStepInput!) {
    addProgramStep(input: $input) {
      id
      stepName
    }
  }
`;

const REMOVE_STEP = `
  mutation RemoveProgramStep($id: ID!) {
    removeProgramStep(id: $id)
  }
`;

const ADD_VARIABLE = `
  mutation AddProgramVariable($input: CreateVariableInput!) {
    addProgramVariable(input: $input) {
      id
      varName
    }
  }
`;

const REMOVE_VARIABLE = `
  mutation RemoveProgramVariable($id: ID!) {
    removeProgramVariable(id: $id)
  }
`;

// ============================================================================
// Helper Functions
// ============================================================================

const getStatusColor = (status: ProgramStatus): string => {
  const colors: Record<ProgramStatus, string> = {
    [ProgramStatus.DRAFT]: 'bg-gray-100 text-gray-700',
    [ProgramStatus.PENDING_REVIEW]: 'bg-yellow-100 text-yellow-700',
    [ProgramStatus.APPROVED]: 'bg-blue-100 text-blue-700',
    [ProgramStatus.DEPLOYING]: 'bg-orange-100 text-orange-700',
    [ProgramStatus.DEPLOYED]: 'bg-green-100 text-green-700',
    [ProgramStatus.ARCHIVED]: 'bg-gray-100 text-gray-500',
  };
  return colors[status] || colors[ProgramStatus.DRAFT];
};

const getStatusText = (status: ProgramStatus): string => {
  const texts: Record<ProgramStatus, string> = {
    [ProgramStatus.DRAFT]: 'Taslak',
    [ProgramStatus.PENDING_REVIEW]: 'Inceleniyor',
    [ProgramStatus.APPROVED]: 'Onaylandi',
    [ProgramStatus.DEPLOYING]: 'Yukleniyor',
    [ProgramStatus.DEPLOYED]: 'Devrede',
    [ProgramStatus.ARCHIVED]: 'Arsivlendi',
  };
  return texts[status] || status;
};

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
  const { token } = useAuth();
  const isNew = !programId || programId === 'new';

  // State
  const [activeTab, setActiveTab] = useState<'info' | 'steps' | 'variables' | 'code' | 'deploy'>('info');
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
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [showAddStep, setShowAddStep] = useState(false);
  const [showAddVariable, setShowAddVariable] = useState(false);
  const [newStep, setNewStep] = useState({ stepName: '', stepCode: '', stepOrder: 1, stepType: 'normal' });
  const [newVariable, setNewVariable] = useState({ varName: '', dataType: 'BOOL', initialValue: '', scope: 'LOCAL' });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Query
  const { data, isLoading } = useQuery({
    queryKey: ['automationProgram', programId],
    queryFn: () =>
      graphqlFetch<{
        automationProgram: AutomationProgram;
        programSteps: ProgramStep[];
        programVariables: ProgramVariable[];
        programTransitions: ProgramTransition[];
      }>(PROGRAM_QUERY, { id: programId }, token),
    enabled: !isNew && !!token,
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
    // Auto-clear error after 8 seconds
    setTimeout(() => setErrorMessage((prev) => (prev === message ? null : prev)), 8000);
  };

  const createMutation = useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      graphqlFetch<{ createAutomationProgram: { id: string } }>(CREATE_PROGRAM, { input }, token),
    onSuccess: (result) => {
      setErrorMessage(null);
      navigate(`/sensor/automation/${result.createAutomationProgram.id}`);
    },
    onError: (error: Error) => handleMutationError(error, 'Program olusturulamadi'),
  });

  const updateMutation = useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      graphqlFetch(UPDATE_PROGRAM, { id: programId, input }, token),
    onSuccess: () => {
      setErrorMessage(null);
      queryClient.invalidateQueries({ queryKey: ['automationProgram', programId] });
    },
    onError: (error: Error) => handleMutationError(error, 'Program kaydedilemedi'),
  });

  const submitForReviewMutation = useMutation({
    mutationFn: () => graphqlFetch(SUBMIT_FOR_REVIEW, { id: programId }, token),
    onSuccess: () => {
      setErrorMessage(null);
      queryClient.invalidateQueries({ queryKey: ['automationProgram', programId] });
    },
    onError: (error: Error) => handleMutationError(error, 'Incelemeye gonderilemedi'),
  });

  const addStepMutation = useMutation({
    mutationFn: (input: typeof newStep & { programId: string }) =>
      graphqlFetch(ADD_STEP, { input }, token),
    onSuccess: () => {
      setErrorMessage(null);
      queryClient.invalidateQueries({ queryKey: ['automationProgram', programId] });
      setShowAddStep(false);
      setNewStep({ stepName: '', stepCode: '', stepOrder: (data?.programSteps?.length ?? 0) + 1, stepType: 'normal' });
    },
    onError: (error: Error) => handleMutationError(error, 'Adim eklenemedi'),
  });

  const removeStepMutation = useMutation({
    mutationFn: (id: string) => graphqlFetch(REMOVE_STEP, { id }, token),
    onSuccess: () => {
      setErrorMessage(null);
      queryClient.invalidateQueries({ queryKey: ['automationProgram', programId] });
    },
    onError: (error: Error) => handleMutationError(error, 'Adim silinemedi'),
  });

  const addVariableMutation = useMutation({
    mutationFn: (input: typeof newVariable & { programId: string }) =>
      graphqlFetch(ADD_VARIABLE, { input }, token),
    onSuccess: () => {
      setErrorMessage(null);
      queryClient.invalidateQueries({ queryKey: ['automationProgram', programId] });
      setShowAddVariable(false);
      setNewVariable({ varName: '', dataType: 'BOOL', initialValue: '', scope: 'LOCAL' });
    },
    onError: (error: Error) => handleMutationError(error, 'Degisken eklenemedi'),
  });

  const removeVariableMutation = useMutation({
    mutationFn: (id: string) => graphqlFetch(REMOVE_VARIABLE, { id }, token),
    onSuccess: () => {
      setErrorMessage(null);
      queryClient.invalidateQueries({ queryKey: ['automationProgram', programId] });
    },
    onError: (error: Error) => handleMutationError(error, 'Degisken silinemedi'),
  });

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
    if (programId && newStep.stepName) {
      addStepMutation.mutate({ ...newStep, programId });
    }
  };

  const handleAddVariable = () => {
    if (programId && newVariable.varName) {
      addVariableMutation.mutate({ ...newVariable, programId });
    }
  };

  const program = data?.automationProgram;
  const steps = data?.programSteps || [];
  const variables = data?.programVariables || [];

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
                  onChange={(e) => setNewVariable({ ...newVariable, scope: e.target.value })}
                  className="px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg"
                >
                  <option value="LOCAL">LOCAL</option>
                  <option value="INPUT">INPUT</option>
                  <option value="OUTPUT">OUTPUT</option>
                  <option value="IN_OUT">IN_OUT</option>
                  <option value="GLOBAL">GLOBAL</option>
                </select>
              </div>
              <div className="flex justify-end gap-2 mt-4">
                <button
                  onClick={() => setShowAddVariable(false)}
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
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Aciklama</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {variables.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
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
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
              IEC 61131-3 Structured Text
            </h3>
            <button
              onClick={async () => {
                setIsValidating(true);
                try {
                  const res = await graphqlFetch<{ validateStructuredText: ValidationResult }>(
                    `mutation ValidateST($code: String!) {
                      validateStructuredText(code: $code) {
                        valid
                        errors { line column severity message code }
                        warnings { line column severity message code }
                        infos { line column severity message code }
                        parsedSymbols
                      }
                    }`,
                    { code: stCode },
                    token,
                  );
                  setValidationResult(res.validateStructuredText);
                } catch (err: any) {
                  setValidationResult({
                    valid: false,
                    errors: [{ line: 0, column: 0, severity: 'error', message: err.message }],
                    warnings: [],
                    infos: [],
                  });
                } finally {
                  setIsValidating(false);
                }
              }}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
            >
              <CheckCircle className="h-3.5 w-3.5" />
              Dogrula
            </button>
          </div>
          <STEditor
            value={stCode}
            onChange={setStCode}
            height="450px"
          />
          <CompileResultPanel
            result={validationResult}
            isValidating={isValidating}
          />
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
              {program?.status === ProgramStatus.APPROVED && (
                <button className="inline-flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700">
                  <Upload className="h-4 w-4" />
                  Dagitim Baslat
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AutomationProgramEditorPage;
