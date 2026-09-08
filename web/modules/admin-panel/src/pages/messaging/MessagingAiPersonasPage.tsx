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
import { Card, Button, Badge } from '@aquaculture/shared-ui';
import { messagingApi } from '../../services/adminApi';
import type { AiPersonaDefinition } from '../../services/api/messaging';
import type { ApiError } from '../../services/http-client';

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
  purple: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
  cyan: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300',
  blue: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  green: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  orange: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
};

// ============================================================================
// LIFE-SAFETY: Actuation policy descriptions
// ============================================================================

/** LIFE-SAFETY: Human-readable descriptions for each actuation policy level. */
const ACTUATION_POLICY_INFO: Record<string, { label: string; color: string; description: string }> = {
  blocked: {
    label: 'BLOCKED',
    color: 'bg-red-100 text-red-800 border-red-300',
    description: 'AI cannot execute any PLC actuation commands. All actuation requests are rejected.',
  },
  confirm_required: {
    label: 'CONFIRM REQUIRED',
    color: 'bg-amber-100 text-amber-800 border-amber-300',
    description: 'AI can propose actuation commands but requires explicit human confirmation before execution.',
  },
  allowed: {
    label: 'ALLOWED',
    color: 'bg-red-100 text-red-800 border-red-300',
    description: 'AI can execute actuation commands autonomously within configured safety limits. CAUTION: This enables autonomous PLC control.',
  },
};

// ============================================================================
// PersonaRow Component
// ============================================================================

