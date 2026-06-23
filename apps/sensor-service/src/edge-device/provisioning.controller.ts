import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  Res,
  HttpStatus,
  Logger,
  HttpException,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';

import {
  DeviceActivationRequest,
  DeviceActivationResponse,
  ActivationErrorResponse,
  ActivationErrorCode,
  SelfRegisterRequest,
  SelfRegisterResponse,
} from './dto/provisioning.dto';
import { ProvisioningService } from './provisioning.service';
import { SimpleRateLimitGuard, RateLimit } from '../guards/rate-limit.guard';
import { Public, SkipTenantGuard } from '@aquaculture/backend-common/decorators';

/**
 * Provisioning Controller
 * Public REST endpoints for device provisioning (no auth required)
 *
 * SECURITY: Rate limiting is applied to prevent brute-force attacks
 * - Install script: 5 requests per minute per IP
 * - Device activation: 3 requests per minute per IP
 *
 * These endpoints are called by:
 * 1. The installer script (GET /install/:deviceCode)
 * 2. The edge agent (POST /api/devices/activate)
 *
 * @SkipTenantGuard bypasses the global TenantGuard since these endpoints
 * are anonymous (no tenant context). Each endpoint has its own validation.
 */
@Controller()
@Public()
@UseGuards(SimpleRateLimitGuard)
@SkipTenantGuard()
export class ProvisioningController {
  private readonly logger = new Logger(ProvisioningController.name);

  constructor(private readonly provisioningService: ProvisioningService) {}

  /**
   * GET /install/:deviceCode?token=<provisioningToken>
   *
   * Returns the installer script for a device.
   * This is called by: curl -sSL "http://host/install/{deviceCode}?token={token}" | sudo sh
   *
   * Returns: Shell script (text/x-shellscript)
   *
   * SECURITY: The provisioning token must be supplied as a query parameter.
   * Knowing the device code alone is insufficient — the token acts as the
   * shared secret that authorises script retrieval.
   * Also limited to 5 requests per minute per IP to prevent brute-force.
   */
  @Get('install/:deviceCode')
  @RateLimit({ limit: 5, windowMs: 60000 })
  async getInstallerScript(
    @Param('deviceCode') deviceCode: string,
    @Query('token') token: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    // Validate device code format to prevent injection
    if (!/^[A-Z]{2,5}-[0-9A-F]{8}$/.test(deviceCode)) {
      res.status(HttpStatus.BAD_REQUEST).contentType('text/plain').send('Invalid device code format');
      return;
    }

    // Require the provisioning token to be present
    if (!token) {
      res.status(HttpStatus.UNAUTHORIZED).contentType('text/plain').send('Provisioning token required');
      return;
    }

    this.logger.log(`Installer script requested for device: ${deviceCode}`);

    try {
      // Check if device is ready for installation
      const readyCheck = await this.provisioningService.isDeviceReadyForActivation(deviceCode);

      if (!readyCheck.ready) {
        this.logger.warn(`Installer script denied for ${deviceCode}: ${readyCheck.reason}`);

        // Return error as shell script that exits with error message
        const errorScript = this.generateErrorScript(
          deviceCode,
          readyCheck.reason || 'Unknown error',
          readyCheck.errorCode,
        );

        res
          .status(HttpStatus.OK) // Return 200 so curl doesn't fail silently
          .contentType('text/x-shellscript')
          .send(errorScript);
        return;
      }

      // Generate installer script — token is validated inside the service
      const script = await this.provisioningService.generateInstallerScript(deviceCode, token);

      this.logger.log(`Installer script generated for device: ${deviceCode}`);

      res
        .status(HttpStatus.OK)
        .contentType('text/x-shellscript')
        .set('Content-Disposition', `attachment; filename="install-${deviceCode}.sh"`)
        .send(script);
    } catch (error) {
      this.logger.error(`Failed to generate installer script for ${deviceCode}:`, error);

      // Return error as shell script
      const errorScript = this.generateErrorScript(
        deviceCode,
        error instanceof Error ? error.message : 'Internal server error',
        ActivationErrorCode.INTERNAL_ERROR,
      );

      res
        .status(HttpStatus.OK)
        .contentType('text/x-shellscript')
        .send(errorScript);
    }
  }

