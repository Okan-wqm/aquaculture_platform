import { Field, ID, Int, ObjectType } from '@nestjs/graphql';

import type { SensorMqttCredentials } from './sensor-mqtt-identity.service';

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
