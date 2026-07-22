/**
 * APA-321 regression: the Backups tab's Backup Schedule card must render the
 * real daily/weekly wire contract, not a phantom `{ enabled, schedule, nextRun }`
 * shape. The admin-panel hand-mirrored keys that do not exist on the wire, so
 * the card always showed "Not configured" + a "suspended" badge even though the
 * backend reports both cadences enabled.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/database-mgmt.md#APA-321
 */
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import DatabaseManagementPage from '../DatabaseManagementPage';
import { databaseApi } from '../../services/api/database';

vi.mock('../../services/api/database', async () => {
  const actual =
    await vi.importActual<typeof import('../../services/api/database')>(
      '../../services/api/database',
    );
  return {
    ...actual,
    databaseApi: {
      ...actual.databaseApi,
      getSchemas: vi.fn(),
      getBackups: vi.fn(),
      getBackupScheduleStatus: vi.fn(),
    },
  };
});

const api = vi.mocked(databaseApi);

const schedule = {
  dailyBackupEnabled: true,
  weeklyBackupEnabled: true,
  nextDailyBackup: '2026-07-23T02:00:00.000Z',
  nextWeeklyBackup: '2026-07-26T03:00:00.000Z',
  lastDailyBackup: '2026-07-22T02:00:00.000Z',
  lastWeeklyBackup: null,
};

describe('DatabaseManagementPage backup schedule card (APA-321)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getSchemas.mockResolvedValue({ data: [], total: 0, page: 1, limit: 100, totalPages: 0 });
    // getBackups must resolve — an error early-returns the tab and hides the card.
    api.getBackups.mockResolvedValue({ data: [], total: 0, page: 1, limit: 50, totalPages: 0 });
    api.getBackupScheduleStatus.mockResolvedValue(schedule);
  });

  it('renders Daily + Weekly cadences from the real contract, never "Not configured"', async () => {
    render(
      <BrowserRouter>
        <DatabaseManagementPage />
      </BrowserRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /backups/i }));
    await waitFor(() => expect(api.getBackupScheduleStatus).toHaveBeenCalled());

    expect(await screen.findByText('Daily Backup')).toBeInTheDocument();
    expect(screen.getByText('Weekly Backup')).toBeInTheDocument();
    expect(screen.queryByText('Not configured')).not.toBeInTheDocument();
  });

  it('shows a suspended badge when a cadence is disabled', async () => {
    api.getBackupScheduleStatus.mockResolvedValue({ ...schedule, dailyBackupEnabled: false });
    render(
      <BrowserRouter>
        <DatabaseManagementPage />
      </BrowserRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /backups/i }));
    expect(await screen.findByText('Daily Backup')).toBeInTheDocument();
    expect(screen.getAllByText(/suspended/i).length).toBeGreaterThanOrEqual(1);
  });
});