/** Row for a single persona in the configuration table. */
function PersonaRow({ persona }: { persona: AiPersonaDefinition }): React.ReactElement {
  const colorClass = COLOR_CLASSES[persona.color] ?? COLOR_CLASSES['purple'];

  return (
    <tr className="border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50">
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center justify-center w-8 h-8 rounded-lg text-xs font-bold ${colorClass}`}>
            {persona.icon.charAt(0).toUpperCase()}
          </span>
          <div>
            <p className="text-sm font-semibold text-gray-900 dark:text-white">
              {persona.name}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {persona.description}
            </p>
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        <code className="text-xs bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded font-mono text-gray-600 dark:text-gray-400">
          {persona.id ?? 'general'}
        </code>
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-1">
          {persona.capabilities.slice(0, 3).map((cap) => (
            <span
              key={cap}
              className={`text-[10px] px-1.5 py-0.5 rounded-full ${colorClass}`}
            >
              {cap}
            </span>
          ))}
          {persona.capabilities.length > 3 && (
            <span className="text-[10px] text-gray-400">
              +{persona.capabilities.length - 3} more
            </span>
          )}
        </div>
      </td>
    </tr>
  );
}

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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            AI Personas Configuration
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            View AI assistant personas from the backend registry.
            Each persona maps to a specialized ai-service profile with real actuation policies.
          </p>
        </div>
      </div>

      {/* LIFE-SAFETY Warning */}
      <Card className="p-4 bg-red-50 dark:bg-red-900/20 border-red-300 dark:border-red-800">
        <div className="flex items-start gap-3">
          <svg className="w-5 h-5 text-red-600 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <div>
            <h3 className="text-sm font-semibold text-red-900 dark:text-red-200">
              LIFE-SAFETY: Autonomous PLC Actuation
            </h3>
            <p className="text-xs text-red-700 dark:text-red-300 leading-relaxed mt-1">
              Some AI personas (especially SCADA AI / Supervisor) can control physical
              equipment through PLC actuation. The actuation policy and autonomous safety
              limits shown below are loaded from the real backend TenantAgentConfig entity.
              These are not display-only values -- they directly control what the AI can
              do to physical infrastructure. Always verify actuation policies match your
              operational requirements.
            </p>
          </div>
        </div>
      </Card>

      {/* Tenant ID Input */}
      <Card>
        <div className="p-4">
          <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-end">
            <div className="flex-1 w-full">
              <label htmlFor="persona-tenant-id" className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                Tenant ID (UUID) -- required to load personas
              </label>
              <input
                id="persona-tenant-id"
                type="text"
                placeholder="e.g. 550e8400-e29b-41d4-a716-446655440000"
                value={tenantId}
                onChange={(e) => setTenantId(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-hidden bg-white dark:bg-gray-800"
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
        <Card className="p-4 bg-red-50 border-red-200">
          <div className="flex items-start gap-3">
            <svg className="w-5 h-5 text-red-500 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <p className="text-sm font-medium text-red-800">Failed to load personas</p>
              <p className="text-xs text-red-700 mt-1">{loadState.error}</p>
              <button
                onClick={() => void fetchPersonas(tenantId)}
                className="text-xs text-red-600 hover:text-red-800 mt-2 underline"
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
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mx-auto mb-3" />
              <p className="text-sm text-gray-500">Loading personas from backend...</p>
            </div>
          </div>
        </Card>
      )}

      {/* Personas table -- only shown when data is loaded */}
      {!loadState.loading && !loadState.error && personas.length > 0 && (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="bg-gray-50 dark:bg-gray-800/50 border-b border-gray-200 dark:border-gray-700">
                <tr>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Persona
                  </th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    ID
                  </th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Capabilities
                  </th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider text-center">
                    Scope
                  </th>
                </tr>
              </thead>
              <tbody>
                {personas.map((persona) => (
                  <PersonaRow key={persona.id ?? 'general'} persona={persona} />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* No personas loaded yet (initial state) */}
      {!loadState.loading && !loadState.error && personas.length === 0 && !tenantId.trim() && (
        <Card>
          <div className="flex items-center justify-center py-16">
            <div className="text-center">
              <svg className="w-12 h-12 text-gray-300 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              <p className="text-sm text-gray-500">Enter a Tenant ID and click "Load Personas" to view the AI persona configuration from the backend.</p>
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
            These policies are configured per-tenant in the TenantAgentConfig entity.
            The effective policy is the most restrictive between the persona base policy
            and the tenant override. Fields: actuationPolicy, autonomousSafetyLimits,
            autonomousActionsEnabled, proactiveMonitoringEnabled.
          </p>
          <div className="space-y-3">
            {Object.entries(ACTUATION_POLICY_INFO).map(([key, info]) => (
              <div
                key={key}
                className={`p-3 rounded-lg border ${info.color}`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-bold">{info.label}</span>
                  <code className="text-[10px] bg-white/50 px-1.5 py-0.5 rounded font-mono">
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
            When autonomousActionsEnabled is true and actuationPolicy is &apos;allowed&apos;,
            the AI operates within these hard limits enforced by the platform runtime.
            Values exceeding these limits trigger automatic escalation to human operators.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-gray-50 dark:bg-gray-800/50">
                <tr>
                  <th className="px-3 py-2 font-semibold text-gray-500 uppercase tracking-wider">Field</th>
                  <th className="px-3 py-2 font-semibold text-gray-500 uppercase tracking-wider">Type</th>
                  <th className="px-3 py-2 font-semibold text-gray-500 uppercase tracking-wider">Description</th>
                  <th className="px-3 py-2 font-semibold text-gray-500 uppercase tracking-wider">Safety Impact</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                <tr>
                  <td className="px-3 py-2 font-mono text-gray-700">maxDosingKg</td>
                  <td className="px-3 py-2 text-gray-500">number (nullable)</td>
                  <td className="px-3 py-2 text-gray-600">Maximum reagent dosing per actuation in kilograms</td>
                  <td className="px-3 py-2">
                    <Badge variant="error" size="sm">CRITICAL</Badge>
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2 font-mono text-gray-700">phRange</td>
                  <td className="px-3 py-2 text-gray-500">{'{ min, max }'} (nullable)</td>
                  <td className="px-3 py-2 text-gray-600">Allowed pH range for autonomous adjustments</td>
                  <td className="px-3 py-2">
                    <Badge variant="error" size="sm">CRITICAL</Badge>
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2 font-mono text-gray-700">temperatureRange</td>
                  <td className="px-3 py-2 text-gray-500">{'{ min, max }'} (nullable)</td>
                  <td className="px-3 py-2 text-gray-600">Allowed temperature range for autonomous adjustments</td>
                  <td className="px-3 py-2">
                    <Badge variant="error" size="sm">CRITICAL</Badge>
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2 font-mono text-gray-700">autonomousActionsEnabled</td>
                  <td className="px-3 py-2 text-gray-500">boolean</td>
                  <td className="px-3 py-2 text-gray-600">Master switch for autonomous AI actions</td>
                  <td className="px-3 py-2">
                    <Badge variant="warning" size="sm">HIGH</Badge>
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2 font-mono text-gray-700">proactiveMonitoringEnabled</td>
                  <td className="px-3 py-2 text-gray-500">boolean</td>
                  <td className="px-3 py-2 text-gray-600">Whether AI proactively monitors sensor data</td>
                  <td className="px-3 py-2">
                    <Badge variant="info" size="sm">MEDIUM</Badge>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </Card>

      {/* Architecture Note */}
      <Card className="p-4 bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800">
        <h3 className="text-sm font-semibold text-blue-900 dark:text-blue-200 mb-1">
          Architecture Note
        </h3>
        <p className="text-xs text-blue-700 dark:text-blue-300 leading-relaxed">
          Persona definitions are loaded from the messaging-service AiPersonasRegistryService
          via NATS request-reply (pattern: request.messaging.admin.getPersonas). Per-tenant
          actuation policies and safety limits are stored in the TenantAgentConfig entity in
          the ai-service database. The effective actuation policy is resolved at runtime by
          AgentProfileService using most-restrictive-wins logic between the persona base
          policy and the tenant override. Custom personas backed by external MCP servers are
          planned for a future release.
        </p>
      </Card>
    </div>
  );
}

export default MessagingAiPersonasPage;
