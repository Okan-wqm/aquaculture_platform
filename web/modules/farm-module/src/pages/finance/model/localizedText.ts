/**
 * Text carried by preview sample data in every supported locale.
 *
 * WHY not message keys: sample names (a cost centre, a site, an output unit)
 * are part of the sample, not of the product's vocabulary. Keeping both
 * spellings in the `*.preview.ts` value means deleting the preview, once its
 * backend lands, deletes every sample string with it — nothing is left behind
 * in the locale catalogues.
 */
import type { SupportedLocale } from '@aquaculture/shared-ui';

export type LocalizedText = Readonly<Record<SupportedLocale, string>>;
