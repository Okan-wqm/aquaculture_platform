/**
 * Immediate-report tab submission tests (federation-free vitest).
 *
 * Locks the fe-immediate-reports fix: the Welfare / Escape / Disease tabs must
 *   - call the REAL submit mutation (graphqlClient.request) with the resolved
 *     Mattilsynet identity block — never console.log + fake-success;
 *   - close the modal ONLY when ReportSubmissionResult.success === true;
 *   - keep the modal OPEN and surface an error when success === false (or the
 *     request throws).
 *
 * The modals are mocked with a faithful stub that replicates the production
 * modal's close-contract (await onSubmit → on resolve call onClose; on reject
 * stay mounted + record the error). `@aquaculture/shared-ui` is mocked to
 * supply auth + a controllable graphqlClient, and useTanks is stubbed so the
 * tabs render without a live data layer. The REAL useSubmit* hooks run, so the
 * test exercises the genuine hook → graphqlClient request path.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WelfareEventTab } from '../WelfareEventTab';
import { EscapeReportTab } from '../EscapeReportTab';
import { DiseaseOutbreakTab } from '../DiseaseOutbreakTab';
import '@testing-library/jest-dom/vitest';

// ── graphqlClient.request is the seam we drive success/failure through ──
// Hoisted so the (hoisted) vi.mock factories below can safely reference it.
const { requestMock, REGULATORY_SETTINGS } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  REGULATORY_SETTINGS: {
    organisationNumber: '987654321',
    defaultContactName: 'Ola Nordmann',
    defaultContactEmail: 'ola@farm.no',
    defaultContactPhone: '+4798989898',
    siteLocalityMappings: [{ siteId: 'site-001', lokalitetsnummer: 12345 }],
    maskinportenConfigured: true,
  },
}));

vi.mock('@aquaculture/shared-ui', async () => {
  const actual =
    await vi.importActual<typeof import('@aquaculture/shared-ui')>('@aquaculture/shared-ui');
  return {
    ...actual,
    useAuth: () => ({
      token: 'jwt',
      tenantId: 'aaaaaaaa-1111-4222-8333-444444444444',
      isAuthenticated: true,
      isLoading: false,
    }),
    graphqlClient: { request: requestMock },
  };
});

// Tabs read tank lists for context banners — stub to an empty list.
vi.mock('../../../../hooks/useTanks', () => ({
  useTanksList: () => ({ data: { items: [] } }),
}));

// The tabs now render the real SubmissionHistorySection — stub its read-model
// hooks so the history query does not pollute the graphqlClient mutation seam.
vi.mock('../../../../hooks/useRegulatoryReports', () => ({
  useRegulatoryReports: () => ({ data: [], isLoading: false, error: null }),
  useRegulatoryReportSummary: () => ({ data: [], isLoading: false }),
  useRegulatoryReport: () => ({ data: null, isLoading: false }),
}));

vi.mock('../../../../hooks/useRegulatory', async () => {
  const actual =
    await vi.importActual<typeof import('../../../../hooks/useRegulatory')>(
      '../../../../hooks/useRegulatory',
    );
  return {
    ...actual,
    useRegulatorySettings: () => ({ data: REGULATORY_SETTINGS }),
  };
});

// ── Faithful modal stub: replicates the production close-contract ──
// Renders a submit button + an error region. On submit it awaits onSubmit; if
// it resolves it calls onClose (modal closes); if it rejects it stays rendered
// and shows the error — exactly what the real modal does.
interface StubModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (report: Record<string, unknown>) => Promise<void>;
}

function makeModalStub(
  payload: Record<string, unknown>,
  testId: string,
): React.FC<StubModalProps> {
  return function ModalStub(props: StubModalProps): React.ReactElement | null {
    const [error, setError] = React.useState<string | null>(null);
    if (!props.isOpen) return null;
    const submit = async (): Promise<void> => {
      setError(null);
      try {
        await props.onSubmit(payload);
        props.onClose();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'error');
      }
    };
    return (
      <div data-testid={testId}>
        <button type="button" onClick={() => void submit()}>
          Submit Report
        </button>
        {error !== null && <p role="alert">{error}</p>}
      </div>
    );
  };
}

vi.mock('../../components/modals', () => ({
  WelfareEventModal: makeModalStub(
    {
      siteId: 'site-001',
      siteName: 'North Site',
      eventType: 'welfare_impact',
      severity: 'high',
      detectedAt: new Date('2026-06-14T08:00:00.000Z'),
      welfareData: { description: 'Net damage', affectedFishEstimate: 100, immediateActions: ['Repair'] },
      immediateActions: ['Repair'],
    },
    'welfare-modal',
  ),
  EscapeReportModal: makeModalStub(
    {
      siteId: 'site-001',
      siteName: 'North Site',
      detectedAt: new Date('2026-06-14T08:00:00.000Z'),
      escape: {
        estimatedCount: 5000,
        species: 'Atlantic Salmon',
        avgWeightG: 3500,
        totalBiomassKg: 17500,
        cause: 'storm_damage',
        causeDescription: '',
      },
      affectedUnits: [{ unitName: 'Cage 3' }],
      recovery: { ongoingEfforts: true, recapturedCount: 0, estimatedRemaining: 5000 },
    },
    'escape-modal',
  ),
  DiseaseOutbreakModal: makeModalStub(
    {
      siteId: 'site-001',
      siteName: 'North Site',
      detectedAt: new Date('2026-06-14T08:00:00.000Z'),
      disease: { category: 'C', name: 'Pancreas Disease', suspectedOrConfirmed: 'lab_confirmed' },
      affectedPopulation: { estimatedCount: 2000, percentage: 15, batches: [], tanks: [] },
      clinicalSigns: ['lethargy'],
      veterinarianNotified: true,
    },
    'disease-modal',
  ),
}));

function renderTab(tab: React.ReactElement): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}>{tab}</QueryClientProvider>);
}

async function openModalViaHeaderButton(label: RegExp): Promise<void> {
  const user = userEvent.setup();
  // The first matching header "Report ..." button opens the modal.
  const [openBtn] = screen.getAllByRole('button', { name: label });
  await user.click(openBtn);
}

const cases = [
  {
    name: 'Welfare',
    tab: <WelfareEventTab siteId="site-001" />,
    openLabel: /report event/i,
    modalTestId: 'welfare-modal',
    responseKey: 'submitWelfareEvent',
  },
  {
    name: 'Escape',
    tab: <EscapeReportTab siteId="site-001" />,
    openLabel: /report escape/i,
    modalTestId: 'escape-modal',
    responseKey: 'submitEscapeReport',
  },
  {
    name: 'Disease',
    tab: <DiseaseOutbreakTab siteId="site-001" />,
    openLabel: /report outbreak/i,
    modalTestId: 'disease-modal',
    responseKey: 'submitDiseaseOutbreak',
  },
] as const;

describe('immediate-report tabs — real submission + success/failure handling', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe.each(cases)('$name tab', ({ tab, openLabel, modalTestId, responseKey }) => {
    it('calls the real mutation and closes the modal ONLY on success', async () => {
      requestMock.mockResolvedValue({ [responseKey]: { success: true, referanse: 'evt-1', klientReferanse: 'ref' } });
      const user = userEvent.setup();
      renderTab(tab);

      await openModalViaHeaderButton(openLabel);
      expect(screen.getByTestId(modalTestId)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /submit report/i }));

      // Real mutation fired (not a console.log placeholder).
      await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
      // Modal closed because success === true.
      await waitFor(() => expect(screen.queryByTestId(modalTestId)).not.toBeInTheDocument());
    });

    it('keeps the modal OPEN and surfaces an error when success === false', async () => {
      requestMock.mockResolvedValue({
        [responseKey]: { success: false, klientReferanse: 'ref', feilmelding: 'Mattilsynet rejected' },
      });
      const user = userEvent.setup();
      renderTab(tab);

      await openModalViaHeaderButton(openLabel);
      await user.click(screen.getByRole('button', { name: /submit report/i }));

      await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
      // Modal stays open and the failure is surfaced — never fake-success.
      expect(screen.getByTestId(modalTestId)).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Mattilsynet rejected'));
    });
  });
});
