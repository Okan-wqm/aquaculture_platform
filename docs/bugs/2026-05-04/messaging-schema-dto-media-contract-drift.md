# Messaging Schema, DTO, and Media Contract Drift

- Date: 2026-05-04
- Affected area: messaging-service E2E contract, compliance DTOs, GDPR export, media upload
- Status: fixed in this change set

## Observed issue

E2E exposed three contract drifts: outbox SQL selected `event_type` while the canonical table uses `"eventType"`, compliance GraphQL inputs were rejected by whitelist validation as non-decorated properties, and attachment verification invoked AWS SDK `HeadObject` directly inside Jest instead of honoring the documented mocked object-storage boundary.

## Root cause

The test and service contracts had drifted from the canonical runtime model. The outbox entity/migration owns camelCase columns, compliance inputs had GraphQL fields but no `class-validator` metadata, and media verification was not behind an injectable boundary.

## Architectural fix

Outbox E2E now queries the canonical `"eventType"` column rather than adding duplicate schema. Compliance input classes now carry explicit validation metadata so global `whitelist` and `forbidNonWhitelisted` remain strict. Media attachment existence checks moved behind `StorageObjectVerifier`; production uses an S3 implementation, while E2E overrides the port with a deterministic fake.

## Verification

- `npx tsc -p apps/messaging-service/tsconfig.app.json --noEmit`
- `npx tsc -p apps/messaging-service/tsconfig.spec.json --noEmit`
- `npx jest --config apps/messaging-service/jest.config.ts apps/messaging-service/src/gdpr/__tests__/gdpr.service.spec.ts --runInBand`

The fix intentionally avoids VM flags, duplicate columns, validation pipe weakening, and AWS SDK monkey-patching.
