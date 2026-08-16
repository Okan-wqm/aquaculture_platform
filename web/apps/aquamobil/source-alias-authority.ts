import { resolve } from 'node:path';

/** Runtime-build source aliases consumed by both Vite and Vitest. */
export const AQUAMOBIL_SOURCE_ALIAS_AUTHORITY = Object.freeze({
  '@': resolve(__dirname, 'src'),
  '@aquaculture/farm-shared': resolve(__dirname, '../../../libs/farm-shared/src'),
  '@aquaculture/shared-contracts': resolve(__dirname, '../../../libs/shared-contracts/src'),
  '@aquaculture/feeding-contracts': resolve(__dirname, '../../../libs/feeding-contracts/src'),
});
