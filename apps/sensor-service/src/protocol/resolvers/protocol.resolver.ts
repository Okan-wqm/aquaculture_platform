import {
  Resolver,
  Query,
  Mutation,
  Args,
  ObjectType,
  Field,
  ID,
  InputType,
  registerEnumType,
  Int,
} from '@nestjs/graphql';
import { IsString, IsOptional, IsBoolean, IsNumber, IsObject } from 'class-validator';
import { GraphQLJSON } from 'graphql-scalars';

import { ProtocolCategory } from '../../database/entities/sensor-protocol.entity';
import { ConnectionTesterService } from '../services/connection-tester.service';
import { ProtocolRegistryService, ProtocolInfo, ProtocolSummary } from '../services/protocol-registry.service';
import { ProtocolValidatorService } from '../services/protocol-validator.service';

// GraphQL Object Types

// Register enums
registerEnumType(ProtocolCategory, {
  name: 'ProtocolCategory',
  description: 'Protocol category',
});

@ObjectType()
class ProtocolCapabilitiesType {
  @Field() supportsDiscovery: boolean;
  @Field() supportsBidirectional: boolean;
  @Field() supportsPolling: boolean;
  @Field() supportsSubscription: boolean;
  @Field() supportsAuthentication: boolean;
  @Field() supportsEncryption: boolean;
  @Field(() => [String]) supportedDataTypes: string[];
}

@ObjectType()
class ProtocolInfoType {
  @Field() code: string;
  @Field() displayName: string;
  @Field() description: string;
  @Field(() => ProtocolCategory) category: ProtocolCategory;
  @Field() subcategory: string;
  @Field() connectionType: string;
  @Field(() => ProtocolCapabilitiesType) capabilities: ProtocolCapabilitiesType;
}

@ObjectType()
class ProtocolSummaryType {
  @Field() code: string;
  @Field() name: string;
  @Field(() => ProtocolCategory) category: ProtocolCategory;
  @Field() subcategory: string;
}

@ObjectType()
class ProtocolDetailsType {
  @Field(() => ID) id: string;
  @Field() code: string;
  @Field() name: string;
  @Field(() => ProtocolCategory) category: ProtocolCategory;
  @Field() subcategory: string;
  @Field() connectionType: string;
  @Field() description: string;
  @Field(() => GraphQLJSON) configurationSchema: object;
  @Field(() => GraphQLJSON) defaultConfiguration: object;
  @Field() isActive: boolean;
}

@ObjectType()
class ValidationErrorType {
  @Field() field: string;
  @Field() message: string;
}

@ObjectType()
class ValidationResultType {
  @Field() isValid: boolean;
  @Field(() => [ValidationErrorType]) errors: ValidationErrorType[];
}

@ObjectType()
class SensorReadingDataType {
  @Field() timestamp: Date;
  @Field(() => GraphQLJSON) values: object;
  @Field(() => Int) quality: number;
  @Field() source: string;
}

@ObjectType()
class ConnectionDiagnosticsType {
  @Field(() => Int, { nullable: true }) dnsResolutionMs?: number;
  @Field(() => Int, { nullable: true }) tcpConnectMs?: number;
  @Field(() => Int, { nullable: true }) sslHandshakeMs?: number;
  @Field(() => Int, { nullable: true }) authenticationMs?: number;
  @Field(() => Int, { nullable: true }) firstByteMs?: number;
  @Field(() => Int) totalMs: number;
}

@ObjectType()
class ProtocolConnectionTestResultType {
  @Field() success: boolean;
  @Field() protocolCode: string;
  @Field() testedAt: Date;
  @Field(() => GraphQLJSON) configUsed: object;
  @Field(() => Int, { nullable: true }) latencyMs?: number;
  @Field({ nullable: true }) error?: string;
  @Field(() => SensorReadingDataType, { nullable: true }) sampleData?: SensorReadingDataType;
  @Field(() => ConnectionDiagnosticsType, { nullable: true }) diagnostics?: ConnectionDiagnosticsType;
}

@ObjectType()
class PingTestResultType {
  @Field(() => Int) avgLatencyMs: number;
  @Field(() => Int) minLatencyMs: number;
  @Field(() => Int) maxLatencyMs: number;
  @Field(() => Int) loss: number;
}

@ObjectType()
class CategoryStatsType {
  @Field(() => Int) industrial: number;
  @Field(() => Int) iot: number;
  @Field(() => Int) serial: number;
  @Field(() => Int) wireless: number;
}

// Input Types
@InputType()
class TestConnectionInput {
  @Field()
  @IsString()
  protocolCode: string;

  @Field(() => GraphQLJSON)
  @IsObject()
  config: object;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  timeout?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  fetchSampleData?: boolean;
}

@InputType()
class ValidateConfigInput {
  @Field()
  @IsString()
  protocolCode: string;

