/**
 * CommandLogPage (/sensor/commands) — what was sent to the field, by whom,
 * when, and what the device replied (SENSOR-MEDIUM-185).
 *
 * The real hooks run against a mocked graphqlFetch transport, so these tests
 * pin the reads the page makes and what it shows from each:
 *   - vfdDevices → the drive picker; vfdCommandAuditLog(vfdDeviceId, 100) →
 *     that drive's latest 100 commands, said so in the section;
 *   - feedingParameters (sentOnly, newest send first, paged on the server) →
 *     feeding program sends;
 *   - deploymentHistory with no device, paged → every program deployment of
 *     the tenant, names joined from automationPrograms and edgeDevices;
 *   - people are shown by the e-mail recorded beside their id, by the id
 *     only on rows recorded before the e-mail was kept;
 *   - the cross-device log and the lock list have no backend: they render
 *     only inside MockPreview, which names the finding.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import type { DeploymentHistoryEntry } from '../../../hooks/useDeploymentHistory';
import type { FeedingParameter } from '../../../hooks/usePlcControl';
import type { VfdCommandAuditEntry } from '../../../hooks/useVfdCommandAuditLog';
import CommandLogPage from '../CommandLogPage';
import {
  AUTOMATION_ENGINEER_ID,
  AUTOMATION_PROGRAMS,
  EDGE_DEVICES,
  FEED_MANAGER_ID,
  VFD_DEVICES,
  deployment,
  feedingParameter,
  vfdEntry,
} from './commandLogFixtures';

const { fetchMock, auth } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  auth: { token: 'jwt', tenantId: 'aaaaaaaa-1111-4222-8333-444444444444' },
}));

vi.mock('../../../config/api', () => ({
  graphqlFetch: (...args: unknown[]) => fetchMock(...args),
}));

// useTenantQuery reads shared-ui's own useAuth module, the PLC hooks read the
// package export: both see one authenticated tenant session.
vi.mock('../../../../../../shared-ui/src/hooks/useAuth', () => ({
  useAuth: () => ({ token: auth.token, tenantId: auth.tenantId }),
}));

vi.mock('@aquaculture/shared-ui', async () => {
  const actual =
    await vi.importActual<typeof import('@aquaculture/shared-ui')>('@aquaculture/shared-ui');
  const { useTenantQuery } = await import('../../../../../../shared-ui/src/hooks/useTenantQuery');
  return {
    ...actual,
    useAuth: () => ({ token: auth.token, tenantId: auth.tenantId }),
    useTenantQuery,
  };
});

interface Transport {
  devices?: typeof VFD_DEVICES;
  audit?: Record<string, VfdCommandAuditEntry[]>;
  auditFails?: boolean;
  /** The sends the server holds, in its order; it pages over them as asked. */
  feeding?: FeedingParameter[];
  deployments?: DeploymentHistoryEntry[];
}

interface PageArgs {
  page: number;
  limit: number;
}

