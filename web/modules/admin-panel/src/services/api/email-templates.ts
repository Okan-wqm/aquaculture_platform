/**
 * Email Templates API
 *
 * CRUD, preview, and test-send operations for email templates.
 * Extracted from settings.ts for single-responsibility.
 */

import { apiFetch } from '../http-client';
import type { EmailTemplate } from '../types';
import {
  ADMIN_API_ROUTES,
  type AdminApiRouteBody,
} from '../types/generated/admin-route-contracts';

type TestEmailVariables = AdminApiRouteBody<'POST /settings/email-templates/:id/test'>['variables'];

export const emailTemplatesApi = {
  getEmailTemplates: () =>
    apiFetch(ADMIN_API_ROUTES['GET /settings/email-templates'], { query: {  } }),
  getEmailTemplate: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /settings/email-templates/:id'], { path: { id: id } }),
  getEmailTemplateByCode: (code: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /settings/email-templates/code/:code'], {
      path: { code: code },
      query: {  },
    }),
  createEmailTemplate: (data: Omit<EmailTemplate, 'id' | 'createdAt' | 'updatedAt'>) =>
    apiFetch(ADMIN_API_ROUTES['POST /settings/email-templates'], { body: data }),
  updateEmailTemplate: (id: string, data: Partial<EmailTemplate>) =>
    apiFetch(ADMIN_API_ROUTES['PUT /settings/email-templates/:id'], {
      path: { id: id },
      body: data,
    }),
  deleteEmailTemplate: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['DELETE /settings/email-templates/:id'], { path: { id: id } }),
  // Fix: backend uses GET (not POST) for preview, no body needed (uses sample data internally)
  previewEmailTemplate: (id: string, _sampleData?: Record<string, unknown>) =>
    apiFetch(ADMIN_API_ROUTES['GET /settings/email-templates/by-id/:id/preview'], {
      path: { id: id },
    }),
  // Fix: backend body uses { recipientEmail, variables } (not { to, sampleData })
  sendTestEmail: (id: string, to: string, sampleData: TestEmailVariables) =>
    apiFetch(ADMIN_API_ROUTES['POST /settings/email-templates/:id/test'], {
      path: { id: id },
      body: { recipientEmail: to, variables: sampleData },
    }),
};
