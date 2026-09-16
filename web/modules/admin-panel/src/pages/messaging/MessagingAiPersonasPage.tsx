/**
 * AI Personas — a LIFE-SAFETY page that said hardcoded documentation was the
 * tenant's live PLC actuation policy (ADMIN-CRITICAL-154 / ADMIN-HIGH-121).
 *
 * The page's own docblock stated the rule it broke:
 *
 *   > LIFE-SAFETY (C9): This page reflects autonomous PLC actuation policy.
 *   > It MUST show real backend state, not hardcoded defaults.
 *
 * and its red banner told the operator:
 *
 *   > The actuation policy and autonomous safety limits shown below are loaded
 *   > from the real backend TenantAgentConfig entity. These are not
 *   > display-only values -- they directly control what the AI can do to
 *   > physical infrastructure. Always verify actuation policies match your
 *   > operational requirements.
 *
 * **Nothing on this page was ever loaded from `TenantAgentConfig`.** The two
 * sections headed "(from TenantAgentConfig)" were a static glossary typed into
 * the file: `ACTUATION_POLICY_GLOSSARY` describes what the three policy VALUES
 * mean, and the safety-limits table lists FIELD NAMES and their descriptions.
 * `GET /messaging/personas` returns
 * `{id, name, description, icon, color, capabilities}` — no policy, no limits —
 * and admin-api has **no route, no NATS call and no reference** to
 * `TenantAgentConfig`, `actuationPolicy` or `autonomousSafetyLimits` anywhere
 * in the service.
 *
 * So an operator who came here to verify that a tenant's SCADA AI cannot
 * autonomously dose reagent was shown a glossary, told it was that tenant's
 * live configuration, and instructed to verify against it. That is a
 * fabricated PROVENANCE rather than a fabricated number, on the surface that
 * governs autonomous control of physical equipment — which is why it outranks
 * every other finding in this audit.
 *
 * This commit removes the claim: the reference sections say what they are, the
 * banner says what the page can and cannot show, and the place an operator
 * looks for the effective policy states plainly that admin-api cannot read it
 * yet, naming ADMIN-HIGH-155 — the read path that has to be built, in
 * ai-service and admin-api, before this page can answer the question it was
 * built to answer.
 *
 * Also fixed here: the table declared four headers and rendered three cells,
 * so the "Scope" column was empty; the tenant was an unvalidated free-text
 * UUID box; and admin-api's `PersonaResponse` declared `id: string` where the
 * reply sends `string | null`, invented an `isActive`, and omitted `icon`,
 * `color` and `capabilities` — the panel's hand-written type was the more
 * accurate of the two.
 *
 * Personas themselves remain read-only: there is no persona write endpoint, so
 * the page offers no toggle or "add persona" control (ADMIN-HIGH-011 — a
 * control whose request can never succeed is not shown).
 *
 * @see ADR-012 Phase 4 (AI Persona-Based Messaging Channels)
 */

import React, { useState } from 'react';
import { Card, Badge } from '@aquaculture/shared-ui';
import { messagingApi } from '../../services/api/messaging';
import type { AiPersonaDefinition } from '../../services/api/messaging';
import { adminKeys, useAdminQuery } from '../../hooks';
import { TenantSelect } from '../../components/TenantSelect';
import { QueryFailureNotice } from '../../components/QueryFailureNotice';

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
// Actuation policy GLOSSARY — what the values mean, not what a tenant has
// ============================================================================

/**
 * What each `actuationPolicy` value means.
 *
 * A GLOSSARY. It was headed "Actuation Policy Reference (from
 * TenantAgentConfig)", which read as this tenant's configuration; it is three
 * definitions, and no tenant's policy is on this page at all.
 */
const ACTUATION_POLICY_GLOSSARY: Record<
  string,
  { readonly label: string; readonly color: string; readonly description: string }
