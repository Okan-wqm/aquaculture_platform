/**
 * FARM-AI-0.1: service principal audit UUID fix.
 *
 * tool_execution_audit.userId is uuid NOT NULL; service identities like
 * 'service:sensor-service' are INVALID uuids → INSERT silently failed
 * (best-effort catch). The service now derives a deterministic UUID from
 * the service name; these specs pin the contract.
 */
import 'reflect-metadata';
import { servicePrincipalUuid } from '../audit.service';

describe('servicePrincipalUuid (FARM-AI-0.1)', () => {
  it('produces valid UUIDs', () => {
    const uuid = servicePrincipalUuid('service:sensor-service');
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('is deterministic (same service → same uuid)', () => {
    const a = servicePrincipalUuid('service:sensor-service');
    const b = servicePrincipalUuid('service:sensor-service');
    expect(a).toBe(b);
  });

  it('is distinct per service', () => {
    const a = servicePrincipalUuid('service:sensor-service');
    const b = servicePrincipalUuid('service:messaging-service');
    expect(a).not.toBe(b);
  });
});
