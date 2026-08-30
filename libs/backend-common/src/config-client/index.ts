/**
 * @aquaculture/backend-common/config-client
 *
 * Trusted read path to config-service's *effective* configuration over NATS
 * request-reply (Billing Revival Faz C). Every request is ServiceIdentity
 * HMAC-v2 signed; the GET_SECRET subject is the ONE place a decrypted platform
 * secret crosses the wire and is defended in depth (see config-runtime contract).
 */
export {
  ConfigRuntimeClient,
  CONFIG_NATS_CLIENT,
  CONFIG_RUNTIME_CONSUMER_SERVICE,
  type BillingStripeSettings,
} from './config-runtime.client';
export { ConfigClientModule } from './config-client.module';
export { MarineProviderCredentialClientModule } from './marine-provider-credential-client.module';
export {
  MarineProviderCredentialClient,
  MarineProviderCredentialTransportError,
  MARINE_PROVIDER_CREDENTIAL_CONSUMER_SERVICE,
  MARINE_PROVIDER_CREDENTIAL_CONSUMER_SERVICE_TOKEN,
  MARINE_PROVIDER_CREDENTIAL_NATS_CLIENT,
  type CdseProviderCredentialBundle,
} from './marine-provider-credential.client';
