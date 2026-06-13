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
  /** Whether the remote should eagerly import this dep */
  import?: boolean;
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
      import: true,
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
