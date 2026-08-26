import { runtimeRolesForTenantAwareSchema } from '../tenant-schema-privileges';

describe('tenant schema runtime roles', () => {
  it('grants the dedicated Rust ingress role only on sensor tenant schemas', () => {
    expect(runtimeRolesForTenantAwareSchema('sensor')).toEqual([
      'sensor_service',
      'sensor_ingestion',
    ]);
    expect(runtimeRolesForTenantAwareSchema('farm')).toEqual(['farm_service']);
  });
});
