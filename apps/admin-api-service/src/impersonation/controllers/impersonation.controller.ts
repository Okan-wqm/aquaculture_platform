import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Headers,
  Req,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
  ParseUUIDPipe,
  type PipeTransform,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsString,
  IsOptional,
  IsUUID,
  IsBoolean,
  IsEnum,
  IsInt,
  IsArray,
  IsObject,
  Min,
  Max,
  MaxLength,
  IsDateString,
  IsIn,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Request } from 'express';
import { resolveClientNetworkContext } from '@aquaculture/backend-common/http';
import type { TenantRequest } from '@aquaculture/backend-common/types';
import {
  IMPERSONATION_AUTHORIZATION_HTTP_METHODS,
  IMPERSONATION_AUTHORIZATION_RECEIPT_VERSION,
  IMPERSONATION_CONTEXT_ID_PATTERN,
  IMPERSONATION_MODULES,
  IMPERSONATION_OPERATION_GRANT_MAP,
  impersonationAuthorizationOperationSetDigestV1,
  isImpersonationContextId,
  isImpersonationCredential,
  type ImpersonationAuthorizationHttpMethod,
  type ImpersonationOperationAuthority,
} from '@aquaculture/shared-contracts';
import { getAuthUser } from '../../shared/authenticated-request';
import { PlatformAdminGuard } from '../../guards/platform-admin.guard';

