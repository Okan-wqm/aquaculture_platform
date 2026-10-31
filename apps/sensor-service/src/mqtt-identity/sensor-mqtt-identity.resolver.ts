import { CurrentUser, Roles, Role, Tenant } from '@aquaculture/backend-common/decorators';
import { Args, ID, Mutation, Resolver } from '@nestjs/graphql';

import { SensorMqttCredentialsType } from './sensor-mqtt-credentials.type';
import { SensorMqttIdentityService } from './sensor-mqtt-identity.service';

export { SensorMqttCredentialsType } from './sensor-mqtt-credentials.type';

@Resolver()
export class SensorMqttIdentityResolver {
  constructor(private readonly identity: SensorMqttIdentityService) {}

  /**
   * Issue the sensor a new broker credential (ADR-047 §6); the one it held, if
   * any, stops working. The answer is the only copy of the password.
   * SECURITY: TENANT_ADMIN or MODULE_MANAGER, the roles that register and move
   * sensors.
   */
  @Mutation(() => SensorMqttCredentialsType, { name: 'rotateSensorMqttCredentials' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async rotateSensorMqttCredentials(
    @Args('sensorId', { type: () => ID }) sensorId: string,
    @Tenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<SensorMqttCredentialsType> {
    return Object.assign(
      new SensorMqttCredentialsType(),
      await this.identity.rotate(tenantId, sensorId, user.sub),
    );
  }
}
