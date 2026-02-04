import { UseGuards } from '@nestjs/common';
import { Resolver, Query, Mutation, Args, ID, Float, ObjectType, Field } from '@nestjs/graphql';
import { Roles, Role, TenantGuard, Tenant } from '@platform/backend-common';
import { GraphQLJSON } from 'graphql-scalars';

import { VFD_BRAND_COMMANDS } from '../brand-configs';
import { VfdCommandDto, VfdCommandResultDto } from '../dto/vfd-command.dto';
import { VfdRegisterMapping } from '../entities/vfd-register-mapping.entity';
import { VfdBrand, VfdProtocol, VfdParameterCategory, VfdCommandType } from '../entities/vfd.enums';
import { VfdCommandService } from '../services/vfd-command.service';
import { VfdConnectionTesterService } from '../services/vfd-connection-tester.service';
import { VfdRegisterMappingService } from '../services/vfd-register-mapping.service';

// GraphQL Response Types for Code-First
@ObjectType()
class VfdValidationResult {
  @Field()
  valid!: boolean;

  @Field(() => [String], { nullable: true })
  errors?: string[];
}

/**
 * VFD Command and Configuration GraphQL Resolver
 */
@Resolver()
@UseGuards(TenantGuard)
export class VfdCommandResolver {
  constructor(
    private readonly commandService: VfdCommandService,
    private readonly connectionTesterService: VfdConnectionTesterService,
    private readonly registerMappingService: VfdRegisterMappingService
  ) {}

  // ============ COMMAND MUTATIONS ============
  // SECURITY: All VFD commands require TENANT_ADMIN or MODULE_MANAGER role
  // These are critical industrial equipment controls that can damage hardware

