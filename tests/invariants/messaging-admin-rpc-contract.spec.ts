/**
 * Platform-wide invariant — ADMIN-CRITICAL-017 / APA-163 (drift detector):
 *
 * The admin-panel legal-hold *release* control failed 100% of the time because
 * the dual-approver fields (`approverId`, `releaseReason`) required by the
 * LEGAL-MEDIUM-002 retrofit at the messaging-service command handler + service
 * layer + DB CHECK were silently dropped by the admin proxy chain: the
 * `request.messaging.admin.*` NATS payloads were hand-duplicated, untyped
 * interfaces on each side, and admin-api's REST DTOs were plain TS interfaces
 * the ValidationPipe skips. Tightening the consumer therefore broke no build,
 * no test, and no boundary — only the deepest handler at click time (surfaced
 * as a retried 502).
 *
 * The fix makes that class of BE↔BE request drift impossible: a single shared
 * contract (`libs/event-contracts/src/rpc/messaging-admin-rpc.ts`) is the SSoT
 * for the request payloads, consumed by BOTH sides. This gate pins that wiring
 * so it cannot silently regress:
 *
 *   1. The contract declares `approverId` + `releaseReason` as REQUIRED on the
 *      release request (a bare `?:` here would re-open the exact bug).
 *   2. messaging-service's handler types every `@MessagePattern` from the
 *      contract constants — no raw `request.messaging.admin.*` string literals,
 *      no locally re-declared `*Payload` interfaces.
 *   3. admin-api constrains `sendNatsRequest`'s payload to the contract and
 *      routes release through `POST .../:id/release` (a body-bearing command),
 *      never the pre-fix bodyless `DELETE` that structurally could not carry
 *      the dual-approver fields.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const CONTRACT_FILE = 'libs/event-contracts/src/rpc/messaging-admin-rpc.ts';
const HANDLER_FILE =
  'apps/messaging-service/src/event-handlers/messaging-admin-nats.handler.ts';
const CONTROLLER_FILE =
  'apps/admin-api-service/src/messaging/messaging-admin.controller.ts';
const RELEASE_DTO_FILE =
  'apps/admin-api-service/src/messaging/dto/release-legal-hold.dto.ts';

function read(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
}

describe('INVARIANT (ADMIN-CRITICAL-017 / APA-163): messaging-admin RPC request contract is the SSoT', () => {
  describe('shared contract', () => {
    const contract = read(CONTRACT_FILE);

    it('declares the release request with REQUIRED approverId + releaseReason', () => {
      // Isolate the ReleaseLegalHoldRequest interface body.
      const match = contract.match(
        /export interface ReleaseLegalHoldRequest[^{]*\{([\s\S]*?)\n\}/,
      );
      expect(match).not.toBeNull();
      const body = match![1];

      // Required means `approverId: ...` / `releaseReason: ...`, NOT `?:`.
      expect(body).toMatch(/(^|\n)\s*approverId:\s*string;/);
      expect(body).toMatch(/(^|\n)\s*releaseReason:\s*string;/);
      expect(body).not.toMatch(/approverId\?:/);
      expect(body).not.toMatch(/releaseReason\?:/);
    });

    it('exports the pattern constants and the shared reason-length SSoT', () => {
      expect(contract).toMatch(/export const MESSAGING_ADMIN_PATTERNS = \{/);
      expect(contract).toMatch(
        /export const LEGAL_HOLD_MIN_RELEASE_REASON_CHARS = 50;/,
      );
      expect(contract).toMatch(/export interface MessagingAdminRpcRequest \{/);
    });
  });

  describe('messaging-service handler consumes the contract', () => {
    const handler = read(HANDLER_FILE);

    it('imports the pattern constants + request types from the contract lib', () => {
      expect(handler).toMatch(/from '@platform\/event-contracts'/);
      expect(handler).toMatch(/MESSAGING_ADMIN_PATTERNS/);
      expect(handler).toMatch(/ReleaseLegalHoldRequest/);
    });

    it('routes every @MessagePattern through MESSAGING_ADMIN_PATTERNS (no raw subject literals)', () => {
      // No hand-typed 'request.messaging.admin.*' string LITERAL remains in the
      // handler (quote-delimited only; backtick-wrapped prose in doc comments
      // that names the subject family is fine).
      expect(handler).not.toMatch(/['"]request\.messaging\.admin\./);
      // And every pattern decorator uses the constant object.
      const patternDecorators = handler.match(/@MessagePattern\(([^)]*)\)/g) ?? [];
      expect(patternDecorators.length).toBeGreaterThan(0);
      for (const decorator of patternDecorators) {
        expect(decorator).toMatch(/MESSAGING_ADMIN_PATTERNS\./);
      }
    });

    it('no longer declares local payload interfaces for the RPC patterns', () => {
      // The pre-fix drift was a locally re-declared ReleaseLegalHoldPayload.
      expect(handler).not.toMatch(/interface\s+\w*Payload\b/);
    });
  });

  describe('admin-api controller constrains the boundary', () => {
    const controller = read(CONTROLLER_FILE);
    const dto = read(RELEASE_DTO_FILE);

    it('types sendNatsRequest payload against MessagingAdminRpcRequest', () => {
      expect(controller).toMatch(/from '@platform\/event-contracts'/);
      expect(controller).toMatch(
        /payload:\s*MessagingAdminRpcRequest\[P\]/,
      );
    });

    it('routes release via POST .../:id/release, never the bodyless DELETE', () => {
      expect(controller).toMatch(
        /@Post\('compliance\/legal-holds\/:id\/release'\)/,
      );
      expect(controller).not.toMatch(
        /@Delete\('compliance\/legal-holds\/:id'\)/,
      );
    });

    it('every sendNatsRequest callsite passes a MESSAGING_ADMIN_PATTERNS subject', () => {
      expect(controller).not.toMatch(/['"]request\.messaging\.admin\./);
      const callsites =
        controller.match(/this\.sendNatsRequest<[^>]*>\(\s*([^,]*),/g) ?? [];
      expect(callsites.length).toBeGreaterThan(0);
      for (const callsite of callsites) {
        expect(callsite).toMatch(/MESSAGING_ADMIN_PATTERNS\./);
      }
    });

    it('the release DTO is a class-validator class binding the shared reason-length SSoT', () => {
      expect(dto).toMatch(/export class ReleaseLegalHoldDto/);
      expect(dto).toMatch(/@IsUUID\('4'\)\s*\n\s*approverId!/);
      expect(dto).toMatch(
        /@MinLength\(LEGAL_HOLD_MIN_RELEASE_REASON_CHARS\)/,
      );
      expect(dto).toMatch(
        /LEGAL_HOLD_MIN_RELEASE_REASON_CHARS.*from '@platform\/event-contracts'/,
      );
    });
  });
});
