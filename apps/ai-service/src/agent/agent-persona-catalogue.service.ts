import { BadRequestException, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { AI_PERSONA_CATALOGUE, type AiPersonaCatalogueEntry } from '@aquaculture/shared-contracts';
import { RESTRICTED_PROMPT_DELIMITERS } from '../safety/instruction-hierarchy.service';
import { ToolRegistryService } from '../tools/tool-registry.service';
import { composePersona, PROMPT_PREAMBLE, type ComposedPersona } from './personas/compose';
import { SPECIALTIES } from './personas/specialties';
import { TIERS } from './personas/tiers';

/** Thrown when a caller names a persona the catalogue does not publish. */
export class UnknownPersonaError extends BadRequestException {
  constructor(personaId: string) {
    super(`Unknown persona "${personaId}"`);
  }
}

/**
 * Composes every published persona (shared-contracts AI_PERSONA_CATALOGUE ×
 * TIERS × SPECIALTIES) once, and refuses to boot when the composition is
 * inconsistent: a bundle naming a tool the registry does not have, a bundled
 * module-gated tool outside its specialty's module, a fragment carrying a
 * reserved delimiter, or a catalogue id that does not compose. Unknown ids
 * are a hard error — never a silent fallback to a lower-privilege persona.
 */
@Injectable()
export class AgentPersonaCatalogueService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AgentPersonaCatalogueService.name);
  private composed: ReadonlyMap<string, ComposedPersona> | null = null;

  constructor(private readonly toolRegistry: ToolRegistryService) {}

  onApplicationBootstrap(): void {
    const catalogue = this.build();
    this.logger.log(`Composed ${catalogue.size} AI personas from the shared catalogue`);
  }

  /** The composed persona for a published id; throws for anything else. */
  resolve(personaId: string): ComposedPersona {
    const persona = this.build().get(personaId);
    if (!persona) {
      throw new UnknownPersonaError(personaId);
    }
    return persona;
  }

  /** Every composed persona, in catalogue order. */
  list(): readonly ComposedPersona[] {
    return Array.from(this.build().values());
  }

  private build(): ReadonlyMap<string, ComposedPersona> {
    if (this.composed) return this.composed;
    this.assertFragmentsSafe();
    this.assertBundlesRegistered();
    const map = new Map<string, ComposedPersona>();
    for (const entry of AI_PERSONA_CATALOGUE) {
      map.set(entry.id, this.compose(entry));
    }
    this.composed = map;
    return map;
  }

  private compose(entry: AiPersonaCatalogueEntry): ComposedPersona {
    const tier = TIERS[entry.tier];
    const specialty = SPECIALTIES[entry.specialty];
    return composePersona(entry, tier, specialty, (toolName) =>
      this.tierAllowsTool(entry.tier, toolName),
    );
  }

  private tierAllowsTool(tier: AiPersonaCatalogueEntry['tier'], toolName: string): boolean {
    const tool = this.toolRegistry.getTool(toolName);
    if (!tool) return false;
    return tool.getMetadata().requiredPermissions.includes(tier);
  }

  private assertBundlesRegistered(): void {
    const problems: string[] = [];
    for (const specialty of Object.values(SPECIALTIES)) {
      for (const toolName of specialty.toolNames) {
        const tool = this.toolRegistry.getTool(toolName);
        if (!tool) {
          problems.push(`specialty "${specialty.id}" bundles unregistered tool "${toolName}"`);
          continue;
        }
        const requiresModule = tool.getMetadata().requiresModule;
        if (requiresModule !== null && requiresModule !== specialty.requiresModule) {
          problems.push(
            `specialty "${specialty.id}" (module ${specialty.requiresModule ?? 'core'}) bundles ` +
              `"${toolName}" which requires module "${requiresModule}"`,
          );
        }
      }
    }
    if (problems.length > 0) {
      throw new Error(`AI persona catalogue is inconsistent:\n  ${problems.join('\n  ')}`);
    }
  }

  private assertFragmentsSafe(): void {
    const fragments: Array<[string, string]> = [['PROMPT_PREAMBLE', PROMPT_PREAMBLE]];
    for (const tier of Object.values(TIERS))
      fragments.push([`tier ${tier.id}`, tier.promptFragment]);
    for (const specialty of Object.values(SPECIALTIES)) {
      fragments.push([`specialty ${specialty.id}`, specialty.promptFragment]);
    }
    for (const [label, text] of fragments) {
      for (const delimiter of RESTRICTED_PROMPT_DELIMITERS) {
        if (text.includes(delimiter)) {
          throw new Error(
            `AI persona prompt fragment "${label}" contains the reserved delimiter "${delimiter}"`,
          );
        }
      }
    }
  }
}
