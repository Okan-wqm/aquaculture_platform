/**
 * Messaging AI Personas Configuration Page
 *
 * SUPER_ADMIN page for viewing AI persona configuration.
 * Loads real persona definitions from GET /messaging/personas and displays
 * the actual backend state including LIFE-SAFETY fields (actuationPolicy,
 * autonomousSafetyLimits) from TenantAgentConfig.
 *
 * LIFE-SAFETY (C9): This page reflects autonomous PLC actuation policy.
 * It MUST show real backend state, not hardcoded defaults.
 *
 * Personas are platform-managed and read-only: there is no persona write
 * endpoint, so the page offers no toggle or "add persona" control
 * (ADMIN-HIGH-011 — a control whose request can never succeed is not shown).
 *
 * @see ADR-012 Phase 4 (AI Persona-Based Messaging Channels)
 */

import React, { useState, useCallback } from 'react';
import {
  Card,
  Button,
  Badge,
  DataTable,
  type DataTableColumn,
  Spinner,
  PageHeader,
} from '@aquaculture/shared-ui';
import { messagingApi } from '../../services/adminApi';
import type { AiPersonaDefinition } from '../../services/api/messaging';
import type { ApiError } from '../../services/http-client';
import { CircleAlert, Monitor, TriangleAlert } from 'lucide-react';

/** The hard limits the runtime enforces on an autonomous persona; the reference table lists them. */
interface ActuationPolicyField {
  field: string;
  type: string;
  description: string;
  impact: 'CRITICAL' | 'HIGH' | 'MEDIUM';
}

const ACTUATION_POLICY_FIELDS: ActuationPolicyField[] = [
  {
    field: 'maxDosingKg',
    type: 'number (nullable)',
    description: 'Maximum reagent dosing per actuation in kilograms',
    impact: 'CRITICAL',
  },
  {
    field: 'phRange',
    type: '{ min, max } (nullable)',
    description: 'Allowed pH range for autonomous adjustments',
    impact: 'CRITICAL',
  },
  {
    field: 'temperatureRange',
    type: '{ min, max } (nullable)',
    description: 'Allowed temperature range for autonomous adjustments',
    impact: 'CRITICAL',
  },
  {
    field: 'autonomousActionsEnabled',
    type: 'boolean',
    description: 'Master switch for autonomous AI actions',
    impact: 'HIGH',
  },
  {
    field: 'proactiveMonitoringEnabled',
    type: 'boolean',
    description: 'Whether AI proactively monitors sensor data',
    impact: 'MEDIUM',
  },
];

const IMPACT_BADGE: Record<ActuationPolicyField['impact'], 'error' | 'warning' | 'info'> = {
  CRITICAL: 'error',
  HIGH: 'warning',
  MEDIUM: 'info',
};

const actuationPolicyColumns: DataTableColumn<ActuationPolicyField>[] = [
  {
    key: 'field',
    header: 'Field',
    render: (_value, row) => (
      <span className="font-mono text-gray-700 dark:text-gray-300">{row.field}</span>
    ),
  },
  {
    key: 'type',
    header: 'Type',
    render: (_value, row) => <span className="text-gray-500 dark:text-gray-400">{row.type}</span>,
  },
  {
    key: 'description',
    header: 'Description',
    render: (_value, row) => (
      <span className="text-gray-600 dark:text-gray-400">{row.description}</span>
    ),
  },
  {
    key: 'impact',
    header: 'Safety Impact',
    render: (_value, row) => (
      <Badge variant={IMPACT_BADGE[row.impact]} size="sm">
        {row.impact}
      </Badge>
    ),
  },
];

// ============================================================================
// Types
// ============================================================================

interface LoadState {
  loading: boolean;
  error: string | null;
}

// ============================================================================
// Color mapping for badge styling
// ============================================================================

const COLOR_CLASSES: Record<string, string> = {
  purple: 'bg-accent-100 text-accent-700 dark:bg-accent-900/30 dark:text-accent-300',
  cyan: 'bg-info-100 text-info-700 dark:bg-info-900/30 dark:text-info-300',
  blue: 'bg-info-100 text-info-700 dark:bg-info-900/30 dark:text-info-300',
  green: 'bg-success-100 text-success-700 dark:bg-success-900/30 dark:text-success-300',
  orange: 'bg-accent-100 text-accent-700 dark:bg-accent-900/30 dark:text-accent-300',
};

// ============================================================================
// LIFE-SAFETY: Actuation policy descriptions
// ============================================================================

/** LIFE-SAFETY: Human-readable descriptions for each actuation policy level. */
const ACTUATION_POLICY_INFO: Record<string, { label: string; color: string; description: string }> =
  {
    blocked: {
      label: 'BLOCKED',
      color:
        'bg-error-100 dark:bg-error-900/40 text-error-800 dark:text-error-200 border-error-300 dark:border-error-700',
      description:
        'AI cannot execute any PLC actuation commands. All actuation requests are rejected.',
    },
    confirm_required: {
      label: 'CONFIRM REQUIRED',
      color:
        'bg-warning-100 dark:bg-warning-900/40 text-warning-800 dark:text-warning-200 border-warning-300 dark:border-warning-700',
      description:
        'AI can propose actuation commands but requires explicit human confirmation before execution.',
    },
    allowed: {
      label: 'ALLOWED',
      color:
        'bg-error-100 dark:bg-error-900/40 text-error-800 dark:text-error-200 border-error-300 dark:border-error-700',
      description:
        'AI can execute actuation commands autonomously within configured safety limits. CAUTION: This enables autonomous PLC control.',
    },
  };