> = {
  blocked: {
    label: 'BLOCKED',
    color: 'bg-red-100 text-red-800 border-red-300',
    description:
      'AI cannot execute any PLC actuation commands. All actuation requests are rejected.',
  },
  confirm_required: {
    label: 'CONFIRM REQUIRED',
    color: 'bg-amber-100 text-amber-800 border-amber-300',
    description:
      'AI can propose actuation commands but requires explicit human confirmation before execution.',
  },
  allowed: {
    label: 'ALLOWED',
    color: 'bg-red-100 text-red-800 border-red-300',
    description:
      'AI can execute actuation commands autonomously within configured safety limits. CAUTION: this enables autonomous PLC control.',
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
          {persona.capabilities.slice(0, 3).map((cap: string) => (
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
      {/* The table declared four headers and rendered three cells, so this
          column was empty. It says what the persona's reach is — which is a
          property of the registry entry, not of any tenant's policy. */}
      <td className="px-4 py-3 text-center">
        <Badge variant={persona.id === null ? 'info' : 'default'} size="sm">
          {persona.id === null ? 'All tenants' : 'Platform persona'}
        </Badge>
      </td>
    </tr>
  );
}

// ============================================================================
// Main Component
// ============================================================================

/** Admin page for viewing AI persona configuration from the real backend. */
function MessagingAiPersonasPage(): React.ReactElement {
  const [tenantId, setTenantId] = useState<string | null>(null);

  const personasQuery = useAdminQuery<AiPersonaDefinition[]>(
    adminKeys.messaging.personas(tenantId ?? ''),
    ({ signal }) => messagingApi.getPersonas(tenantId ?? '', signal),
    { enabled: tenantId !== null },
  );

  const personas = personasQuery.data ?? [];

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            AI Personas Configuration
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            The AI assistant personas in the messaging registry, per tenant. Read-only: there is
            no persona write endpoint.
          </p>
        </div>
      </div>

      {/*
        LIFE-SAFETY: what this page can and cannot tell you.

        The previous banner said the actuation policy and safety limits shown
        below were "loaded from the real backend TenantAgentConfig entity" and
        were "not display-only values". They are exactly display-only: nothing
        on this page has ever been read from TenantAgentConfig, and admin-api
        has no route to it (ADMIN-CRITICAL-154). Saying so is the only honest
        state until ADMIN-HIGH-155 builds the read path.
      */}
      <Card className="p-4 bg-red-50 dark:bg-red-900/20 border-red-300 dark:border-red-800">
        <div className="flex items-start gap-3">
          <svg
            className="w-5 h-5 text-red-600 mt-0.5 flex-shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
          <div>
            <h3 className="text-sm font-semibold text-red-900 dark:text-red-200">
              LIFE-SAFETY: this page does NOT show a tenant&apos;s actuation policy
            </h3>
            <p className="text-xs text-red-700 dark:text-red-300 leading-relaxed mt-1">
              Some AI personas — the SCADA supervisor above all — can control physical equipment
              through PLC actuation. What any given tenant&apos;s AI is actually permitted to
              actuate is decided by <span className="font-mono">TenantAgentConfig</span> in
              ai-service: <span className="font-mono">actuationPolicy</span> and{' '}
              <span className="font-mono">autonomousSafetyLimits</span>.{' '}
              <strong>
                admin-api cannot read that entity, so none of it appears on this page.
              </strong>{' '}
              The capability labels below describe what a persona is FOR, not what it is allowed
              to do. Verify a tenant&apos;s effective policy in ai-service directly until the
              read path lands (tracked as ADMIN-HIGH-155); the two reference sections at the
              bottom of this page are field documentation, not this tenant&apos;s settings.
            </p>
          </div>
        </div>
      </Card>

      {/* Tenant picker */}
      <Card>
        <div className="p-4">
          <label
            htmlFor="persona-tenant"
            className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1"
          >
            Tenant
          </label>
          {/* A picker, not a UUID box. The route verifies the id against
              `auth.tenants` and refuses anything else, so hand-typing it only
              ever produced a 400 an operator had to decode. */}
          <div id="persona-tenant" className="max-w-sm">
            <TenantSelect value={tenantId} onChange={(next) => setTenantId(next || null)} />
          </div>
        </div>
      </Card>

      <QueryFailureNotice
        errors={[personasQuery.error]}
        hasContent={personas.length > 0}
        onRetry={() => void personasQuery.refetch()}
      />

      {tenantId === null ? (
        <Card>
          <div className="flex items-center justify-center py-16">
            <div className="text-center">
              <p className="text-sm text-gray-500">
                Choose a tenant to see the personas its AI has available.
              </p>
            </div>
          </div>
        </Card>
      ) : personasQuery.isPending ? (
        <Card>
          <div className="flex items-center justify-center py-16">
            <div className="text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mx-auto mb-3" />
              <p className="text-sm text-gray-500">Loading personas...</p>
            </div>
          </div>
        </Card>
      ) : personasQuery.isError ? (
        // The notice above carries the reason; no table is drawn.
        null
      ) : personas.length === 0 ? (
        <Card>
          <div className="flex items-center justify-center py-16">
            <p className="text-sm text-gray-500">
              This tenant has no AI personas available.
            </p>
          </div>
        </Card>
      ) : (
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
                    Capabilities (descriptive, not permissions)
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

      {/* The effective policy — the answer this page cannot give yet */}
      <Card className="p-4 border-dashed">
        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
          Effective actuation policy for this tenant
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          Not shown, because admin-api cannot read it. The effective policy is resolved at
          runtime by <span className="font-mono">AgentProfileService</span> as the most
          restrictive of the persona base policy and the tenant override in ai-service&apos;s{' '}
          <span className="font-mono">TenantAgentConfig</span>; admin-api has no route, no NATS
          call and no reference to that entity. Building the read path is tracked as
          ADMIN-HIGH-155. Until it lands, this panel is empty rather than filled with a default,
          because a default here reads as a policy.
        </p>
      </Card>

      {/* LIFE-SAFETY: Actuation Policy Reference */}
      <Card>
        <div className="p-5">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">
            What each actuation policy value means
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
            A glossary of the three values{' '}
            <span className="font-mono">TenantAgentConfig.actuationPolicy</span> can hold —{' '}
            <strong>not this tenant&apos;s setting</strong>. Nothing in this section is read
            from anywhere.
          </p>
          <div className="space-y-3">
            {Object.entries(ACTUATION_POLICY_GLOSSARY).map(([key, info]) => (
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
            The fields that make up an autonomous safety limit
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
            The SHAPE of{' '}
            <span className="font-mono">TenantAgentConfig.autonomousSafetyLimits</span> — field
            names, types and what each one bounds. <strong>No values</strong>: this page cannot
            read the entity. When{' '}
            <span className="font-mono">autonomousActionsEnabled</span> is true and{' '}
            <span className="font-mono">actuationPolicy</span> is &lsquo;allowed&rsquo;, the AI
            operates within whatever limits that tenant has set, enforced by the platform
            runtime.
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
          policy and the tenant override — and admin-api has no route to that entity, which is
          why this page shows personas and not policies (ADMIN-HIGH-155). Custom personas
          backed by external MCP servers are not implemented.
        </p>
      </Card>
    </div>
  );
}

export default MessagingAiPersonasPage;
