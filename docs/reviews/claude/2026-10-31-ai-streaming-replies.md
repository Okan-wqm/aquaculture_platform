# AI replies that stream: the output PII filter on partial text — 2026-10-31

Found on 2026-10-31 while making AI replies stream as they are written. A reply shown before it
is complete must still pass the output PII filter (MSG-HIGH-032), so the filter has to redact a
text that arrives in pieces and give, joined, exactly what it gives for the whole text. Defining
that required `redact` to be well defined on overlapping matches, which it was not.

## AISAFETY-MEDIUM-039

Defect. `OutputPiiScannerService.redact` scanned each pattern on its own, then applied every
detection by descending `startIndex` to the string it was rewriting. Two patterns can match the
same characters: 13 Luhn-valid digits are both a phone number and a card number. The first
replacement shortened the string; the second sliced the shortened string at the original
`endIndex` and deleted text that followed the number.

Severity MEDIUM. Owner Okan-wqm, deadline 2026-11-14.

Where.

- `libs/backend-common/src/ai-safety/output-pii-scanner.service.ts:82` (phone) and `:99`
  (credit card) match the same digits.
- `libs/backend-common/src/ai-safety/output-pii-scanner.service.ts:210-220` applies the
  detections one after another to the rewritten string.
- Every AI reply passes through it: `apps/ai-service/src/safety/ai-safety.middleware.ts:235`,
  and AI channel replies again in `apps/messaging-service/src/ai/services/ai-chat-bridge.service.ts:318`.

Failure. `Card 4222222222222 is on file.` was redacted to `Card [REDACTED] on file.`: the word
after the number was lost. The PII itself was removed; the reply around it was corrupted.

Fix. Overlapping detection ranges are merged before replacement, so each stretch of PII is
replaced by one `[REDACTED]` and the text after it is kept. The scanner also gains
`redactStream`: text is released only at a whitespace character no pattern's match can cross.
Each pattern now has to declare `crossesWhitespace`, the text around a whitespace character
inside one of its matches. A seeded test feeds 3,000 random texts, built from the characters the
patterns use, in random pieces. It asserts that the stream gives exactly what `redact` gives for
the whole text. Removing the phone pattern's declaration turns it red, and so does the old
sequential replacement.

## MSG-MEDIUM-089

Gap. An AI reply reached the user only whole, after every model turn had finished. The
providers called the non-streaming API. `request.ai.chat` answered once per request. The AI
channel bridge and the assistant socket waited for that answer, up to 60 seconds, and showed
nothing until it arrived. Raised from the operator's request that AI answers appear as they are
written.

Severity MEDIUM. Owner Okan-wqm, deadline 2026-11-14.

Where.

- `apps/ai-service/src/agent/providers/anthropic.provider.ts:66` (`messages.create`) and
  `apps/ai-service/src/agent/providers/openai.provider.ts:99` (`chat.completions.create`,
  inherited by Z.ai).
- `apps/ai-service/src/chat/ai-chat.responder.ts:149`: one reply per request.
- `apps/messaging-service/src/ai/services/ai-chat-bridge.service.ts:733` and
  `apps/gateway-api/src/websocket/ai-chat.gateway.ts:243` wait for that one reply.

Fix. Every provider streams. Each model turn's text passes the output safety stage as it
arrives (AISAFETY-MEDIUM-039's `redactStream`), and the stored reply is built from the same
released text the drafts carried, so the text a user watched is the text that is stored.