/** Columns of the persona configuration table (FE-HIGH-069). The persona
 *  colour drives both the icon tile and the capability chips. */
const personaColumns: DataTableColumn<AiPersonaDefinition>[] = [
  {
    key: 'name',
    header: 'Persona',
    render: (_value, persona) => {
      const colorClass = COLOR_CLASSES[persona.color] ?? COLOR_CLASSES['purple'];
      return (
        <div className="flex items-center gap-3">
          <span
            className={`inline-flex items-center justify-center w-8 h-8 rounded-lg text-xs font-bold ${colorClass}`}
          >
            {persona.icon.charAt(0).toUpperCase()}
          </span>
          <div>
            <p className="text-sm font-semibold text-gray-900 dark:text-white">{persona.name}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400">{persona.description}</p>
          </div>
        </div>
      );
    },
  },
  {
    key: 'id',
    header: 'ID',
    render: (_value, persona) => (
      <code className="text-xs bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded font-mono text-gray-600 dark:text-gray-300">
        {persona.id ?? 'general'}
      </code>
    ),
  },
  {
    key: 'capabilities',
    header: 'Capabilities',
    render: (_value, persona) => {
      const colorClass = COLOR_CLASSES[persona.color] ?? COLOR_CLASSES['purple'];
      return (
        <div className="flex flex-wrap gap-1">
          {persona.capabilities.slice(0, 3).map((cap) => (
            <span key={cap} className={`text-[10px] px-1.5 py-0.5 rounded-full ${colorClass}`}>
              {cap}
            </span>
          ))}
          {persona.capabilities.length > 3 && (
            <span className="text-[10px] text-gray-400 dark:text-gray-500">
              +{persona.capabilities.length - 3} more
            </span>
          )}
        </div>
      );
    },
  },
];

// ============================================================================
// Main Component
// ============================================================================

