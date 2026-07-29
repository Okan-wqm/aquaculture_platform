import { PROTOCOL_ADAPTERS } from '../protocol-adapters.registry';
import {
  PROTOCOL_IMPLEMENTATION_STATUS,
  ProtocolImplementationStatus,
  getProtocolImplementationStatus,
  isSelectableProtocol,
} from '../protocol-implementation-status';

/**
 * Completeness invariant for SENSOR-CRITICAL-008: every registered protocol
 * adapter must be classified, and the classification set must not drift from
 * the registry. A new adapter added without a classification, or a stale
 * classification for a removed adapter, fails the build here.
 */
describe('protocol implementation-status SSoT', () => {
  // protocolCode is a field initializer independent of constructor deps, so a
  // bare construct is enough to read it (Reflect.construct tolerates the one
  // adapter that takes an injected collaborator).
  const registeredCodes: string[] = PROTOCOL_ADAPTERS.map((AdapterClass) => {
    const instance: { protocolCode: string } = Reflect.construct(AdapterClass, []);
    return instance.protocolCode;
  });

  it('classifies every registered protocol adapter', () => {
    const unclassified = registeredCodes.filter(
      (code) => !(code in PROTOCOL_IMPLEMENTATION_STATUS),
    );
    expect(unclassified).toEqual([]);
  });

  it('has no classification entry for an unregistered code', () => {
    const registered = new Set(registeredCodes);
    const orphaned = Object.keys(PROTOCOL_IMPLEMENTATION_STATUS).filter(
      (code) => !registered.has(code),
    );
    expect(orphaned).toEqual([]);
  });

  it('maps every registered code to a valid status', () => {
    const validStatuses = new Set<string>(Object.values(ProtocolImplementationStatus));
    for (const code of registeredCodes) {
      expect(validStatuses.has(getProtocolImplementationStatus(code))).toBe(true);
    }
  });

  it('fails safe to UNSUPPORTED (not selectable) for an unknown code', () => {
    expect(getProtocolImplementationStatus('NO_SUCH_PROTOCOL')).toBe(
      ProtocolImplementationStatus.UNSUPPORTED,
    );
    expect(isSelectableProtocol('NO_SUCH_PROTOCOL')).toBe(false);
  });

  it('treats UNSUPPORTED protocols as non-selectable and others as selectable', () => {
    for (const code of registeredCodes) {
      const selectable =
        getProtocolImplementationStatus(code) !== ProtocolImplementationStatus.UNSUPPORTED;
      expect(isSelectableProtocol(code)).toBe(selectable);
    }
  });
});
