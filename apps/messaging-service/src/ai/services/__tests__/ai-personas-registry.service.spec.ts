import { AI_PERSONA_CATALOGUE } from '@aquaculture/shared-contracts';
import { AiPersonasRegistryService } from '../ai-personas-registry.service';

/**
 * AISAFETY-MEDIUM-024 — the messaging persona registry is a VIEW of the
 * shared catalogue, filtered by the caller's capabilities exactly as
 * ai-service filters per turn.
 */
describe('AiPersonasRegistryService (shared catalogue view)', () => {
  const registry = new AiPersonasRegistryService();

  it('always leads with the tenant-default entry (id null)', () => {
    const list = registry.getAvailablePersonas({ roles: ['MODULE_USER'], resourcePermissions: [] });
    expect(list[0]).toMatchObject({ id: null, name: 'General AI Assistant' });
    expect(list).toHaveLength(1);
  });

  it('offers exactly the personas the caller holds every required capability for', () => {
    const list = registry.getAvailablePersonas({
      roles: ['MODULE_USER'],
      resourcePermissions: ['ai_personas:operator', 'ai_personas:manager', 'ai_specialties:farm'],
    });
    expect(list.map((p) => p.id)).toEqual([
      null,
      'operator-v1',
      'manager-v1',
      'operator-farm-water-health-v1',
      'manager-farm-water-health-v1',
      'operator-farm-production-v1',
      'manager-farm-production-v1',
      'operator-farm-operations-v1',
      'manager-farm-operations-v1',
    ]);
  });

  it('withholds farm specialists from a caller with the tier but not the farm specialty', () => {
    const list = registry.getAvailablePersonas({
      roles: ['MODULE_USER'],
      resourcePermissions: ['ai_personas:operator', 'ai_personas:manager', 'ai_personas:expert'],
    });
    expect(list.map((p) => p.id)).toEqual([null, 'operator-v1', 'manager-v1', 'expert-v1']);
  });

  it('a tenant admin sees the whole catalogue; listAll serves the 13 published personas', () => {
    const admin = registry.getAvailablePersonas({
      roles: ['TENANT_ADMIN'],
      resourcePermissions: [],
    });
    expect(admin).toHaveLength(AI_PERSONA_CATALOGUE.length + 1);
    // The admin inventory is the 13 PUBLISHED personas; the `id: null`
    // tenant-default row is a picker affordance, not a persona.
    expect(registry.listAll().map((p) => p.id)).toEqual(AI_PERSONA_CATALOGUE.map((e) => e.id));
    expect(registry.listAll()).toHaveLength(13);
  });

  it('carries the catalogue presentation (renamed general personas, specialist names)', () => {
    const byId = new Map(registry.listAll().map((p) => [p.id, p]));
    expect(byId.get('operator-v1')?.name).toBe('Operations Assistant (General)');
    expect(byId.get('expert-farm-water-health-v1')).toMatchObject({
      name: 'Water & Fish Health Specialist (Expert)',
      icon: 'heart-pulse',
      color: 'cyan',
    });
    expect(byId.get('expert-farm-water-health-v1')?.capabilities).toContain(
      'Harvest eligibility (withdrawal)',
    );
  });
});
