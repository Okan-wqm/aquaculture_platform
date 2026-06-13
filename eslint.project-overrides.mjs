// AUTO-GENERATED faithful translation of the 31 per-project `.eslintrc.cjs`
// files (A2 PR-2). PROVENANCE: each entry's `rules` + `testOverrides` are the
// VERBATIM resolved `module.exports.rules` / `overrides` of that project's
// (now-deleted) `.eslintrc.cjs`, captured under ESLint 8 before cutover, and
// `tsProjects` is that file's `parserOptions.project` re-based to repo root.
// Each `.eslintrc.cjs` was `root: true` (it did NOT inherit the root
// `.eslintrc.json` overrides), so this per-project data — together with the
// shared presets in eslint.config.mjs — is the COMPLETE lint policy for each
// project. Faithfulness is proven by tools/lint-gates/eslintrc-flat-parity.spec.ts
// (ESLint 8 golden resolved-map vs ESLint 9 flat resolved-map, per rule).
//
// This file is now the SSoT for per-project lint policy. Regenerating requires
// the `.eslintrc.cjs` files from this commit's parent.
export const PROJECT_LINT_OVERRIDES = [
  {
    "dir": "apps/admin-api-service",
    "tsProjects": [
      "apps/admin-api-service/tsconfig.eslint.json"
    ],
    "rules": {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "import/order": "off",
      "@typescript-eslint/no-extraneous-class": "off",
      "no-console": [
        "error"
      ],
      "no-restricted-imports": [
        "error",
        {
          "paths": [
            {
              "name": "@aquaculture/backend-common",
              "message": "The root @aquaculture/backend-common barrel aggregates ~25 subtrees; importing from it forces every consumer to re-invalidate on any change to any subtree. Import from the specific sub-barrel instead — @aquaculture/backend-common/auth, /guards, /database, /utils, /nats, etc. The 2026-04-23 mass-codemod (AUDIT-MEDIUM-005) split all existing consumers, and this rule keeps it that way."
            },
            {
              "name": "@platform/backend-common",
              "message": "Same rationale as @aquaculture/backend-common — import from the specific sub-barrel (@platform/backend-common/<subtree>). Also note that @aquaculture/backend-common/<subtree> is the canonical alias platform-wide; @platform/backend-common exists as a parity alias used by only two files."
            }
          ]
        }
      ],
      "no-restricted-syntax": [
        "error",
        {
          "selector": "CallExpression[callee.property.name='getRepository']",
          "message": "Direct getRepository() bypasses TenantAwareRepository and skips tenantId injection on all find operations, creating IDOR vulnerabilities. Use getScopedRepository() instead. For cross-tenant admin operations, use getUnfilteredRepository() with explicit justification."
        },
        {
          "selector": "CallExpression[callee.object.name='JSON'][callee.property.name='stringify'][arguments.length>2]",
          "message": "JSON.stringify with an indent argument produces multi-line output that breaks structured JSON logging. Use the NestJS Logger — it calls StructuredLoggerService and emits a single JSON event per log."
        },
        {
          "selector": "CallExpression[callee.property.name='get'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). The platform migrated from HS256 (shared JWT_SECRET) to RS256 (auth-service signs with private key, every consumer verifies with public key) in commit 7c076361. Reintroducing JWT_SECRET reads recreates the algorithm-confusion + shared-secret-leak surface the migration eliminated. Token-CONSUMER services: import PlatformJwtModule from @aquaculture/backend-common (it wraps getJwtVerifyOptions which loads JWT_PUBLIC_KEY). Token-ISSUER (auth-service): use JWT_PRIVATE_KEY for signing; the dev-only fallback uses DEV_JWT_SECRET (a different env var)."
        },
        {
          "selector": "CallExpression[callee.property.name='getOrThrow'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). See the .get('JWT_SECRET') message above for the migration path: PlatformJwtModule for consumers, JWT_PRIVATE_KEY for the issuer. The 2026-04-14 hydroponics-service deploy outage was a configService.getOrThrow<string>('JWT_SECRET') call that crashed at boot when JWT_SECRET stopped being provisioned — this rule exists to prevent that recurrence."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='JWT_SECRET']",
          "message": "process.env.JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][computed=true][property.value='JWT_SECRET']",
          "message": "process.env['JWT_SECRET'] reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        }
      ],
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-useless-constructor": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/unbound-method": "off"
    },
    "testOverrides": [
      {
        "files": [
          "src/**/*.spec.ts",
          "src/**/*.test.ts",
          "src/**/__tests__/**/*.ts"
        ],
        "rules": {
          "no-console": "off"
        }
      }
    ]
  },
  {
    "dir": "apps/ai-service",
    "tsProjects": [
      "apps/ai-service/tsconfig.eslint.json"
    ],
    "rules": {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          "argsIgnorePattern": "^_",
          "varsIgnorePattern": "^_"
        }
      ],
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "import/order": "off",
      "@typescript-eslint/no-extraneous-class": [
        "error",
        {
          "allowWithDecorator": true
        }
      ],
      "no-console": [
        "error"
      ],
      "no-restricted-imports": [
        "error",
        {
          "paths": [
            {
              "name": "@aquaculture/backend-common",
              "message": "The root @aquaculture/backend-common barrel aggregates ~25 subtrees; importing from it forces every consumer to re-invalidate on any change to any subtree. Import from the specific sub-barrel instead — @aquaculture/backend-common/auth, /guards, /database, /utils, /nats, etc. The 2026-04-23 mass-codemod (AUDIT-MEDIUM-005) split all existing consumers, and this rule keeps it that way."
            },
            {
              "name": "@platform/backend-common",
              "message": "Same rationale as @aquaculture/backend-common — import from the specific sub-barrel (@platform/backend-common/<subtree>). Also note that @aquaculture/backend-common/<subtree> is the canonical alias platform-wide; @platform/backend-common exists as a parity alias used by only two files."
            }
          ]
        }
      ],
      "no-restricted-syntax": [
        "error",
        {
          "selector": "CallExpression[callee.property.name='getRepository']",
          "message": "Direct getRepository() bypasses TenantAwareRepository and skips tenantId injection on all find operations, creating IDOR vulnerabilities. Use getScopedRepository() instead. For cross-tenant admin operations, use getUnfilteredRepository() with explicit justification."
        },
        {
          "selector": "CallExpression[callee.object.name='JSON'][callee.property.name='stringify'][arguments.length>2]",
          "message": "JSON.stringify with an indent argument produces multi-line output that breaks structured JSON logging. Use the NestJS Logger — it calls StructuredLoggerService and emits a single JSON event per log."
        },
        {
          "selector": "CallExpression[callee.property.name='get'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). The platform migrated from HS256 (shared JWT_SECRET) to RS256 (auth-service signs with private key, every consumer verifies with public key) in commit 7c076361. Reintroducing JWT_SECRET reads recreates the algorithm-confusion + shared-secret-leak surface the migration eliminated. Token-CONSUMER services: import PlatformJwtModule from @aquaculture/backend-common (it wraps getJwtVerifyOptions which loads JWT_PUBLIC_KEY). Token-ISSUER (auth-service): use JWT_PRIVATE_KEY for signing; the dev-only fallback uses DEV_JWT_SECRET (a different env var)."
        },
        {
          "selector": "CallExpression[callee.property.name='getOrThrow'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). See the .get('JWT_SECRET') message above for the migration path: PlatformJwtModule for consumers, JWT_PRIVATE_KEY for the issuer. The 2026-04-14 hydroponics-service deploy outage was a configService.getOrThrow<string>('JWT_SECRET') call that crashed at boot when JWT_SECRET stopped being provisioned — this rule exists to prevent that recurrence."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='JWT_SECRET']",
          "message": "process.env.JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][computed=true][property.value='JWT_SECRET']",
          "message": "process.env['JWT_SECRET'] reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        }
      ],
      "@typescript-eslint/require-await": "off"
    },
    "testOverrides": [
      {
        "files": [
          "src/**/*.spec.ts",
          "src/**/*.test.ts",
          "src/**/__tests__/**/*.ts"
        ],
        "rules": {
          "@typescript-eslint/no-non-null-assertion": "off",
          "@typescript-eslint/no-unnecessary-type-assertion": "off",
          "@typescript-eslint/no-unsafe-argument": "off"
        }
      }
    ]
  },
  {
    "dir": "apps/alert-engine",
    "tsProjects": [
      "apps/alert-engine/tsconfig.eslint.json"
    ],
    "rules": {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": "off",
      "import/order": "off",
      "@typescript-eslint/no-extraneous-class": [
        "error",
        {
          "allowWithDecorator": true
        }
      ],
      "no-console": [
        "error"
      ],
      "no-restricted-imports": [
        "error",
        {
          "paths": [
            {
              "name": "@aquaculture/backend-common",
              "message": "The root @aquaculture/backend-common barrel aggregates ~25 subtrees; importing from it forces every consumer to re-invalidate on any change to any subtree. Import from the specific sub-barrel instead — @aquaculture/backend-common/auth, /guards, /database, /utils, /nats, etc. The 2026-04-23 mass-codemod (AUDIT-MEDIUM-005) split all existing consumers, and this rule keeps it that way."
            },
            {
              "name": "@platform/backend-common",
              "message": "Same rationale as @aquaculture/backend-common — import from the specific sub-barrel (@platform/backend-common/<subtree>). Also note that @aquaculture/backend-common/<subtree> is the canonical alias platform-wide; @platform/backend-common exists as a parity alias used by only two files."
            }
          ]
        }
      ],
      "no-restricted-syntax": [
        "error",
        {
          "selector": "CallExpression[callee.property.name='getRepository']",
          "message": "Direct getRepository() bypasses TenantAwareRepository and skips tenantId injection on all find operations, creating IDOR vulnerabilities. Use getScopedRepository() instead. For cross-tenant admin operations, use getUnfilteredRepository() with explicit justification."
        },
        {
          "selector": "CallExpression[callee.object.name='JSON'][callee.property.name='stringify'][arguments.length>2]",
          "message": "JSON.stringify with an indent argument produces multi-line output that breaks structured JSON logging. Use the NestJS Logger — it calls StructuredLoggerService and emits a single JSON event per log."
        },
        {
          "selector": "CallExpression[callee.property.name='get'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). The platform migrated from HS256 (shared JWT_SECRET) to RS256 (auth-service signs with private key, every consumer verifies with public key) in commit 7c076361. Reintroducing JWT_SECRET reads recreates the algorithm-confusion + shared-secret-leak surface the migration eliminated. Token-CONSUMER services: import PlatformJwtModule from @aquaculture/backend-common (it wraps getJwtVerifyOptions which loads JWT_PUBLIC_KEY). Token-ISSUER (auth-service): use JWT_PRIVATE_KEY for signing; the dev-only fallback uses DEV_JWT_SECRET (a different env var)."
        },
        {
          "selector": "CallExpression[callee.property.name='getOrThrow'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). See the .get('JWT_SECRET') message above for the migration path: PlatformJwtModule for consumers, JWT_PRIVATE_KEY for the issuer. The 2026-04-14 hydroponics-service deploy outage was a configService.getOrThrow<string>('JWT_SECRET') call that crashed at boot when JWT_SECRET stopped being provisioned — this rule exists to prevent that recurrence."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='JWT_SECRET']",
          "message": "process.env.JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][computed=true][property.value='JWT_SECRET']",
          "message": "process.env['JWT_SECRET'] reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        }
      ],
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-inferrable-types": "off",
      "@typescript-eslint/no-this-alias": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/restrict-template-expressions": "off"
    },
    "testOverrides": [
      {
        "files": [
          "src/**/*.spec.ts",
          "src/**/*.test.ts",
          "src/**/__tests__/**/*.ts"
        ],
        "rules": {
          "@typescript-eslint/await-thenable": "off",
          "@typescript-eslint/no-floating-promises": "off",
          "@typescript-eslint/unbound-method": "off"
        }
      }
    ]
  },
  {
    "dir": "apps/auth-service",
    "tsProjects": [
      "apps/auth-service/tsconfig.eslint.json"
    ],
    "rules": {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "import/order": "off",
      "@typescript-eslint/no-extraneous-class": [
        "error",
        {
          "allowWithDecorator": true
        }
      ],
      "no-console": [
        "error"
      ],
      "no-restricted-imports": [
        "error",
        {
          "paths": [
            {
              "name": "@aquaculture/backend-common",
              "message": "The root @aquaculture/backend-common barrel aggregates ~25 subtrees; importing from it forces every consumer to re-invalidate on any change to any subtree. Import from the specific sub-barrel instead — @aquaculture/backend-common/auth, /guards, /database, /utils, /nats, etc. The 2026-04-23 mass-codemod (AUDIT-MEDIUM-005) split all existing consumers, and this rule keeps it that way."
            },
            {
              "name": "@platform/backend-common",
              "message": "Same rationale as @aquaculture/backend-common — import from the specific sub-barrel (@platform/backend-common/<subtree>). Also note that @aquaculture/backend-common/<subtree> is the canonical alias platform-wide; @platform/backend-common exists as a parity alias used by only two files."
            }
          ]
        }
      ],
      "no-restricted-syntax": [
        "error",
        {
          "selector": "CallExpression[callee.property.name='getRepository']",
          "message": "Direct getRepository() bypasses TenantAwareRepository and skips tenantId injection on all find operations, creating IDOR vulnerabilities. Use getScopedRepository() instead. For cross-tenant admin operations, use getUnfilteredRepository() with explicit justification."
        },
        {
          "selector": "CallExpression[callee.object.name='JSON'][callee.property.name='stringify'][arguments.length>2]",
          "message": "JSON.stringify with an indent argument produces multi-line output that breaks structured JSON logging. Use the NestJS Logger — it calls StructuredLoggerService and emits a single JSON event per log."
        },
        {
          "selector": "CallExpression[callee.property.name='get'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). The platform migrated from HS256 (shared JWT_SECRET) to RS256 (auth-service signs with private key, every consumer verifies with public key) in commit 7c076361. Reintroducing JWT_SECRET reads recreates the algorithm-confusion + shared-secret-leak surface the migration eliminated. Token-CONSUMER services: import PlatformJwtModule from @aquaculture/backend-common (it wraps getJwtVerifyOptions which loads JWT_PUBLIC_KEY). Token-ISSUER (auth-service): use JWT_PRIVATE_KEY for signing; the dev-only fallback uses DEV_JWT_SECRET (a different env var)."
        },
        {
          "selector": "CallExpression[callee.property.name='getOrThrow'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). See the .get('JWT_SECRET') message above for the migration path: PlatformJwtModule for consumers, JWT_PRIVATE_KEY for the issuer. The 2026-04-14 hydroponics-service deploy outage was a configService.getOrThrow<string>('JWT_SECRET') call that crashed at boot when JWT_SECRET stopped being provisioned — this rule exists to prevent that recurrence."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='JWT_SECRET']",
          "message": "process.env.JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][computed=true][property.value='JWT_SECRET']",
          "message": "process.env['JWT_SECRET'] reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        }
      ],
      "@typescript-eslint/no-dynamic-delete": "off",
      "@typescript-eslint/no-inferrable-types": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/require-await": "off"
    },
    "testOverrides": [
      {
        "files": [
          "src/**/*.spec.ts",
          "src/**/*.test.ts",
          "src/**/__tests__/**/*.ts"
        ],
        "rules": {
          "@typescript-eslint/await-thenable": "off",
          "@typescript-eslint/no-floating-promises": "off",
          "@typescript-eslint/unbound-method": "off"
        }
      }
    ]
  },
  {
    "dir": "apps/billing-service",
    "tsProjects": [
      "apps/billing-service/tsconfig.eslint.json"
    ],
    "rules": {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": "off",
      "import/order": "off",
      "@typescript-eslint/no-extraneous-class": [
        "error",
        {
          "allowWithDecorator": true
        }
      ],
      "no-console": [
        "error"
      ],
      "no-restricted-imports": [
        "error",
        {
          "paths": [
            {
              "name": "@aquaculture/backend-common",
              "message": "The root @aquaculture/backend-common barrel aggregates ~25 subtrees; importing from it forces every consumer to re-invalidate on any change to any subtree. Import from the specific sub-barrel instead — @aquaculture/backend-common/auth, /guards, /database, /utils, /nats, etc. The 2026-04-23 mass-codemod (AUDIT-MEDIUM-005) split all existing consumers, and this rule keeps it that way."
            },
            {
              "name": "@platform/backend-common",
              "message": "Same rationale as @aquaculture/backend-common — import from the specific sub-barrel (@platform/backend-common/<subtree>). Also note that @aquaculture/backend-common/<subtree> is the canonical alias platform-wide; @platform/backend-common exists as a parity alias used by only two files."
            }
          ]
        }
      ],
      "no-restricted-syntax": [
        "error",
        {
          "selector": "CallExpression[callee.property.name='getRepository']",
          "message": "Direct getRepository() bypasses TenantAwareRepository and skips tenantId injection on all find operations, creating IDOR vulnerabilities. Use getScopedRepository() instead. For cross-tenant admin operations, use getUnfilteredRepository() with explicit justification."
        },
        {
          "selector": "CallExpression[callee.object.name='JSON'][callee.property.name='stringify'][arguments.length>2]",
          "message": "JSON.stringify with an indent argument produces multi-line output that breaks structured JSON logging. Use the NestJS Logger — it calls StructuredLoggerService and emits a single JSON event per log."
        },
        {
          "selector": "CallExpression[callee.property.name='get'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). The platform migrated from HS256 (shared JWT_SECRET) to RS256 (auth-service signs with private key, every consumer verifies with public key) in commit 7c076361. Reintroducing JWT_SECRET reads recreates the algorithm-confusion + shared-secret-leak surface the migration eliminated. Token-CONSUMER services: import PlatformJwtModule from @aquaculture/backend-common (it wraps getJwtVerifyOptions which loads JWT_PUBLIC_KEY). Token-ISSUER (auth-service): use JWT_PRIVATE_KEY for signing; the dev-only fallback uses DEV_JWT_SECRET (a different env var)."
        },
        {
          "selector": "CallExpression[callee.property.name='getOrThrow'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). See the .get('JWT_SECRET') message above for the migration path: PlatformJwtModule for consumers, JWT_PRIVATE_KEY for the issuer. The 2026-04-14 hydroponics-service deploy outage was a configService.getOrThrow<string>('JWT_SECRET') call that crashed at boot when JWT_SECRET stopped being provisioned — this rule exists to prevent that recurrence."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='JWT_SECRET']",
          "message": "process.env.JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][computed=true][property.value='JWT_SECRET']",
          "message": "process.env['JWT_SECRET'] reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        }
      ],
      "@typescript-eslint/no-inferrable-types": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/prefer-const": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "prefer-const": "off"
    },
    "testOverrides": [
      {
        "files": [
          "src/**/*.spec.ts",
          "src/**/*.test.ts",
          "src/**/__tests__/**/*.ts"
        ],
        "rules": {
          "@typescript-eslint/await-thenable": "off",
          "@typescript-eslint/no-floating-promises": "off",
          "@typescript-eslint/unbound-method": "off"
        }
      }
    ]
  },
  {
    "dir": "apps/config-service",
    "tsProjects": [
      "apps/config-service/tsconfig.eslint.json"
    ],
    "rules": {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "import/order": "off",
      "@typescript-eslint/no-extraneous-class": [
        "error",
        {
          "allowWithDecorator": true
        }
      ],
      "no-console": [
        "error"
      ],
      "no-restricted-imports": [
        "error",
        {
          "paths": [
            {
              "name": "@aquaculture/backend-common",
              "message": "The root @aquaculture/backend-common barrel aggregates ~25 subtrees; importing from it forces every consumer to re-invalidate on any change to any subtree. Import from the specific sub-barrel instead — @aquaculture/backend-common/auth, /guards, /database, /utils, /nats, etc. The 2026-04-23 mass-codemod (AUDIT-MEDIUM-005) split all existing consumers, and this rule keeps it that way."
            },
            {
              "name": "@platform/backend-common",
              "message": "Same rationale as @aquaculture/backend-common — import from the specific sub-barrel (@platform/backend-common/<subtree>). Also note that @aquaculture/backend-common/<subtree> is the canonical alias platform-wide; @platform/backend-common exists as a parity alias used by only two files."
            }
          ]
        }
      ],
      "no-restricted-syntax": [
        "error",
        {
          "selector": "CallExpression[callee.property.name='getRepository']",
          "message": "Direct getRepository() bypasses TenantAwareRepository and skips tenantId injection on all find operations, creating IDOR vulnerabilities. Use getScopedRepository() instead. For cross-tenant admin operations, use getUnfilteredRepository() with explicit justification."
        },
        {
          "selector": "CallExpression[callee.object.name='JSON'][callee.property.name='stringify'][arguments.length>2]",
          "message": "JSON.stringify with an indent argument produces multi-line output that breaks structured JSON logging. Use the NestJS Logger — it calls StructuredLoggerService and emits a single JSON event per log."
        },
        {
          "selector": "CallExpression[callee.property.name='get'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). The platform migrated from HS256 (shared JWT_SECRET) to RS256 (auth-service signs with private key, every consumer verifies with public key) in commit 7c076361. Reintroducing JWT_SECRET reads recreates the algorithm-confusion + shared-secret-leak surface the migration eliminated. Token-CONSUMER services: import PlatformJwtModule from @aquaculture/backend-common (it wraps getJwtVerifyOptions which loads JWT_PUBLIC_KEY). Token-ISSUER (auth-service): use JWT_PRIVATE_KEY for signing; the dev-only fallback uses DEV_JWT_SECRET (a different env var)."
        },
        {
          "selector": "CallExpression[callee.property.name='getOrThrow'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). See the .get('JWT_SECRET') message above for the migration path: PlatformJwtModule for consumers, JWT_PRIVATE_KEY for the issuer. The 2026-04-14 hydroponics-service deploy outage was a configService.getOrThrow<string>('JWT_SECRET') call that crashed at boot when JWT_SECRET stopped being provisioned — this rule exists to prevent that recurrence."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='JWT_SECRET']",
          "message": "process.env.JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][computed=true][property.value='JWT_SECRET']",
          "message": "process.env['JWT_SECRET'] reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        }
      ],
      "@typescript-eslint/no-inferrable-types": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/restrict-template-expressions": "off"
    },
    "testOverrides": []
  },
  {
    "dir": "apps/db-migrate",
    "tsProjects": [
      "apps/db-migrate/tsconfig.eslint.json"
    ],
    "rules": {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          "argsIgnorePattern": "^_",
          "varsIgnorePattern": "^_"
        }
      ],
      "@typescript-eslint/explicit-function-return-type": [
        "warn",
        {
          "allowExpressions": true,
          "allowTypedFunctionExpressions": true
        }
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "import/order": [
        "error",
        {
          "groups": [
            "builtin",
            "external",
            "internal",
            "parent",
            "sibling",
            "index"
          ],
          "newlines-between": "always",
          "alphabetize": {
            "order": "asc",
            "caseInsensitive": true
          }
        }
      ],
      "@typescript-eslint/no-extraneous-class": [
        "error",
        {
          "allowWithDecorator": true
        }
      ],
      "no-console": [
        "error"
      ],
      "no-restricted-imports": [
        "error",
        {
          "paths": [
            {
              "name": "@aquaculture/backend-common",
              "message": "The root @aquaculture/backend-common barrel aggregates ~25 subtrees; importing from it forces every consumer to re-invalidate on any change to any subtree. Import from the specific sub-barrel instead — @aquaculture/backend-common/auth, /guards, /database, /utils, /nats, etc. The 2026-04-23 mass-codemod (AUDIT-MEDIUM-005) split all existing consumers, and this rule keeps it that way."
            },
            {
              "name": "@platform/backend-common",
              "message": "Same rationale as @aquaculture/backend-common — import from the specific sub-barrel (@platform/backend-common/<subtree>). Also note that @aquaculture/backend-common/<subtree> is the canonical alias platform-wide; @platform/backend-common exists as a parity alias used by only two files."
            }
          ]
        }
      ],
      "no-restricted-syntax": [
        "error",
        {
          "selector": "CallExpression[callee.property.name='getRepository']",
          "message": "Direct getRepository() bypasses TenantAwareRepository and skips tenantId injection on all find operations, creating IDOR vulnerabilities. Use getScopedRepository() instead. For cross-tenant admin operations, use getUnfilteredRepository() with explicit justification."
        },
        {
          "selector": "CallExpression[callee.object.name='JSON'][callee.property.name='stringify'][arguments.length>2]",
          "message": "JSON.stringify with an indent argument produces multi-line output that breaks structured JSON logging. Use the NestJS Logger — it calls StructuredLoggerService and emits a single JSON event per log."
        },
        {
          "selector": "CallExpression[callee.property.name='get'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). The platform migrated from HS256 (shared JWT_SECRET) to RS256 (auth-service signs with private key, every consumer verifies with public key) in commit 7c076361. Reintroducing JWT_SECRET reads recreates the algorithm-confusion + shared-secret-leak surface the migration eliminated. Token-CONSUMER services: import PlatformJwtModule from @aquaculture/backend-common (it wraps getJwtVerifyOptions which loads JWT_PUBLIC_KEY). Token-ISSUER (auth-service): use JWT_PRIVATE_KEY for signing; the dev-only fallback uses DEV_JWT_SECRET (a different env var)."
        },
        {
          "selector": "CallExpression[callee.property.name='getOrThrow'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). See the .get('JWT_SECRET') message above for the migration path: PlatformJwtModule for consumers, JWT_PRIVATE_KEY for the issuer. The 2026-04-14 hydroponics-service deploy outage was a configService.getOrThrow<string>('JWT_SECRET') call that crashed at boot when JWT_SECRET stopped being provisioned — this rule exists to prevent that recurrence."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='JWT_SECRET']",
          "message": "process.env.JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][computed=true][property.value='JWT_SECRET']",
          "message": "process.env['JWT_SECRET'] reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        }
      ],
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off"
    },
    "testOverrides": []
  },
  {
    "dir": "apps/event-store-service",
    "tsProjects": [
      "apps/event-store-service/tsconfig.eslint.json"
    ],
    "rules": {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          "argsIgnorePattern": "^_",
          "varsIgnorePattern": "^_"
        }
      ],
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": "off",
      "import/order": "off",
      "@typescript-eslint/no-extraneous-class": [
        "error",
        {
          "allowWithDecorator": true
        }
      ],
      "no-console": [
        "error"
      ],
      "no-restricted-imports": [
        "error",
        {
          "paths": [
            {
              "name": "@aquaculture/backend-common",
              "message": "The root @aquaculture/backend-common barrel aggregates ~25 subtrees; importing from it forces every consumer to re-invalidate on any change to any subtree. Import from the specific sub-barrel instead — @aquaculture/backend-common/auth, /guards, /database, /utils, /nats, etc. The 2026-04-23 mass-codemod (AUDIT-MEDIUM-005) split all existing consumers, and this rule keeps it that way."
            },
            {
              "name": "@platform/backend-common",
              "message": "Same rationale as @aquaculture/backend-common — import from the specific sub-barrel (@platform/backend-common/<subtree>). Also note that @aquaculture/backend-common/<subtree> is the canonical alias platform-wide; @platform/backend-common exists as a parity alias used by only two files."
            }
          ]
        }
      ],
      "no-restricted-syntax": [
        "error",
        {
          "selector": "CallExpression[callee.property.name='getRepository']",
          "message": "Direct getRepository() bypasses TenantAwareRepository and skips tenantId injection on all find operations, creating IDOR vulnerabilities. Use getScopedRepository() instead. For cross-tenant admin operations, use getUnfilteredRepository() with explicit justification."
        },
        {
          "selector": "CallExpression[callee.object.name='JSON'][callee.property.name='stringify'][arguments.length>2]",
          "message": "JSON.stringify with an indent argument produces multi-line output that breaks structured JSON logging. Use the NestJS Logger — it calls StructuredLoggerService and emits a single JSON event per log."
        },
        {
          "selector": "CallExpression[callee.property.name='get'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). The platform migrated from HS256 (shared JWT_SECRET) to RS256 (auth-service signs with private key, every consumer verifies with public key) in commit 7c076361. Reintroducing JWT_SECRET reads recreates the algorithm-confusion + shared-secret-leak surface the migration eliminated. Token-CONSUMER services: import PlatformJwtModule from @aquaculture/backend-common (it wraps getJwtVerifyOptions which loads JWT_PUBLIC_KEY). Token-ISSUER (auth-service): use JWT_PRIVATE_KEY for signing; the dev-only fallback uses DEV_JWT_SECRET (a different env var)."
        },
        {
          "selector": "CallExpression[callee.property.name='getOrThrow'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). See the .get('JWT_SECRET') message above for the migration path: PlatformJwtModule for consumers, JWT_PRIVATE_KEY for the issuer. The 2026-04-14 hydroponics-service deploy outage was a configService.getOrThrow<string>('JWT_SECRET') call that crashed at boot when JWT_SECRET stopped being provisioned — this rule exists to prevent that recurrence."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='JWT_SECRET']",
          "message": "process.env.JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][computed=true][property.value='JWT_SECRET']",
          "message": "process.env['JWT_SECRET'] reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        }
      ],
      "@typescript-eslint/no-inferrable-types": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/only-throw-error": "off"
    },
    "testOverrides": [
      {
        "files": [
          "src/**/*.spec.ts",
          "src/**/*.test.ts",
          "src/**/__tests__/**/*.ts"
        ],
        "rules": {
          "@typescript-eslint/no-explicit-any": "off",
          "@typescript-eslint/unbound-method": "off"
        }
      }
    ]
  },
  {
    "dir": "apps/farm-service",
    "tsProjects": [
      "apps/farm-service/tsconfig.eslint.json"
    ],
    "rules": {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "import/order": "off",
      "@typescript-eslint/no-extraneous-class": "off",
      "no-console": "off",
      "no-restricted-imports": [
        "error",
        {
          "paths": [
            {
              "name": "@aquaculture/backend-common",
              "message": "The root @aquaculture/backend-common barrel aggregates ~25 subtrees; importing from it forces every consumer to re-invalidate on any change to any subtree. Import from the specific sub-barrel instead — @aquaculture/backend-common/auth, /guards, /database, /utils, /nats, etc. The 2026-04-23 mass-codemod (AUDIT-MEDIUM-005) split all existing consumers, and this rule keeps it that way."
            },
            {
              "name": "@platform/backend-common",
              "message": "Same rationale as @aquaculture/backend-common — import from the specific sub-barrel (@platform/backend-common/<subtree>). Also note that @aquaculture/backend-common/<subtree> is the canonical alias platform-wide; @platform/backend-common exists as a parity alias used by only two files."
            }
          ]
        }
      ],
      "no-restricted-syntax": [
        "error",
        {
          "selector": "CallExpression[callee.property.name='getRepository']",
          "message": "Direct getRepository() bypasses TenantAwareRepository and skips tenantId injection on all find operations, creating IDOR vulnerabilities. Use getScopedRepository() instead. For cross-tenant admin operations, use getUnfilteredRepository() with explicit justification."
        },
        {
          "selector": "CallExpression[callee.object.name='JSON'][callee.property.name='stringify'][arguments.length>2]",
          "message": "JSON.stringify with an indent argument produces multi-line output that breaks structured JSON logging. Use the NestJS Logger — it calls StructuredLoggerService and emits a single JSON event per log."
        },
        {
          "selector": "CallExpression[callee.property.name='get'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). The platform migrated from HS256 (shared JWT_SECRET) to RS256 (auth-service signs with private key, every consumer verifies with public key) in commit 7c076361. Reintroducing JWT_SECRET reads recreates the algorithm-confusion + shared-secret-leak surface the migration eliminated. Token-CONSUMER services: import PlatformJwtModule from @aquaculture/backend-common (it wraps getJwtVerifyOptions which loads JWT_PUBLIC_KEY). Token-ISSUER (auth-service): use JWT_PRIVATE_KEY for signing; the dev-only fallback uses DEV_JWT_SECRET (a different env var)."
        },
        {
          "selector": "CallExpression[callee.property.name='getOrThrow'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). See the .get('JWT_SECRET') message above for the migration path: PlatformJwtModule for consumers, JWT_PRIVATE_KEY for the issuer. The 2026-04-14 hydroponics-service deploy outage was a configService.getOrThrow<string>('JWT_SECRET') call that crashed at boot when JWT_SECRET stopped being provisioned — this rule exists to prevent that recurrence."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='JWT_SECRET']",
          "message": "process.env.JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][computed=true][property.value='JWT_SECRET']",
          "message": "process.env['JWT_SECRET'] reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        }
      ],
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-dynamic-delete": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-inferrable-types": "off",
      "@typescript-eslint/no-invalid-void-type": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/only-throw-error": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/unbound-method": "off",
      "no-case-declarations": "off",
      "prefer-const": "off"
    },
    "testOverrides": [
      {
        "files": [
          "src/**/__tests__/e2e/**/*.ts",
          "test/**/*.ts"
        ],
        "rules": {
          "no-restricted-imports": "off",
          "no-restricted-syntax": "off"
        }
      }
    ]
  },
  {
    "dir": "apps/gateway-api",
    "tsProjects": [
      "apps/gateway-api/tsconfig.eslint.json"
    ],
    "rules": {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "import/order": "off",
      "@typescript-eslint/no-extraneous-class": "off",
      "no-console": "off",
      "no-restricted-imports": [
        "error",
        {
          "paths": [
            {
              "name": "@aquaculture/backend-common",
              "message": "The root @aquaculture/backend-common barrel aggregates ~25 subtrees; importing from it forces every consumer to re-invalidate on any change to any subtree. Import from the specific sub-barrel instead — @aquaculture/backend-common/auth, /guards, /database, /utils, /nats, etc. The 2026-04-23 mass-codemod (AUDIT-MEDIUM-005) split all existing consumers, and this rule keeps it that way."
            },
            {
              "name": "@platform/backend-common",
              "message": "Same rationale as @aquaculture/backend-common — import from the specific sub-barrel (@platform/backend-common/<subtree>). Also note that @aquaculture/backend-common/<subtree> is the canonical alias platform-wide; @platform/backend-common exists as a parity alias used by only two files."
            }
          ]
        }
      ],
      "no-restricted-syntax": [
        "error",
        {
          "selector": "CallExpression[callee.property.name='getRepository']",
          "message": "Direct getRepository() bypasses TenantAwareRepository and skips tenantId injection on all find operations, creating IDOR vulnerabilities. Use getScopedRepository() instead. For cross-tenant admin operations, use getUnfilteredRepository() with explicit justification."
        },
        {
          "selector": "CallExpression[callee.object.name='JSON'][callee.property.name='stringify'][arguments.length>2]",
          "message": "JSON.stringify with an indent argument produces multi-line output that breaks structured JSON logging. Use the NestJS Logger — it calls StructuredLoggerService and emits a single JSON event per log."
        },
        {
          "selector": "CallExpression[callee.property.name='get'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). The platform migrated from HS256 (shared JWT_SECRET) to RS256 (auth-service signs with private key, every consumer verifies with public key) in commit 7c076361. Reintroducing JWT_SECRET reads recreates the algorithm-confusion + shared-secret-leak surface the migration eliminated. Token-CONSUMER services: import PlatformJwtModule from @aquaculture/backend-common (it wraps getJwtVerifyOptions which loads JWT_PUBLIC_KEY). Token-ISSUER (auth-service): use JWT_PRIVATE_KEY for signing; the dev-only fallback uses DEV_JWT_SECRET (a different env var)."
        },
        {
          "selector": "CallExpression[callee.property.name='getOrThrow'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). See the .get('JWT_SECRET') message above for the migration path: PlatformJwtModule for consumers, JWT_PRIVATE_KEY for the issuer. The 2026-04-14 hydroponics-service deploy outage was a configService.getOrThrow<string>('JWT_SECRET') call that crashed at boot when JWT_SECRET stopped being provisioned — this rule exists to prevent that recurrence."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='JWT_SECRET']",
          "message": "process.env.JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][computed=true][property.value='JWT_SECRET']",
          "message": "process.env['JWT_SECRET'] reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        }
      ],
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-dynamic-delete": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-inferrable-types": "off",
      "@typescript-eslint/no-invalid-void-type": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/only-throw-error": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/unbound-method": "off",
      "no-case-declarations": "off",
      "prefer-const": "off"
    },
    "testOverrides": []
  },
  {
    "dir": "apps/hr-service",
    "tsProjects": [
      "apps/hr-service/tsconfig.eslint.json"
    ],
    "rules": {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "import/order": "off",
      "@typescript-eslint/no-extraneous-class": "off",
      "no-console": "off",
      "no-restricted-imports": [
        "error",
        {
          "paths": [
            {
              "name": "@aquaculture/backend-common",
              "message": "The root @aquaculture/backend-common barrel aggregates ~25 subtrees; importing from it forces every consumer to re-invalidate on any change to any subtree. Import from the specific sub-barrel instead — @aquaculture/backend-common/auth, /guards, /database, /utils, /nats, etc. The 2026-04-23 mass-codemod (AUDIT-MEDIUM-005) split all existing consumers, and this rule keeps it that way."
            },
            {
              "name": "@platform/backend-common",
              "message": "Same rationale as @aquaculture/backend-common — import from the specific sub-barrel (@platform/backend-common/<subtree>). Also note that @aquaculture/backend-common/<subtree> is the canonical alias platform-wide; @platform/backend-common exists as a parity alias used by only two files."
            }
          ]
        }
      ],
      "no-restricted-syntax": [
        "error",
        {
          "selector": "CallExpression[callee.property.name='getRepository']",
          "message": "Direct getRepository() bypasses TenantAwareRepository and skips tenantId injection on all find operations, creating IDOR vulnerabilities. Use getScopedRepository() instead. For cross-tenant admin operations, use getUnfilteredRepository() with explicit justification."
        },
        {
          "selector": "CallExpression[callee.object.name='JSON'][callee.property.name='stringify'][arguments.length>2]",
          "message": "JSON.stringify with an indent argument produces multi-line output that breaks structured JSON logging. Use the NestJS Logger — it calls StructuredLoggerService and emits a single JSON event per log."
        },
        {
          "selector": "CallExpression[callee.property.name='get'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). The platform migrated from HS256 (shared JWT_SECRET) to RS256 (auth-service signs with private key, every consumer verifies with public key) in commit 7c076361. Reintroducing JWT_SECRET reads recreates the algorithm-confusion + shared-secret-leak surface the migration eliminated. Token-CONSUMER services: import PlatformJwtModule from @aquaculture/backend-common (it wraps getJwtVerifyOptions which loads JWT_PUBLIC_KEY). Token-ISSUER (auth-service): use JWT_PRIVATE_KEY for signing; the dev-only fallback uses DEV_JWT_SECRET (a different env var)."
        },
        {
          "selector": "CallExpression[callee.property.name='getOrThrow'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). See the .get('JWT_SECRET') message above for the migration path: PlatformJwtModule for consumers, JWT_PRIVATE_KEY for the issuer. The 2026-04-14 hydroponics-service deploy outage was a configService.getOrThrow<string>('JWT_SECRET') call that crashed at boot when JWT_SECRET stopped being provisioned — this rule exists to prevent that recurrence."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='JWT_SECRET']",
          "message": "process.env.JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][computed=true][property.value='JWT_SECRET']",
          "message": "process.env['JWT_SECRET'] reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        }
      ],
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-dynamic-delete": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-inferrable-types": "off",
      "@typescript-eslint/no-invalid-void-type": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/only-throw-error": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/unbound-method": "off",
      "no-case-declarations": "off",
      "prefer-const": "off"
    },
    "testOverrides": []
  },
  {
    "dir": "apps/hydroponics-service",
    "tsProjects": [
      "apps/hydroponics-service/tsconfig.eslint.json"
    ],
    "rules": {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "import/order": "off",
      "@typescript-eslint/no-extraneous-class": "off",
      "no-console": "off",
      "no-restricted-imports": [
        "error",
        {
          "paths": [
            {
              "name": "@aquaculture/backend-common",
              "message": "The root @aquaculture/backend-common barrel aggregates ~25 subtrees; importing from it forces every consumer to re-invalidate on any change to any subtree. Import from the specific sub-barrel instead — @aquaculture/backend-common/auth, /guards, /database, /utils, /nats, etc. The 2026-04-23 mass-codemod (AUDIT-MEDIUM-005) split all existing consumers, and this rule keeps it that way."
            },
            {
              "name": "@platform/backend-common",
              "message": "Same rationale as @aquaculture/backend-common — import from the specific sub-barrel (@platform/backend-common/<subtree>). Also note that @aquaculture/backend-common/<subtree> is the canonical alias platform-wide; @platform/backend-common exists as a parity alias used by only two files."
            }
          ]
        }
      ],
      "no-restricted-syntax": [
        "error",
        {
          "selector": "CallExpression[callee.property.name='getRepository']",
          "message": "Direct getRepository() bypasses TenantAwareRepository and skips tenantId injection on all find operations, creating IDOR vulnerabilities. Use getScopedRepository() instead. For cross-tenant admin operations, use getUnfilteredRepository() with explicit justification."
        },
        {
          "selector": "CallExpression[callee.object.name='JSON'][callee.property.name='stringify'][arguments.length>2]",
          "message": "JSON.stringify with an indent argument produces multi-line output that breaks structured JSON logging. Use the NestJS Logger — it calls StructuredLoggerService and emits a single JSON event per log."
        },
        {
          "selector": "CallExpression[callee.property.name='get'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). The platform migrated from HS256 (shared JWT_SECRET) to RS256 (auth-service signs with private key, every consumer verifies with public key) in commit 7c076361. Reintroducing JWT_SECRET reads recreates the algorithm-confusion + shared-secret-leak surface the migration eliminated. Token-CONSUMER services: import PlatformJwtModule from @aquaculture/backend-common (it wraps getJwtVerifyOptions which loads JWT_PUBLIC_KEY). Token-ISSUER (auth-service): use JWT_PRIVATE_KEY for signing; the dev-only fallback uses DEV_JWT_SECRET (a different env var)."
        },
        {
          "selector": "CallExpression[callee.property.name='getOrThrow'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). See the .get('JWT_SECRET') message above for the migration path: PlatformJwtModule for consumers, JWT_PRIVATE_KEY for the issuer. The 2026-04-14 hydroponics-service deploy outage was a configService.getOrThrow<string>('JWT_SECRET') call that crashed at boot when JWT_SECRET stopped being provisioned — this rule exists to prevent that recurrence."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='JWT_SECRET']",
          "message": "process.env.JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][computed=true][property.value='JWT_SECRET']",
          "message": "process.env['JWT_SECRET'] reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        }
      ],
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-dynamic-delete": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-inferrable-types": "off",
      "@typescript-eslint/no-invalid-void-type": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/only-throw-error": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/unbound-method": "off",
      "no-case-declarations": "off",
      "prefer-const": "off"
    },
    "testOverrides": []
  },
  {
    "dir": "apps/messaging-service",
    "tsProjects": [
      "apps/messaging-service/tsconfig.eslint.json"
    ],
    "rules": {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "import/order": "off",
      "@typescript-eslint/no-extraneous-class": "off",
      "no-console": "off",
      "no-restricted-imports": [
        "error",
        {
          "paths": [
            {
              "name": "@aquaculture/backend-common",
              "message": "The root @aquaculture/backend-common barrel aggregates ~25 subtrees; importing from it forces every consumer to re-invalidate on any change to any subtree. Import from the specific sub-barrel instead — @aquaculture/backend-common/auth, /guards, /database, /utils, /nats, etc. The 2026-04-23 mass-codemod (AUDIT-MEDIUM-005) split all existing consumers, and this rule keeps it that way."
            },
            {
              "name": "@platform/backend-common",
              "message": "Same rationale as @aquaculture/backend-common — import from the specific sub-barrel (@platform/backend-common/<subtree>). Also note that @aquaculture/backend-common/<subtree> is the canonical alias platform-wide; @platform/backend-common exists as a parity alias used by only two files."
            }
          ]
        }
      ],
      "no-restricted-syntax": [
        "error",
        {
          "selector": "CallExpression[callee.property.name='getRepository']",
          "message": "Direct getRepository() bypasses TenantAwareRepository and skips tenantId injection on all find operations, creating IDOR vulnerabilities. Use getScopedRepository() instead. For cross-tenant admin operations, use getUnfilteredRepository() with explicit justification."
        },
        {
          "selector": "CallExpression[callee.object.name='JSON'][callee.property.name='stringify'][arguments.length>2]",
          "message": "JSON.stringify with an indent argument produces multi-line output that breaks structured JSON logging. Use the NestJS Logger — it calls StructuredLoggerService and emits a single JSON event per log."
        },
        {
          "selector": "CallExpression[callee.property.name='get'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). The platform migrated from HS256 (shared JWT_SECRET) to RS256 (auth-service signs with private key, every consumer verifies with public key) in commit 7c076361. Reintroducing JWT_SECRET reads recreates the algorithm-confusion + shared-secret-leak surface the migration eliminated. Token-CONSUMER services: import PlatformJwtModule from @aquaculture/backend-common (it wraps getJwtVerifyOptions which loads JWT_PUBLIC_KEY). Token-ISSUER (auth-service): use JWT_PRIVATE_KEY for signing; the dev-only fallback uses DEV_JWT_SECRET (a different env var)."
        },
        {
          "selector": "CallExpression[callee.property.name='getOrThrow'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). See the .get('JWT_SECRET') message above for the migration path: PlatformJwtModule for consumers, JWT_PRIVATE_KEY for the issuer. The 2026-04-14 hydroponics-service deploy outage was a configService.getOrThrow<string>('JWT_SECRET') call that crashed at boot when JWT_SECRET stopped being provisioned — this rule exists to prevent that recurrence."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='JWT_SECRET']",
          "message": "process.env.JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][computed=true][property.value='JWT_SECRET']",
          "message": "process.env['JWT_SECRET'] reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        }
      ],
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-dynamic-delete": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-inferrable-types": "off",
      "@typescript-eslint/no-invalid-void-type": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/only-throw-error": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/unbound-method": "off",
      "no-case-declarations": "off",
      "prefer-const": "off"
    },
    "testOverrides": []
  },
  {
    "dir": "apps/notification-service",
    "tsProjects": [
      "apps/notification-service/tsconfig.eslint.json"
    ],
    "rules": {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "import/order": "off",
      "@typescript-eslint/no-extraneous-class": "off",
      "no-console": "off",
      "no-restricted-imports": [
        "error",
        {
          "paths": [
            {
              "name": "@aquaculture/backend-common",
              "message": "The root @aquaculture/backend-common barrel aggregates ~25 subtrees; importing from it forces every consumer to re-invalidate on any change to any subtree. Import from the specific sub-barrel instead — @aquaculture/backend-common/auth, /guards, /database, /utils, /nats, etc. The 2026-04-23 mass-codemod (AUDIT-MEDIUM-005) split all existing consumers, and this rule keeps it that way."
            },
            {
              "name": "@platform/backend-common",
              "message": "Same rationale as @aquaculture/backend-common — import from the specific sub-barrel (@platform/backend-common/<subtree>). Also note that @aquaculture/backend-common/<subtree> is the canonical alias platform-wide; @platform/backend-common exists as a parity alias used by only two files."
            }
          ]
        }
      ],
      "no-restricted-syntax": [
        "error",
        {
          "selector": "CallExpression[callee.property.name='getRepository']",
          "message": "Direct getRepository() bypasses TenantAwareRepository and skips tenantId injection on all find operations, creating IDOR vulnerabilities. Use getScopedRepository() instead. For cross-tenant admin operations, use getUnfilteredRepository() with explicit justification."
        },
        {
          "selector": "CallExpression[callee.object.name='JSON'][callee.property.name='stringify'][arguments.length>2]",
          "message": "JSON.stringify with an indent argument produces multi-line output that breaks structured JSON logging. Use the NestJS Logger — it calls StructuredLoggerService and emits a single JSON event per log."
        },
        {
          "selector": "CallExpression[callee.property.name='get'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). The platform migrated from HS256 (shared JWT_SECRET) to RS256 (auth-service signs with private key, every consumer verifies with public key) in commit 7c076361. Reintroducing JWT_SECRET reads recreates the algorithm-confusion + shared-secret-leak surface the migration eliminated. Token-CONSUMER services: import PlatformJwtModule from @aquaculture/backend-common (it wraps getJwtVerifyOptions which loads JWT_PUBLIC_KEY). Token-ISSUER (auth-service): use JWT_PRIVATE_KEY for signing; the dev-only fallback uses DEV_JWT_SECRET (a different env var)."
        },
        {
          "selector": "CallExpression[callee.property.name='getOrThrow'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). See the .get('JWT_SECRET') message above for the migration path: PlatformJwtModule for consumers, JWT_PRIVATE_KEY for the issuer. The 2026-04-14 hydroponics-service deploy outage was a configService.getOrThrow<string>('JWT_SECRET') call that crashed at boot when JWT_SECRET stopped being provisioned — this rule exists to prevent that recurrence."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='JWT_SECRET']",
          "message": "process.env.JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][computed=true][property.value='JWT_SECRET']",
          "message": "process.env['JWT_SECRET'] reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        }
      ],
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-dynamic-delete": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-inferrable-types": "off",
      "@typescript-eslint/no-invalid-void-type": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/only-throw-error": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/unbound-method": "off",
      "no-case-declarations": "off",
      "prefer-const": "off"
    },
    "testOverrides": []
  },
  {
    "dir": "apps/observability-service",
    "tsProjects": [
      "apps/observability-service/tsconfig.eslint.json"
    ],
    "rules": {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "import/order": "off",
      "@typescript-eslint/no-extraneous-class": "off",
      "no-console": "off",
      "no-restricted-imports": [
        "error",
        {
          "paths": [
            {
              "name": "@aquaculture/backend-common",
              "message": "The root @aquaculture/backend-common barrel aggregates ~25 subtrees; importing from it forces every consumer to re-invalidate on any change to any subtree. Import from the specific sub-barrel instead — @aquaculture/backend-common/auth, /guards, /database, /utils, /nats, etc. The 2026-04-23 mass-codemod (AUDIT-MEDIUM-005) split all existing consumers, and this rule keeps it that way."
            },
            {
              "name": "@platform/backend-common",
              "message": "Same rationale as @aquaculture/backend-common — import from the specific sub-barrel (@platform/backend-common/<subtree>). Also note that @aquaculture/backend-common/<subtree> is the canonical alias platform-wide; @platform/backend-common exists as a parity alias used by only two files."
            }
          ]
        }
      ],
      "no-restricted-syntax": [
        "error",
        {
          "selector": "CallExpression[callee.property.name='getRepository']",
          "message": "Direct getRepository() bypasses TenantAwareRepository and skips tenantId injection on all find operations, creating IDOR vulnerabilities. Use getScopedRepository() instead. For cross-tenant admin operations, use getUnfilteredRepository() with explicit justification."
        },
        {
          "selector": "CallExpression[callee.object.name='JSON'][callee.property.name='stringify'][arguments.length>2]",
          "message": "JSON.stringify with an indent argument produces multi-line output that breaks structured JSON logging. Use the NestJS Logger — it calls StructuredLoggerService and emits a single JSON event per log."
        },
        {
          "selector": "CallExpression[callee.property.name='get'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). The platform migrated from HS256 (shared JWT_SECRET) to RS256 (auth-service signs with private key, every consumer verifies with public key) in commit 7c076361. Reintroducing JWT_SECRET reads recreates the algorithm-confusion + shared-secret-leak surface the migration eliminated. Token-CONSUMER services: import PlatformJwtModule from @aquaculture/backend-common (it wraps getJwtVerifyOptions which loads JWT_PUBLIC_KEY). Token-ISSUER (auth-service): use JWT_PRIVATE_KEY for signing; the dev-only fallback uses DEV_JWT_SECRET (a different env var)."
        },
        {
          "selector": "CallExpression[callee.property.name='getOrThrow'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). See the .get('JWT_SECRET') message above for the migration path: PlatformJwtModule for consumers, JWT_PRIVATE_KEY for the issuer. The 2026-04-14 hydroponics-service deploy outage was a configService.getOrThrow<string>('JWT_SECRET') call that crashed at boot when JWT_SECRET stopped being provisioned — this rule exists to prevent that recurrence."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='JWT_SECRET']",
          "message": "process.env.JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][computed=true][property.value='JWT_SECRET']",
          "message": "process.env['JWT_SECRET'] reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        }
      ],
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-dynamic-delete": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-inferrable-types": "off",
      "@typescript-eslint/no-invalid-void-type": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/only-throw-error": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/unbound-method": "off",
      "no-case-declarations": "off",
      "prefer-const": "off"
    },
    "testOverrides": []
  },
  {
    "dir": "apps/sensor-service",
    "tsProjects": [
      "apps/sensor-service/tsconfig.eslint.json"
    ],
    "rules": {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "import/order": "off",
      "@typescript-eslint/no-extraneous-class": "off",
      "no-console": "off",
      "no-restricted-imports": [
        "error",
        {
          "paths": [
            {
              "name": "@aquaculture/backend-common",
              "message": "The root @aquaculture/backend-common barrel aggregates ~25 subtrees; importing from it forces every consumer to re-invalidate on any change to any subtree. Import from the specific sub-barrel instead — @aquaculture/backend-common/auth, /guards, /database, /utils, /nats, etc. The 2026-04-23 mass-codemod (AUDIT-MEDIUM-005) split all existing consumers, and this rule keeps it that way."
            },
            {
              "name": "@platform/backend-common",
              "message": "Same rationale as @aquaculture/backend-common — import from the specific sub-barrel (@platform/backend-common/<subtree>). Also note that @aquaculture/backend-common/<subtree> is the canonical alias platform-wide; @platform/backend-common exists as a parity alias used by only two files."
            }
          ]
        }
      ],
      "no-restricted-syntax": [
        "error",
        {
          "selector": "CallExpression[callee.property.name='getRepository']",
          "message": "Direct getRepository() bypasses TenantAwareRepository and skips tenantId injection on all find operations, creating IDOR vulnerabilities. Use getScopedRepository() instead. For cross-tenant admin operations, use getUnfilteredRepository() with explicit justification."
        },
        {
          "selector": "CallExpression[callee.object.name='JSON'][callee.property.name='stringify'][arguments.length>2]",
          "message": "JSON.stringify with an indent argument produces multi-line output that breaks structured JSON logging. Use the NestJS Logger — it calls StructuredLoggerService and emits a single JSON event per log."
        },
        {
          "selector": "CallExpression[callee.property.name='get'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). The platform migrated from HS256 (shared JWT_SECRET) to RS256 (auth-service signs with private key, every consumer verifies with public key) in commit 7c076361. Reintroducing JWT_SECRET reads recreates the algorithm-confusion + shared-secret-leak surface the migration eliminated. Token-CONSUMER services: import PlatformJwtModule from @aquaculture/backend-common (it wraps getJwtVerifyOptions which loads JWT_PUBLIC_KEY). Token-ISSUER (auth-service): use JWT_PRIVATE_KEY for signing; the dev-only fallback uses DEV_JWT_SECRET (a different env var)."
        },
        {
          "selector": "CallExpression[callee.property.name='getOrThrow'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). See the .get('JWT_SECRET') message above for the migration path: PlatformJwtModule for consumers, JWT_PRIVATE_KEY for the issuer. The 2026-04-14 hydroponics-service deploy outage was a configService.getOrThrow<string>('JWT_SECRET') call that crashed at boot when JWT_SECRET stopped being provisioned — this rule exists to prevent that recurrence."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='JWT_SECRET']",
          "message": "process.env.JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][computed=true][property.value='JWT_SECRET']",
          "message": "process.env['JWT_SECRET'] reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        }
      ],
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-dynamic-delete": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-inferrable-types": "off",
      "@typescript-eslint/no-invalid-void-type": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/only-throw-error": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/unbound-method": "off",
      "no-case-declarations": "off",
      "prefer-const": "off"
    },
    "testOverrides": []
  },
  {
    "dir": "libs/event-contracts",
    "tsProjects": [
      "libs/event-contracts/tsconfig.eslint.json"
    ],
    "rules": {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          "argsIgnorePattern": "^_",
          "varsIgnorePattern": "^_"
        }
      ],
      "@typescript-eslint/explicit-function-return-type": [
        "warn",
        {
          "allowExpressions": true,
          "allowTypedFunctionExpressions": true
        }
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "import/order": "off",
      "@typescript-eslint/no-extraneous-class": [
        "error",
        {
          "allowWithDecorator": true
        }
      ],
      "no-console": [
        "error"
      ],
      "no-restricted-imports": [
        "error",
        {
          "paths": [
            {
              "name": "@aquaculture/backend-common",
              "message": "The root @aquaculture/backend-common barrel aggregates ~25 subtrees; importing from it forces every consumer to re-invalidate on any change to any subtree. Import from the specific sub-barrel instead — @aquaculture/backend-common/auth, /guards, /database, /utils, /nats, etc. The 2026-04-23 mass-codemod (AUDIT-MEDIUM-005) split all existing consumers, and this rule keeps it that way."
            },
            {
              "name": "@platform/backend-common",
              "message": "Same rationale as @aquaculture/backend-common — import from the specific sub-barrel (@platform/backend-common/<subtree>). Also note that @aquaculture/backend-common/<subtree> is the canonical alias platform-wide; @platform/backend-common exists as a parity alias used by only two files."
            }
          ]
        }
      ],
      "no-restricted-syntax": [
        "error",
        {
          "selector": "CallExpression[callee.property.name='getRepository']",
          "message": "Direct getRepository() bypasses TenantAwareRepository and skips tenantId injection on all find operations, creating IDOR vulnerabilities. Use getScopedRepository() instead. For cross-tenant admin operations, use getUnfilteredRepository() with explicit justification."
        },
        {
          "selector": "CallExpression[callee.object.name='JSON'][callee.property.name='stringify'][arguments.length>2]",
          "message": "JSON.stringify with an indent argument produces multi-line output that breaks structured JSON logging. Use the NestJS Logger — it calls StructuredLoggerService and emits a single JSON event per log."
        },
        {
          "selector": "CallExpression[callee.property.name='get'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). The platform migrated from HS256 (shared JWT_SECRET) to RS256 (auth-service signs with private key, every consumer verifies with public key) in commit 7c076361. Reintroducing JWT_SECRET reads recreates the algorithm-confusion + shared-secret-leak surface the migration eliminated. Token-CONSUMER services: import PlatformJwtModule from @aquaculture/backend-common (it wraps getJwtVerifyOptions which loads JWT_PUBLIC_KEY). Token-ISSUER (auth-service): use JWT_PRIVATE_KEY for signing; the dev-only fallback uses DEV_JWT_SECRET (a different env var)."
        },
        {
          "selector": "CallExpression[callee.property.name='getOrThrow'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). See the .get('JWT_SECRET') message above for the migration path: PlatformJwtModule for consumers, JWT_PRIVATE_KEY for the issuer. The 2026-04-14 hydroponics-service deploy outage was a configService.getOrThrow<string>('JWT_SECRET') call that crashed at boot when JWT_SECRET stopped being provisioned — this rule exists to prevent that recurrence."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='JWT_SECRET']",
          "message": "process.env.JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][computed=true][property.value='JWT_SECRET']",
          "message": "process.env['JWT_SECRET'] reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        }
      ],
      "@typescript-eslint/no-unnecessary-type-assertion": "off"
    },
    "testOverrides": [
      {
        "files": [
          "src/**/*.spec.ts",
          "src/**/*.test.ts",
          "src/**/__tests__/**/*.ts"
        ],
        "rules": {
          "@typescript-eslint/no-dynamic-delete": "off",
          "@typescript-eslint/no-unsafe-assignment": "off"
        }
      }
    ]
  },
  {
    "dir": "libs/node-components",
    "tsProjects": [
      "libs/node-components/tsconfig.eslint.json"
    ],
    "rules": {
      "@nx/enforce-module-boundaries": [
        "error",
        {
          "enforceBuildableLibDependency": true,
          "allow": [
            "@aquaculture/shared-ui",
            "@aquaculture/shared-ui/*"
          ],
          "depConstraints": [
            {
              "sourceTag": "*",
              "onlyDependOnLibsWithTags": [
                "*"
              ]
            }
          ]
        }
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          "argsIgnorePattern": "^_",
          "varsIgnorePattern": "^_"
        }
      ],
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "import/order": [
        "error",
        {
          "groups": [
            "builtin",
            "external",
            "internal",
            "parent",
            "sibling",
            "index"
          ],
          "newlines-between": "always",
          "alphabetize": {
            "order": "asc",
            "caseInsensitive": true
          }
        }
      ],
      "@typescript-eslint/no-extraneous-class": [
        "error",
        {
          "allowWithDecorator": true
        }
      ],
      "no-console": [
        "error"
      ],
      "no-restricted-imports": [
        "error",
        {
          "paths": [
            {
              "name": "@aquaculture/backend-common",
              "message": "The root @aquaculture/backend-common barrel aggregates ~25 subtrees; importing from it forces every consumer to re-invalidate on any change to any subtree. Import from the specific sub-barrel instead — @aquaculture/backend-common/auth, /guards, /database, /utils, /nats, etc. The 2026-04-23 mass-codemod (AUDIT-MEDIUM-005) split all existing consumers, and this rule keeps it that way."
            },
            {
              "name": "@platform/backend-common",
              "message": "Same rationale as @aquaculture/backend-common — import from the specific sub-barrel (@platform/backend-common/<subtree>). Also note that @aquaculture/backend-common/<subtree> is the canonical alias platform-wide; @platform/backend-common exists as a parity alias used by only two files."
            }
          ]
        }
      ],
      "no-restricted-syntax": [
        "error",
        {
          "selector": "CallExpression[callee.property.name='getRepository']",
          "message": "Direct getRepository() bypasses TenantAwareRepository and skips tenantId injection on all find operations, creating IDOR vulnerabilities. Use getScopedRepository() instead. For cross-tenant admin operations, use getUnfilteredRepository() with explicit justification."
        },
        {
          "selector": "CallExpression[callee.object.name='JSON'][callee.property.name='stringify'][arguments.length>2]",
          "message": "JSON.stringify with an indent argument produces multi-line output that breaks structured JSON logging. Use the NestJS Logger — it calls StructuredLoggerService and emits a single JSON event per log."
        },
        {
          "selector": "CallExpression[callee.property.name='get'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). The platform migrated from HS256 (shared JWT_SECRET) to RS256 (auth-service signs with private key, every consumer verifies with public key) in commit 7c076361. Reintroducing JWT_SECRET reads recreates the algorithm-confusion + shared-secret-leak surface the migration eliminated. Token-CONSUMER services: import PlatformJwtModule from @aquaculture/backend-common (it wraps getJwtVerifyOptions which loads JWT_PUBLIC_KEY). Token-ISSUER (auth-service): use JWT_PRIVATE_KEY for signing; the dev-only fallback uses DEV_JWT_SECRET (a different env var)."
        },
        {
          "selector": "CallExpression[callee.property.name='getOrThrow'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). See the .get('JWT_SECRET') message above for the migration path: PlatformJwtModule for consumers, JWT_PRIVATE_KEY for the issuer. The 2026-04-14 hydroponics-service deploy outage was a configService.getOrThrow<string>('JWT_SECRET') call that crashed at boot when JWT_SECRET stopped being provisioned — this rule exists to prevent that recurrence."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='JWT_SECRET']",
          "message": "process.env.JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][computed=true][property.value='JWT_SECRET']",
          "message": "process.env['JWT_SECRET'] reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        }
      ]
    },
    "testOverrides": []
  },
  {
    "dir": "mcp/farm-management",
    "tsProjects": [
      "mcp/farm-management/tsconfig.eslint.json"
    ],
    "rules": {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          "argsIgnorePattern": "^_",
          "varsIgnorePattern": "^_"
        }
      ],
      "@typescript-eslint/explicit-function-return-type": [
        "warn",
        {
          "allowExpressions": true,
          "allowTypedFunctionExpressions": true
        }
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "import/order": [
        "error",
        {
          "groups": [
            "builtin",
            "external",
            "internal",
            "parent",
            "sibling",
            "index"
          ],
          "newlines-between": "always",
          "alphabetize": {
            "order": "asc",
            "caseInsensitive": true
          }
        }
      ],
      "@typescript-eslint/no-extraneous-class": [
        "error",
        {
          "allowWithDecorator": true
        }
      ],
      "no-console": [
        "error"
      ],
      "no-restricted-imports": [
        "error",
        {
          "paths": [
            {
              "name": "@aquaculture/backend-common",
              "message": "The root @aquaculture/backend-common barrel aggregates ~25 subtrees; importing from it forces every consumer to re-invalidate on any change to any subtree. Import from the specific sub-barrel instead — @aquaculture/backend-common/auth, /guards, /database, /utils, /nats, etc. The 2026-04-23 mass-codemod (AUDIT-MEDIUM-005) split all existing consumers, and this rule keeps it that way."
            },
            {
              "name": "@platform/backend-common",
              "message": "Same rationale as @aquaculture/backend-common — import from the specific sub-barrel (@platform/backend-common/<subtree>). Also note that @aquaculture/backend-common/<subtree> is the canonical alias platform-wide; @platform/backend-common exists as a parity alias used by only two files."
            }
          ]
        }
      ],
      "no-restricted-syntax": [
        "error",
        {
          "selector": "CallExpression[callee.property.name='getRepository']",
          "message": "Direct getRepository() bypasses TenantAwareRepository and skips tenantId injection on all find operations, creating IDOR vulnerabilities. Use getScopedRepository() instead. For cross-tenant admin operations, use getUnfilteredRepository() with explicit justification."
        },
        {
          "selector": "CallExpression[callee.object.name='JSON'][callee.property.name='stringify'][arguments.length>2]",
          "message": "JSON.stringify with an indent argument produces multi-line output that breaks structured JSON logging. Use the NestJS Logger — it calls StructuredLoggerService and emits a single JSON event per log."
        },
        {
          "selector": "CallExpression[callee.property.name='get'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). The platform migrated from HS256 (shared JWT_SECRET) to RS256 (auth-service signs with private key, every consumer verifies with public key) in commit 7c076361. Reintroducing JWT_SECRET reads recreates the algorithm-confusion + shared-secret-leak surface the migration eliminated. Token-CONSUMER services: import PlatformJwtModule from @aquaculture/backend-common (it wraps getJwtVerifyOptions which loads JWT_PUBLIC_KEY). Token-ISSUER (auth-service): use JWT_PRIVATE_KEY for signing; the dev-only fallback uses DEV_JWT_SECRET (a different env var)."
        },
        {
          "selector": "CallExpression[callee.property.name='getOrThrow'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). See the .get('JWT_SECRET') message above for the migration path: PlatformJwtModule for consumers, JWT_PRIVATE_KEY for the issuer. The 2026-04-14 hydroponics-service deploy outage was a configService.getOrThrow<string>('JWT_SECRET') call that crashed at boot when JWT_SECRET stopped being provisioned — this rule exists to prevent that recurrence."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='JWT_SECRET']",
          "message": "process.env.JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][computed=true][property.value='JWT_SECRET']",
          "message": "process.env['JWT_SECRET'] reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        }
      ]
    },
    "testOverrides": [
      {
        "files": [
          "src/__tests__/**/*.ts"
        ],
        "rules": {
          "@typescript-eslint/no-non-null-assertion": "off",
          "@typescript-eslint/no-explicit-any": "off",
          "@typescript-eslint/no-unsafe-argument": "off",
          "@typescript-eslint/no-unsafe-assignment": "off",
          "@typescript-eslint/no-unsafe-member-access": "off",
          "@typescript-eslint/no-unused-vars": "off",
          "@typescript-eslint/explicit-function-return-type": "off",
          "no-console": "off"
        }
      },
      {
        "files": [
          "src/tools/**/*.ts"
        ],
        "rules": {
          "@typescript-eslint/no-explicit-any": "off",
          "@typescript-eslint/no-non-null-assertion": "off",
          "@typescript-eslint/no-unsafe-argument": "off",
          "@typescript-eslint/no-unsafe-assignment": "off",
          "@typescript-eslint/no-unsafe-member-access": "off",
          "@typescript-eslint/no-unsafe-return": "off",
          "@typescript-eslint/no-unused-vars": "off",
          "@typescript-eslint/require-await": "off",
          "@typescript-eslint/restrict-template-expressions": "off",
          "import/order": "off"
        }
      },
      {
        "files": [
          "src/server.ts"
        ],
        "rules": {
          "@typescript-eslint/no-unused-vars": "off",
          "@typescript-eslint/require-await": "off"
        }
      },
      {
        "files": [
          "src/analytics/**/*.ts",
          "src/auth/session-context.ts",
          "src/graphql/client.ts",
          "src/knowledge/**/*.ts"
        ],
        "rules": {
          "@typescript-eslint/no-non-null-assertion": "off",
          "@typescript-eslint/no-unused-vars": "off"
        }
      },
      {
        "files": [
          "src/index.ts"
        ],
        "rules": {
          "no-console": [
            "error",
            {
              "allow": [
                "error"
              ]
            }
          ]
        }
      },
      {
        "files": [
          "src/utils/stats.ts"
        ],
        "rules": {
          "@typescript-eslint/no-non-null-assertion": "off"
        }
      },
      {
        "files": [
          "src/utils/logger.ts"
        ],
        "rules": {
          "no-console": [
            "error",
            {
              "allow": [
                "error"
              ]
            }
          ]
        }
      }
    ]
  },
  {
    "dir": "scripts",
    "tsProjects": [
      "scripts/tsconfig.eslint.json"
    ],
    "rules": {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "import/order": "off",
      "@typescript-eslint/no-extraneous-class": [
        "error",
        {
          "allowWithDecorator": true
        }
      ],
      "no-console": "off",
      "no-restricted-imports": [
        "error",
        {
          "paths": [
            {
              "name": "@aquaculture/backend-common",
              "message": "The root @aquaculture/backend-common barrel aggregates ~25 subtrees; importing from it forces every consumer to re-invalidate on any change to any subtree. Import from the specific sub-barrel instead — @aquaculture/backend-common/auth, /guards, /database, /utils, /nats, etc. The 2026-04-23 mass-codemod (AUDIT-MEDIUM-005) split all existing consumers, and this rule keeps it that way."
            },
            {
              "name": "@platform/backend-common",
              "message": "Same rationale as @aquaculture/backend-common — import from the specific sub-barrel (@platform/backend-common/<subtree>). Also note that @aquaculture/backend-common/<subtree> is the canonical alias platform-wide; @platform/backend-common exists as a parity alias used by only two files."
            }
          ]
        }
      ],
      "no-restricted-syntax": [
        "error",
        {
          "selector": "CallExpression[callee.property.name='getRepository']",
          "message": "Direct getRepository() bypasses TenantAwareRepository and skips tenantId injection on all find operations, creating IDOR vulnerabilities. Use getScopedRepository() instead. For cross-tenant admin operations, use getUnfilteredRepository() with explicit justification."
        },
        {
          "selector": "CallExpression[callee.object.name='JSON'][callee.property.name='stringify'][arguments.length>2]",
          "message": "JSON.stringify with an indent argument produces multi-line output that breaks structured JSON logging. Use the NestJS Logger — it calls StructuredLoggerService and emits a single JSON event per log."
        },
        {
          "selector": "CallExpression[callee.property.name='get'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). The platform migrated from HS256 (shared JWT_SECRET) to RS256 (auth-service signs with private key, every consumer verifies with public key) in commit 7c076361. Reintroducing JWT_SECRET reads recreates the algorithm-confusion + shared-secret-leak surface the migration eliminated. Token-CONSUMER services: import PlatformJwtModule from @aquaculture/backend-common (it wraps getJwtVerifyOptions which loads JWT_PUBLIC_KEY). Token-ISSUER (auth-service): use JWT_PRIVATE_KEY for signing; the dev-only fallback uses DEV_JWT_SECRET (a different env var)."
        },
        {
          "selector": "CallExpression[callee.property.name='getOrThrow'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). See the .get('JWT_SECRET') message above for the migration path: PlatformJwtModule for consumers, JWT_PRIVATE_KEY for the issuer. The 2026-04-14 hydroponics-service deploy outage was a configService.getOrThrow<string>('JWT_SECRET') call that crashed at boot when JWT_SECRET stopped being provisioned — this rule exists to prevent that recurrence."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='JWT_SECRET']",
          "message": "process.env.JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][computed=true][property.value='JWT_SECRET']",
          "message": "process.env['JWT_SECRET'] reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        }
      ],
      "@nx/enforce-module-boundaries": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/restrict-template-expressions": "off"
    },
    "testOverrides": []
  },
  {
    "dir": "tests/invariants",
    "tsProjects": [
      "tests/invariants/tsconfig.eslint.json"
    ],
    "rules": {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "import/order": "off",
      "@typescript-eslint/no-extraneous-class": [
        "error",
        {
          "allowWithDecorator": true
        }
      ],
      "no-console": "off",
      "no-restricted-imports": [
        "error",
        {
          "paths": [
            {
              "name": "@aquaculture/backend-common",
              "message": "The root @aquaculture/backend-common barrel aggregates ~25 subtrees; importing from it forces every consumer to re-invalidate on any change to any subtree. Import from the specific sub-barrel instead — @aquaculture/backend-common/auth, /guards, /database, /utils, /nats, etc. The 2026-04-23 mass-codemod (AUDIT-MEDIUM-005) split all existing consumers, and this rule keeps it that way."
            },
            {
              "name": "@platform/backend-common",
              "message": "Same rationale as @aquaculture/backend-common — import from the specific sub-barrel (@platform/backend-common/<subtree>). Also note that @aquaculture/backend-common/<subtree> is the canonical alias platform-wide; @platform/backend-common exists as a parity alias used by only two files."
            }
          ]
        }
      ],
      "no-restricted-syntax": [
        "error",
        {
          "selector": "CallExpression[callee.property.name='getRepository']",
          "message": "Direct getRepository() bypasses TenantAwareRepository and skips tenantId injection on all find operations, creating IDOR vulnerabilities. Use getScopedRepository() instead. For cross-tenant admin operations, use getUnfilteredRepository() with explicit justification."
        },
        {
          "selector": "CallExpression[callee.object.name='JSON'][callee.property.name='stringify'][arguments.length>2]",
          "message": "JSON.stringify with an indent argument produces multi-line output that breaks structured JSON logging. Use the NestJS Logger — it calls StructuredLoggerService and emits a single JSON event per log."
        },
        {
          "selector": "CallExpression[callee.property.name='get'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). The platform migrated from HS256 (shared JWT_SECRET) to RS256 (auth-service signs with private key, every consumer verifies with public key) in commit 7c076361. Reintroducing JWT_SECRET reads recreates the algorithm-confusion + shared-secret-leak surface the migration eliminated. Token-CONSUMER services: import PlatformJwtModule from @aquaculture/backend-common (it wraps getJwtVerifyOptions which loads JWT_PUBLIC_KEY). Token-ISSUER (auth-service): use JWT_PRIVATE_KEY for signing; the dev-only fallback uses DEV_JWT_SECRET (a different env var)."
        },
        {
          "selector": "CallExpression[callee.property.name='getOrThrow'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). See the .get('JWT_SECRET') message above for the migration path: PlatformJwtModule for consumers, JWT_PRIVATE_KEY for the issuer. The 2026-04-14 hydroponics-service deploy outage was a configService.getOrThrow<string>('JWT_SECRET') call that crashed at boot when JWT_SECRET stopped being provisioned — this rule exists to prevent that recurrence."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='JWT_SECRET']",
          "message": "process.env.JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][computed=true][property.value='JWT_SECRET']",
          "message": "process.env['JWT_SECRET'] reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        }
      ],
      "@nx/enforce-module-boundaries": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-dynamic-delete": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-inferrable-types": "off",
      "@typescript-eslint/no-invalid-void-type": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/only-throw-error": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/unbound-method": "off",
      "no-case-declarations": "off",
      "prefer-const": "off"
    },
    "testOverrides": []
  },
  {
    "dir": "tools/eslint-rules",
    "tsProjects": [
      "tools/eslint-rules/tsconfig.json"
    ],
    "rules": {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          "argsIgnorePattern": "^_",
          "varsIgnorePattern": "^_"
        }
      ],
      "@typescript-eslint/explicit-function-return-type": [
        "warn",
        {
          "allowExpressions": true,
          "allowTypedFunctionExpressions": true
        }
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "import/order": [
        "error",
        {
          "groups": [
            "builtin",
            "external",
            "internal",
            "parent",
            "sibling",
            "index"
          ],
          "newlines-between": "always",
          "alphabetize": {
            "order": "asc",
            "caseInsensitive": true
          }
        }
      ],
      "@typescript-eslint/no-extraneous-class": [
        "error",
        {
          "allowWithDecorator": true
        }
      ],
      "no-console": [
        "error"
      ],
      "no-restricted-imports": [
        "error",
        {
          "paths": [
            {
              "name": "@aquaculture/backend-common",
              "message": "The root @aquaculture/backend-common barrel aggregates ~25 subtrees; importing from it forces every consumer to re-invalidate on any change to any subtree. Import from the specific sub-barrel instead — @aquaculture/backend-common/auth, /guards, /database, /utils, /nats, etc. The 2026-04-23 mass-codemod (AUDIT-MEDIUM-005) split all existing consumers, and this rule keeps it that way."
            },
            {
              "name": "@platform/backend-common",
              "message": "Same rationale as @aquaculture/backend-common — import from the specific sub-barrel (@platform/backend-common/<subtree>). Also note that @aquaculture/backend-common/<subtree> is the canonical alias platform-wide; @platform/backend-common exists as a parity alias used by only two files."
            }
          ]
        }
      ],
      "no-restricted-syntax": [
        "error",
        {
          "selector": "CallExpression[callee.property.name='getRepository']",
          "message": "Direct getRepository() bypasses TenantAwareRepository and skips tenantId injection on all find operations, creating IDOR vulnerabilities. Use getScopedRepository() instead. For cross-tenant admin operations, use getUnfilteredRepository() with explicit justification."
        },
        {
          "selector": "CallExpression[callee.object.name='JSON'][callee.property.name='stringify'][arguments.length>2]",
          "message": "JSON.stringify with an indent argument produces multi-line output that breaks structured JSON logging. Use the NestJS Logger — it calls StructuredLoggerService and emits a single JSON event per log."
        },
        {
          "selector": "CallExpression[callee.property.name='get'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). The platform migrated from HS256 (shared JWT_SECRET) to RS256 (auth-service signs with private key, every consumer verifies with public key) in commit 7c076361. Reintroducing JWT_SECRET reads recreates the algorithm-confusion + shared-secret-leak surface the migration eliminated. Token-CONSUMER services: import PlatformJwtModule from @aquaculture/backend-common (it wraps getJwtVerifyOptions which loads JWT_PUBLIC_KEY). Token-ISSUER (auth-service): use JWT_PRIVATE_KEY for signing; the dev-only fallback uses DEV_JWT_SECRET (a different env var)."
        },
        {
          "selector": "CallExpression[callee.property.name='getOrThrow'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). See the .get('JWT_SECRET') message above for the migration path: PlatformJwtModule for consumers, JWT_PRIVATE_KEY for the issuer. The 2026-04-14 hydroponics-service deploy outage was a configService.getOrThrow<string>('JWT_SECRET') call that crashed at boot when JWT_SECRET stopped being provisioned — this rule exists to prevent that recurrence."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='JWT_SECRET']",
          "message": "process.env.JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][computed=true][property.value='JWT_SECRET']",
          "message": "process.env['JWT_SECRET'] reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        }
      ],
      "@typescript-eslint/no-unsafe-enum-comparison": "off"
    },
    "testOverrides": []
  },
  {
    "dir": "web/modules/admin-panel",
    "tsProjects": [
      "web/modules/admin-panel/tsconfig.eslint.json"
    ],
    "rules": {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "import/order": "off",
      "@typescript-eslint/no-extraneous-class": [
        "error",
        {
          "allowWithDecorator": true
        }
      ],
      "no-console": "off",
      "no-restricted-imports": [
        "error",
        {
          "paths": [
            {
              "name": "@aquaculture/backend-common",
              "message": "The root @aquaculture/backend-common barrel aggregates ~25 subtrees; importing from it forces every consumer to re-invalidate on any change to any subtree. Import from the specific sub-barrel instead — @aquaculture/backend-common/auth, /guards, /database, /utils, /nats, etc. The 2026-04-23 mass-codemod (AUDIT-MEDIUM-005) split all existing consumers, and this rule keeps it that way."
            },
            {
              "name": "@platform/backend-common",
              "message": "Same rationale as @aquaculture/backend-common — import from the specific sub-barrel (@platform/backend-common/<subtree>). Also note that @aquaculture/backend-common/<subtree> is the canonical alias platform-wide; @platform/backend-common exists as a parity alias used by only two files."
            }
          ]
        }
      ],
      "no-restricted-syntax": "off",
      "@typescript-eslint/no-dynamic-delete": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-invalid-void-type": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/unbound-method": "off",
      "jsx-a11y/click-events-have-key-events": "off",
      "jsx-a11y/label-has-associated-control": "off",
      "jsx-a11y/no-autofocus": "off",
      "jsx-a11y/no-static-element-interactions": "off",
      "react/display-name": "off",
      "react-hooks/exhaustive-deps": "off"
    },
    "testOverrides": []
  },
  {
    "dir": "web/modules/dashboard",
    "tsProjects": [
      "web/modules/dashboard/tsconfig.eslint.json"
    ],
    "rules": {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        {
          "checksVoidReturn": {
            "attributes": false
          }
        }
      ],
      "import/order": "off",
      "@typescript-eslint/no-extraneous-class": [
        "error",
        {
          "allowWithDecorator": true
        }
      ],
      "no-console": [
        "error"
      ],
      "no-restricted-imports": [
        "error",
        {
          "paths": [
            {
              "name": "@aquaculture/backend-common",
              "message": "The root @aquaculture/backend-common barrel aggregates ~25 subtrees; importing from it forces every consumer to re-invalidate on any change to any subtree. Import from the specific sub-barrel instead — @aquaculture/backend-common/auth, /guards, /database, /utils, /nats, etc. The 2026-04-23 mass-codemod (AUDIT-MEDIUM-005) split all existing consumers, and this rule keeps it that way."
            },
            {
              "name": "@platform/backend-common",
              "message": "Same rationale as @aquaculture/backend-common — import from the specific sub-barrel (@platform/backend-common/<subtree>). Also note that @aquaculture/backend-common/<subtree> is the canonical alias platform-wide; @platform/backend-common exists as a parity alias used by only two files."
            }
          ]
        }
      ],
      "no-restricted-syntax": [
        "error",
        {
          "selector": "CallExpression[callee.property.name='getRepository']",
          "message": "Direct getRepository() bypasses TenantAwareRepository and skips tenantId injection on all find operations, creating IDOR vulnerabilities. Use getScopedRepository() instead. For cross-tenant admin operations, use getUnfilteredRepository() with explicit justification."
        },
        {
          "selector": "CallExpression[callee.object.name='JSON'][callee.property.name='stringify'][arguments.length>2]",
          "message": "JSON.stringify with an indent argument produces multi-line output that breaks structured JSON logging. Use the NestJS Logger — it calls StructuredLoggerService and emits a single JSON event per log."
        },
        {
          "selector": "CallExpression[callee.property.name='get'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). The platform migrated from HS256 (shared JWT_SECRET) to RS256 (auth-service signs with private key, every consumer verifies with public key) in commit 7c076361. Reintroducing JWT_SECRET reads recreates the algorithm-confusion + shared-secret-leak surface the migration eliminated. Token-CONSUMER services: import PlatformJwtModule from @aquaculture/backend-common (it wraps getJwtVerifyOptions which loads JWT_PUBLIC_KEY). Token-ISSUER (auth-service): use JWT_PRIVATE_KEY for signing; the dev-only fallback uses DEV_JWT_SECRET (a different env var)."
        },
        {
          "selector": "CallExpression[callee.property.name='getOrThrow'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). See the .get('JWT_SECRET') message above for the migration path: PlatformJwtModule for consumers, JWT_PRIVATE_KEY for the issuer. The 2026-04-14 hydroponics-service deploy outage was a configService.getOrThrow<string>('JWT_SECRET') call that crashed at boot when JWT_SECRET stopped being provisioned — this rule exists to prevent that recurrence."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='JWT_SECRET']",
          "message": "process.env.JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][computed=true][property.value='JWT_SECRET']",
          "message": "process.env['JWT_SECRET'] reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        }
      ],
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "off"
    },
    "testOverrides": [
      {
        "files": [
          "src/**/*.spec.ts",
          "src/**/*.test.ts",
          "src/**/__tests__/**/*"
        ],
        "rules": {
          "@typescript-eslint/no-floating-promises": "off",
          "@typescript-eslint/no-explicit-any": "off"
        }
      }
    ]
  },
  {
    "dir": "web/modules/farm-module",
    "tsProjects": [
      "web/modules/farm-module/tsconfig.eslint.json"
    ],
    "rules": {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "import/order": "off",
      "@typescript-eslint/no-extraneous-class": [
        "error",
        {
          "allowWithDecorator": true
        }
      ],
      "no-console": "off",
      "no-restricted-imports": [
        "error",
        {
          "paths": [
            {
              "name": "@aquaculture/backend-common",
              "message": "The root @aquaculture/backend-common barrel aggregates ~25 subtrees; importing from it forces every consumer to re-invalidate on any change to any subtree. Import from the specific sub-barrel instead — @aquaculture/backend-common/auth, /guards, /database, /utils, /nats, etc. The 2026-04-23 mass-codemod (AUDIT-MEDIUM-005) split all existing consumers, and this rule keeps it that way."
            },
            {
              "name": "@platform/backend-common",
              "message": "Same rationale as @aquaculture/backend-common — import from the specific sub-barrel (@platform/backend-common/<subtree>). Also note that @aquaculture/backend-common/<subtree> is the canonical alias platform-wide; @platform/backend-common exists as a parity alias used by only two files."
            }
          ]
        }
      ],
      "no-restricted-syntax": [
        "error",
        {
          "selector": "CallExpression[callee.property.name='getRepository']",
          "message": "Direct getRepository() bypasses TenantAwareRepository and skips tenantId injection on all find operations, creating IDOR vulnerabilities. Use getScopedRepository() instead. For cross-tenant admin operations, use getUnfilteredRepository() with explicit justification."
        },
        {
          "selector": "CallExpression[callee.object.name='JSON'][callee.property.name='stringify'][arguments.length>2]",
          "message": "JSON.stringify with an indent argument produces multi-line output that breaks structured JSON logging. Use the NestJS Logger — it calls StructuredLoggerService and emits a single JSON event per log."
        },
        {
          "selector": "CallExpression[callee.property.name='get'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). The platform migrated from HS256 (shared JWT_SECRET) to RS256 (auth-service signs with private key, every consumer verifies with public key) in commit 7c076361. Reintroducing JWT_SECRET reads recreates the algorithm-confusion + shared-secret-leak surface the migration eliminated. Token-CONSUMER services: import PlatformJwtModule from @aquaculture/backend-common (it wraps getJwtVerifyOptions which loads JWT_PUBLIC_KEY). Token-ISSUER (auth-service): use JWT_PRIVATE_KEY for signing; the dev-only fallback uses DEV_JWT_SECRET (a different env var)."
        },
        {
          "selector": "CallExpression[callee.property.name='getOrThrow'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). See the .get('JWT_SECRET') message above for the migration path: PlatformJwtModule for consumers, JWT_PRIVATE_KEY for the issuer. The 2026-04-14 hydroponics-service deploy outage was a configService.getOrThrow<string>('JWT_SECRET') call that crashed at boot when JWT_SECRET stopped being provisioned — this rule exists to prevent that recurrence."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='JWT_SECRET']",
          "message": "process.env.JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][computed=true][property.value='JWT_SECRET']",
          "message": "process.env['JWT_SECRET'] reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        }
      ],
      "@typescript-eslint/no-inferrable-types": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-dynamic-delete": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/restrict-plus-operands": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "jsx-a11y/click-events-have-key-events": "off",
      "jsx-a11y/label-has-associated-control": "off",
      "jsx-a11y/no-autofocus": "off",
      "jsx-a11y/no-static-element-interactions": "off",
      "no-case-declarations": "off",
      "react/no-unescaped-entities": "off",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "off"
    },
    "testOverrides": []
  },
  {
    "dir": "web/modules/hr-module",
    "tsProjects": [
      "web/modules/hr-module/tsconfig.eslint.json"
    ],
    "rules": {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "import/order": "off",
      "@typescript-eslint/no-extraneous-class": [
        "error",
        {
          "allowWithDecorator": true
        }
      ],
      "no-console": "off",
      "no-restricted-imports": [
        "error",
        {
          "paths": [
            {
              "name": "@aquaculture/backend-common",
              "message": "The root @aquaculture/backend-common barrel aggregates ~25 subtrees; importing from it forces every consumer to re-invalidate on any change to any subtree. Import from the specific sub-barrel instead — @aquaculture/backend-common/auth, /guards, /database, /utils, /nats, etc. The 2026-04-23 mass-codemod (AUDIT-MEDIUM-005) split all existing consumers, and this rule keeps it that way."
            },
            {
              "name": "@platform/backend-common",
              "message": "Same rationale as @aquaculture/backend-common — import from the specific sub-barrel (@platform/backend-common/<subtree>). Also note that @aquaculture/backend-common/<subtree> is the canonical alias platform-wide; @platform/backend-common exists as a parity alias used by only two files."
            }
          ]
        }
      ],
      "no-restricted-syntax": [
        "error",
        {
          "selector": "CallExpression[callee.property.name='getRepository']",
          "message": "Direct getRepository() bypasses TenantAwareRepository and skips tenantId injection on all find operations, creating IDOR vulnerabilities. Use getScopedRepository() instead. For cross-tenant admin operations, use getUnfilteredRepository() with explicit justification."
        },
        {
          "selector": "CallExpression[callee.object.name='JSON'][callee.property.name='stringify'][arguments.length>2]",
          "message": "JSON.stringify with an indent argument produces multi-line output that breaks structured JSON logging. Use the NestJS Logger — it calls StructuredLoggerService and emits a single JSON event per log."
        },
        {
          "selector": "CallExpression[callee.property.name='get'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). The platform migrated from HS256 (shared JWT_SECRET) to RS256 (auth-service signs with private key, every consumer verifies with public key) in commit 7c076361. Reintroducing JWT_SECRET reads recreates the algorithm-confusion + shared-secret-leak surface the migration eliminated. Token-CONSUMER services: import PlatformJwtModule from @aquaculture/backend-common (it wraps getJwtVerifyOptions which loads JWT_PUBLIC_KEY). Token-ISSUER (auth-service): use JWT_PRIVATE_KEY for signing; the dev-only fallback uses DEV_JWT_SECRET (a different env var)."
        },
        {
          "selector": "CallExpression[callee.property.name='getOrThrow'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). See the .get('JWT_SECRET') message above for the migration path: PlatformJwtModule for consumers, JWT_PRIVATE_KEY for the issuer. The 2026-04-14 hydroponics-service deploy outage was a configService.getOrThrow<string>('JWT_SECRET') call that crashed at boot when JWT_SECRET stopped being provisioned — this rule exists to prevent that recurrence."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='JWT_SECRET']",
          "message": "process.env.JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][computed=true][property.value='JWT_SECRET']",
          "message": "process.env['JWT_SECRET'] reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        }
      ],
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-dynamic-delete": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-inferrable-types": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/restrict-plus-operands": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "jsx-a11y/click-events-have-key-events": "off",
      "jsx-a11y/label-has-associated-control": "off",
      "jsx-a11y/no-autofocus": "off",
      "jsx-a11y/no-static-element-interactions": "off",
      "no-case-declarations": "off",
      "react/no-unescaped-entities": "off",
      "react-hooks/exhaustive-deps": "off",
      "react-hooks/rules-of-hooks": "error"
    },
    "testOverrides": []
  },
  {
    "dir": "web/modules/hydroponics-module",
    "tsProjects": [
      "web/modules/hydroponics-module/tsconfig.eslint.json"
    ],
    "rules": {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "import/order": "off",
      "@typescript-eslint/no-extraneous-class": [
        "error",
        {
          "allowWithDecorator": true
        }
      ],
      "no-console": "off",
      "no-restricted-imports": [
        "error",
        {
          "paths": [
            {
              "name": "@aquaculture/backend-common",
              "message": "The root @aquaculture/backend-common barrel aggregates ~25 subtrees; importing from it forces every consumer to re-invalidate on any change to any subtree. Import from the specific sub-barrel instead — @aquaculture/backend-common/auth, /guards, /database, /utils, /nats, etc. The 2026-04-23 mass-codemod (AUDIT-MEDIUM-005) split all existing consumers, and this rule keeps it that way."
            },
            {
              "name": "@platform/backend-common",
              "message": "Same rationale as @aquaculture/backend-common — import from the specific sub-barrel (@platform/backend-common/<subtree>). Also note that @aquaculture/backend-common/<subtree> is the canonical alias platform-wide; @platform/backend-common exists as a parity alias used by only two files."
            }
          ]
        }
      ],
      "no-restricted-syntax": [
        "error",
        {
          "selector": "CallExpression[callee.property.name='getRepository']",
          "message": "Direct getRepository() bypasses TenantAwareRepository and skips tenantId injection on all find operations, creating IDOR vulnerabilities. Use getScopedRepository() instead. For cross-tenant admin operations, use getUnfilteredRepository() with explicit justification."
        },
        {
          "selector": "CallExpression[callee.object.name='JSON'][callee.property.name='stringify'][arguments.length>2]",
          "message": "JSON.stringify with an indent argument produces multi-line output that breaks structured JSON logging. Use the NestJS Logger — it calls StructuredLoggerService and emits a single JSON event per log."
        },
        {
          "selector": "CallExpression[callee.property.name='get'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). The platform migrated from HS256 (shared JWT_SECRET) to RS256 (auth-service signs with private key, every consumer verifies with public key) in commit 7c076361. Reintroducing JWT_SECRET reads recreates the algorithm-confusion + shared-secret-leak surface the migration eliminated. Token-CONSUMER services: import PlatformJwtModule from @aquaculture/backend-common (it wraps getJwtVerifyOptions which loads JWT_PUBLIC_KEY). Token-ISSUER (auth-service): use JWT_PRIVATE_KEY for signing; the dev-only fallback uses DEV_JWT_SECRET (a different env var)."
        },
        {
          "selector": "CallExpression[callee.property.name='getOrThrow'][arguments.0.value='JWT_SECRET']",
          "message": "JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). See the .get('JWT_SECRET') message above for the migration path: PlatformJwtModule for consumers, JWT_PRIVATE_KEY for the issuer. The 2026-04-14 hydroponics-service deploy outage was a configService.getOrThrow<string>('JWT_SECRET') call that crashed at boot when JWT_SECRET stopped being provisioned — this rule exists to prevent that recurrence."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='JWT_SECRET']",
          "message": "process.env.JWT_SECRET reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        },
        {
          "selector": "MemberExpression[object.object.name='process'][object.property.name='env'][computed=true][property.value='JWT_SECRET']",
          "message": "process.env['JWT_SECRET'] reads are banned (WS2.C / ADR-016 Phase B). Use PlatformJwtModule (consumer services) or JWT_PRIVATE_KEY (auth-service issuer)."
        }
      ],
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-dynamic-delete": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-inferrable-types": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/restrict-plus-operands": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "jsx-a11y/click-events-have-key-events": "off",
      "jsx-a11y/label-has-associated-control": "off",
      "jsx-a11y/no-autofocus": "off",
      "jsx-a11y/no-static-element-interactions": "off",
      "no-case-declarations": "off",
      "react/no-unescaped-entities": "off",
      "react-hooks/exhaustive-deps": "off",
      "react-hooks/rules-of-hooks": "error"
    },
    "testOverrides": []
  },
  {
    "dir": "web/modules/sensor-module",
    "tsProjects": [
      "web/modules/sensor-module/tsconfig.eslint.json"
    ],
    "rules": {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "import/order": "off",
      "@typescript-eslint/no-extraneous-class": [
        "error",
        {
          "allowWithDecorator": true
        }
      ],
      "no-console": "off",
      "no-restricted-imports": [
        "error",
        {
          "paths": [
            {
              "name": "@aquaculture/backend-common",
              "message": "The root @aquaculture/backend-common barrel aggregates ~25 subtrees; importing from it forces every consumer to re-invalidate on any change to any subtree. Import from the specific sub-barrel instead — @aquaculture/backend-common/auth, /guards, /database, /utils, /nats, etc. The 2026-04-23 mass-codemod (AUDIT-MEDIUM-005) split all existing consumers, and this rule keeps it that way."
            },
            {
              "name": "@platform/backend-common",
              "message": "Same rationale as @aquaculture/backend-common — import from the specific sub-barrel (@platform/backend-common/<subtree>). Also note that @aquaculture/backend-common/<subtree> is the canonical alias platform-wide; @platform/backend-common exists as a parity alias used by only two files."
            }
          ]
        }
      ],
      "no-restricted-syntax": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-dynamic-delete": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-inferrable-types": "off",
      "@typescript-eslint/no-invalid-void-type": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/restrict-plus-operands": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "jsx-a11y/click-events-have-key-events": "off",
      "jsx-a11y/label-has-associated-control": "off",
      "jsx-a11y/no-autofocus": "off",
      "jsx-a11y/no-static-element-interactions": "off",
      "no-case-declarations": "off",
      "react/no-unescaped-entities": "off",
      "react-hooks/exhaustive-deps": "off",
      "react-hooks/rules-of-hooks": "error"
    },
    "testOverrides": [
      {
        "files": [
          "src/**/*.spec.ts",
          "src/**/*.spec.tsx",
          "src/**/*.test.ts",
          "src/**/*.test.tsx",
          "src/**/__tests__/**/*.ts",
          "src/**/__tests__/**/*.tsx"
        ],
        "rules": {
          "@typescript-eslint/unbound-method": "off"
        }
      }
    ]
  },
  {
    "dir": "web/modules/tenant-admin",
    "tsProjects": [
      "web/modules/tenant-admin/tsconfig.eslint.json"
    ],
    "rules": {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "import/order": "off",
      "@typescript-eslint/no-extraneous-class": [
        "error",
        {
          "allowWithDecorator": true
        }
      ],
      "no-console": "off",
      "no-restricted-imports": [
        "error",
        {
          "paths": [
            {
              "name": "@aquaculture/backend-common",
              "message": "The root @aquaculture/backend-common barrel aggregates ~25 subtrees; importing from it forces every consumer to re-invalidate on any change to any subtree. Import from the specific sub-barrel instead — @aquaculture/backend-common/auth, /guards, /database, /utils, /nats, etc. The 2026-04-23 mass-codemod (AUDIT-MEDIUM-005) split all existing consumers, and this rule keeps it that way."
            },
            {
              "name": "@platform/backend-common",
              "message": "Same rationale as @aquaculture/backend-common — import from the specific sub-barrel (@platform/backend-common/<subtree>). Also note that @aquaculture/backend-common/<subtree> is the canonical alias platform-wide; @platform/backend-common exists as a parity alias used by only two files."
            }
          ]
        }
      ],
      "no-restricted-syntax": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-dynamic-delete": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-inferrable-types": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/restrict-plus-operands": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "jsx-a11y/click-events-have-key-events": "off",
      "jsx-a11y/label-has-associated-control": "off",
      "jsx-a11y/no-autofocus": "off",
      "jsx-a11y/no-static-element-interactions": "off",
      "no-case-declarations": "off",
      "react/no-unescaped-entities": "off",
      "react-hooks/exhaustive-deps": "off",
      "react-hooks/rules-of-hooks": "error"
    },
    "testOverrides": [
      {
        "files": [
          "src/**/*.spec.ts",
          "src/**/*.spec.tsx",
          "src/**/*.test.ts",
          "src/**/*.test.tsx",
          "src/**/__tests__/**/*.ts",
          "src/**/__tests__/**/*.tsx"
        ],
        "rules": {
          "@typescript-eslint/unbound-method": "off"
        }
      }
    ]
  },
  {
    "dir": "web/shared-ui",
    "tsProjects": [
      "web/shared-ui/tsconfig.eslint.json"
    ],
    "rules": {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "import/order": "off",
      "@typescript-eslint/no-extraneous-class": [
        "error",
        {
          "allowWithDecorator": true
        }
      ],
      "no-console": "off",
      "no-restricted-imports": [
        "error",
        {
          "paths": [
            {
              "name": "@aquaculture/backend-common",
              "message": "The root @aquaculture/backend-common barrel aggregates ~25 subtrees; importing from it forces every consumer to re-invalidate on any change to any subtree. Import from the specific sub-barrel instead — @aquaculture/backend-common/auth, /guards, /database, /utils, /nats, etc. The 2026-04-23 mass-codemod (AUDIT-MEDIUM-005) split all existing consumers, and this rule keeps it that way."
            },
            {
              "name": "@platform/backend-common",
              "message": "Same rationale as @aquaculture/backend-common — import from the specific sub-barrel (@platform/backend-common/<subtree>). Also note that @aquaculture/backend-common/<subtree> is the canonical alias platform-wide; @platform/backend-common exists as a parity alias used by only two files."
            }
          ]
        }
      ],
      "no-restricted-syntax": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-dynamic-delete": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-inferrable-types": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/restrict-plus-operands": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "jsx-a11y/click-events-have-key-events": "off",
      "jsx-a11y/label-has-associated-control": "off",
      "jsx-a11y/no-autofocus": "off",
      "jsx-a11y/no-static-element-interactions": "off",
      "no-case-declarations": "off",
      "react/no-unescaped-entities": "off",
      "react-hooks/exhaustive-deps": "off",
      "react-hooks/rules-of-hooks": "error"
    },
    "testOverrides": [
      {
        "files": [
          "src/**/*.spec.ts",
          "src/**/*.spec.tsx",
          "src/**/*.test.ts",
          "src/**/*.test.tsx",
          "src/**/__tests__/**/*.ts",
          "src/**/__tests__/**/*.tsx"
        ],
        "rules": {
          "@typescript-eslint/unbound-method": "off"
        }
      }
    ]
  },
  {
    "dir": "web/shell",
    "tsProjects": [
      "web/shell/tsconfig.eslint.json"
    ],
    "rules": {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "import/order": "off",
      "@typescript-eslint/no-extraneous-class": [
        "error",
        {
          "allowWithDecorator": true
        }
      ],
      "no-console": "off",
      "no-restricted-imports": [
        "error",
        {
          "paths": [
            {
              "name": "@aquaculture/backend-common",
              "message": "The root @aquaculture/backend-common barrel aggregates ~25 subtrees; importing from it forces every consumer to re-invalidate on any change to any subtree. Import from the specific sub-barrel instead — @aquaculture/backend-common/auth, /guards, /database, /utils, /nats, etc. The 2026-04-23 mass-codemod (AUDIT-MEDIUM-005) split all existing consumers, and this rule keeps it that way."
            },
            {
              "name": "@platform/backend-common",
              "message": "Same rationale as @aquaculture/backend-common — import from the specific sub-barrel (@platform/backend-common/<subtree>). Also note that @aquaculture/backend-common/<subtree> is the canonical alias platform-wide; @platform/backend-common exists as a parity alias used by only two files."
            }
          ]
        }
      ],
      "no-restricted-syntax": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-dynamic-delete": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-inferrable-types": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/restrict-plus-operands": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "jsx-a11y/click-events-have-key-events": "off",
      "jsx-a11y/label-has-associated-control": "off",
      "jsx-a11y/no-autofocus": "off",
      "jsx-a11y/no-static-element-interactions": "off",
      "no-case-declarations": "off",
      "react/no-unescaped-entities": "off",
      "react-hooks/exhaustive-deps": "off",
      "react-hooks/rules-of-hooks": "error"
    },
    "testOverrides": []
  }
];
