import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Res,
  HttpStatus,
  Logger,
  HttpException,
  BadRequestException,
} from '@nestjs/common';
import { Response } from 'express';

import {
  DeviceActivationRequest,
  DeviceActivationResponse,
  ActivationErrorResponse,
  ActivationErrorCode,
} from './dto/provisioning.dto';
import { ProvisioningService } from './provisioning.service';

/**
 * Provisioning Controller
 * Public REST endpoints for device provisioning (no auth required)
 *
 * These endpoints are called by:
 * 1. The installer script (GET /install/:deviceCode)
 * 2. The edge agent (POST /api/devices/activate)
 */
@Controller()
export class ProvisioningController {
  private readonly logger = new Logger(ProvisioningController.name);

  constructor(private readonly provisioningService: ProvisioningService) {}

  /**
   * GET /install/:deviceCode
   *
   * Public endpoint that returns the installer script for a device.
   * This is called by: curl -sSL http://localhost:3000/install/{deviceCode} | sudo sh
   *
   * Returns: Shell script (text/x-shellscript)
   */
  @Get('install/:deviceCode')
  async getInstallerScript(
    @Param('deviceCode') deviceCode: string,
    @Res() res: Response,
  ): Promise<void> {
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

      // Generate installer script
      const script = await this.provisioningService.generateInstallerScript(deviceCode);

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
   * POST /api/devices/activate
   *
   * Public endpoint for device activation (v1.1 - no version prefix).
   * Called by the edge agent after installation.
   *
   * Request: DeviceActivationRequest
   * Response: DeviceActivationResponse | ActivationErrorResponse
   */
  @Post('api/devices/activate')
  async activateDevice(
    @Body() request: DeviceActivationRequest,
  ): Promise<DeviceActivationResponse | ActivationErrorResponse> {
    this.logger.log(`Activation request received for device: ${request.deviceId}`);

    // Validate request
    if (!request.deviceId || !request.token) {
      throw new BadRequestException({
        success: false,
        error: 'Missing required fields: deviceId and token',
        errorCode: ActivationErrorCode.INVALID_TOKEN,
      } as ActivationErrorResponse);
    }

    if (!request.fingerprint) {
      throw new BadRequestException({
        success: false,
        error: 'Missing required field: fingerprint',
        errorCode: ActivationErrorCode.INVALID_TOKEN,
      } as ActivationErrorResponse);
    }

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
  async getDeviceStatus(
    @Param('deviceCode') deviceCode: string,
  ): Promise<{
    deviceCode: string;
    ready: boolean;
    status: string;
    reason?: string;
  }> {
    this.logger.log(`Status check for device: ${deviceCode}`);

    const device = await this.provisioningService.getDeviceByCode(deviceCode);

    if (!device) {
      return {
        deviceCode,
        ready: false,
        status: 'NOT_FOUND',
        reason: 'Device not found',
      };
    }

    const readyCheck = await this.provisioningService.isDeviceReadyForActivation(deviceCode);

    return {
      deviceCode,
      ready: readyCheck.ready,
      status: device.lifecycleState,
      reason: readyCheck.reason,
    };
  }

  /**
   * Generate error script that outputs error message and exits
   */
  private generateErrorScript(
    deviceCode: string,
    errorMessage: string,
    errorCode?: ActivationErrorCode,
  ): string {
    return `#!/bin/bash
# Suderra Edge Agent Installer - Error

echo ""
echo "========================================"
echo "  Suderra Agent Installation Failed"
echo "========================================"
echo ""
echo "Device Code: ${deviceCode}"
echo "Error: ${errorMessage}"
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
