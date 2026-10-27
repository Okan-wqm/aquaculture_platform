import { MODULE_ROLES, type ModuleRole, type OwnerModuleCode } from '@aquaculture/shared-contracts';
import { Field, ID, InputType, ObjectType } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import { IsIn, IsOptional, IsUUID, ValidateNested } from 'class-validator';

import {
  MODULE_ROLE_GRAPHQL_ENUM,
  ModuleAccessGrants,
} from '../../authentication/dto/module-access.dto';

/**
 * The admin path of module access (PKG-06; ADR-051 §2 "Change"), added in release R3 (C1: a
 * client reads and sends these from the release after). ModuleAccessInput mirrors the
 * `ModuleAccess` output: one nullable ModuleRole per owner module, mapped over OwnerModuleCode,
 * so a new owner module does not compile until it has its field. A null or absent field means no
 * grant: the input is the member's whole set of module roles (a declarative replace).
 */
type ModuleAccessInputFields = { [Code in OwnerModuleCode]?: ModuleRole | null };

@InputType('ModuleAccessInput')
export class ModuleAccessInput implements ModuleAccessInputFields {
  @Field(() => MODULE_ROLE_GRAPHQL_ENUM, { nullable: true })
  @IsOptional()
  @IsIn(MODULE_ROLES)
  farm?: ModuleRole | null;

  @Field(() => MODULE_ROLE_GRAPHQL_ENUM, { nullable: true })
  @IsOptional()
  @IsIn(MODULE_ROLES)
  hr?: ModuleRole | null;

  @Field(() => MODULE_ROLE_GRAPHQL_ENUM, { nullable: true })
  @IsOptional()
  @IsIn(MODULE_ROLES)
  sensor?: ModuleRole | null;

  @Field(() => MODULE_ROLE_GRAPHQL_ENUM, { nullable: true })
  @IsOptional()
  @IsIn(MODULE_ROLES)
  hydroponics?: ModuleRole | null;
}

@InputType()
export class SetUserModuleAccessInput {
  @Field(() => ID)
  @IsUUID('4')
  userId!: string;

  @Field(() => ModuleAccessInput)
  @ValidateNested()
  @Type(() => ModuleAccessInput)
  moduleAccess!: ModuleAccessInput;
}

/** A member's module roles in the enabled modules, as their next token carries them. */
@ObjectType()
export class UserModuleAccess {
  @Field(() => ID)
  userId!: string;

  @Field(() => ModuleAccessGrants)
  moduleAccess!: ModuleAccessGrants;
}

/** The primary manager of an enabled owner module (the Assign Manager designation). */
@ObjectType()
export class ModulePrimaryManager {
  @Field()
  moduleCode!: string;

  @Field(() => ID)
  userId!: string;
}
