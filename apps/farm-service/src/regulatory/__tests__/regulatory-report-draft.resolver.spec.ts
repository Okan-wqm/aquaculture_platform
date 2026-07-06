/**
 * RegulatoryReportDraftResolver — tenant extraction + delegation, and the
 * updateAutoSubmitPolicy mapping from the saved policy map to entries.
 * The @Roles authorisation is covered by the permission-matrix invariant;
 * the draft lifecycle itself by regulatory-report-draft.service.spec.ts.
 */
import { UnauthorizedException } from '@nestjs/common';

import { RegulatoryReportDraftResolver } from '../regulatory-report-draft.resolver';
import { RegulatoryReportDraftService } from '../services/regulatory-report-draft.service';
import { RegulatorySettingsService } from '../regulatory-settings.service';
import { RegulatorySettings } from '../entities/regulatory-settings.entity';

const TENANT = 'aaaaaaaa-1111-4222-8333-444444444444';

function ctx(): { req: { user: { tenantId: string } } } {
  return { req: { user: { tenantId: TENANT } } };
}

describe('RegulatoryReportDraftResolver', () => {
  let resolver: RegulatoryReportDraftResolver;
  let listDrafts: jest.Mock;
  let saveOverrides: jest.Mock;
  let dismissDraft: jest.Mock;
  let updateAutoSubmitPolicy: jest.Mock;

  beforeEach(() => {
    listDrafts = jest.fn().mockResolvedValue([]);
    saveOverrides = jest.fn().mockResolvedValue({ id: 'draft-1' });
    dismissDraft = jest.fn().mockResolvedValue({ id: 'draft-1' });
    updateAutoSubmitPolicy = jest.fn();

    const draftService: Pick<
      RegulatoryReportDraftService,
      'listDrafts' | 'saveOverrides' | 'dismissDraft'
    > = { listDrafts, saveOverrides, dismissDraft };
    const settingsService: Pick<RegulatorySettingsService, 'updateAutoSubmitPolicy'> = {
      updateAutoSubmitPolicy,
    };

    resolver = new RegulatoryReportDraftResolver(
      draftService as RegulatoryReportDraftService,
      settingsService as RegulatorySettingsService,
    );
  });

  it('reportDrafts forwards the tenant + filter to the service', async () => {
    await resolver.reportDrafts(ctx(), { siteId: 'site-1' });
    expect(listDrafts).toHaveBeenCalledWith(TENANT, { siteId: 'site-1' });
  });

  it('saveReportDraftOverrides forwards draftId + overrides', async () => {
    await resolver.saveReportDraftOverrides({ draftId: 'draft-1', overrides: { '/x': 1 } }, ctx());
    expect(saveOverrides).toHaveBeenCalledWith(TENANT, 'draft-1', { '/x': 1 });
  });

  it('throws when the tenant context is missing', async () => {
    await expect(resolver.dismissReportDraft('draft-1', { req: {} })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(dismissDraft).not.toHaveBeenCalled();
  });

  it('updateAutoSubmitPolicy returns the saved policy map as entries', async () => {
    const saved = new RegulatorySettings();
    saved.autoSubmitPolicies = { SEA_LICE: true, SMOLT: false };
    updateAutoSubmitPolicy.mockResolvedValue(saved);

    const result = await resolver.updateAutoSubmitPolicy(
      { reportType: 'SEA_LICE', enabled: true },
      ctx(),
    );

    expect(updateAutoSubmitPolicy).toHaveBeenCalledWith(TENANT, 'SEA_LICE', true);
    expect(result).toEqual([
      { reportType: 'SEA_LICE', enabled: true },
      { reportType: 'SMOLT', enabled: false },
    ]);
  });
});
