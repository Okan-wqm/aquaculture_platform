import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveCmemsSelectionLock } from '../../../tools/cmems-resolved-selection-lock';
import resolvedSelectionLock from '../../catalog/cmems-resolved-selection-lock.v2.generated.json';
import {
  MARINE_SELECTION_CATALOG_REVISION,
  MARINE_SELECTION_CATALOG_SCHEMA_VERSION,
  MARINE_SELECTION_CATALOG_VERSION,
} from '../../marine-worker-control';

const SOURCE_CATALOG_PATH = resolve(
  process.cwd(),
  'apps/farm-service/src/marine-explorer/catalog/copernicus-catalog-lock.v2.json',
);

describe('generated CMEMS resolved-selection lock', () => {
  it('is the deterministic complete derivative of the sole hand-authored farm catalogue', () => {
    const sourceBytes = readFileSync(SOURCE_CATALOG_PATH);
    expect(resolvedSelectionLock).toEqual(resolveCmemsSelectionLock(sourceBytes));
    expect(
      new Set(
        resolvedSelectionLock.resolvedSelections.map(
          (selection) => selection.selectionProvenance.catalogEntryId,
        ),
      ).size,
    ).toBe(resolvedSelectionLock.resolvedSelections.length);
    expect(resolvedSelectionLock.resolvedSelections).toHaveLength(15);

    const currents = resolvedSelectionLock.resolvedSelections.find(
      (selection) =>
        selection.selectionProvenance.catalogEntryId === 'cmems.operational.currents.analysis',
    );
    expect(currents?.selectionProvenance.variables.map(({ id }) => id)).toEqual(['uo', 'vo']);
    expect(currents?.selectionProvenance.display).toMatchObject({
      variable: 'sea_water_velocity',
      wmtsCapabilitiesUrl:
        'https://wmts.marine.copernicus.eu/teroWmts/GLOBAL_ANALYSISFORECAST_PHY_001_024/cmems_mod_glo_phy-cur_anfc_0.083deg_P1D-m_202406?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetCapabilities',
      artifact: {
        dataKind: 'RASTER',
        mediaType: 'image/png',
        authority: 'DISPLAY_ONLY',
      },
    });
    expect(currents?.selectionProvenance.attribution).toMatchObject({
      id: 'attribution.cmems.global-analysisforecast-phy-001-024.v1',
      provider: 'COPERNICUS_MARINE',
      requiredTemplateVariables: ['ACCESSED_ON'],
      doi: '10.48670/moi-00016',
    });
  });

  it('keeps the exported wire constants pinned to the derivative source identity', () => {
    expect(MARINE_SELECTION_CATALOG_SCHEMA_VERSION).toBe(
      resolvedSelectionLock.sourceCatalog.schemaVersion,
    );
    expect(MARINE_SELECTION_CATALOG_VERSION).toBe(
      resolvedSelectionLock.sourceCatalog.catalogVersion,
    );
    expect(MARINE_SELECTION_CATALOG_REVISION).toBe(
      resolvedSelectionLock.sourceCatalog.catalogRevision,
    );
  });
});
