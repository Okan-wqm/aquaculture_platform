import {
  devicePlacementOf,
  verifyDeviceOwnershipReply,
  type VerifyDeviceOwnershipResponse,
} from '../sensor-device-ownership-queries';

const SITE = '33333333-3333-4333-8333-333333333339';

/**
 * The edge-device ownership answer carries the device's site (SEC-CRITICAL-207), so the /sensors
 * gateway can admit a site-bound sensor operator to a device of its own sites only. A reply that
 * names no site places the device on no site; a responder of the release before this field gives
 * that reply, so a site-bound caller is refused rather than admitted.
 */
describe('request.sensor.verifyDeviceOwnership reply', () => {
  it('answers an owned device with its site and an unknown one with none', () => {
    const owned: VerifyDeviceOwnershipResponse = verifyDeviceOwnershipReply({ siteId: SITE });
    const siteless: VerifyDeviceOwnershipResponse = verifyDeviceOwnershipReply({ siteId: null });
    const unknown: VerifyDeviceOwnershipResponse = verifyDeviceOwnershipReply(null);

    expect([owned, siteless, unknown]).toEqual([
      { owned: true, siteId: SITE },
      { owned: true, siteId: null },
      { owned: false, siteId: null },
    ]);
  });

  it('reads the placement of an owned device', () => {
    expect(devicePlacementOf({ owned: true, siteId: SITE })).toEqual({ siteId: SITE });
    expect(devicePlacementOf({ owned: true, siteId: null })).toEqual({ siteId: null });
  });

  it('reads a reply without siteId, from a responder of the previous release, as no site', () => {
    expect(devicePlacementOf({ owned: true })).toEqual({ siteId: null });
  });

  it.each([
    ['a device another tenant owns', { owned: false, siteId: null }],
    ['a reply without owned', { siteId: SITE }],
    ['an owned flag that is no boolean', { owned: 'true', siteId: SITE }],
    ['a site that is no string', { owned: true, siteId: 7 }],
    ['an empty site', { owned: true, siteId: '' }],
    ['no object at all', 'owned'],
    ['null', null],
  ])('places nothing for %s', (_case, reply) => {
    expect(devicePlacementOf(reply)).toBeNull();
  });
});
