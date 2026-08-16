import { resolve } from 'path';

/**
 * Source alias authority shared by AquaMobil's production and test compilers.
 *
 * The standalone PWA deliberately resolves a small set of repository sources
 * without publishing them as npm packages. Keeping those coordinates here
 * prevents Vite and Vitest from compiling different dependency graphs.
 */
export const AQUAMOBIL_SOURCE_PATH_ALIASES = Object.freeze({
  '@': resolve(__dirname, 'src'),
  '@aquaculture/farm-shared': resolve(__dirname, '../../../libs/farm-shared/src'),
  '@aquaculture/shared-contracts': resolve(__dirname, '../../../libs/shared-contracts/src'),
  '@platform/identity': resolve(__dirname, '../../../libs/event-contracts/src/roles.ts'),
});
