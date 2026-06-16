// ============================================================================
// AquaMobil Auth Identity Operations — FE-MEDIUM-051
// ============================================================================
// WHY this file exists: the aquamobil client must derive its `Role` vocabulary
// from the backend's canonical GraphQL `Role` enum (SUPER_ADMIN / TENANT_ADMIN /
// MODULE_MANAGER / MODULE_USER) instead of a hand-maintained union that drifted
// to phantom MANAGER/OPERATOR/VIEWER values the server never emits.
//
// WHAT it does: graphql-codegen only emits a schema enum into
// ../generated/graphql.ts when a SCANNED document (codegen.ts globs
// src/graphql/**/*.ts) SELECTS a field of that enum type. The `Login`/refresh
// queries that previously selected `user.role` live as INLINE strings inside
// useAuth.tsx and are invisible to codegen, so `Role` was never generated. This
// `CurrentUser` document selects `user.role` (schema type `Role!`) and is the
// single document responsible for pulling the backend `Role` enum into the
// generated SSoT that types/index.ts then imports. It mirrors the inline
// login/refresh `user { ... }` selection so the typed result is the canonical
// authenticated-user shape.

import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { gql } from 'graphql-tag';

import type { CurrentUserQuery, CurrentUserQueryVariables } from '../generated/graphql';

// WHY: `currentUser` resolves the authenticated principal from the JWT
// (auth subgraph), returning `User!` whose `role` field is the canonical
// `Role` enum. Selecting `role` here is what makes codegen emit `Role`.
export const CURRENT_USER: TypedDocumentNode<CurrentUserQuery, CurrentUserQueryVariables> = gql`
  query CurrentUser {
    currentUser {
      id
      email
      firstName
      lastName
      role
      tenantId
      accessType
    }
  }
`;
