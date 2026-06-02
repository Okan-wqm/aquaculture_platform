import {
  InternalServerErrorException,
  ServiceUnavailableException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  EnsureTenantMessagingPartitionsCommand,
  EnsureTenantMessagingPartitionsResult,
  MESSAGING_COMMAND_SUBJECTS,
} from '@platform/event-contracts';
import { catchError, firstValueFrom, throwError, timeout } from 'rxjs';

const DEFAULT_MESSAGING_NATS_TIMEOUT_MS = 15_000;

@Injectable()
export class MessagingCommandClientService {
  private readonly logger = new Logger(MessagingCommandClientService.name);
  private readonly timeoutMs: number;

  constructor(
    @Inject('MESSAGING_NATS_CLIENT')
    private readonly messagingNatsClient: ClientProxy,
  ) {
    const configured = parseInt(process.env['MESSAGING_NATS_TIMEOUT_MS'] ?? '', 10);
    this.timeoutMs =
      Number.isFinite(configured) && configured > 0
        ? configured
        : DEFAULT_MESSAGING_NATS_TIMEOUT_MS;
  }

  async ensureTenantPartitions(tenantId: string, correlationId?: string): Promise<void> {
    const command: EnsureTenantMessagingPartitionsCommand = { tenantId, correlationId };
    const result = await firstValueFrom(
      this.messagingNatsClient
        .send<EnsureTenantMessagingPartitionsResult, EnsureTenantMessagingPartitionsCommand>(
          MESSAGING_COMMAND_SUBJECTS.ENSURE_TENANT_PARTITIONS,
          command,
        )
        .pipe(
          timeout(this.timeoutMs),
          catchError((error: unknown) =>
            throwError(
              () =>
                new ServiceUnavailableException(
                  `Messaging-service partition command unavailable: ${this.errorMessage(error)}`,
                ),
            ),
          ),
        ),
    );

    if (!result.success) {
      this.logger.error(
        `Messaging tenant partition ensure failed: tenantId=${tenantId}, error=${result.error ?? result.errorCode}`,
      );
      throw new InternalServerErrorException(
        result.error ?? 'Messaging tenant partition ensure failed',
      );
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