import { ThrottleSensitive } from '@aquaculture/backend-common/security';
import {
  ImpersonationStatus,
  ImpersonationReason,
  ImpersonationPermissions,
  IMPERSONATION_MAX_SESSION_MINUTES,
} from '../entities/impersonation-session.entity';
import {
  ImpersonationService,
  type AuthorizeImpersonationOperationsRequest,
  type AuthorizeImpersonationRequest,
  type StartImpersonationRequest,
} from '../services/impersonation.service';
import type { IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import {
  AdminResponseContract,
  AdminRouteLifecycle,
} from '../../shared/admin-response-contract.decorator';
import { ADMIN_CONTROL_CHARACTER_FREE_PATTERN } from '../../shared/admin-text-boundary';
import {
  impersonationImpersonationPermissionPageContract,
  type ImpersonationImpersonationPermissionDto,
  impersonationGetStatsResponseContract,
  type ImpersonationGetStatsResponseDto,
  impersonationImpersonationPermissionContract,
  impersonationGetPermissionResponseContract,
  type ImpersonationGetPermissionResponseDto,
  voidResponseContract,
  type VoidResponseDto,
  impersonationCheckPermissionResponseContract,
  type ImpersonationCheckPermissionResponseDto,
  impersonationStartImpersonationResponseContract,
  type ImpersonationStartImpersonationResponseDto,
  impersonationImpersonationSessionContract,
  type ImpersonationImpersonationSessionDto,
  impersonationAuthorizationContextResponseContract,
  type ImpersonationAuthorizationContextResponseDto,
  impersonationAuthorizationReceiptResponseContract,
  type ImpersonationAuthorizationReceiptResponseDto,
  impersonationImpersonationSessionArrayContract,
  impersonationGetActiveSessionCountResponseContract,
  type ImpersonationGetActiveSessionCountResponseDto,
  impersonationQuerySessionsPageContract,
  impersonationImpersonationAuditSummaryContract,
  type ImpersonationImpersonationAuditSummaryDto,
} from '../contracts/admin-http-response.contract';

// ============================================================================
// DTOs with Validation
// ============================================================================

class GrantPermissionDto {
  @IsUUID('4', { message: 'Invalid super admin ID format' })
  superAdminId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  superAdminEmail?: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  allowedTenants?: string[];

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  restrictedTenants?: string[];

  @IsOptional()
  @IsObject()
  defaultPermissions?: ImpersonationPermissions;

  @IsOptional()
  @IsInt()
  @Min(1)
  // RBAC-MEDIUM-009 (M7): grants previously accepted up to 1440 min (24 h),
  // violating the 1-hour impersonation policy the SSoT constant owns.
  @Max(IMPERSONATION_MAX_SESSION_MINUTES)
  maxSessionDurationMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  maxConcurrentSessions?: number;

  @IsOptional()
  @IsBoolean()
  requireReason?: boolean;

  @IsOptional()
  @IsBoolean()
  requireTicketReference?: boolean;

  @IsOptional()
  @IsBoolean()
  notifyTenantAdmin?: boolean;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

class StartImpersonationDto {
  @IsUUID('4', { message: 'Invalid target tenant ID format' })
  targetTenantId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  targetTenantName?: string;

  @IsOptional()
  @IsUUID('4')
  targetUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  targetUserEmail?: string;

  @IsEnum(ImpersonationReason, { message: 'Invalid impersonation reason' })
  reason!: ImpersonationReason;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reasonDetails?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  ticketReference?: string;

  @IsOptional()
  @IsObject()
  permissions?: Partial<ImpersonationPermissions>;

  @IsOptional()
  @IsInt()
  @Min(1)
  // RBAC-MEDIUM-009 (M7): requests previously accepted up to 480 min (8 h).
  @Max(IMPERSONATION_MAX_SESSION_MINUTES)
  durationMinutes?: number;
}

class EndImpersonationDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

class TerminateSessionDto {
  @IsString()
  @MaxLength(500)
  reason!: string;
}

class ExtendSessionDto {
  @IsInt()
  @Min(5, { message: 'Minimum extension is 5 minutes' })
  // RBAC-MEDIUM-009 (M7): an extension can never exceed the absolute session
  // ceiling (the service additionally bounds TOTAL duration to the cap).
  @Max(IMPERSONATION_MAX_SESSION_MINUTES, {
    message: `Maximum extension is ${IMPERSONATION_MAX_SESSION_MINUTES} minutes`,
  })
  additionalMinutes!: number;
}

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const AUTHORIZATION_PATH_PATTERN = /^\/(?:[\x21-\x7e]*)$/;
const IMPERSONATION_OPERATION_AUTHORITIES = Object.freeze(
  Object.keys(IMPERSONATION_OPERATION_GRANT_MAP),
);

class AuthorizationCoordinateDto {
  @IsString()
  @IsIn([IMPERSONATION_AUTHORIZATION_RECEIPT_VERSION])
  schemaVersion!: typeof IMPERSONATION_AUTHORIZATION_RECEIPT_VERSION;

  @IsUUID('4')
  @Matches(IMPERSONATION_CONTEXT_ID_PATTERN)
  authorizationReceiptId!: string;

  @IsUUID('4')
  @Matches(IMPERSONATION_CONTEXT_ID_PATTERN)
  sessionId!: string;

  @IsUUID('4')
  @Matches(IMPERSONATION_CONTEXT_ID_PATTERN)
  effectiveTenantId!: string;

  @IsString()
  @IsIn(IMPERSONATION_AUTHORIZATION_HTTP_METHODS)
  method!: ImpersonationAuthorizationHttpMethod;

  @IsString()
  @MaxLength(2_048)
  @Matches(AUTHORIZATION_PATH_PATTERN)
  normalizedPath!: string;

  @IsString()
  @Matches(SHA256_HEX_PATTERN)
  normalizedQueryHash!: string;

  @IsString()
  @Matches(SHA256_HEX_PATTERN)
  bodyHash!: string;

  @IsString()
  @Matches(SHA256_HEX_PATTERN)
  requestDigest!: string;
}

class AuthorizationOperationDto {
  @IsString()
  @IsIn(IMPERSONATION_OPERATION_AUTHORITIES)
  authority!: ImpersonationOperationAuthority;

  @IsString()
  @IsIn(IMPERSONATION_MODULES)
  module!: (typeof IMPERSONATION_MODULES)[number];

  @IsString()
  @MaxLength(2_048)
  @Matches(ADMIN_CONTROL_CHARACTER_FREE_PATTERN)
  operation!: string;
}

class AuthorizationOperationsDto extends AuthorizationCoordinateDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AuthorizationOperationDto)
  operations!: AuthorizationOperationDto[];

  @IsString()
  @Matches(SHA256_HEX_PATTERN)
  operationSetDigest!: string;
}

