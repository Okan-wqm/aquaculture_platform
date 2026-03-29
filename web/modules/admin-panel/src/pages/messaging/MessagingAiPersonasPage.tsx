/**
 * Messaging AI Personas Configuration Page
 *
 * SUPER_ADMIN page for managing AI persona availability per tenant.
 * Shows a table of available AI personas with toggle controls for
 * enabling/disabling per tenant. Future: custom persona registration
 * with external MCP server URLs.
 *
 * @see ADR-012 Phase 4 (AI Persona-Based Messaging Channels)
 */

import React, { useState, useCallback } from 'react';
import { Card, Button, Badge } from '@aquaculture/shared-ui';

// ============================================================================
// Types
// ============================================================================

interface PersonaConfig {
  id: string | null;
  name: string;
  description: string;
  icon: string;
  color: string;
  capabilities: string[];
  enabledForAll: boolean;
}

interface TenantPersonaOverride {
  tenantId: string;
  tenantName: string;
  disabledPersonas: string[];
}

// ============================================================================
// Default Personas (mirrors backend registry)
// ============================================================================

const DEFAULT_PERSONAS: PersonaConfig[] = [
  {
    id: null,
    name: 'General AI Assistant',
    description: 'Ask anything about aquaculture operations',
    icon: 'bot',
    color: 'purple',
    capabilities: ['General questions', 'Basic guidance', 'Platform help'],
    enabledForAll: true,
  },
  {
    id: 'operator-v1',
    name: 'Water Quality Specialist',
    description: 'Water chemistry, sensors, calibration, safe ranges',
    icon: 'droplets',
    color: 'cyan',
    capabilities: ['Water quality parameters', 'Sensor readings', 'Toxicity calculations'],
    enabledForAll: true,
  },
  {
    id: 'expert-v1',
    name: 'Farm Expert',
    description: 'Tanks, batches, feeding, growth analytics, dosing',
    icon: 'fish',
    color: 'blue',
    capabilities: ['Growth analytics', 'Feed optimization', 'Reagent dosing', 'Risk assessment'],
    enabledForAll: true,
  },
  {
    id: 'manager-v1',
    name: 'Management Assistant',
    description: 'Analytics, reporting, risk assessment, data-driven insights',
    icon: 'bar-chart',
    color: 'green',
    capabilities: ['Report generation', 'Trend analysis', 'Feed management', 'Alert analysis'],
    enabledForAll: true,
  },
  {
    id: 'supervisor-v1',
    name: 'SCADA AI',
    description: 'Automation, PLC control, autonomous monitoring',
    icon: 'cpu',
    color: 'orange',
    capabilities: ['Autonomous monitoring', 'Equipment actuation', 'PLC control', 'Safety limits'],
    enabledForAll: true,
  },
];

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
// Sub-components
// ============================================================================

/** Row for a single persona in the configuration table. */
function PersonaRow({
  persona,
  onToggle,
}: {
  persona: PersonaConfig;
  onToggle: (personaId: string | null) => void;
}) {
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
      <td className="px-4 py-3 text-center">
        <button
          onClick={() => onToggle(persona.id)}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            persona.enabledForAll
              ? 'bg-green-500'
              : 'bg-gray-300 dark:bg-gray-600'
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
              persona.enabledForAll ? 'translate-x-4.5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </td>
      <td className="px-4 py-3 text-center">
        <Badge
          variant={persona.enabledForAll ? 'success' : 'default'}
          size="sm"
        >
          {persona.enabledForAll ? 'All Tenants' : 'Disabled'}
        </Badge>
      </td>
    </tr>
  );
}

// ============================================================================
// Main Component
// ============================================================================

/** Admin page for managing AI persona configuration per tenant. */
function MessagingAiPersonasPage() {
  const [personas, setPersonas] = useState<PersonaConfig[]>(DEFAULT_PERSONAS);
  const [showAddForm, setShowAddForm] = useState(false);

  const handleToggle = useCallback((personaId: string | null) => {
    setPersonas((prev) =>
      prev.map((p) =>
        p.id === personaId ? { ...p, enabledForAll: !p.enabledForAll } : p,
      ),
    );
    // TODO: Persist toggle via admin API mutation
  }, []);

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            AI Personas Configuration
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Manage AI assistant personas available in messaging channels.
            Each persona maps to a specialized ai-service or external MCP server.
          </p>
        </div>
        <Button
          onClick={() => setShowAddForm(!showAddForm)}
          variant="primary"
          size="sm"
        >
          + Add Custom Persona
        </Button>
      </div>

      {/* Future: Add custom persona form */}
      {showAddForm && (
        <Card className="p-4 border-dashed border-2 border-gray-300 dark:border-gray-700">
          <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">
            Custom persona registration (with external MCP server URL) will be available in a future release.
          </p>
        </Card>
      )}

      {/* Personas table */}
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
                  Enabled
                </th>
                <th className="px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider text-center">
                  Scope
                </th>
              </tr>
            </thead>
            <tbody>
              {personas.map((persona) => (
                <PersonaRow
                  key={persona.id ?? 'general'}
                  persona={persona}
                  onToggle={handleToggle}
                />
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Info card */}
      <Card className="p-4 bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800">
        <h3 className="text-sm font-semibold text-blue-900 dark:text-blue-200 mb-1">
          Architecture Note
        </h3>
        <p className="text-xs text-blue-700 dark:text-blue-300 leading-relaxed">
          Each persona corresponds to an ai-service persona definition with its own model,
          system prompt, and tool set. Custom personas can point to external MCP servers
          via the aiServiceUrl field. When set, messaging-service will forward chat requests
          via HTTP POST instead of NATS, with automatic fallback to the default NATS transport.
        </p>
      </Card>
    </div>
  );
}

export default MessagingAiPersonasPage;
