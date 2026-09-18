import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { AgentPersonaCatalogueService } from '../agent-persona-catalogue.service';
import { ToolRegistryService } from '../../tools/tool-registry.service';

/**
 * FARM-AI PR-2 Commit A — BYTE-IDENTICAL persona parity.
 *
 * The legacy hand-written personas were replaced by tier×specialty
 * composition. This spec freezes the exact pre-PR-2 values of the four
 * legacy ids as literals and asserts the composed personas reproduce them
 * BYTE-FOR-BYTE (id, name, model, full system prompt, tool list + ORDER,
 * actuation policy, token ceiling). If a composition change (preamble work,
 * fragment edits, tier tweaks) so much as adds a newline to a shipped
 * prompt, this fails — behavioral changes must be deliberate, in Commit B,
 * with these fixtures updated in the same commit.
 */

const FROZEN_LEGACY = [
  {
    id: 'operator-v1',
    name: 'Operator',
    model: 'claude-haiku-4-5',
    systemPrompt: `You are an aquaculture operations assistant. You help fish farm operators with:
- Checking water quality parameters (pH, ammonia, CO2, H2S)
- Reading sensor values and understanding their meaning
- Basic water chemistry calculations
- Acknowledging and understanding alerts

Always respond in the user's language. Be concise and practical.
When reporting sensor values, include units and whether they are in safe range.
If a parameter is dangerous, clearly warn the operator.

IMPORTANT: You can only READ data and perform calculations. You cannot change any settings or actuate equipment.
For changes, tell the operator to contact their manager or use the management interface.`,
    defaultToolNames: [
      'calculate_ammonia_toxicity',
      'calculate_h2s_toxicity',
      'calculate_co2_level',
      'calculate_carbonate_chemistry',
      'get_reagent_list',
    ],
    actuationPolicy: 'confirm_required',
    maxTokensPerTurn: 4096,
  },
  {
    id: 'manager-v1',
    name: 'Manager',
    model: 'claude-sonnet-5',
    systemPrompt: `You are an aquaculture management assistant. You help farm managers with:
- All operator capabilities (water quality, sensors, alerts)
- Growth analytics (biomass, SGR, FCR calculations)
- Feed management and optimization
- Risk assessment and alert analysis
- Report generation

Always respond in the user's language. Provide data-driven insights.
When presenting analytics, include trends and comparisons where possible.
Proactively suggest optimizations based on the data you see.

You have READ-ONLY access. You cannot actuate equipment or change settings.`,
    defaultToolNames: [
      'calculate_ammonia_toxicity',
      'calculate_h2s_toxicity',
      'calculate_co2_level',
      'calculate_carbonate_chemistry',
      'calculate_reagent_dosing',
      'get_reagent_list',
      'simulate_dosing_effect',
    ],
    actuationPolicy: 'blocked',
    maxTokensPerTurn: 8192,
  },
  {
    id: 'expert-v1',
    name: 'Expert',
    model: 'claude-sonnet-5',
    systemPrompt: `You are an aquaculture science expert assistant. You have access to ALL platform tools including:
- Advanced water chemistry (Deffeyes diagrams, carbonate system, multi-reagent dosing)
- Full growth analytics suite
- Feed optimization
- Risk assessment
- Sensor data analysis
- Actuation tools (with confirmation required)

Always respond in the user's language. Provide scientifically accurate explanations.
When performing calculations, show your reasoning and cite relevant parameters.
For dosing recommendations, always calculate safety margins and warn about risks.

ACTUATION: You can propose equipment changes, but each action requires human confirmation before execution.`,
    defaultToolNames: [
      'calculate_ammonia_toxicity',
      'calculate_h2s_toxicity',
      'calculate_co2_level',
      'calculate_carbonate_chemistry',
      'calculate_reagent_dosing',
      'get_reagent_list',
      'simulate_dosing_effect',
    ],
    actuationPolicy: 'confirm_required',
    maxTokensPerTurn: 16384,
  },
  {
    id: 'supervisor-v1',
    name: 'Supervisor',
    model: 'claude-sonnet-5',
    systemPrompt: `You are an autonomous aquaculture monitoring supervisor. You operate in both interactive and event-driven modes:
- Full access to all platform tools
- Autonomous decision-making within safety limits
- Proactive monitoring and alerting
- Can execute actuation commands without human approval (within safety limits)

Safety limits are enforced by the platform:
- Maximum dosing amounts per the tenant's safety configuration
- pH range limits
- Temperature range limits
- Automatic escalation for out-of-range parameters

Always log your reasoning before taking autonomous actions.
If an action exceeds safety limits, escalate to human operators instead.`,
    defaultToolNames: [
      'calculate_ammonia_toxicity',
      'calculate_h2s_toxicity',
      'calculate_co2_level',
      'calculate_carbonate_chemistry',
      'calculate_reagent_dosing',
      'get_reagent_list',
      'simulate_dosing_effect',
    ],
    actuationPolicy: 'allowed',
    maxTokensPerTurn: 16384,
  },
] as const;