class QueryPermissionsDto {
  @IsOptional()
  @IsUUID('4')
  tenantId?: string;

  @IsOptional()
  @IsString()
  @IsIn(['true', 'false'])
  isActive?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

class AuditSummaryQueryDto {
  @IsOptional()
  @IsDateString({ strict: true })
  startDate?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  endDate?: string;
}

class CanonicalUuidPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!isImpersonationContextId(value)) {
      throw new BadRequestException('UUID path parameter must use canonical lower-case text');
    }
    return value;
  }
}

const UUID_V4_PIPE = new ParseUUIDPipe({ version: '4' });
const CANONICAL_UUID_PIPE = new CanonicalUuidPipe();

function parseCanonicalAuditTimestamp(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new BadRequestException('Audit timestamps must use canonical UTC ISO-8601 text');
  }
  return parsed;
}

function authorizationRequestFromGateway(
  dto: AuthorizationCoordinateDto,
  credential: string | undefined,
  req: TenantRequest,
): AuthorizeImpersonationRequest {
  if (!isImpersonationCredential(credential)) {
    throw new BadRequestException('A canonical impersonation credential is required');
  }
  const identity = req.verifiedIdentity;
  if (
    identity?.serviceName !== 'gateway-api' ||
    identity.audience !== 'admin-api-service' ||
    identity.tenantId !== dto.effectiveTenantId ||
    identity.effectiveTenantId !== dto.effectiveTenantId
  ) {
    throw new ForbiddenException(
      'Impersonation authorization is restricted to the signed gateway authority',
    );
  }
  const user = getAuthUser(req);
  if (!user?.id || !isImpersonationContextId(user.id)) {
    throw new UnauthorizedException('A canonical authenticated actor is required');
  }
  if (user.mfaVerified !== true) {
    throw new ForbiddenException('MFA verification is required for impersonation');
  }
  const assertion = req.verifiedUserAssertion;
  const actorHomeTenantId = user.tenantId ?? null;
  if (
    assertion?.issuer !== 'gateway-api' ||
    assertion.subject !== user.id ||
    assertion.tenantId !== actorHomeTenantId ||
    assertion.effectiveTenantId !== actorHomeTenantId ||
    assertion.mfaVerified !== true
  ) {
    throw new ForbiddenException('Signed gateway actor context does not match authorization');
  }
  const network = resolveClientNetworkContext(req);
  if (network.source !== 'gateway-assertion' || !network.ip || !network.userAgent) {
    throw new BadRequestException(
      'Canonical client IP and user agent are required for impersonation authorization',
    );
  }
  return {
    schemaVersion: dto.schemaVersion,
    authorizationReceiptId: dto.authorizationReceiptId,
    sessionId: dto.sessionId,
    actorId: user.id,
    mfaVerified: true,
    effectiveTenantId: dto.effectiveTenantId,
    method: dto.method,
    normalizedPath: dto.normalizedPath,
    normalizedQueryHash: dto.normalizedQueryHash,
    bodyHash: dto.bodyHash,
    clientIp: network.ip,
    clientUserAgent: network.userAgent,
    credential,
    requestDigest: dto.requestDigest,
  };
}

class QuerySessionsDto {
  @IsOptional()
  @IsUUID('4')
  superAdminId?: string;

  @IsOptional()
  @IsUUID('4')
  targetTenantId?: string;

