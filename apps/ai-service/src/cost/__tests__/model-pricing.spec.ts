import { computeTurnCostUsd, resolveModelPricing, DEFAULT_MODEL_PRICING } from '../model-pricing';

/**
 * ORPHAN-MEDIUM-380 / DB-PEOPLE-MEDIUM-002 — per-model pricing SSoT.
 *
 * WHY these pins: costUsd rides finance reconciliation, so the arithmetic
 * (per-class rates, cache multipliers, rounding to the numeric(12,6) scale)
 * must be locked by tests, not eyeballed. The cache-creation class carrying a
 * NON-ZERO Anthropic rate is the heart of the finding — these tests make a
 * regression to "cache writes are free" a red build.
 */
describe('model-pricing (ORPHAN-MEDIUM-380)', () => {
  describe('resolveModelPricing', () => {
    it('resolves catalog models with Anthropic cache multipliers derived from the input rate', () => {
      const { pricing, catalogMatch } = resolveModelPricing('claude-sonnet-5');
      expect(catalogMatch).toBe(true);
      expect(pricing.inputUsdPerMTok).toBe(3);
      expect(pricing.outputUsdPerMTok).toBe(15);
      // Anthropic prompt-cache economics: read = 0.1x input, write = 1.25x input
      expect(pricing.cacheReadUsdPerMTok).toBeCloseTo(0.3, 10);
      expect(pricing.cacheCreationUsdPerMTok).toBeCloseTo(3.75, 10);
    });

    it('resolves dated snapshot IDs via longest-prefix matching', () => {
      const dated = resolveModelPricing('claude-sonnet-4-5-20250929');
      expect(dated.catalogMatch).toBe(true);
      expect(dated.pricing.inputUsdPerMTok).toBe(3);

      const haiku = resolveModelPricing('claude-haiku-4-5-20251001');
      expect(haiku.catalogMatch).toBe(true);
      expect(haiku.pricing.inputUsdPerMTok).toBe(1);
      expect(haiku.pricing.outputUsdPerMTok).toBe(5);
    });

    it('prefers the longer prefix when several match (gpt-4o-mini over gpt-4o)', () => {
      const mini = resolveModelPricing('gpt-4o-mini-2024-07-18');
      expect(mini.catalogMatch).toBe(true);
      expect(mini.pricing.inputUsdPerMTok).toBeCloseTo(0.15, 10);
    });

    it('models OpenAI cache economics as read-discount only (no write surcharge)', () => {
      const { pricing } = resolveModelPricing('gpt-4o');
      expect(pricing.cacheReadUsdPerMTok).toBeCloseTo(1.25, 10); // 0.5x of $2.50
      expect(pricing.cacheCreationUsdPerMTok).toBe(0);
    });

    it('falls back to the default (Sonnet-tier) pricing for unknown models and says so', () => {
      const { pricing, catalogMatch } = resolveModelPricing('totally-unknown-model');
      expect(catalogMatch).toBe(false);
      expect(pricing).toEqual(DEFAULT_MODEL_PRICING);
      // WHY non-zero: an unknown model must never make a turn look free.
      expect(pricing.inputUsdPerMTok).toBeGreaterThan(0);
    });
  });

  describe('computeTurnCostUsd', () => {
    it('bills all four token classes including cache creation (the finding)', () => {
      // claude-sonnet-5: in $3, out $15, read $0.30, write $3.75 per MTok
      //   100 in  -> 0.000300
      //    50 out -> 0.000750
      //    30 rd  -> 0.000009
      //    20 wr  -> 0.000075
      const { costUsd, catalogMatch } = computeTurnCostUsd('claude-sonnet-5', {
        input: 100,
        output: 50,
        cacheRead: 30,
        cacheCreation: 20,
      });
      expect(catalogMatch).toBe(true);
      expect(costUsd).toBeCloseTo(0.001134, 9);
    });

    it('cache-creation tokens are strictly more expensive than plain input tokens', () => {
      const plain = computeTurnCostUsd('claude-sonnet-5', {
        input: 1000,
        output: 0,
        cacheRead: 0,
        cacheCreation: 0,
      });
      const cached = computeTurnCostUsd('claude-sonnet-5', {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheCreation: 1000,
      });
      expect(cached.costUsd).toBeGreaterThan(plain.costUsd);
      expect(cached.costUsd / plain.costUsd).toBeCloseTo(1.25, 6);
    });

    it('rounds to 6 decimal places so the value fits numeric(12,6) exactly', () => {
      const { costUsd } = computeTurnCostUsd('claude-haiku-4-5', {
        input: 1,
        output: 1,
        cacheRead: 1,
        cacheCreation: 1,
      });
      // 0.000001 + 0.000005 + 0.0000001 + 0.00000125 => rounds to 0.000007
      expect(costUsd).toBe(0.000007);
      expect(Number(costUsd.toFixed(6))).toBe(costUsd);
    });

    it('a zero-usage turn costs zero', () => {
      const { costUsd } = computeTurnCostUsd('claude-sonnet-5', {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheCreation: 0,
      });
      expect(costUsd).toBe(0);
    });
  });
});
