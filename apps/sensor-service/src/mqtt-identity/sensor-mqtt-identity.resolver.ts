import { CurrentUser, Roles, Role, Tenant } from '@aquaculture/backend-common/decorators';
import { Args, Field, ID, Int, Mutation, ObjectType, Resolver } from '@nestjs/graphql';

import {
  type SensorMqttCredentials,
  SensorMqttIdentityService,
} from './sensor-mqtt-identity.service';

/** How a sensor connects with its own broker principal; returned once. */
@ObjectType('SensorMqttCredentials')
export class SensorMqttCredentialsType implements SensorMqttCredentials {
  @Field(() => ID)
  sensorId!: string;

  @Field()
  host!: string;

  @Field(() => Int)
  port!: number;

  @Field()
  tls!: boolean;

  @Field()
  clientId!: string;

  @Field()
  username!: string;

  /** Shown once: it is not stored and cannot be read again. */
  @Field()
  password!: string;

  @Field()
  topic!: string;
}

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