  /**
   * GET /install/:deviceCode/suderra-os?token=<provisioningToken>
   *
   * Returns a Suderra OS JSON manifest. This is consumed by the forced-command
   * provision user, not by curl|bash.
   */
  @Get('install/:deviceCode/suderra-os')
  @RateLimit({ limit: 5, windowMs: 60000 })
  async getSuderraOsInstallManifest(
    @Param('deviceCode') deviceCode: string,
    @Query('token') token: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (!/^[A-Z]{2,5}-[0-9A-F]{8}$/.test(deviceCode)) {
      res.status(HttpStatus.BAD_REQUEST).contentType('application/json').send({ error: 'Invalid device code format' });
      return;
    }

    if (!token) {
      res.status(HttpStatus.UNAUTHORIZED).contentType('application/json').send({ error: 'Provisioning token required' });
      return;
    }

    try {
      const manifest = await this.provisioningService.generateSuderraOsInstallManifest(deviceCode, token);
      res
        .status(HttpStatus.OK)
        .contentType('application/json')
        .set('Content-Disposition', `attachment; filename="install-${deviceCode}-suderra-os.json"`)
        .send(manifest);
    } catch (error) {
      this.logger.error(`Failed to generate Suderra OS manifest for ${deviceCode}:`, error);
      res.status(HttpStatus.BAD_REQUEST).contentType('application/json').send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }

  /**
   * GET /install/:deviceCode/uninstall
   *
   * Returns the uninstall script for a device.
   * This is called by: curl -sSL "http://host/install/{deviceCode}/uninstall" | sudo bash
   *
   * Returns: Shell script (text/x-shellscript)
   *
   * SECURITY: No token required — the uninstall script only performs local cleanup
   * and does not contain any secrets or sensitive data.
   * Rate limited to 5 requests per minute per IP.
   */
  @Get('install/:deviceCode/uninstall')
  @RateLimit({ limit: 5, windowMs: 60000 })
  async getUninstallScript(
    @Param('deviceCode') deviceCode: string,
    @Res() res: Response,
  ): Promise<void> {
    // Validate device code format to prevent injection
    if (!/^[A-Z]{2,5}-[0-9A-F]{8}$/.test(deviceCode)) {
      res.status(HttpStatus.BAD_REQUEST).contentType('text/plain').send('Invalid device code format');
      return;
    }

    this.logger.log(`Uninstall script requested for device: ${deviceCode}`);

    try {
      const script = await this.provisioningService.generateUninstallScript(deviceCode);

      res
        .status(HttpStatus.OK)
        .contentType('text/x-shellscript')
        .set('Content-Disposition', `attachment; filename="uninstall-${deviceCode}.sh"`)
        .send(script);
    } catch (error) {
      this.logger.error(`Failed to generate uninstall script for ${deviceCode}:`, error);

      res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .contentType('text/plain')
        .send('Failed to generate uninstall script');
    }
  }

  /**
   * GET /install/:deviceCode/update
   *
   * Returns the update script for a device.
   * This is called by: curl -sSL "http://host/install/{deviceCode}/update" | sudo bash
   *
   * Returns: Shell script (text/x-shellscript)
   *
   * SECURITY: No token required — the update script only replaces the binary
   * and does not contain any secrets. Config is preserved.
   * Rate limited to 5 requests per minute per IP.
   */
  @Get('install/:deviceCode/update')
  @RateLimit({ limit: 5, windowMs: 60000 })
  async getUpdateScript(
    @Param('deviceCode') deviceCode: string,
    @Res() res: Response,
  ): Promise<void> {
    // Validate device code format to prevent injection
    if (!/^[A-Z]{2,5}-[0-9A-F]{8}$/.test(deviceCode)) {
      res.status(HttpStatus.BAD_REQUEST).contentType('text/plain').send('Invalid device code format');
      return;
    }

    this.logger.log(`Update script requested for device: ${deviceCode}`);

    try {
      const script = await this.provisioningService.generateUpdateScript(deviceCode);

      res
        .status(HttpStatus.OK)
        .contentType('text/x-shellscript')
        .set('Content-Disposition', `attachment; filename="update-${deviceCode}.sh"`)
        .send(script);
    } catch (error) {
      this.logger.error(`Failed to generate update script for ${deviceCode}:`, error);

      res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .contentType('text/plain')
        .send('Failed to generate update script');
    }
  }

  /**
   * POST /api/devices/activate
   *
   * Public endpoint for device activation (v1.1 - no version prefix).
   * Called by the edge agent after installation.
   *
   * Request: DeviceActivationRequest
   * Response: DeviceActivationResponse | ActivationErrorResponse
   *
   * SECURITY: Limited to 10 requests per minute per IP to prevent brute-force
   * while allowing legitimate edge agent retries with exponential backoff.
   */
  @Post('api/devices/activate')
  @RateLimit({ limit: 10, windowMs: 60000 })
  async activateDevice(
    @Body() request: DeviceActivationRequest,
  ): Promise<DeviceActivationResponse | ActivationErrorResponse> {
    this.logger.log(`Activation request received for device: ${request.deviceId}`);

    // SECURITY NOTE: Input validation is now handled by class-validator decorators
    // in DeviceActivationRequest DTO. ValidationPipe must be enabled globally.

    try {
      const response = await this.provisioningService.activateDevice(request);
      this.logger.log(`Device ${request.deviceId} activated successfully`);
      return response;
    } catch (error) {
      // Re-throw HTTP exceptions (they already have proper format)
      if (error instanceof HttpException) {
        throw error;
      }

      // Log unexpected errors
      this.logger.error(`Unexpected error during activation:`, error);
      throw new HttpException(
        {
          success: false,
          error: 'Internal server error',
          errorCode: ActivationErrorCode.INTERNAL_ERROR,
        } as ActivationErrorResponse,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/devices/:deviceCode/status
   *
   * Public endpoint to check device provisioning status (v1.1 - no version prefix).
   * Can be used by the installer to verify device state.
   */
  @Get('api/devices/:deviceCode/status')
  @RateLimit({ limit: 3, windowMs: 60000 }) // Tightened from 5 to 3/min to slow enumeration
  async getDeviceStatus(
    @Param('deviceCode') deviceCode: string,
  ): Promise<{
    deviceCode: string;
    ready: boolean;
    status: string;
  }> {
    // LOW-002: Constant-time response to prevent device code enumeration via timing.
    // Valid device codes hit the DB (slow); invalid ones return immediately (fast).
    // An attacker can distinguish valid vs invalid by measuring response time.
    // Fix: enforce a minimum response time for all paths.
    const startTime = Date.now();
    const MIN_RESPONSE_MS = 100; // minimum 100ms for all responses

    // Validate device code format to prevent injection/enumeration
    if (!/^[A-Z]{2,5}-[0-9A-F]{8}$/.test(deviceCode)) {
      const elapsed = Date.now() - startTime;
      if (elapsed < MIN_RESPONSE_MS) {
        await new Promise((r) => setTimeout(r, MIN_RESPONSE_MS - elapsed));
      }
      return {
        deviceCode: '',
        ready: false,
        status: 'NOT_AVAILABLE',
      };
    }

    this.logger.log(`Status check for device: ${deviceCode}`);

    const device = await this.provisioningService.getDeviceByCode(deviceCode);

    if (!device) {
      const elapsed = Date.now() - startTime;
      if (elapsed < MIN_RESPONSE_MS) {
        await new Promise((r) => setTimeout(r, MIN_RESPONSE_MS - elapsed));
      }
      return {
        deviceCode,
        ready: false,
        status: 'NOT_AVAILABLE',
      };
    }

    const readyCheck = await this.provisioningService.isDeviceReadyForActivation(deviceCode);

    const elapsed = Date.now() - startTime;
    if (elapsed < MIN_RESPONSE_MS) {
      await new Promise((r) => setTimeout(r, MIN_RESPONSE_MS - elapsed));
    }

    return {
      deviceCode,
      ready: readyCheck.ready,
      status: readyCheck.ready ? 'READY' : 'NOT_AVAILABLE',
    };
  }

  /**
   * GET /install/t/:tenantToken
   *
   * Public endpoint that returns the tenant-level installer script.
   * This is called by: curl -sSL http://localhost:3000/install/t/{tenantToken} | sudo bash
   *
   * Returns: Shell script (text/x-shellscript)
   *
   * SECURITY: Limited to 5 requests per minute per IP
   */
  @Get('install/t/:tenantToken')
  @RateLimit({ limit: 5, windowMs: 60000 })
  async getTenantInstallerScript(
    @Param('tenantToken') tenantToken: string,
    @Res() res: Response,
  ): Promise<void> {
    // Validate tenant token format (64 char hex string)
    if (!/^[0-9a-f]{64}$/.test(tenantToken)) {
      res.status(HttpStatus.BAD_REQUEST).contentType('text/plain').send('Invalid token format');
      return;
    }

    this.logger.log(`Tenant installer script requested for token: ${tenantToken.substring(0, 8)}...`);

    try {
      const script = await this.provisioningService.generateTenantInstallerScript(tenantToken);

      this.logger.log('Tenant installer script generated successfully');

      res
        .status(HttpStatus.OK)
        .contentType('text/x-shellscript')
        .set('Content-Disposition', 'attachment; filename="install-suderra.sh"')
        .send(script);
    } catch (error) {
      this.logger.error('Failed to generate tenant installer script:', error);

      const errorScript = this.generateErrorScript(
        'TENANT',
        error instanceof Error ? error.message : 'Internal server error',
        ActivationErrorCode.INTERNAL_ERROR,
      );

      res
        .status(HttpStatus.OK)
        .contentType('text/x-shellscript')
        .send(errorScript);
    }
  }

  /**
   * POST /api/devices/self-register
   *
   * Public endpoint for device self-registration (v2.0 - tenant-first).
   * Called by the edge agent when installed via tenant installer link.
   *
   * Request: SelfRegisterRequest
   * Response: SelfRegisterResponse
   *
   * SECURITY: Limited to 3 requests per minute per IP
   */
  @Post('api/devices/self-register')
  @RateLimit({ limit: 3, windowMs: 60000 })
  async selfRegisterDevice(
    @Body() request: SelfRegisterRequest,
  ): Promise<SelfRegisterResponse | ActivationErrorResponse> {
    // Validate tenant token format
    if (!/^[0-9a-f]{64}$/.test(request.tenant_token)) {
      throw new HttpException(
        { success: false, error: 'Invalid token format', errorCode: ActivationErrorCode.INVALID_TOKEN },
        HttpStatus.BAD_REQUEST,
      );
    }

    this.logger.log('Self-register request received');

    try {
      const response = await this.provisioningService.selfRegisterDevice(request);
      this.logger.log(`Device ${response.device_code} self-registered successfully`);
      return response;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      this.logger.error('Unexpected error during self-registration:', error);
      throw new HttpException(
        {
          success: false,
          error: 'Internal server error',
          errorCode: ActivationErrorCode.INTERNAL_ERROR,
        } as ActivationErrorResponse,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Generate error script that outputs error message and exits
   */
  private generateErrorScript(
    deviceCode: string,
    errorMessage: string,
    errorCode?: ActivationErrorCode,
  ): string {
    // Sanitize inputs for shell safety
    const safeDeviceCode = deviceCode.replace(/[^a-zA-Z0-9._-]/g, '');
    const safeErrorMessage = errorMessage.replace(/[^a-zA-Z0-9._\- ]/g, '');

    return `#!/bin/bash
# Suderra Edge Agent Installer - Error

echo ""
echo "========================================"
echo "  Suderra Agent Installation Failed"
echo "========================================"
echo ""
echo "Device Code: ${safeDeviceCode}"
echo "Error: ${safeErrorMessage}"
${errorCode ? `echo "Error Code: ${errorCode}"` : ''}
echo ""
echo "Possible solutions:"
${this.getErrorSolutions(errorCode)}
echo ""
exit 1
`;
  }

  /**
   * Get error-specific solutions for the installer script
   */
  private getErrorSolutions(errorCode?: ActivationErrorCode): string {
    switch (errorCode) {
      case ActivationErrorCode.DEVICE_NOT_FOUND:
        return `echo "  - Verify the device code is correct"
echo "  - Contact your administrator to register this device"`;

      case ActivationErrorCode.TOKEN_EXPIRED:
        return `echo "  - The provisioning token has expired"
echo "  - Contact your administrator to regenerate the token"
echo "  - Then run this installer again with the new URL"`;

      case ActivationErrorCode.TOKEN_ALREADY_USED:
        return `echo "  - This device has already been activated"
echo "  - If this is a re-installation, contact your administrator"
echo "  - to reset the device and regenerate the token"`;

      case ActivationErrorCode.DEVICE_DECOMMISSIONED:
        return `echo "  - This device has been decommissioned"
echo "  - Contact your administrator if you need to re-enable it"`;

      default:
        return `echo "  - Check your network connection"
echo "  - Verify the API server is accessible"
echo "  - Contact your administrator for assistance"`;
    }
  }
}
