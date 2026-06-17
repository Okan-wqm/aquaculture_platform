/**
 * Module Federation Shared Dependencies Configuration
 *
 * SECURITY: Single source of truth for ALL shared dependency versions and flags
 * used by both the shell (host) and every remote module.
 *
 * FE-HIGH-004: Without `strictVersion: true`, the federation runtime silently
 * falls back to loading a remote's bundled copy when version ranges don't
 * exactly match — producing TWO React instances at runtime. Two React instances
 * break hooks, context, QueryClient sharing, and auth state propagation.
 *
 * By importing this config in every vite.config.ts, we guarantee:
 *   1. `strictVersion: true` is ALWAYS set (structural enforcement)
 *   2. Version pins are identical across shell and all remotes
 *   3. Adding a new shared dep requires updating ONE file
 *
 * @see FE-HIGH-004
 */

// ============================================================================
// Types
// ============================================================================

export interface SharedDepConfig {
  /** Only one instance allowed at runtime */
  singleton: true;
  /** Fail loudly instead of silently loading duplicate */
  strictVersion: true;
  /** Exact version pin — must match package.json */
  requiredVersion: string;
  /** Explicit version for deps whose package.json lacks exports["./package.json"] */
  version?: string;
}

// ============================================================================
// Version Pins (update here when upgrading)
// ============================================================================

/** Canonical version pins for all shared dependencies */
export const SHARED_VERSIONS = {
  react: '18.3.1',
  'react-dom': '18.3.1',
  'react-router-dom': '6.30.3',
  '@tanstack/react-query': '5.90.10',
  '@aquaculture/shared-ui': '1.0.0',
  // zustand stays 4.5.7 until the graph lib (reactflow 11 / @xyflow/react 12)
  // widens its hard `zustand ^4.4.0` dependency to allow v5. As of xyflow
  // 12.11.0 it still pins ^4.4.0, so bumping zustand to 5 would resolve TWO
  // versions in the lockfile (4.x for the graph lib + 5.x here) and break the
  // single-version singleton invariant. The code already uses the v5-style
  // `useShallow` API, which exists since 4.4.0 — so there is no functional gap.
  // See docs/reviews/orphan-findings.md#ORPHAN-MEDIUM-104. zustand 5 is gated
  // on the graph-lib range widening, NOT on the C2 reactflow→xyflow migration.
  zustand: '4.5.7',
  reactflow: '11.11.4',
  // C0 federation rails (FE-HIGH-005): these two were previously inline
  // literals in dashboard/tenant-admin vite configs — the exact override
  // class that produced the duplicate-key + strictVersion-less entries.
  // Pins match the root-lockfile RESOLVED versions, so adopting them is a
  // config-hygiene change with zero runtime delta.
  'lucide-react': '0.469.0',
  recharts: '2.15.4',
} as const;

// ============================================================================
// Shared Configs
// ============================================================================

/**
 * Core shared dependencies required by ALL modules (shell + every remote).
 *
 * IMPORTANT: Every entry has `strictVersion: true`. This makes version
 * mismatches a BUILD-TIME error instead of a silent runtime duplicate.
 */
export function getCoreSharedConfig(): Record<string, SharedDepConfig> {
  return {
    react: {
      singleton: true,
      strictVersion: true,
      requiredVersion: SHARED_VERSIONS.react,
    },
    'react-dom': {
      singleton: true,
      strictVersion: true,
      requiredVersion: SHARED_VERSIONS['react-dom'],
    },
    'react-router-dom': {
      singleton: true,
      strictVersion: true,
      requiredVersion: SHARED_VERSIONS['react-router-dom'],
    },
    '@tanstack/react-query': {
      singleton: true,
      strictVersion: true,
      requiredVersion: SHARED_VERSIONS['@tanstack/react-query'],
    },
    '@aquaculture/shared-ui': {
      singleton: true,
      strictVersion: true,
      requiredVersion: SHARED_VERSIONS['@aquaculture/shared-ui'],
    },
    zustand: {
      singleton: true,
      strictVersion: true,
      requiredVersion: SHARED_VERSIONS.zustand,
    },
  };
}

/**
 * Extended shared config that includes reactflow (for sensor-module SCADA).
 *
 * Explicit `version` is REQUIRED because reactflow v11's package.json exports
 * map omits "./package.json", which the Module Federation plugin uses to
 * auto-detect the version. Providing `version` bypasses that resolution.
 */
export function getSharedConfigWithReactFlow(): Record<string, SharedDepConfig> {
  return {
    ...getCoreSharedConfig(),
    reactflow: {
      singleton: true,
      strictVersion: true,
      requiredVersion: SHARED_VERSIONS.reactflow,
      version: SHARED_VERSIONS.reactflow,
    },
  };
}

/**
 * Extended shared config that includes recharts (dashboard charts).
 *
 * WHY here and not inline in dashboard's vite.config: the federation
 * invariant (tests/invariants/federation-shared-singleton.spec.ts) bans
 * shared-entry literals outside this file — inline entries are how the
 * strictVersion-less override class (FE-HIGH-004/FE-HIGH-005) re-enters.
 */
export function getSharedConfigWithRecharts(): Record<string, SharedDepConfig> {
  return {
    ...getCoreSharedConfig(),
    recharts: {
      singleton: true,
      strictVersion: true,
      requiredVersion: SHARED_VERSIONS.recharts,
    },
  };
}

/**
 * Extended shared config that includes lucide-react (tenant-admin icons).
 * Same SSoT rationale as getSharedConfigWithRecharts above.
 */
export function getSharedConfigWithLucide(): Record<string, SharedDepConfig> {
  return {
    ...getCoreSharedConfig(),
    'lucide-react': {
      singleton: true,
      strictVersion: true,
      requiredVersion: SHARED_VERSIONS['lucide-react'],
    },
  };
}

/**
 * Extended shared config that includes BOTH recharts and lucide-react.
 *
 * WHY (fe-eager-imports / FARM-MEDIUM-060): farm-module consumes both heavy
 * libs (recharts in feeding/water-chemistry/analytics/harvest charts; lucide
 * across the UI) but used getCoreSharedConfig(), so each was bundled INTO the
 * farm remote and duplicated against dashboard (recharts) and tenant-admin
 * (lucide). Sharing them as singletons removes the cross-remote duplicate
 * download. Safe: both are already pinned to ONE version repo-wide by
 * tests/invariants/federation-shared-singleton.spec.ts, so this is config
 * hygiene with no version-drift exposure. Same SSoT rationale as the
 * single-extension helpers above.
 */
export function getSharedConfigWithChartsAndIcons(): Record<string, SharedDepConfig> {
  return {
    ...getCoreSharedConfig(),
    recharts: {
      singleton: true,
      strictVersion: true,
      requiredVersion: SHARED_VERSIONS.recharts,
    },
    'lucide-react': {
      singleton: true,
      strictVersion: true,
      requiredVersion: SHARED_VERSIONS['lucide-react'],
    },
  };
}
