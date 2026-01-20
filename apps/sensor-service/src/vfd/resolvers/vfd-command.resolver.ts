import { Resolver, Query, Mutation, Args, ID, Context } from '@nestjs/graphql';
import { VfdCommandService, VfdCommandInput } from '../services/vfd-command.service';
import { VfdConnectionTesterService } from '../services/vfd-connection-tester.service';
import { VfdRegisterMappingService } from '../services/vfd-register-mapping.service';
import { VfdBrand, VfdProtocol, VfdParameterCategory, VfdCommandType } from '../entities/vfd.enums';
import { VfdRegisterMapping } from '../entities/vfd-register-mapping.entity';
import { VFD_BRAND_COMMANDS } from '../brand-configs';

/**
 * VFD Command and Configuration GraphQL Resolver
 */
@Resolver('VfdCommand')
export class VfdCommandResolver {
  constructor(
    private readonly commandService: VfdCommandService,
    private readonly connectionTesterService: VfdConnectionTesterService,
    private readonly registerMappingService: VfdRegisterMappingService
  ) {}

  // ============ COMMAND MUTATIONS ============

  /**
   * Send a command to a VFD device
   */
  @Mutation('sendVfdCommand')
  async sendCommand(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Args('command') command: VfdCommandInput,
    @Context() context: { tenantId: string }
  ) {
    return this.commandService.executeCommand(vfdDeviceId, context.tenantId, command);
  }

  /**
   * Start VFD (shorthand)
   */
  @Mutation('startVfd')
  async startVfd(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Context() context: { tenantId: string }
  ) {
    return this.commandService.executeCommand(vfdDeviceId, context.tenantId, {
      command: VfdCommandType.START,
    });
  }

  /**
   * Stop VFD (shorthand)
   */
  @Mutation('stopVfd')
  async stopVfd(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Context() context: { tenantId: string }
  ) {
    return this.commandService.executeCommand(vfdDeviceId, context.tenantId, {
      command: VfdCommandType.STOP,
    });
  }

  /**
   * Set VFD frequency (shorthand)
   */
  @Mutation('setVfdFrequency')
  async setFrequency(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Args('frequencyHz') frequencyHz: number,
    @Context() context: { tenantId: string }
  ) {
    return this.commandService.executeCommand(vfdDeviceId, context.tenantId, {
      command: VfdCommandType.SET_FREQUENCY,
      value: frequencyHz,
    });
  }

  /**
   * Set VFD speed percentage (shorthand)
   */
  @Mutation('setVfdSpeed')
  async setSpeed(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Args('speedPercent') speedPercent: number,
    @Context() context: { tenantId: string }
  ) {
    return this.commandService.executeCommand(vfdDeviceId, context.tenantId, {
      command: VfdCommandType.SET_SPEED,
      value: speedPercent,
    });
  }

  /**
   * Reset VFD fault (shorthand)
   */
  @Mutation('resetVfdFault')
  async resetFault(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Context() context: { tenantId: string }
  ) {
    return this.commandService.executeCommand(vfdDeviceId, context.tenantId, {
      command: VfdCommandType.FAULT_RESET,
    });
  }

  /**
   * Emergency stop VFD (shorthand)
   */
  @Mutation('emergencyStopVfd')
  async emergencyStop(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Context() context: { tenantId: string }
  ) {
    return this.commandService.executeCommand(vfdDeviceId, context.tenantId, {
      command: VfdCommandType.EMERGENCY_STOP,
    });
  }

  // ============ CONFIGURATION QUERIES ============

  /**
   * Get all supported VFD brands
   */
  @Query('vfdBrands')
  async getVfdBrands() {
    return this.registerMappingService.getBrandsSummary();
  }

  /**
   * Get supported protocols for a brand
   */
  @Query('vfdProtocols')
  async getVfdProtocols() {
    return this.connectionTesterService.getSupportedProtocols();
  }

  /**
   * Get protocol configuration schema
   */
  @Query('vfdProtocolSchema')
  async getProtocolSchema(
    @Args('protocol') protocol: VfdProtocol
  ) {
    return this.connectionTesterService.getProtocolSchema(protocol);
  }

  /**
   * Get default configuration for a protocol
   */
  @Query('vfdProtocolDefaultConfig')
  async getProtocolDefaultConfig(
    @Args('protocol') protocol: VfdProtocol
  ) {
    return this.connectionTesterService.getDefaultConfiguration(protocol);
  }

  /**
   * Get register mappings for a brand
   */
  @Query('vfdRegisterMappings')
  async getRegisterMappings(
    @Args('brand') brand: VfdBrand,
    @Args('modelSeries') modelSeries: string
  ): Promise<VfdRegisterMapping[]> {
    return this.registerMappingService.getMappingsForBrand(brand, modelSeries);
  }

  /**
   * Get register mappings by category
   */
  @Query('vfdRegisterMappingsByCategory')
  async getRegisterMappingsByCategory(
    @Args('brand') brand: VfdBrand,
    @Args('category') category: VfdParameterCategory
  ): Promise<VfdRegisterMapping[]> {
    return this.registerMappingService.getMappingsByCategory(brand, category);
  }

  /**
   * Get control commands for a brand
   */
  @Query('vfdBrandCommands')
  async getBrandCommands(
    @Args('brand') brand: VfdBrand
  ): Promise<Record<string, number>> {
    return VFD_BRAND_COMMANDS[brand] || {};
  }

  /**
   * Validate protocol configuration
   */
  @Query('validateVfdConfig')
  async validateConfig(
    @Args('protocol') protocol: VfdProtocol,
    @Args('configuration') configuration: Record<string, unknown>
  ) {
    return this.connectionTesterService.validateConfiguration(protocol, configuration);
  }
}
