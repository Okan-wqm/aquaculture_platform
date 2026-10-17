/**
 * The review's findings for the eleven v3 sections, in document order.
 */
import type { ReviewSection } from '../../types';

import { FINDINGS_01_04 } from './findings-01-04';
import { FINDINGS_05_08 } from './findings-05-08';
import { FINDINGS_09_11 } from './findings-09-11';

export const REVIEW_SECTIONS: readonly ReviewSection[] = [
  ...FINDINGS_01_04,
  ...FINDINGS_05_08,
  ...FINDINGS_09_11,
];
