/**
 * DepartmentResponse serves the department's manager as the row stores it.
 *
 * WHY: the department resolvers return the Department entity itself, so a
 * response field carries data only when its name is an entity column. The
 * former `departmentManager` field matched no column and was always null, and
 * the web (facility-structure page) read it and reported every department as
 * having no responsible person. These checks build the code-first schema the
 * way the subgraph emitter does and tie the served manager fields to the
 * entity's columns, so a rename on either side fails here.
 */
import { NestFactory } from '@nestjs/core';
import { GraphQLSchemaBuilderModule, GraphQLSchemaFactory, Query, Resolver } from '@nestjs/graphql';
import { GraphQLObjectType, getNamedType, type GraphQLFieldMap } from 'graphql';
import { getMetadataArgsStorage } from 'typeorm';

import { DepartmentResponse } from '../dto/department.response';
import { Department } from '../entities/department.entity';

@Resolver()
class DepartmentResponseProbeResolver {
  @Query(() => DepartmentResponse, { nullable: true })
  departmentResponseProbe(): DepartmentResponse | null {
    return null;
  }
}

const MANAGER_FIELDS = ['managerUserId', 'managerName'] as const;

describe('DepartmentResponse — department manager fields', () => {
  let fields: GraphQLFieldMap<unknown, unknown>;

  beforeAll(async () => {
    const app = await NestFactory.createApplicationContext(GraphQLSchemaBuilderModule, {
      logger: false,
    });
    const schema = await app
      .get(GraphQLSchemaFactory)
      .create([DepartmentResponseProbeResolver], [], { skipCheck: true, orphanedTypes: [] });
    await app.close();
    const type = schema.getType('DepartmentResponse');
    if (!(type instanceof GraphQLObjectType)) {
      throw new Error('DepartmentResponse is not in the built schema as an object type');
    }
    fields = type.getFields();
  });

  function namedTypeOf(field: string): string {
    const definition = fields[field];
    if (!definition) throw new Error(`DepartmentResponse.${field} is not served`);
    return getNamedType(definition.type).name;
  }

  it('serves the stored manager: managerUserId (ID) and managerName (String)', () => {
    expect(namedTypeOf('managerUserId')).toBe('ID');
    expect(namedTypeOf('managerName')).toBe('String');
  });

  it('no longer serves departmentManager, which no column backs', () => {
    expect(fields).not.toHaveProperty('departmentManager');
  });

  it('names each manager field after a Department entity column', () => {
    const columns = getMetadataArgsStorage()
      .columns.filter((column) => column.target === Department)
      .map((column) => column.propertyName);
    expect(columns).toEqual(expect.arrayContaining([...MANAGER_FIELDS]));
  });
});