  /**
   * Send a command to a VFD device
   * SECURITY: Requires elevated permissions for industrial equipment control
   */
  @Mutation(() => VfdCommandResultDto, { name: 'sendVfdCommand' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async sendCommand(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Args('command') command: VfdCommandDto,
    @Tenant() tenantId: string
  ): Promise<VfdCommandResultDto> {
    return this.commandService.executeCommand(vfdDeviceId, tenantId, command);
  }

  /**
   * Start VFD (shorthand)
   * SECURITY: Requires elevated permissions - can start industrial motors
   */
  @Mutation(() => VfdCommandResultDto, { name: 'startVfd' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async startVfd(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Tenant() tenantId: string
  ): Promise<VfdCommandResultDto> {
    return this.commandService.executeCommand(vfdDeviceId, tenantId, {
      command: VfdCommandType.START,
    });
  }

  /**
   * Stop VFD (shorthand)
   * SECURITY: Requires elevated permissions - can stop industrial motors
   */
  @Mutation(() => VfdCommandResultDto, { name: 'stopVfd' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async stopVfd(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Tenant() tenantId: string
  ): Promise<VfdCommandResultDto> {
    return this.commandService.executeCommand(vfdDeviceId, tenantId, {
      command: VfdCommandType.STOP,
    });
  }

  /**
   * Set VFD frequency (shorthand)
   * SECURITY: Requires elevated permissions - controls motor speed
   */
  @Mutation(() => VfdCommandResultDto, { name: 'setVfdFrequency' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async setFrequency(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Args('frequencyHz', { type: () => Float }) frequencyHz: number,
    @Tenant() tenantId: string
  ): Promise<VfdCommandResultDto> {
    return this.commandService.executeCommand(vfdDeviceId, tenantId, {
      command: VfdCommandType.SET_FREQUENCY,
      value: frequencyHz,
    });
  }

  /**
   * Set VFD speed percentage (shorthand)
   * SECURITY: Requires elevated permissions - controls motor speed
   */
  @Mutation(() => VfdCommandResultDto, { name: 'setVfdSpeed' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async setSpeed(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Args('speedPercent', { type: () => Float }) speedPercent: number,
    @Tenant() tenantId: string
  ): Promise<VfdCommandResultDto> {
    return this.commandService.executeCommand(vfdDeviceId, tenantId, {
      command: VfdCommandType.SET_SPEED,
      value: speedPercent,
    });
  }

  /**
   * Reset VFD fault (shorthand)
   * SECURITY: Requires elevated permissions - clears equipment fault states
   */
  @Mutation(() => VfdCommandResultDto, { name: 'resetVfdFault' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async resetFault(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Tenant() tenantId: string
  ): Promise<VfdCommandResultDto> {
    return this.commandService.executeCommand(vfdDeviceId, tenantId, {
      command: VfdCommandType.FAULT_RESET,
    });
  }

  /**
   * Emergency stop VFD (shorthand)
   * SECURITY: Emergency stop is allowed for ALL authenticated users for safety
   * Any user should be able to perform an emergency stop
   */
  @Mutation(() => VfdCommandResultDto, { name: 'emergencyStopVfd' })
  async emergencyStop(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Tenant() tenantId: string
  ): Promise<VfdCommandResultDto> {
    return this.commandService.executeCommand(vfdDeviceId, tenantId, {
      command: VfdCommandType.EMERGENCY_STOP,
    });
  }

  // ============ CONFIGURATION QUERIES ============

  /**
   * Get all supported VFD brands
   */
  @Query(() => GraphQLJSON, { name: 'vfdBrands', nullable: true })
  async getVfdBrands(): Promise<unknown> {
    return this.registerMappingService.getBrandsSummary();
  }

  /**
   * Get supported protocols for a brand
   */
  @Query(() => GraphQLJSON, { name: 'vfdProtocols', nullable: true })
  async getVfdProtocols(): Promise<unknown> {
    return this.connectionTesterService.getSupportedProtocols();
  }

  /**
   * Get protocol configuration schema
   */
  @Query(() => GraphQLJSON, { name: 'vfdProtocolSchema', nullable: true })
  async getProtocolSchema(
    @Args('protocol', { type: () => VfdProtocol }) protocol: VfdProtocol
  ): Promise<unknown> {
    return this.connectionTesterService.getProtocolSchema(protocol);
  }

  /**
   * Get default configuration for a protocol
   */
  @Query(() => GraphQLJSON, { name: 'vfdProtocolDefaultConfig', nullable: true })
  async getProtocolDefaultConfig(
    @Args('protocol', { type: () => VfdProtocol }) protocol: VfdProtocol
  ): Promise<unknown> {
    return this.connectionTesterService.getDefaultConfiguration(protocol);
  }

  /**
   * Get register mappings for a brand
   */
  @Query(() => [VfdRegisterMapping], { name: 'vfdRegisterMappings' })
  async getRegisterMappings(
    @Args('brand', { type: () => VfdBrand }) brand: VfdBrand,
    @Args('modelSeries') modelSeries: string
  ): Promise<VfdRegisterMapping[]> {
    return this.registerMappingService.getMappingsForBrand(brand, modelSeries);
  }

  /**
   * Get register mappings by category
   */
  @Query(() => [VfdRegisterMapping], { name: 'vfdRegisterMappingsByCategory' })
  async getRegisterMappingsByCategory(
    @Args('brand', { type: () => VfdBrand }) brand: VfdBrand,
    @Args('category', { type: () => VfdParameterCategory }) category: VfdParameterCategory
  ): Promise<VfdRegisterMapping[]> {
    return this.registerMappingService.getMappingsByCategory(brand, category);
  }

  /**
   * Get control commands for a brand
   */
  @Query(() => GraphQLJSON, { name: 'vfdBrandCommands', nullable: true })
  async getBrandCommands(
    @Args('brand', { type: () => VfdBrand }) brand: VfdBrand
  ): Promise<Record<string, number>> {
    return VFD_BRAND_COMMANDS[brand] || {};
  }

  /**
   * Validate protocol configuration
   */
  @Query(() => VfdValidationResult, { name: 'validateVfdConfig' })
  async validateConfig(
    @Args('protocol', { type: () => VfdProtocol }) protocol: VfdProtocol,
    @Args('configuration', { type: () => GraphQLJSON }) configuration: Record<string, unknown>
  ): Promise<VfdValidationResult> {
    return this.connectionTesterService.validateConfiguration(protocol, configuration);
  }
}