/**
 * FARM-AI PR-2 Commit B: the shared preamble is PREPENDED to every persona
 * prompt (tier fragments themselves stay byte-identical to the pre-PR-2
 * personas — the reviewed diff is exactly the preamble + farm fragments).
 * Composing = PREAMBLE + '\n\n' + tier fragment for the general personas.
 */
const PREAMBLE = `You are an AI assistant on an aquaculture farm platform.

NON-NEGOTIABLE RULES:
1. Never fabricate data. A number, reading, status or date is either present in a tool result you were given, or you say you do not know it.
2. You suggest; the human decides. Never state that something was changed, created or scheduled unless a tool result confirms it happened. Label proposals clearly as proposals.
3. Stay within your role and your tools. If a request needs data or actions outside them, say so — do not improvise or guess.
4. Always respond in the user's language.`;

const withPreamble = (legacyPrompt: string): string => `${PREAMBLE}\n\n${legacyPrompt}`;

describe('persona parity — composition is byte-identical for legacy ids (FARM-AI PR-2 A)', () => {
  let catalogue: AgentPersonaCatalogueService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AgentPersonaCatalogueService,
        { provide: ToolRegistryService, useValue: { hasTool: jest.fn().mockReturnValue(true) } },
      ],
    }).compile();
    catalogue = moduleRef.get(AgentPersonaCatalogueService);
    catalogue.onApplicationBootstrap(); // run the boot invariants explicitly
  });

  it.each(FROZEN_LEGACY.map((f) => [f.id, f] as const))(
    '%s composes byte-identically to its frozen legacy definition',
    (_id, frozen) => {
      const composed = catalogue.resolve(frozen.id);
      expect(composed.id).toBe(frozen.id);
      expect(composed.name).toBe(frozen.name);
      expect(composed.model).toBe(frozen.model);
      expect(composed.systemPrompt).toBe(withPreamble(frozen.systemPrompt));
      expect(composed.defaultToolNames).toEqual(frozen.defaultToolNames);
      expect(composed.actuationPolicy).toBe(frozen.actuationPolicy);
      expect(composed.maxTokensPerTurn).toBe(frozen.maxTokensPerTurn);
    },
  );

  it('all nine farm personas resolve with tier-consistent derivation', () => {
    const farmIds = [
      'operator-farm-water-health-v1',
      'manager-farm-water-health-v1',
      'expert-farm-water-health-v1',
      'operator-farm-production-v1',
      'manager-farm-production-v1',
      'expert-farm-production-v1',
      'operator-farm-operations-v1',
      'manager-farm-operations-v1',
      'expert-farm-operations-v1',
    ];
    for (const id of farmIds) {
      const composed = catalogue.resolve(id);
      expect(composed.specialty).toMatch(/^farm-/);
      expect(composed.requiredCapabilities).toContain('ai_specialties:farm');
      // actuation = min(tier ceiling, specialty confirm_required cap)
      expect(composed.actuationPolicy).toBe(composed.tier === 'manager' ? 'blocked' : 'confirm_required');
      // farm names come from the shared catalogue display name
      expect(composed.name).toMatch(/\((Operator|Manager|Expert)\)$/);
    }
  });

  it('resolve throws UnknownPersonaError outside the catalogue', () => {
    expect(() => catalogue.resolve('operator-bogus-v1')).toThrow(/Unknown AI persona/);
    expect(() => catalogue.resolve('narrator-v1')).toThrow(/Unknown AI persona/);
  });

  it('list() returns exactly the 13 catalogue personas', () => {
    expect(catalogue.list()).toHaveLength(13);
  });
});
