import {
  AdminHttpContractError,
  decodeStandardPaginatedResultCandidate,
  encodeAdminHttpPageV1,
  encodeAdminHttpValueV1,
  projectAdminResponseToJson,
  type AdminHttpSuccessEnvelopeV1,
} from '@platform/admin-http-contracts';
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  StreamableFile,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type { Request, Response } from 'express';

import {
  manualResponseProfileFor,
  responseContractFor,
} from './admin-response-contract.decorator';
import { adminRequestContext } from './admin-request-context';

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, AdminHttpSuccessEnvelopeV1 | T> {
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<AdminHttpSuccessEnvelopeV1 | T> {
    // The envelope is an HTTP contract. The hybrid Nest application also runs
    // NATS handlers through global interceptors; those values retain their RPC
    // contract unchanged.
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const requestContext = adminRequestContext(request, response);

    const handler = context.getHandler();
    if (typeof handler !== 'function') {
      throw new AdminHttpContractError(
        '$.route',
        'HTTP handler identity is unavailable; response authority cannot be resolved',
      );
    }
    const contract = responseContractFor(handler);
    const bypass = manualResponseProfileFor(handler);
    if (contract !== undefined && bypass !== undefined) {
      throw new AdminHttpContractError(
        '$.route',
        'HTTP route declares both an envelope contract and a transport bypass',
      );
    }
    if (bypass !== undefined) {
      if (bypass.kind === 'binary-download') {
        return next.handle();
      }
      return next.handle().pipe(
        map((data: T): T => {
          const manualResponse = context.switchToHttp().getResponse<{
            readonly headersSent?: boolean;
            readonly statusCode?: number;
          }>();
          if (data === undefined && manualResponse.headersSent === true) return data;
          const status = manualResponse.statusCode ?? 200;
          if (!bypass.statusCodes.includes(status)) {
            throw new AdminHttpContractError(
              '$.status',
              `health response status ${status} is outside its executable profile`,
            );
          }
          return projectAdminResponseToJson(bypass.body, data) as T;
        }),
      );
    }
    if (contract === undefined) {
      throw new AdminHttpContractError(
        '$.route',
        'HTTP route has neither an executable response contract nor a typed bypass',
      );
    }

    return next.handle().pipe(
      map((data: T): AdminHttpSuccessEnvelopeV1 | T => {
        if (data instanceof StreamableFile || Buffer.isBuffer(data)) {
          throw new AdminHttpContractError(
            '$.data',
            'binary response requires an executable binary response profile',
          );
        }

        const projected = projectAdminResponseToJson(contract, data);
        const timestamp = new Date().toISOString();
        if (contract.kind === 'page') {
          const page = decodeStandardPaginatedResultCandidate(projected);
          if (page === null) {
            throw new AdminHttpContractError(
              '$.data',
              'root page contract did not project a canonical page',
            );
          }
          return encodeAdminHttpPageV1(page, timestamp, requestContext.requestId);
        }

        // A void command still has an explicit JSON representation. This keeps
        // the success envelope strict instead of allowing the data key to
        // disappear during JSON serialization.
        return encodeAdminHttpValueV1(projected ?? null, timestamp, requestContext.requestId);
      }),
    );
  }
}