  @IsOptional()
  @IsEnum(ImpersonationStatus)
  status?: ImpersonationStatus;

  @IsOptional()
  @IsEnum(ImpersonationReason)
  reason?: ImpersonationReason;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  startDate?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  endDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

// ============================================================================
// Controller
// ============================================================================

@ApiTags('Impersonation')
@Controller('impersonation')
@UseGuards(PlatformAdminGuard)
export class ImpersonationController {
  constructor(private readonly impersonationService: ImpersonationService) {}

  // ============================================================================
  // Permission Management
  // ============================================================================

  @AdminResponseContract(impersonationImpersonationPermissionPageContract)
  @Get('permissions')
  async queryPermissions(
    @Query() query: QueryPermissionsDto,
  ): Promise<IStandardPaginatedResult<ImpersonationImpersonationPermissionDto>> {
    return this.impersonationService.queryPermissions({
      tenantId: query.tenantId,
      isActive: query.isActive !== undefined ? query.isActive === 'true' : undefined,
      page: query.page,
      limit: query.limit,
    });
  }

  @AdminResponseContract(impersonationGetStatsResponseContract)
  @Get('stats')
  async getStats(): Promise<ImpersonationGetStatsResponseDto> {
    return this.impersonationService.getImpersonationStats();
  }

  @AdminResponseContract(impersonationImpersonationPermissionContract)
  @ThrottleSensitive()
  @Post('permissions')
  async grantPermission(
    @Body() dto: GrantPermissionDto,
    @Req() req: Request,
  ): Promise<ImpersonationImpersonationPermissionDto> {
    // SECURITY FIX: Get admin ID from verified JWT token, not client-supplied headers
    const user = getAuthUser(req);
    if (!user?.id) {
      throw new UnauthorizedException('User not authenticated');
    }
    return this.impersonationService.grantImpersonationPermission({
      ...dto,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
      grantedBy: user.id,
    });
  }

  @AdminResponseContract(impersonationGetPermissionResponseContract)
  @Get('permissions/:superAdminId')
  async getPermission(
    @Param('superAdminId', UUID_V4_PIPE, CANONICAL_UUID_PIPE) superAdminId: string,
  ): Promise<ImpersonationGetPermissionResponseDto> {
    return this.impersonationService.getImpersonationPermission(superAdminId);
  }

  @AdminResponseContract(voidResponseContract)
  @ThrottleSensitive()
  @Post('permissions/:superAdminId/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokePermission(
    @Param('superAdminId', UUID_V4_PIPE, CANONICAL_UUID_PIPE) superAdminId: string,
    @Req() req: Request,
  ): Promise<void> {
    const user = getAuthUser(req);
    if (!user?.id) {
      throw new UnauthorizedException('User not authenticated');
    }
    await this.impersonationService.revokeImpersonationPermission(superAdminId, user.id);
  }

  @AdminResponseContract(impersonationCheckPermissionResponseContract)
  @Get('permissions/:superAdminId/check/:tenantId')
  async checkPermission(
    @Param('superAdminId', UUID_V4_PIPE, CANONICAL_UUID_PIPE) superAdminId: string,
    @Param('tenantId', UUID_V4_PIPE, CANONICAL_UUID_PIPE) tenantId: string,
  ): Promise<ImpersonationCheckPermissionResponseDto> {
    return this.impersonationService.canImpersonate(superAdminId, tenantId);
  }

  // ============================================================================
  // Session Management
  // ============================================================================

