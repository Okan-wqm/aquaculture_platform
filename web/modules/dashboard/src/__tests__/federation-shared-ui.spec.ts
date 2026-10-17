// @vitest-environment node
/**
 * The shell's TenantProvider and DashboardPage's useTenantContext must come from
 * ONE shared-ui module instance at runtime (FE-HIGH-343).
 *
 * In a browser that holds only if both the host and this remote import
 * `@aquaculture/shared-ui` through Module Federation's `loadShare` proxy. Both
 * configs used to alias the package to `web/shared-ui/dist` in every mode;
 * Vite's alias plugin runs before `@module-federation/vite`, so the import
 * arrived at the federation plugin as a file path and was bundled privately.
 * The dashboard then read its own TenantContext and /dashboard failed with
 * "useTenantContext must be used within a TenantProvider".
 *
 * This spec runs each config's real plugin pipeline in a production mode and
 * asks what the specifier resolves to. `react` is the control: it has always
 * reached the share scope. `@module-federation/vite` returns no plugins when it
 * detects a test process; MFE_VITE_NO_TEST_ENV_CHECK is its documented switch
 * for loading them anyway.
 */
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const DASHBOARD_ROOT = resolve(__dirname, '../..');
const SHELL_ROOT = resolve(__dirname, '../../../../shell');

const SIDES = [
  {
    side: 'dashboard remote',
    root: DASHBOARD_ROOT,
    importer: resolve(DASHBOARD_ROOT, 'src/pages/DashboardPage.tsx'),
  },
  {
    side: 'shell host',
    root: SHELL_ROOT,
    importer: resolve(SHELL_ROOT, 'src/bootstrap.tsx'),
  },
] as const;

describe.each(SIDES)(
  '$side resolves shared singletons through the federation share scope',
  (config) => {
    let server: ViteDevServer;

    beforeAll(async () => {
      vi.stubEnv('MFE_VITE_NO_TEST_ENV_CHECK', 'true');
      server = await createServer({
        configFile: resolve(config.root, 'vite.config.ts'),
        root: config.root,
        mode: 'production',
        logLevel: 'silent',
        server: { middlewareMode: true, hmr: false, ws: false },
      });
    });

    afterAll(async () => {
      await server.close();
      vi.unstubAllEnvs();
    });

    it.each(['react', '@aquaculture/shared-ui'])(
      '%s resolves to its loadShare proxy',
      async (specifier) => {
        const resolved = await server.pluginContainer.resolveId(specifier, config.importer);

        expect(resolved?.id).toMatch(/__loadShare__/);
      },
    );
  },
);
