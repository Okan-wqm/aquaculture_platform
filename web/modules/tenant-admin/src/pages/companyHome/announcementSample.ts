/**
 * An announcement as the company dashboard shows a member: its title and
 * text. Members cannot read announcements yet (RBAC-MEDIUM-021); the notice
 * renders its sample (announcements.preview.ts) through MockPreview.
 */
export interface AnnouncementSample {
  readonly title: string;
  readonly content: string;
}
