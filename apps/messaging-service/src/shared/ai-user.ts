/**
 * MSGFIX-FAZ2 2.3: the virtual AI assistant user identity — ONE constant for
 * every messaging-service site that must recognise (or write) AI-authored
 * messages:
 *
 *   - ai-chat-bridge.service.ts writes AI replies under this senderId;
 *   - ai-trigger-nats.handler.ts skips its own output (feedback-loop guard);
 *   - messaging-push.service.ts suppresses offline push for AI replies;
 *   - message send paths reject user-forged contentType SYSTEM under this id.
 *
 * Kept a valid UUID so it satisfies UUID-shaped predicates and schemas; the
 * all-zeros-plus-01 pattern is reserved for platform service identities
 * (the anonymised-user marker uses all zeros).
 */
export const AI_USER_ID = '00000000-0000-0000-0000-000000000001';
