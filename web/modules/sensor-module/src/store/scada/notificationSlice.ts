/**
 * notificationSlice — Notification configuration state & actions.
 *
 * Manages the set of alarm notification configs (email / webhook) and
 * tracks whether the SMTP gateway has been configured on the server.
 */
import type { ScadaSliceCreator } from './types';
import { generateId } from './types';
import type { NotificationConfig } from '../../types/scada-runtime.types';

/* ------------------------------------------------------------------ */
/*  Slice Interface                                                     */
/* ------------------------------------------------------------------ */

export interface NotificationSlice {
  // State
  notifications: NotificationConfig[];
  smtpConfigured: boolean;

  // Actions
  addNotification: (config: Omit<NotificationConfig, 'id'>) => string;
  updateNotification: (id: string, updates: Partial<NotificationConfig>) => void;
  removeNotification: (id: string) => void;
  setSmtpConfigured: (configured: boolean) => void;
}

/* ------------------------------------------------------------------ */
/*  Slice Creator                                                       */
/* ------------------------------------------------------------------ */

export const createNotificationSlice: ScadaSliceCreator<NotificationSlice> = (set) => ({
  // Initial state
  notifications: [],
  smtpConfigured: false,

  // Actions
  addNotification: (config) => {
    const id = generateId();
    set((state) => {
      state.notifications.push({ ...config, id });
    });
    return id;
  },

  updateNotification: (id, updates) =>
    set((state) => {
      const notification = state.notifications.find((n) => n.id === id);
      if (!notification) return;
      Object.assign(notification, updates);
    }),

  removeNotification: (id) =>
    set((state) => {
      state.notifications = state.notifications.filter((n) => n.id !== id);
    }),

  setSmtpConfigured: (configured) =>
    set((state) => {
      state.smtpConfigured = configured;
    }),
});
