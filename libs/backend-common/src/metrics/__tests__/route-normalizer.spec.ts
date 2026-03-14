import { normalizeRoute } from '../route-normalizer';

describe('normalizeRoute', () => {
  it('should return "/" for empty input', () => {
    expect(normalizeRoute('')).toBe('/');
  });

  it('should not modify static routes', () => {
    expect(normalizeRoute('/health')).toBe('/health');
    expect(normalizeRoute('/health/live')).toBe('/health/live');
    expect(normalizeRoute('/health/ready')).toBe('/health/ready');
    expect(normalizeRoute('/metrics')).toBe('/metrics');
    expect(normalizeRoute('/graphql')).toBe('/graphql');
  });

  it('should normalize UUID path segments to :id', () => {
    expect(normalizeRoute('/api/tenants/550e8400-e29b-41d4-a716-446655440000'))
      .toBe('/api/tenants/:id');

    expect(normalizeRoute('/api/tenants/550e8400-e29b-41d4-a716-446655440000/farms/123e4567-e89b-12d3-a456-426614174000'))
      .toBe('/api/tenants/:id/farms/:id');
  });

  it('should normalize numeric IDs to :id', () => {
    expect(normalizeRoute('/api/sensors/42')).toBe('/api/sensors/:id');
    expect(normalizeRoute('/api/sensors/42/readings/99'))
      .toBe('/api/sensors/:id/readings/:id');
  });

  it('should normalize MongoDB ObjectId to :id', () => {
    expect(normalizeRoute('/api/users/507f1f77bcf86cd799439011'))
      .toBe('/api/users/:id');
  });

  it('should normalize slug-like IDs with digits', () => {
    expect(normalizeRoute('/api/sensors/sensor-abc-123'))
      .toBe('/api/sensors/:id');
  });

  it('should preserve known static segments', () => {
    expect(normalizeRoute('/api/v1/sensors/42/readings'))
      .toBe('/api/v1/sensors/:id/readings');

    expect(normalizeRoute('/api/v2/tenants/550e8400-e29b-41d4-a716-446655440000/users'))
      .toBe('/api/v2/tenants/:id/users');
  });

  it('should handle deeply nested routes', () => {
    expect(normalizeRoute('/api/tenants/550e8400-e29b-41d4-a716-446655440000/farms/42/sensors/sensor-abc-123/readings'))
      .toBe('/api/tenants/:id/farms/:id/sensors/:id/readings');
  });

  it('should not normalize pure text segments without digits', () => {
    expect(normalizeRoute('/api/billing/plans')).toBe('/api/billing/plans');
    expect(normalizeRoute('/api/auth/login')).toBe('/api/auth/login');
  });
});