  @Field(() => GraphQLJSON)
  @IsObject()
  config: object;
}

@Resolver()
export class ProtocolResolver {
  constructor(
    private protocolRegistry: ProtocolRegistryService,
    private protocolValidator: ProtocolValidatorService,
    private connectionTester: ConnectionTesterService,
  ) {}

  // Queries
  @Query(() => [ProtocolInfoType], { name: 'protocols' })
  getProtocols(
    @Args('category', { type: () => ProtocolCategory, nullable: true }) category?: ProtocolCategory,
  ): ProtocolInfo[] {
    if (category) {
      return this.protocolRegistry.getProtocolsByCategory(category);
    }
    return this.protocolRegistry.getAllProtocols();
  }

  @Query(() => [ProtocolSummaryType], { name: 'protocolSummaries' })
  getProtocolSummaries(): ProtocolSummary[] {
    return this.protocolRegistry.getProtocolSummaries();
  }

  @Query(() => ProtocolDetailsType, { name: 'protocolDetails', nullable: true })
  getProtocolDetails(
    @Args('code') code: string,
  ): ProtocolDetailsType | null {
    // Use in-memory adapter data (always available) instead of database
    return this.protocolRegistry.getProtocolDetailsFromMemory(code) as ProtocolDetailsType | null;
  }

  @Query(() => GraphQLJSON, { name: 'protocolSchema', nullable: true })
  getProtocolSchema(@Args('code') code: string): object | undefined {
    return this.protocolRegistry.getConfigurationSchema(code);
  }

  @Query(() => GraphQLJSON, { name: 'protocolDefaults', nullable: true })
  getProtocolDefaults(@Args('code') code: string): Record<string, unknown> | undefined {
    return this.protocolRegistry.getDefaultConfiguration(code);
  }

  @Query(() => ProtocolCapabilitiesType, { name: 'protocolCapabilities', nullable: true })
  getProtocolCapabilities(@Args('code') code: string): ProtocolCapabilitiesType | undefined {
    return this.protocolRegistry.getCapabilities(code) as ProtocolCapabilitiesType | undefined;
  }

  @Query(() => CategoryStatsType, { name: 'protocolCategoryStats' })
  getCategoryStats(): CategoryStatsType {
    const stats = this.protocolRegistry.getCategoryStats();
    return {
      industrial: stats[ProtocolCategory.INDUSTRIAL],
      iot: stats[ProtocolCategory.IOT],
      serial: stats[ProtocolCategory.SERIAL],
      wireless: stats[ProtocolCategory.WIRELESS],
    };
  }

  @Query(() => [String], { name: 'protocolCodes' })
  getProtocolCodes(): string[] {
    return this.protocolRegistry.getProtocolCodes();
  }

  // Mutations
  @Mutation(() => ValidationResultType, { name: 'validateProtocolConfig' })
  validateConfig(@Args('input') input: ValidateConfigInput): ValidationResultType {
    const result = this.protocolValidator.validate(input.protocolCode, input.config);
    return {
      isValid: result.isValid,
      errors: result.errors.map((e) => ({ field: e.field, message: e.message })),
    };
  }

  @Mutation(() => ProtocolConnectionTestResultType, { name: 'testProtocolConnection' })
  async testConnection(
    @Args('input') input: TestConnectionInput,
  ): Promise<ProtocolConnectionTestResultType> {
    const result = await this.connectionTester.testConnection(
      input.protocolCode,
      input.config as Record<string, unknown>,
      {
        timeout: input.timeout,
        fetchSampleData: input.fetchSampleData,
      },
    );

    return {
      success: result.success,
      protocolCode: result.protocolCode,
      testedAt: result.testedAt,
      configUsed: result.configUsed,
      latencyMs: result.latencyMs,
      error: result.error,
      sampleData: result.sampleData as SensorReadingDataType | undefined,
      diagnostics: result.diagnostics as ConnectionDiagnosticsType | undefined,
    };
  }

  @Mutation(() => PingTestResultType, { name: 'pingProtocol' })
  async pingProtocol(
    @Args('protocolCode') protocolCode: string,
    @Args('config', { type: () => GraphQLJSON }) config: object,
    @Args('count', { type: () => Int, nullable: true }) count?: number,
  ): Promise<PingTestResultType> {
    return this.connectionTester.pingTest(
      protocolCode,
      config as Record<string, unknown>,
      count || 3,
    );
  }

  @Mutation(() => GraphQLJSON, { name: 'applyProtocolDefaults' })
  applyDefaults(
    @Args('protocolCode') protocolCode: string,
    @Args('config', { type: () => GraphQLJSON }) config: object,
  ): Record<string, unknown> {
    return this.protocolValidator.applyDefaults(protocolCode, config as Record<string, unknown>);
  }
}
