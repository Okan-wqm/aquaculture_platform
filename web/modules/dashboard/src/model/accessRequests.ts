/**
 * The inbox's access-request item: who asks for which capability where.
 * No service records access requests yet (RBAC-MEDIUM-020); the item renders
 * its sample (preview/accessRequests.preview.ts) through MockPreview.
 */
export interface AccessRequestSample {
  readonly count: number;
  readonly names: string;
  readonly capability: string;
  readonly site: string;
}
