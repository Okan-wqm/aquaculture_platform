import { buildNatsConnectionOptions } from '@aquaculture/backend-common/nats';
import { connect } from 'nats';

// Near-miss: the module takes its options from the factory and reads no credential variable.
export const connectWithFactory = (): ReturnType<typeof connect> =>
  connect({ ...buildNatsConnectionOptions('uses-factory') });
