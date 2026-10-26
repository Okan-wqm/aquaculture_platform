import { buildNatsConnectionOptions } from '@aquaculture/backend-common/nats';
import { ConfigService } from '@nestjs/config';
import { connect } from 'nats';

// The gateway bridge shape the RCA names: the factory builds the options, then the bridge
// writes user/pass/token around it from its own reads, without looking at the auth mode.
export class BridgeService {
  constructor(private readonly configService: ConfigService) {}

  async connectBridge(): Promise<void> {
    const connectionOptions: Record<string, unknown> = { ...buildNatsConnectionOptions('bridge') };
    const authToken = this.configService.get<string>('NATS_AUTH_TOKEN');
    const authUser = this.configService.get<string>('NATS_AUTH_USER');
    const authPass = this.configService.get<string>('NATS_AUTH_PASS');
    if (authToken) {
      connectionOptions.token = authToken;
    } else if (authUser && authPass) {
      connectionOptions.user = authUser;
      connectionOptions.pass = authPass;
    }
    await connect(connectionOptions);
  }
}
