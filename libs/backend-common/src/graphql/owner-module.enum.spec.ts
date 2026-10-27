/**
 * The GraphQL face of the module dictionary (RBAC-MEDIUM-023, HR-MEDIUM-064).
 *
 * The enums are built here by Nest's own schema factory, the way each subgraph builds them, so what
 * is pinned is the wire: the existing names, the dictionary's owner modules as values (the only
 * change on the wire is the added HR), and one enum reference per name even when both names are
 * registered in one process.
 */
import { OWNER_MODULE, type OwnerModuleCode } from '@aquaculture/shared-contracts';
import {
  Args,
  Field,
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
  ObjectType,
  Query,
  Resolver,
} from '@nestjs/graphql';
import { Test } from '@nestjs/testing';
import { type GraphQLSchema, isEnumType } from 'graphql';

import { OWNER_MODULE_GRAPHQL_ENUM_NAMES, registerOwnerModuleEnum } from './owner-module.enum';

const DEPARTMENT_DESCRIPTION = 'Module a department belongs to; unset means company-wide';
const ALARM_DESCRIPTION = 'The platform module an alarm originates in';

const HR_MODULE_CODE = registerOwnerModuleEnum('HRModuleCode', DEPARTMENT_DESCRIPTION);
const ALERT_MODULE = registerOwnerModuleEnum('AlertModule', ALARM_DESCRIPTION);

@ObjectType()
class OwnerModuleProbe {
  @Field(() => HR_MODULE_CODE, { nullable: true })
  department?: OwnerModuleCode | null;

  @Field(() => ALERT_MODULE, { nullable: true })
  alarm?: OwnerModuleCode | null;
}

@Resolver(() => OwnerModuleProbe)
class OwnerModuleProbeResolver {
  @Query(() => OwnerModuleProbe)
  ownerModuleProbe(
    @Args('module', { type: () => HR_MODULE_CODE, nullable: true }) module?: OwnerModuleCode,
  ): OwnerModuleProbe {
    return { department: module ?? null, alarm: module ?? null };
  }
}

describe('registerOwnerModuleEnum', () => {
  let schema: GraphQLSchema;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [GraphQLSchemaBuilderModule],
    }).compile();
    schema = await moduleRef.get(GraphQLSchemaFactory).create([OwnerModuleProbeResolver]);
  });

  /** The enum's values as [GraphQL name, internal value] pairs. */
  function valuesOf(name: string): Array<[string, unknown]> {
    const type = schema.getType(name);
    if (!isEnumType(type)) throw new Error(`${name} is not an enum in the built schema`);
    return type.getValues().map((value) => [value.name, value.value]);
  }

  it('keeps the two wire names the clients query today; PKG-01 PR2 merges them', () => {
    expect(OWNER_MODULE_GRAPHQL_ENUM_NAMES).toEqual(['HRModuleCode', 'AlertModule']);
    expect(Object.isFrozen(OWNER_MODULE_GRAPHQL_ENUM_NAMES)).toBe(true);
  });

  it.each(['HRModuleCode', 'AlertModule'])(
    '%s carries exactly the owner modules of the dictionary, HR included',
    (name) => {
      expect(valuesOf(name)).toEqual(Object.entries(OWNER_MODULE));
      expect(valuesOf(name).map(([value]) => value)).toContain('HR');
    },
  );

  it('keeps each enum description, so the wire changes by the HR value only', () => {
    expect(schema.getType('HRModuleCode')?.description).toBe(DEPARTMENT_DESCRIPTION);
    expect(schema.getType('AlertModule')?.description).toBe(ALARM_DESCRIPTION);
  });

  it('gives every name its own frozen enum reference with the dictionary values', () => {
    expect(HR_MODULE_CODE).not.toBe(ALERT_MODULE);
    expect(HR_MODULE_CODE).not.toBe(OWNER_MODULE);
    for (const enumRef of [HR_MODULE_CODE, ALERT_MODULE]) {
      expect(enumRef).toEqual(OWNER_MODULE);
      expect(Object.isFrozen(enumRef)).toBe(true);
    }
  });
});