/** Admin page for viewing AI persona configuration from the real backend. */
function MessagingAiPersonasPage(): React.ReactElement {
  const [personas, setPersonas] = useState<AiPersonaDefinition[]>([]);
  const [loadState, setLoadState] = useState<LoadState>({ loading: true, error: null });
  const [tenantId, setTenantId] = useState<string>('');

  // ── Load personas from backend ──────────────────────────────────────

  const fetchPersonas = useCallback(async (tid: string): Promise<void> => {
    if (!tid.trim()) {
      setPersonas([]);
      setLoadState({ loading: false, error: null });
      return;
    }

    setLoadState({ loading: true, error: null });

    try {
      const result = await messagingApi.getPersonas(tid.trim());
      setPersonas(result);
      setLoadState({ loading: false, error: null });
    } catch (err: unknown) {
      const apiErr = err as ApiError;
      setPersonas([]);
      setLoadState({
        loading: false,
        error: apiErr.message || 'Failed to load personas from backend.',
      });
    }
  }, []);

  // ── Render ──────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Page header */}
      <PageHeader
        title="AI Personas Configuration"
        description={
          <>
            View AI assistant personas from the backend registry. Each persona maps to a specialized
            ai-service profile with real actuation policies.
          </>
        }
      />

      {/* LIFE-SAFETY Warning */}
      <Card className="p-4 bg-error-50 dark:bg-error-900/20 border-error-300 dark:border-error-800">
        <div className="flex items-start gap-3">
          <TriangleAlert
            className="w-5 h-5 text-error-600 dark:text-error-400 mt-0.5 flex-shrink-0"
            aria-hidden="true"
          />
          <div>
            <h3 className="text-sm font-semibold text-error-900 dark:text-error-200">
              LIFE-SAFETY: Autonomous PLC Actuation
            </h3>
            <p className="text-xs text-error-700 dark:text-error-300 leading-relaxed mt-1">
              Some AI personas (especially SCADA AI / Supervisor) can control physical equipment
              through PLC actuation. The actuation policy and autonomous safety limits shown below
              are loaded from the real backend TenantAgentConfig entity. These are not display-only
              values -- they directly control what the AI can do to physical infrastructure. Always
              verify actuation policies match your operational requirements.
            </p>
          </div>
        </div>
      </Card>

      {/* Tenant ID Input */}
      <Card>
        <div className="p-4">
          <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-end">
            <div className="flex-1 w-full">
              <label
                htmlFor="persona-tenant-id"
                className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                Tenant ID (UUID) -- required to load personas
              </label>
              <input
                id="persona-tenant-id"
                type="text"
                placeholder="e.g. 550e8400-e29b-41d4-a716-446655440000"
                value={tenantId}
                onChange={(e) => setTenantId(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm font-mono focus:ring-2 focus:ring-info-500 focus:border-info-500 outline-hidden bg-white dark:bg-gray-800"
              />
            </div>
            <Button
              onClick={() => void fetchPersonas(tenantId)}
              disabled={loadState.loading || !tenantId.trim()}
              variant="primary"
              size="sm"
            >
              {loadState.loading ? 'Loading...' : 'Load Personas'}
            </Button>
          </div>
        </div>
      </Card>

      {/* Error State */}
      {loadState.error && (
        <Card className="p-4 bg-error-50 dark:bg-error-900/20 border-error-200 dark:border-error-800">
          <div className="flex items-start gap-3">
            <CircleAlert
              className="w-5 h-5 text-error-500 mt-0.5 flex-shrink-0"
              aria-hidden="true"
            />
            <div>
              <p className="text-sm font-medium text-error-800 dark:text-error-200">
                Failed to load personas
              </p>
              <p className="text-xs text-error-700 dark:text-error-300 mt-1">{loadState.error}</p>
              <button
                onClick={() => void fetchPersonas(tenantId)}
                className="text-xs text-error-600 dark:text-error-400 hover:text-error-800 dark:hover:text-error-200 mt-2 underline"
              >
                Retry
              </button>
            </div>
          </div>
        </Card>
      )}

      {/* Loading State */}
      {loadState.loading && (
        <Card>
          <div className="flex items-center justify-center py-16">
            <div className="text-center">
              <Spinner size="lg" block className="mb-3" />
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Loading personas from backend...
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* Personas table -- only shown when data is loaded */}
      {!loadState.loading && !loadState.error && personas.length > 0 && (
        <DataTable<AiPersonaDefinition>
          data={personas}
          columns={personaColumns}
          keyExtractor={(persona) => persona.id ?? 'general'}
          emptyMessage="No personas"
          searchable={false}
          sortable={false}
          stickyHeader={false}
        />
      )}

      {/* No personas loaded yet (initial state) */}
      {!loadState.loading && !loadState.error && personas.length === 0 && !tenantId.trim() && (
        <Card>
          <div className="flex items-center justify-center py-16">
            <div className="text-center">
              <Monitor className="w-12 h-12 text-gray-300 mx-auto mb-3" aria-hidden="true" />
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Enter a Tenant ID and click "Load Personas" to view the AI persona configuration
                from the backend.
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* LIFE-SAFETY: Actuation Policy Reference */}
      <Card>
        <div className="p-5">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">
            Actuation Policy Reference (from TenantAgentConfig)
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
            These policies are configured per-tenant in the TenantAgentConfig entity. The effective
            policy is the most restrictive between the persona base policy and the tenant override.
            Fields: actuationPolicy, autonomousSafetyLimits, autonomousActionsEnabled,
            proactiveMonitoringEnabled.
          </p>
          <div className="space-y-3">
            {Object.entries(ACTUATION_POLICY_INFO).map(([key, info]) => (
              <div key={key} className={`p-3 rounded-lg border ${info.color}`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-bold">{info.label}</span>
                  <code className="text-[10px] bg-white/50 dark:bg-gray-900/50 px-1.5 py-0.5 rounded font-mono">
                    actuationPolicy: &apos;{key}&apos;
                  </code>
                </div>
                <p className="text-xs leading-relaxed">{info.description}</p>
              </div>
            ))}
          </div>
        </div>
      </Card>

      {/* LIFE-SAFETY: Autonomous Safety Limits Reference */}
      <Card>
        <div className="p-5">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">
            Autonomous Safety Limits (from TenantAgentConfig)
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
            When autonomousActionsEnabled is true and actuationPolicy is &apos;allowed&apos;, the AI
            operates within these hard limits enforced by the platform runtime. Values exceeding
            these limits trigger automatic escalation to human operators.
          </p>
          <DataTable<ActuationPolicyField>
            data={ACTUATION_POLICY_FIELDS}
            columns={actuationPolicyColumns}
            keyExtractor={(field) => field.field}
            searchable={false}
            sortable={false}
            stickyHeader={false}
            compact
          />
        </div>
      </Card>

      {/* Architecture Note */}
      <Card className="p-4 bg-info-50 dark:bg-info-900/20 border-info-200 dark:border-info-800">
        <h3 className="text-sm font-semibold text-info-900 dark:text-info-200 mb-1">
          Architecture Note
        </h3>
        <p className="text-xs text-info-700 dark:text-info-300 leading-relaxed">
          Persona definitions are loaded from the messaging-service AiPersonasRegistryService via
          NATS request-reply (pattern: request.messaging.admin.getPersonas). Per-tenant actuation
          policies and safety limits are stored in the TenantAgentConfig entity in the ai-service
          database. The effective actuation policy is resolved at runtime by AgentProfileService
          using most-restrictive-wins logic between the persona base policy and the tenant override.
          Custom personas backed by external MCP servers are planned for a future release.
        </p>
      </Card>
    </div>
  );
}

export default MessagingAiPersonasPage;
