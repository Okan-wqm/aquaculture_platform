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
import {
  Card,
  Badge,
  DataTable,
  type DataTableColumn,
  Spinner,
  PageHeader,
} from '@aquaculture/shared-ui';
import { AI_TIER_PRESENTATION, parseAiPersonaId } from '@aquaculture/shared-contracts';
import { messagingApi } from '../../services/api/messaging';
import type { AiPersonaDefinition } from '../../services/api/messaging';
import { adminKeys, useAdminQuery } from '../../hooks';
import { TenantSelect } from '../../components/TenantSelect';
import { QueryFailureNotice } from '../../components/QueryFailureNotice';
import { Monitor, TriangleAlert } from 'lucide-react';

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
      'AI can execute actuation commands autonomously within configured safety limits. CAUTION: this enables autonomous PLC control.',
  },
};

// ============================================================================
// Tier × specialty (AISAFETY-MEDIUM-024)
// ============================================================================

/**
 * Personas are composed as `<tier>[-<specialty>]-v<N>` from the shared
 * catalogue. The tier is the authority level (model, actuation ceiling,
 * `ai_personas:<tier>` capability); the specialty is the tool bundle and, for
 * module-gated ones, the extra `ai_specialties:<module>` capability. The
 * inventory reads both from the id grammar so the shape is visible at a glance.
 */
function tierAndSpecialty(personaId: string | null): { tier: string; specialty: string } {
  const parsed = personaId ? parseAiPersonaId(personaId) : null;
  if (!parsed) return { tier: 'Tenant default', specialty: 'general' };
  return { tier: AI_TIER_PRESENTATION[parsed.tier].label, specialty: parsed.specialty };
}

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
    key: 'tier',
    header: 'Tier / Specialty',
    render: (_value, persona) => {
      const shape = tierAndSpecialty(persona.id);
      return (
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">
            {shape.tier}
          </span>
          <code className="text-[10px] font-mono text-gray-500 dark:text-gray-400">
            {shape.specialty}
          </code>
        </div>
      );
    },
  },
  {
    key: 'capabilities',
    header: 'Capabilities (descriptive, not permissions)',
    render: (_value, persona) => {
      const colorClass = COLOR_CLASSES[persona.color] ?? COLOR_CLASSES['purple'];
      return (
        <div className="flex flex-wrap gap-1">
          {persona.capabilities.slice(0, 3).map((cap: string) => (
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
  {
    // The table declared four headers and rendered three cells, so this
    // column was empty. It says what the persona's reach is — which is a
    // property of the registry entry, not of any tenant's policy.
    key: 'scope',
    header: 'Scope',
    align: 'center',
    render: (_value, persona) => (
      <Badge variant={persona.id === null ? 'info' : 'default'} size="sm">
        {persona.id === null ? 'All tenants' : 'Platform persona'}
      </Badge>
    ),
  },
];

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
      <PageHeader
        title="AI Personas Configuration"
        description={
          <>
            The AI assistant personas in the messaging registry, per tenant. Read-only: there is
            no persona write endpoint.
          </>
        }
      />

      {/*
        LIFE-SAFETY: what this page can and cannot tell you.

        The previous banner said the actuation policy and safety limits shown
        below were "loaded from the real backend TenantAgentConfig entity" and
        were "not display-only values". They are exactly display-only: nothing
        on this page has ever been read from TenantAgentConfig, and admin-api
        has no route to it (ADMIN-CRITICAL-154). Saying so is the only honest
        state until ADMIN-HIGH-155 builds the read path.
      */}
      <Card className="p-4 bg-error-50 dark:bg-error-900/20 border-error-300 dark:border-error-800">
        <div className="flex items-start gap-3">
          <TriangleAlert
            className="w-5 h-5 text-error-600 dark:text-error-400 mt-0.5 flex-shrink-0"
            aria-hidden="true"
          />
          <div>
            <h3 className="text-sm font-semibold text-error-900 dark:text-error-200">
              LIFE-SAFETY: this page does NOT show a tenant&apos;s actuation policy
            </h3>
            <p className="text-xs text-error-700 dark:text-error-300 leading-relaxed mt-1">
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
              <Monitor className="w-12 h-12 text-gray-300 mx-auto mb-3" aria-hidden="true" />
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Choose a tenant to see the personas its AI has available.
              </p>
            </div>
          </div>
        </Card>
      ) : personasQuery.isPending ? (
        <Card>
          <div className="flex items-center justify-center py-16">
            <div className="text-center">
              <Spinner size="lg" block className="mb-3" />
              <p className="text-sm text-gray-500 dark:text-gray-400">Loading personas...</p>
            </div>
          </div>
        </Card>
      ) : personasQuery.isError ? (
        // The notice above carries the reason; no table is drawn.
        null
      ) : personas.length === 0 ? (
        <Card>
          <div className="flex items-center justify-center py-16">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              This tenant has no AI personas available.
            </p>
          </div>
        </Card>
      ) : (
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
          using most-restrictive-wins logic between the persona base policy and the tenant override
          — and admin-api has no route to that entity, which is why this page shows personas and
          not policies (ADMIN-HIGH-155). Custom personas backed by external MCP servers are not
          implemented.
        </p>
      </Card>
    </div>
  );
}

export default MessagingAiPersonasPage;
