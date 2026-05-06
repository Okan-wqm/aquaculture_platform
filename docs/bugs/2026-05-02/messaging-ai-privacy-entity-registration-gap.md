# Messaging AI privacy entity registration gap

Date: 2026-05-02

## Problem

Messaging E2E reported:

- `EntityMetadataNotFoundError: No metadata for "UserAiConsent" was found`
- `EntityMetadataNotFoundError: No metadata for "TenantAiSetting" was found`

## Impact

AI consent/settings GraphQL paths could not access their TypeORM repositories
through the root messaging DataSource. That breaks tenant AI consent decisions
and blocks AI channel tests.

## Root Cause

The messaging root TypeORM config uses an explicit `entities` array. The AI
privacy entities were registered in the feature module but were missing from
the root DataSource entity list.

## Fix

`TenantAiSetting` and `UserAiConsent` are now imported into `app.module.ts` and
included in the root TypeORM entity list.

## Verification

The next messaging E2E run should no longer report missing metadata for AI
privacy entities.
