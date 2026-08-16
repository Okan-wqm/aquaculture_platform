import {
  BaseEntity,
  ChildEntity,
  Entity,
  EntitySchema,
  ViewEntity,
} from 'typeorm';

import type {
  EntitySchemaAliasFixture,
  ReexportedEntitySchemaRecordFixture,
} from './persistence-target.fixture';

export interface ExpectedRouteResponse {
  readonly id: string;
}

export declare function validRoute(): ExpectedRouteResponse;

// Deliberately unsafe compiler fixtures. They are consumed as syntax/type
// inputs by the contract-compiler invariant and are never runtime routes.
export declare function anyRoute(): any;

export declare function promiseAnyRoute(): Promise<any>;

export declare function unknownRoute(): unknown;

export declare function genericRoute<T>(): T;

export declare function indexedRoute<T, K extends keyof T>(): T[K];

export declare function unionDriftRoute():
  | ExpectedRouteResponse
  | { readonly id: number };

export interface NestedAnyResponse {
  readonly id: string;
  readonly nested: { readonly value: any };
}

export interface UnknownIndexResponse {
  readonly id: string;
  readonly values: { readonly [key: string]: unknown };
}

export interface UnsafeMethodResponse {
  readonly id: string;
  compute(): any;
}

export declare function nestedAnyRoute(): NestedAnyResponse;
export declare function unknownIndexRoute(): UnknownIndexResponse;
export declare function unsafeMethodRoute(): UnsafeMethodResponse;
export declare function neverRoute(): never;

@Entity()
export class PersistenceEntityFixture {
  readonly id = 'entity';
}

export declare function directEntityRoute(): PersistenceEntityFixture;
export declare function nestedEntityRoute(): { readonly entity: PersistenceEntityFixture };
export declare function arrayEntityRoute(): readonly PersistenceEntityFixture[];
export declare function promiseEntityRoute(): Promise<PersistenceEntityFixture>;

@ViewEntity({ expression: 'SELECT id FROM fixture' })
export class PersistenceViewFixture {
  readonly id = 'view';
}

@ChildEntity('fixture-child')
export class PersistenceChildFixture {
  readonly id = 'child';
}

export class PersistenceBaseEntityFixture extends BaseEntity {
  readonly id = 'base';
}

export const persistenceEntitySchemaFixture = new EntitySchema<ExpectedRouteResponse>({
  name: 'PersistenceSchemaFixture',
  columns: { id: { type: String, primary: true } },
});

export const aliasedPersistenceEntitySchemaFixture =
  new EntitySchema<EntitySchemaAliasFixture>({
    name: 'AliasedPersistenceSchemaFixture',
    columns: { id: { type: String, primary: true } },
  });

export declare function viewEntityRoute(): PersistenceViewFixture;
export declare function childEntityRoute(): PersistenceChildFixture;
export declare function baseEntityRoute(): PersistenceBaseEntityFixture;
export declare function entitySchemaRoute(): EntitySchema<ExpectedRouteResponse>;
export declare function entitySchemaTargetAliasRoute(): EntitySchemaAliasFixture;
export declare function entitySchemaTargetReexportRoute(): ReexportedEntitySchemaRecordFixture;
