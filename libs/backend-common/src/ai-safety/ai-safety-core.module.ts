import { Module } from '@nestjs/common';

import { InputFilterService } from './input-filter.service';
import { OutputPiiScannerService } from './output-pii-scanner.service';
import { SsrfValidatorService } from './ssrf-validator.service';

/**
 * AiSafetyCoreModule — the canonical NestJS home for the three cross-service
 * AI safety primitives:
 *
 *   - {@link SsrfValidatorService}       URL allowlist + IP denylist + DNS-rebinding guard
 *   - {@link InputFilterService}         prompt-injection / jailbreak pattern detection
 *   - {@link OutputPiiScannerService}    email / phone / SSN / CC / UUID PII scanner
 *
 * Before extraction (AUDIT-HIGH-007, cold audit 2026-04-22), byte-identical
 * copies lived under `apps/ai-service/src/safety/`,
 * `apps/messaging-service/src/ai/safety/`, and
 * `apps/notification-service/src/notification/services/`. Three copies meant
 * the next security patch (e.g. a new RFC 1918 range, a new jailbreak
 * pattern, a new PII regex) would ship to only ONE copy — a predictable
 * divergence-to-CVE pipeline.
 *
 * Every backend service that needs any of these three services now imports
 * `AiSafetyCoreModule` instead of defining its own copies. Services that
 * need a richer pipeline (middleware, instruction hierarchy, tool-schema
 * validator) continue to run their local AiSafetyModule which imports this
 * core module and adds the service-specific providers on top.
 *
 * @see docs/reviews/_audit/2026-04-22-cold-audit/03-explore-findings.md#AUDIT-HIGH-007
 * @see ADR-028 — lib-creation rubric (backend-common/<subdir>/ row)
 */
@Module({
  providers: [SsrfValidatorService, InputFilterService, OutputPiiScannerService],
  exports: [SsrfValidatorService, InputFilterService, OutputPiiScannerService],
})
export class AiSafetyCoreModule {}