/** The server's page envelope over `rows` for the requested page. */
function pageOf<T>(rows: readonly T[], { page, limit }: PageArgs): Record<string, unknown> {
  const totalPages = Math.max(1, Math.ceil(rows.length / limit));
  return {
    items: rows.slice((page - 1) * limit, page * limit),
    total: rows.length,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
}

/** Answers each document the page sends from the transport state, by root field. */
function serve(state: Transport): void {
  fetchMock.mockImplementation(async (query: string, variables?: Record<string, unknown>) => {
    if (query.includes('vfdDevices(')) {
      const items = state.devices ?? VFD_DEVICES;
      return { vfdDevices: { items, total: items.length, page: 1, limit: 100, totalPages: 1 } };
    }
    if (query.includes('vfdCommandAuditLog(')) {
      if (state.auditFails) throw new Error('Forbidden resource');
      const id = String(variables?.vfdDeviceId);
      return { vfdCommandAuditLog: state.audit?.[id] ?? [] };
    }
    if (query.includes('feedingParameters(')) {
      const pagination = variables?.pagination as PageArgs;
      return { feedingParameters: pageOf(state.feeding ?? [], pagination) };
    }
    if (query.includes('deploymentHistory(')) {
      const args = { page: Number(variables?.page), limit: Number(variables?.limit) };
      return { deploymentHistory: pageOf(state.deployments ?? [], args) };
    }
    if (query.includes('automationPrograms(')) {
      return { automationPrograms: { items: AUTOMATION_PROGRAMS, total: 1 } };
    }
    if (query.includes('edgeDevices(')) {
      return { edgeDevices: { items: EDGE_DEVICES, total: 1, page: 1, limit: 100, totalPages: 1 } };
    }
    throw new Error(`unexpected document: ${query.slice(0, 80)}`);
  });
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/sensor/commands']}>
        <CommandLogPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function callsTo(rootField: string): Array<Record<string, unknown> | undefined> {
  return fetchMock.mock.calls
    .filter(([query]) => String(query).includes(`${rootField}(`))
    .map(([, variables]) => variables as Record<string, unknown> | undefined);
}

function section(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

function rowWith(container: HTMLElement, text: string): HTMLElement {
  const row = within(container)
    .getAllByRole('row')
    .find((candidate) => within(candidate).queryByText(text));
  if (row === undefined) throw new Error(`no row shows ${text}`);
  return row;
}

/** `count` sends, newest first as the server orders them. */
function sends(count: number): FeedingParameter[] {
  return Array.from({ length: count }, (_, index) =>
    feedingParameter({ id: `fp-${index + 1}`, name: `Ration ${index + 1}` }),
  );
}

describe('CommandLogPage', () => {
  afterEach(() => fetchMock.mockReset());

  it('is the Command log page, its heading row carrying no eyebrow of its own', async () => {
    serve({});
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Command log' })).toBeInTheDocument();
    // The console header already names the workspace and area (ConsoleHeading).
    expect(screen.queryByText('Control & sensors · SCADA & devices')).toBeNull();
    await waitFor(() => expect(callsTo('vfdDevices')).not.toHaveLength(0));
  });

  describe('drive commands (vfdCommandAuditLog)', () => {
    it("reads the first drive's trail and shows who, what, value, origin and the device reply", async () => {
      serve({
        audit: {
          'vfd-1': [
            vfdEntry({}),
            vfdEntry({
              id: 'cmd-3',
              command: 'SET_SPEED',
              value: 45,
              timestamp: '2026-10-16T07:30:00.000Z',
            }),
            vfdEntry({
              id: 'cmd-2',
              command: 'START',
              value: null,
              success: false,
              error: 'Device not reachable',
              performedByEmail: null,
              performedBy: 'automation-rule',
              source: 'automation',
              latencyMs: null,
              timestamp: '2026-10-16T07:00:00.000Z',
            }),
          ],
        },
      });
      renderPage();

      const drives = section('Drive commands (VFD)');
      await within(drives).findByText('Set frequency');
      expect(callsTo('vfdCommandAuditLog')).toContainEqual({ vfdDeviceId: 'vfd-1', limit: 100 });
      // The query has no offset: the section says how much of the trail it shows.
      expect(drives).toHaveTextContent('its latest 100, newest first');

      const ok = rowWith(drives, 'Set frequency');
      expect(within(ok).getByText('42.5 Hz')).toBeInTheDocument();
      expect(within(ok).getByText('operator@farm.test')).toBeInTheDocument();
      expect(within(ok).getByText('Operator')).toBeInTheDocument();
      expect(within(ok).getByText('Accepted · 180 ms')).toBeInTheDocument();
      expect(within(rowWith(drives, 'Set speed')).getByText('45%')).toBeInTheDocument();

      // A failed command keeps the actor id when no e-mail was recorded and shows the device's error.
      const failed = rowWith(drives, 'Start');
      expect(within(failed).getByText('automation-rule')).toBeInTheDocument();
      expect(within(failed).getByText('Automation')).toBeInTheDocument();
      expect(within(failed).getByText('Failed')).toBeInTheDocument();
      expect(within(failed).getByText('Device not reachable')).toBeInTheDocument();
      // The amber flag bar is drawn on the first cell: WebKit drops a <tr> box shadow.
      expect(failed.className).toContain('[&>td:first-child]:shadow-');
      expect(ok.className).not.toContain('shadow');
    });

    it("switching the drive reads that drive's trail", async () => {
      serve({
        audit: {
          'vfd-2': [vfdEntry({ id: 'cmd-9', vfdDeviceId: 'vfd-2', command: 'STOP', value: null })],
        },
      });
      renderPage();

      const drives = section('Drive commands (VFD)');
      const picker = await within(drives).findByLabelText('Drive');
      await within(picker).findByRole('option', { name: 'Feed pump P-4 · ACS580' });
      fireEvent.change(picker, { target: { value: 'vfd-2' } });

      await within(drives).findByText('Stop');
      expect(callsTo('vfdCommandAuditLog')).toContainEqual({ vfdDeviceId: 'vfd-2', limit: 100 });
    });

    it('says when no drive is registered and reads no trail', async () => {
      serve({ devices: [] });
      renderPage();

      const drives = section('Drive commands (VFD)');
      expect(await within(drives).findByText('No drives are registered yet.')).toBeInTheDocument();
      expect(callsTo('vfdCommandAuditLog')).toHaveLength(0);
    });

    it('a failed read says so and offers a retry, never an empty trail', async () => {
      serve({ auditFails: true });
      renderPage();

      const drives = section('Drive commands (VFD)');
      const alert = await within(drives).findByRole('alert');
      expect(alert).toHaveTextContent('The drive command log could not be loaded.');
      expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
      expect(within(drives).queryByText('No commands are recorded for this drive.')).toBeNull();
    });
  });

  describe('feeding program sends (feedingParameters)', () => {
    it('asks the server for sends only, newest send first, and shows each outcome and author', async () => {
      serve({
        feeding: [
          feedingParameter({
            id: 'fp-2',
            name: 'Winter ration',
            status: 'ERROR',
            sentAt: undefined,
            errorMessage: 'PLC rejected the write',
            createdByEmail: null,
          }),
          feedingParameter({}),
        ],
      });
      renderPage();

      const feeding = section('Feeding program sends');
      await within(feeding).findByText('Spring ration');
      expect(callsTo('feedingParameters')).toContainEqual({
        filter: { sentOnly: true },
        pagination: { page: 1, limit: 25, sortBy: 'lastSendAttemptAt', sortOrder: 'DESC' },
      });

      // The server's order is the log's order: no re-sorting, no client-side filter.
      const names = within(feeding)
        .getAllByText(/ ration$/)
        .map((cell) => cell.textContent);
      expect(names).toEqual(['Winter ration', 'Spring ration']);

      const sent = rowWith(feeding, 'Spring ration');
      expect(within(sent).getByText('Hall A PLC')).toBeInTheDocument();
      expect(within(sent).getByText('Sent')).toBeInTheDocument();
      expect(within(sent).getByText('feed.manager@farm.test')).toBeInTheDocument();
      expect(within(sent).queryByText(FEED_MANAGER_ID)).toBeNull();

      const failed = rowWith(feeding, 'Winter ration');
      expect(within(failed).getByText('Error')).toBeInTheDocument();
      expect(within(failed).getByText('PLC rejected the write')).toBeInTheDocument();
      // A set created before the e-mail was recorded names its author by id.
      expect(within(failed).getByText(FEED_MANAGER_ID)).toBeInTheDocument();
    });

    it('pages through every send: the next page is read from the server', async () => {
      serve({ feeding: sends(30) });
      renderPage();

      const feeding = section('Feeding program sends');
      await within(feeding).findByText('Ration 1');
      expect(feeding).toHaveTextContent('Showing 1–25 of 30');
      expect(within(feeding).queryByText('Ration 26')).toBeNull();

      fireEvent.click(within(feeding).getByRole('button', { name: 'Next page' }));

      await within(feeding).findByText('Ration 26');
      expect(callsTo('feedingParameters')).toContainEqual({
        filter: { sentOnly: true },
        pagination: { page: 2, limit: 25, sortBy: 'lastSendAttemptAt', sortOrder: 'DESC' },
      });
      expect(feeding).toHaveTextContent('Showing 26–30 of 30');
    });

    it('says when no set has been sent yet', async () => {
      serve({ feeding: [] });
      renderPage();

      const feeding = section('Feeding program sends');
      expect(
        await within(feeding).findByText('No feeding program has been sent to a PLC yet.'),
      ).toBeInTheDocument();
    });
  });

  describe('program deployments (deploymentHistory)', () => {
    it('reads the whole tenant history and names the program, edge device and deployer', async () => {
      serve({
        deployments: [
          deployment({}),
          deployment({
            id: 'dep-2',
            programId: 'prog-gone',
            deviceId: 'edge-gone',
            status: 'FAILED',
            edgeAckAt: null,
            errorMessage: 'Edge did not acknowledge',
            deployedByEmail: null,
          }),
        ],
      });
      renderPage();

      const deployments = section('Program deployments');
      await within(deployments).findByText('Aeration cycle');
      expect(callsTo('deploymentHistory')).toContainEqual({
        deviceId: undefined,
        page: 1,
        limit: 25,
      });

      const ok = rowWith(deployments, 'Aeration cycle');
      expect(within(ok).getByText('Hall A gateway')).toBeInTheDocument();
      expect(within(ok).getByText('Deployed')).toBeInTheDocument();
      expect(within(ok).getByText('automation.engineer@farm.test')).toBeInTheDocument();
      expect(within(ok).queryByText(AUTOMATION_ENGINEER_ID)).toBeNull();

      // A program or device that no longer lists is shown by its id, not dropped;
      // a deployment recorded before the e-mail was kept names its deployer by id.
      const failed = rowWith(deployments, 'prog-gone');
      expect(within(failed).getByText('edge-gone')).toBeInTheDocument();
      expect(within(failed).getByText('Failed')).toBeInTheDocument();
      expect(within(failed).getByText('Edge did not acknowledge')).toBeInTheDocument();
      expect(within(failed).getByText(AUTOMATION_ENGINEER_ID)).toBeInTheDocument();
    });

    it('pages through every deployment: the next page is read from the server', async () => {
      serve({
        deployments: Array.from({ length: 27 }, (_, index) =>
          deployment({ id: `dep-${index + 1}`, commandId: `cmd-${index + 1}`, version: index + 1 }),
        ),
      });
      renderPage();

      const deployments = section('Program deployments');
      await within(deployments).findAllByText('Aeration cycle');
      expect(deployments).toHaveTextContent('Showing 1–25 of 27');

      fireEvent.click(within(deployments).getByRole('button', { name: 'Next page' }));

      await waitFor(() =>
        expect(callsTo('deploymentHistory')).toContainEqual({
          deviceId: undefined,
          page: 2,
          limit: 25,
        }),
      );
      await waitFor(() => expect(deployments).toHaveTextContent('Showing 26–27 of 27'));
    });
  });

  describe('what has no backend yet (SENSOR-MEDIUM-185)', () => {
    it('renders the cross-device log and the locks only as labelled previews naming the finding', async () => {
      serve({});
      renderPage();

      for (const name of ['All commands, every device', 'Command locks']) {
        const preview = section(name);
        const note = within(preview).getByRole('note');
        expect(note).toHaveTextContent('PREVIEW · NO BACKEND YET');
        expect(note).toHaveTextContent('Tracked as SENSOR-MEDIUM-185.');
        expect(note).toHaveTextContent('Data shown is sample data.');
        expect(preview.querySelector('[data-preview-finding="SENSOR-MEDIUM-185"]')).not.toBeNull();
      }
      await waitFor(() => expect(callsTo('vfdDevices')).not.toHaveLength(0));
    });

    it('lists only what Architecture §11 defines of a lock: what it blocks and what happens', async () => {
      serve({});
      renderPage();

      const locks = section('Command locks');
      const headers = within(locks)
        .getAllByRole('columnheader')
        .map((header) => header.textContent?.trim());
      expect(headers).toEqual(['Lock', 'What it blocks', 'What happens to the command']);

      expect(
        within(rowWith(locks, 'Open work order')).getByText('Rejected before it is sent'),
      ).toBeInTheDocument();
      expect(
        within(rowWith(locks, 'Livestock-safety limit')).getByText(
          'A setpoint beyond the livestock-safety limit',
        ),
      ).toBeInTheDocument();
      expect(
        within(rowWith(locks, 'Edge offline')).getByText('Queued, then dropped when it expires'),
      ).toBeInTheDocument();
      await waitFor(() => expect(callsTo('vfdDevices')).not.toHaveLength(0));
    });

    it('keeps the real sections outside any preview frame', async () => {
      serve({ audit: { 'vfd-1': [vfdEntry({})] } });
      renderPage();

      for (const name of ['Drive commands (VFD)', 'Feeding program sends', 'Program deployments']) {
        expect(section(name).closest('[data-preview-finding]')).toBeNull();
        expect(section(name).querySelector('[data-preview-finding]')).toBeNull();
      }
      await within(section('Drive commands (VFD)')).findByText('Set frequency');
    });
  });
});
