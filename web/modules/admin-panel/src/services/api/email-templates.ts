/**
 * Email Templates API
 *
 * CRUD, preview, and test-send operations for email templates.
 * Extracted from settings.ts for single-responsibility.
 */

import { apiFetch } from '../http-client';
import type { EmailTemplate } from '../types';

export const emailTemplatesApi = {
  getEmailTemplates: () => apiFetch<EmailTemplate[]>('/settings/email-templates'),
  getEmailTemplate: (id: string) => apiFetch<EmailTemplate>(`/settings/email-templates/${id}`),
  getEmailTemplateByCode: (code: string) => apiFetch<EmailTemplate>(`/settings/email-templates/code/${code}`),
  createEmailTemplate: (data: Omit<EmailTemplate, 'id' | 'createdAt' | 'updatedAt'>) =>
    apiFetch<EmailTemplate>('/settings/email-templates', { method: 'POST', body: JSON.stringify(data) }),
  updateEmailTemplate: (id: string, data: Partial<EmailTemplate>) =>
    apiFetch<EmailTemplate>(`/settings/email-templates/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteEmailTemplate: (id: string) =>
    apiFetch<void>(`/settings/email-templates/${id}`, { method: 'DELETE' }),
  // Fix: backend uses GET (not POST) for preview, no body needed (uses sample data internally)
  previewEmailTemplate: (id: string, _sampleData?: Record<string, unknown>) =>
    apiFetch<{ html: string; text: string; subject: string }>(`/settings/email-templates/${id}/preview`),
  // Fix: backend body uses { recipientEmail, variables } (not { to, sampleData })
  sendTestEmail: (id: string, to: string, sampleData: Record<string, unknown>) =>
    // The endpoint renders only (admin-api has no email dispatch path); `sent` is always false.
    apiFetch<{ sent: false; reason: string; recipientEmail: string; rendered: unknown }>(`/settings/email-templates/${id}/test`, { method: 'POST', body: JSON.stringify({ recipientEmail: to, variables: sampleData }) }),
};
