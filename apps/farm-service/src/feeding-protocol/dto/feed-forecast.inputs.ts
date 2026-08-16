import { Field, ID, InputType } from '@nestjs/graphql';
import { IsUUID } from 'class-validator';

/** One client-owned idempotency key for one governed site refresh operation. */
@InputType()
export class RefreshProtocolFeedForecastInput {
  @Field(() => ID)
  @IsUUID()
  siteId!: string;

  @Field(() => ID)
  @IsUUID()
  operationRequestId!: string;
}
