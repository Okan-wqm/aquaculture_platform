import { UseGuards } from '@nestjs/common';
import { Resolver, Query, Mutation, Args, ID, Int, Float, ObjectType, Field } from '@nestjs/graphql';
import { Roles, Role, Tenant, CurrentUser, CurrentUserPayload } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';
import { ThrottleSensitive } from '@aquaculture/backend-common/security';
import { GraphQLJSON } from 'graphql-scalars';

import { VFD_BRAND_COMMANDS } from '../brand-configs';
import { VfdCommandDto, VfdCommandResultDto } from '../dto/vfd-command.dto';
import { VfdCommandAuditLog } from '../entities/vfd-command-audit-log.entity';
import { VfdRegisterMapping } from '../entities/vfd-register-mapping.entity';
import { VfdBrand, VfdProtocol, VfdParameterCategory, VfdCommandType } from '../entities/vfd.enums';
import { VfdCommandService, VfdCommandActor } from '../services/vfd-command.service';

/** Build the audit actor from the authenticated user (DB-SENSOR-HIGH-003). */
function toActor(user: CurrentUserPayload): VfdCommandActor {
  return { userId: user.sub, email: user.email };
}
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
  // ICS safety: rate limiting on all VFD write mutations prevents rapid
  // START/STOP cycling (capacitor stress) and frequency oscillation (motor hunting).
  @Mutation(() => VfdCommandResultDto, { name: 'sendVfdCommand' })
  @ThrottleSensitive() // 3 req / 5 min per user
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async sendCommand(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Args('command') command: VfdCommandDto,
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload
  ): Promise<VfdCommandResultDto> {
    return this.commandService.executeCommand(vfdDeviceId, tenantId, command, toActor(user));
  }

  /**
   * Start VFD (shorthand)
   * SECURITY: Requires elevated permissions - can start industrial motors
   */
  @ThrottleSensitive()
  @Mutation(() => VfdCommandResultDto, { name: 'startVfd' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async startVfd(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload
  ): Promise<VfdCommandResultDto> {
    return this.commandService.executeCommand(vfdDeviceId, tenantId, {
      command: VfdCommandType.START,
    }, toActor(user));
  }

  /**
   * Stop VFD (shorthand)
   * SECURITY: Requires elevated permissions - can stop industrial motors
   */
  @ThrottleSensitive()
  @Mutation(() => VfdCommandResultDto, { name: 'stopVfd' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async stopVfd(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload
  ): Promise<VfdCommandResultDto> {
    return this.commandService.executeCommand(vfdDeviceId, tenantId, {
      command: VfdCommandType.STOP,
    }, toActor(user));
  }

  /**
   * Set VFD frequency (shorthand)
   * SECURITY: Requires elevated permissions - controls motor speed
   */
  @ThrottleSensitive()
  @Mutation(() => VfdCommandResultDto, { name: 'setVfdFrequency' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async setFrequency(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Args('frequencyHz', { type: () => Float }) frequencyHz: number,
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload
  ): Promise<VfdCommandResultDto> {
    return this.commandService.executeCommand(vfdDeviceId, tenantId, {
      command: VfdCommandType.SET_FREQUENCY,
      value: frequencyHz,
    }, toActor(user));
  }

  /**
   * Set VFD speed percentage (shorthand)
   * SECURITY: Requires elevated permissions - controls motor speed
   */
  @ThrottleSensitive()
  @Mutation(() => VfdCommandResultDto, { name: 'setVfdSpeed' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async setSpeed(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Args('speedPercent', { type: () => Float }) speedPercent: number,
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload
  ): Promise<VfdCommandResultDto> {
    return this.commandService.executeCommand(vfdDeviceId, tenantId, {
      command: VfdCommandType.SET_SPEED,
      value: speedPercent,
    }, toActor(user));
  }

  /**
   * Reset VFD fault (shorthand)
   * SECURITY: Requires elevated permissions - clears equipment fault states
   */
  @ThrottleSensitive()
  @Mutation(() => VfdCommandResultDto, { name: 'resetVfdFault' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async resetFault(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload
  ): Promise<VfdCommandResultDto> {
    return this.commandService.executeCommand(vfdDeviceId, tenantId, {
      command: VfdCommandType.FAULT_RESET,
    }, toActor(user));
  }

  /**
   * Emergency stop VFD (shorthand)
   * SECURITY: Emergency stop is allowed for ALL authenticated users for safety
   * Any user should be able to perform an emergency stop
   */
  @ThrottleSensitive()
  @Mutation(() => VfdCommandResultDto, { name: 'emergencyStopVfd' })
  async emergencyStop(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload
  ): Promise<VfdCommandResultDto> {
    return this.commandService.executeCommand(vfdDeviceId, tenantId, {
      command: VfdCommandType.EMERGENCY_STOP,
    }, toActor(user));
  }

  // ============ COMMAND AUDIT QUERY ============

  /**
   * Read the immutable runtime control-command audit trail for a device
   * (DB-SENSOR-HIGH-003) — surfaces who/when/what/result to operators.
   */
  @Query(() => [VfdCommandAuditLog], { name: 'vfdCommandAuditLog' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async getCommandAuditLog(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Tenant() tenantId: string,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number
  ): Promise<VfdCommandAuditLog[]> {
    return this.commandService.getCommandAuditLog(vfdDeviceId, tenantId, limit ?? 100);
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
