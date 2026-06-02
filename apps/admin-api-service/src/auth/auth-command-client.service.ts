import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { catchError, firstValueFrom, throwError, timeout } from 'rxjs';

const DEFAULT_AUTH_NATS_TIMEOUT_MS = 15_000;

export interface AuthCommandResult {
  success: boolean;
  errorCode?: string;
  error?: string;
}

@Injectable()
export class AuthCommandClientService {
  private readonly timeoutMs: number;

  constructor(
    @Inject('AUTH_NATS_CLIENT')
    private readonly authNatsClient: ClientProxy,
  ) {
    const configured = parseInt(process.env['AUTH_NATS_TIMEOUT_MS'] ?? '', 10);
    this.timeoutMs =
      Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_AUTH_NATS_TIMEOUT_MS;
  }

  async request<TCommand extends object, TResult extends AuthCommandResult>(
    subject: string,
    command: TCommand,
  ): Promise<TResult> {
    return firstValueFrom(
      this.authNatsClient.send<TResult, TCommand>(subject, command).pipe(
        timeout(this.timeoutMs),
        catchError((error: unknown) =>
          throwError(() => new ServiceUnavailableException(this.authUnavailableMessage(error))),
        ),
      ),
    );
  }

  assertSuccess<TResult extends AuthCommandResult>(
    result: TResult,
    fallback = 'Auth-service command failed',
  ): TResult {
    if (result.success) {
      return result;
    }

    const message = result.error || fallback;
    switch (result.errorCode) {
      case 'DUPLICATE_EMAIL':
      case 'DUPLICATE_CODE':
      case 'DUPLICATE_ROLE':
      case 'DUPLICATE_ASSIGNMENT':
      case 'ASSIGNMENT_EXISTS':
      case 'MODULE_ASSIGNED':
        throw new ConflictException(message);
      case 'TENANT_NOT_FOUND':
      case 'USER_NOT_FOUND':
      case 'MODULE_NOT_FOUND':
      case 'ASSIGNMENT_NOT_FOUND':
      case 'ROLE_NOT_FOUND':
        throw new NotFoundException(message);
      case 'INVALID_STATUS':
      case 'INVALID_ROLE':
      case 'VALIDATION_ERROR':
      case 'PASSWORD_POLICY_VIOLATION':
        throw new BadRequestException(message);
      default:
        throw new InternalServerErrorException(message);
    }
  }

  private authUnavailableMessage(error: unknown): string {
    const reason = error instanceof Error ? error.message : String(error);
    return `Auth-service command unavailable: ${reason}`;
  }
}
