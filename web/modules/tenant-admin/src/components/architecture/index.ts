/**
 * The platform reference documents (/tenant/architecture): Platform
 * architecture v4 and its Architecture review.
 */
export {
  architectureAnchorId,
  reviewAnchorId,
  reviewSectionAnchor,
  REVIEW_CROSS_ANCHOR,
  REVIEW_PROPOSALS_ANCHOR,
  REVIEW_SCENARIOS_ANCHOR,
} from './anchors';
export { ArchitectureSectionView } from './ArchitectureSectionView';
export { DiagramLegend } from './DiagramLegend';
export { DocumentIntro, DocumentToc, PartHeading } from './DocumentParts';
export type { TocEntry } from './DocumentParts';
export { CrossTopicsPart } from './review/CrossTopicsPart';
export { FindingSectionView } from './review/FindingSectionView';
export { FindingTagLegend, ReviewStats } from './review/ReviewHeaderParts';
export { PrioritiesPart } from './review/PrioritiesPart';
export { ProposalsPart } from './review/ProposalsPart';
export { ScenarioCheckPart } from './review/ScenarioCheckPart';
