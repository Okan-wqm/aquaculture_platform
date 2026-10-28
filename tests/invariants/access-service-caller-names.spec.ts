/**
 * INVARIANT: a service caller names a NATS identity of `infrastructure/nats/services.yaml`
 * (ADR-051 §1 and §3; ADR-015).
 *
 * `decideAccess` takes a member or a service caller. A `ServiceCaller` names the service whose
 * certificate CN the broker binds, and the `senders` of every gated subject (`REQUEST_ACCESS`,
 * PKG-09) are typed by the same closed `NatsServiceName`, so a misspelled sender does not compile.
 * services.yaml stays the SSoT for the identities: the closed list in
 * `libs/shared-contracts/src/access/access-spec.ts` equals its service names, in its order, and a
 * service added there (with its certificate and generated nats.conf, docs/runbooks/
 * nats-service-addition.md) fails this spec until the list names it too.
 */
import { NATS_SERVICE_NAMES } from '@aquaculture/shared-contracts';

import { loadNatsServices } from '../../tools/gates/nats-services';

describe('INVARIANT: service callers name the services.yaml identities', () => {
  it('NATS_SERVICE_NAMES equals the services.yaml names, in order', () => {
    expect([...NATS_SERVICE_NAMES]).toEqual(loadNatsServices().map((service) => service.name));
  });
});
