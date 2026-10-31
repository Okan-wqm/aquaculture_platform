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
