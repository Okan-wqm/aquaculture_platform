/**
 * Per-model AI pricing catalog + turn-cost computation
 * (DB-PEOPLE-MEDIUM-002 / ORPHAN-MEDIUM-380).
 *
 * WHY THIS EXISTS: the agent runner tracks four token classes (input, output,
 * cacheRead, cacheCreation) but nothing converted them into a USD figure —
 * cache-creation tokens in particular were tracked and then dropped from every
 * billing surface. This module is the single source of truth for per-model
 * rates; TurnLedgerService uses it to persist `costUsd` on every turn.
 *
 * RATES: USD per 1M tokens, from the Anthropic model catalog (verified
 * 2026-07-12 against the platform docs snapshot cached 2026-06-24):
 *   - Opus 4.6/4.7/4.8 ......... $5 in / $25 out
 *   - Sonnet 5 & Sonnet 4.6 .... $3 in / $15 out (Sonnet 5 intro discount
 *     through 2026-08-31 is NOT modeled — the ledger records list price;
 *     Stripe remains the invoice SSoT)
 *   - Haiku 4.5 ................ $1 in / $5 out
 * Anthropic prompt-cache economics: reads bill at 0.1x the input rate,
 * writes (cache creation, 5-minute TTL) at 1.25x the input rate.
 * OpenAI (BYOK provider): cached input bills at 0.5x, cache writes are free
 * (the provider adapter reports cacheCreation = 0 for OpenAI regardless).
 *
 * MATCHING: longest-prefix match so dated snapshot IDs
 * ('claude-sonnet-4-5-20250929') resolve to their family entry. Unknown
 * models fall back to DEFAULT_MODEL_PRICING (Sonnet-tier — the platform's
 * default persona tier) and the caller logs a warning so finance sees the
 * catalog gap instead of silently billing zero.
 */

/** USD per 1,000,000 tokens for each billable token class. */
export interface ModelPricing {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  cacheReadUsdPerMTok: number;
  cacheCreationUsdPerMTok: number;
}

/** Per-class token counts for one completed agent invocation. */
export interface TurnTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/**
 * Anthropic tier helper: derives the cache classes from the input rate using
 * the provider's published multipliers (read = 0.1x, write@5min = 1.25x).
 */
function anthropicTier(inputUsdPerMTok: number, outputUsdPerMTok: number): ModelPricing {
  return {
    inputUsdPerMTok,
    outputUsdPerMTok,
    cacheReadUsdPerMTok: inputUsdPerMTok * 0.1,
    cacheCreationUsdPerMTok: inputUsdPerMTok * 1.25,
  };
}

/**
 * OpenAI tier helper: cached input at 0.5x, no cache-write surcharge.
 */
function openAiTier(inputUsdPerMTok: number, outputUsdPerMTok: number): ModelPricing {
  return {
    inputUsdPerMTok,
    outputUsdPerMTok,
    cacheReadUsdPerMTok: inputUsdPerMTok * 0.5,
    cacheCreationUsdPerMTok: 0,
  };
}

/**
 * Longest-prefix pricing catalog. Order does not matter — resolution picks
 * the LONGEST matching prefix, so 'claude-sonnet-4-6' wins over a
 * hypothetical shorter 'claude-sonnet' entry.
 */
export const MODEL_PRICING_CATALOG: ReadonlyArray<{
  readonly prefix: string;
  readonly pricing: ModelPricing;
}> = [
  // Anthropic — persona defaults (personas/*.ts) + common tenant chatModel picks
  { prefix: 'claude-haiku-4-5', pricing: anthropicTier(1, 5) },
  { prefix: 'claude-sonnet-5', pricing: anthropicTier(3, 15) },
  { prefix: 'claude-sonnet-4-6', pricing: anthropicTier(3, 15) },
  { prefix: 'claude-sonnet-4-5', pricing: anthropicTier(3, 15) },
  { prefix: 'claude-opus-4-8', pricing: anthropicTier(5, 25) },
  { prefix: 'claude-opus-4-7', pricing: anthropicTier(5, 25) },
  { prefix: 'claude-opus-4-6', pricing: anthropicTier(5, 25) },
  // OpenAI — BYOK provider (FAZ1-BYOK); rates are catalog data finance updates
  { prefix: 'gpt-4o-mini', pricing: openAiTier(0.15, 0.6) },
  { prefix: 'gpt-4o', pricing: openAiTier(2.5, 10) },
];

/**
 * Fallback for models absent from the catalog: Sonnet-tier (the platform's
 * default persona tier). WHY not zero: an unknown model must never make a
 * turn LOOK free — over-attribution surfaces the catalog gap, silence hides it.
 */
export const DEFAULT_MODEL_PRICING: ModelPricing = anthropicTier(3, 15);

export interface ResolvedModelPricing {
  pricing: ModelPricing;
  /** false → DEFAULT_MODEL_PRICING was used; caller should log the gap. */
  catalogMatch: boolean;
}

export function resolveModelPricing(model: string): ResolvedModelPricing {
  let best: { prefix: string; pricing: ModelPricing } | undefined;
  for (const entry of MODEL_PRICING_CATALOG) {
    if (model.startsWith(entry.prefix)) {
      if (best === undefined || entry.prefix.length > best.prefix.length) {
        best = entry;
      }
    }
  }
  if (best === undefined) {
    return { pricing: DEFAULT_MODEL_PRICING, catalogMatch: false };
  }
  return { pricing: best.pricing, catalogMatch: true };
}

export interface TurnCost {
  /** USD rounded to 6 decimal places (matches numeric(12,6) column scale). */
  costUsd: number;
  catalogMatch: boolean;
}

/**
 * Compute the USD cost of one turn across ALL four token classes.
 * Including cacheCreation here is the architectural cure for the
 * "cache-creation tokens unbilled" defect (DB-PEOPLE-MEDIUM-002).
 */
export function computeTurnCostUsd(model: string, usage: TurnTokenUsage): TurnCost {
  const { pricing, catalogMatch } = resolveModelPricing(model);
  const raw =
    (usage.input * pricing.inputUsdPerMTok +
      usage.output * pricing.outputUsdPerMTok +
      usage.cacheRead * pricing.cacheReadUsdPerMTok +
      usage.cacheCreation * pricing.cacheCreationUsdPerMTok) /
    1_000_000;
  // Round half-up at 6 dp so the value fits numeric(12,6) exactly.
  const costUsd = Math.round(raw * 1_000_000) / 1_000_000;
  return { costUsd, catalogMatch };
}