  // Fix: H8 -- per-route throttle: impersonation start is sensitive (3 req / 5 min)
  @AdminResponseContract(impersonationStartImpersonationResponseContract)
  @ThrottleSensitive()
  @Post('sessions/start')
  async startImpersonation(
    @Body() dto: StartImpersonationDto,
    @Req() req: Request,
  ): Promise<ImpersonationStartImpersonationResponseDto> {
    // SECURITY FIX: Get admin identity from verified JWT token, not client-supplied headers
    const user = getAuthUser(req);
    // H-08: email PII removed from JWT — only id (sub) is guaranteed present.
    // superAdminEmail is optional in StartImpersonationRequest post H-08.
    if (!user?.id) {
      throw new UnauthorizedException('User not authenticated');
    }
    if (user.mfaVerified !== true) {
      throw new ForbiddenException('MFA verification is required for impersonation');
    }
    const network = resolveClientNetworkContext(req);
    if (!network.ip || !network.userAgent) {
      throw new BadRequestException(
        'Canonical client IP and user agent are required for impersonation',
      );
    }
    const request: StartImpersonationRequest = {
      ...dto,
      superAdminId: user.id,
      superAdminEmail: user.email, // undefined when H-08 JWT in use — accepted by interface
      ipAddress: network.ip,
      userAgent: network.userAgent,
      mfaVerified: true,
    };

    return this.impersonationService.startImpersonation(request);
  }

  // Fix: H8 -- per-route throttle: impersonation end is sensitive (3 req / 5 min)
  @AdminResponseContract(impersonationImpersonationSessionContract)
  @ThrottleSensitive()
  @Post('sessions/:id/end')
  async endImpersonation(
    @Param('id', UUID_V4_PIPE, CANONICAL_UUID_PIPE) sessionId: string,
    @Body() dto: EndImpersonationDto,
    @Req() req: Request,
  ): Promise<ImpersonationImpersonationSessionDto> {
    // SECURITY FIX: Get admin ID from verified JWT token, not client-supplied headers
    const user = getAuthUser(req);
    if (!user?.id) {
      throw new UnauthorizedException('User not authenticated');
    }
    return this.impersonationService.endImpersonation(sessionId, dto.reason, user.id);
  }

  // Fix: H8 -- per-route throttle: session terminate is sensitive (3 req / 5 min)
  @AdminResponseContract(impersonationImpersonationSessionContract)
  @ThrottleSensitive()
  @Post('sessions/:id/terminate')
  async terminateSession(
    @Param('id', UUID_V4_PIPE, CANONICAL_UUID_PIPE) sessionId: string,
    @Body() dto: TerminateSessionDto,
    @Req() req: Request,
  ): Promise<ImpersonationImpersonationSessionDto> {
    // SECURITY FIX: Get admin ID from verified JWT token, not client-supplied headers
    const user = getAuthUser(req);
    if (!user?.id) {
      throw new UnauthorizedException('User not authenticated');
    }
    return this.impersonationService.terminateSession(sessionId, user.id, dto.reason);
  }

  // Fix: H21 -- extend session endpoint
  @AdminResponseContract(impersonationImpersonationSessionContract)
  @ThrottleSensitive()
  @Post('sessions/:id/extend')
  async extendSession(
    @Param('id', UUID_V4_PIPE, CANONICAL_UUID_PIPE) sessionId: string,
    @Body() dto: ExtendSessionDto,
    @Req() req: Request,
  ): Promise<ImpersonationImpersonationSessionDto> {
    const user = getAuthUser(req);
    if (!user?.id) {
      throw new UnauthorizedException('User not authenticated');
    }
    return this.impersonationService.extendSession(sessionId, dto.additionalMinutes, user.id);
  }

  /** Read-only context resolution. Exact operation authorization happens later. */
  @AdminRouteLifecycle('INTERNAL_GATEWAY_ONLY')
  @AdminResponseContract(impersonationAuthorizationContextResponseContract)
  @Post('sessions/authorization-context')
  @HttpCode(HttpStatus.OK)
  async resolveAuthorizationContext(
    @Headers('x-impersonation-token') token: string,
    @Body() dto: AuthorizationCoordinateDto,
    @Req() req: TenantRequest,
  ): Promise<ImpersonationAuthorizationContextResponseDto> {
    const context = await this.impersonationService.resolveAuthorizationContext(
      authorizationRequestFromGateway(dto, token, req),
    );
    if (!context) throw new ForbiddenException('Impersonation authorization was denied');
    return { context };
  }

