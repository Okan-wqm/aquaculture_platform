import {
  AdminHttpContractError,
  decodeAdminAttachmentFilename,
  decodeAdminRequestId,
  encodeAdminAttachmentDisposition,
  isExecutableAdminManualResponseProfile,
  projectAdminResponseToJson,
  type AdminBinaryResponseProfile,
  type AdminAttachmentFilename,
  type AdminHealthResponseProfile,
  type AdminResponseContract,
  type AdminResponseOf,
} from '@platform/admin-http-contracts';
import type { Response } from 'express';

function requireRequestIdHeader(response: Response): string {
  const requestId = decodeAdminRequestId(response.getHeader('X-Request-ID'));
  response.setHeader('X-Request-ID', requestId);
  return requestId;
}

function assertProfileStatus(
  profile: AdminBinaryResponseProfile | AdminHealthResponseProfile,
  status: number,
): void {
  if (!isExecutableAdminManualResponseProfile(profile)) {
    throw new AdminHttpContractError(
      '$.profile',
      'manual response profile lacks builder provenance',
    );
  }
  if (!profile.statusCodes.includes(status)) {
    throw new AdminHttpContractError(
      '$.status',
      `status ${status} is outside the profile [${profile.statusCodes.join(', ')}]`,
    );
  }
}

export function sendAdminHealthResponse<TContract extends AdminResponseContract<unknown, unknown>>(
  response: Response,
  profile: AdminHealthResponseProfile<TContract>,
  status: number,
  body: AdminResponseOf<TContract>,
): void {
  assertProfileStatus(profile, status);
  requireRequestIdHeader(response);
  if (profile.kind !== 'health-response') {
    throw new AdminHttpContractError('$.profile.kind', 'expected a health response profile');
  }
  const projected = projectAdminResponseToJson(profile.body, body);
  response.status(status).json(projected);
}

export function sendAdminBinaryResponse<TProfile extends AdminBinaryResponseProfile>(
  response: Response,
  profile: TProfile,
  output: {
    readonly status: number;
    readonly mediaType: TProfile['mediaTypes'][number];
    readonly filename: AdminAttachmentFilename;
    readonly data: Buffer | string;
  },
): void {
  assertProfileStatus(profile, output.status);
  if (profile.kind !== 'binary-download') {
    throw new AdminHttpContractError('$.profile.kind', 'expected a binary response profile');
  }
  if (!profile.mediaTypes.some((mediaType) => mediaType === output.mediaType)) {
    throw new AdminHttpContractError(
      '$.mediaType',
      `${output.mediaType} is outside the binary response profile`,
    );
  }
  const filename = decodeAdminAttachmentFilename(output.filename);
  const bytes = Buffer.isBuffer(output.data) ? output.data : Buffer.from(output.data, 'utf8');
  if (bytes.byteLength > profile.maxBytes) {
    throw new AdminHttpContractError(
      '$.data',
      `binary response exceeds route budget ${profile.maxBytes} bytes`,
    );
  }
  requireRequestIdHeader(response);

  response.status(output.status);
  response.setHeader('Content-Type', output.mediaType);
  response.setHeader('Content-Disposition', encodeAdminAttachmentDisposition(filename));
  response.setHeader('Content-Length', bytes.byteLength);
  response.end(bytes);
}