  /** Commit one idempotent decision for the exact outward operation set. */
  @AdminRouteLifecycle('INTERNAL_GATEWAY_ONLY')
  @AdminResponseContract(impersonationAuthorizationReceiptResponseContract)
  @Post('sessions/authorization-receipts')
  @HttpCode(HttpStatus.OK)
  async authorizeOperations(
    @Headers('x-impersonation-token') token: string,
    @Body() dto: AuthorizationOperationsDto,
    @Req() req: TenantRequest,
  ): Promise<ImpersonationAuthorizationReceiptResponseDto> {
    let operationSetDigest: string;
    try {
      operationSetDigest = impersonationAuthorizationOperationSetDigestV1(dto.operations);
    } catch {
      throw new BadRequestException('Impersonation operation set is not canonical');
    }
    if (dto.operationSetDigest !== operationSetDigest) {
      throw new BadRequestException('Impersonation operation-set digest does not match');
    }
    const request: AuthorizeImpersonationOperationsRequest = {
      ...authorizationRequestFromGateway(dto, token, req),
      operations: dto.operations,
      operationSetDigest,
    };
    const receipt = await this.impersonationService.authorizeOperations(request);
    if (!receipt) throw new ForbiddenException('Impersonation authorization was denied');
    return receipt;
  }

  @AdminResponseContract(impersonationImpersonationSessionArrayContract)
  @Get('sessions/active')
  async getActiveSessions(): Promise<ImpersonationImpersonationSessionDto[]> {
    return this.impersonationService.getActiveSessions();
  }

  @AdminResponseContract(impersonationGetActiveSessionCountResponseContract)
  @Get('sessions/active/count')
  async getActiveSessionCount(): Promise<ImpersonationGetActiveSessionCountResponseDto> {
    return { count: await this.impersonationService.getActiveSessionCount() };
  }

  @AdminResponseContract(impersonationImpersonationSessionContract)
  @Get('sessions/:id')
  async getSession(
    @Param('id', UUID_V4_PIPE, CANONICAL_UUID_PIPE) id: string,
  ): Promise<ImpersonationImpersonationSessionDto> {
    return this.impersonationService.getSession(id);
  }

  @AdminResponseContract(impersonationQuerySessionsPageContract)
  @Get('sessions')
  async querySessions(
    @Query() query: QuerySessionsDto,
  ): Promise<IStandardPaginatedResult<ImpersonationImpersonationSessionDto>> {
    const startDate = parseCanonicalAuditTimestamp(query.startDate);
    const endDate = parseCanonicalAuditTimestamp(query.endDate);
    if (startDate && endDate && startDate > endDate) {
      throw new BadRequestException('Session query startDate must be before or equal to endDate');
    }
    return this.impersonationService.querySessions({
      superAdminId: query.superAdminId,
      targetTenantId: query.targetTenantId,
      status: query.status,
      reason: query.reason,
      search: query.search,
      startDate,
      endDate,
      page: query.page,
      limit: query.limit,
    });
  }

  // ============================================================================
  // Audit & Reports
  // ============================================================================

  @AdminResponseContract(impersonationImpersonationAuditSummaryContract)
  @Get('audit/summary')
  async getAuditSummary(
    @Query() query: AuditSummaryQueryDto,
  ): Promise<ImpersonationImpersonationAuditSummaryDto> {
    const startDate = parseCanonicalAuditTimestamp(query.startDate);
    const endDate = parseCanonicalAuditTimestamp(query.endDate);
    if (startDate && endDate && startDate > endDate) {
      throw new BadRequestException('Audit startDate must be before or equal to endDate');
    }
    return this.impersonationService.getAuditSummary(startDate, endDate);
  }
}
