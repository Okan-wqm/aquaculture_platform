# Messaging AI Egress Inventory

Date: 2026-05-28

This inventory covers messaging data paths that can send message-derived data
to AI services, external model services, or derived operational knowledge stores.
The required invariant is simple: denied AI consent sends zero payload bytes to
AI or external services.

## Mandatory Gate

All messaging AI egress must pass `AiEgressGateService` or
`AiPrivacyService.canAnalyzeMessage(tenantId, userId)` before payload assembly.

- Tenant AI disabled: block.
- User AI consent denied: block.
- Human-authored chat context: filter per author consent.
- Custom MCP / custom AI URL: same gate as hosted AI, with pathway
  `custom-ai-chat`.
- Knowledge extraction: lawful-basis/consent gate before derived entries are
  created.

## Paths

| Path | Producer | Destination | Payload | Required gate | Current status |
| --- | --- | --- | --- | --- | --- |
| AI channel chat | `AiChatBridgeService.handleAiChannelMessage` | `request.ai.chat` or custom MCP URL | current message plus filtered context | `AiEgressGateService.assertAllowed` for sender and `isAllowed` per context author | Gated |
| Custom MCP AI chat | `AiChatBridgeService.sendViaHttp` | tenant-provided `aiServiceUrl` | same chat request | `custom-ai-chat` gate before HTTP | Gated |
| Sentiment analysis | `AnalyzeMessageHandler` -> `SentimentAnalysisService` | derived `message_analysis`, possible outbox alert | message content | `AiPrivacyService.canAnalyzeMessage` before analysis | Gated |
| Embeddings cron | `EmbeddingService.processBatch` | `request.ai.embeddings` | consented message text batch | per-message `AiPrivacyService.canAnalyzeMessage` keyed by tenant/user | Gated |
| Semantic search query | `SearchSimilarMessagesHandler` | `request.ai.embeddings` | search query text | `AiEgressGateService.assertAllowed` | Gated |
| Knowledge extraction | `KnowledgeExtractionService.processMessage` | DB-derived `knowledge_entries`, `message_entity_references` | message content-derived entities | `AiPrivacyService.canAnalyzeMessage` before deriving artifacts | Gated |
| AI chat REST proxy | `gateway-api` v2 AI routes | `ai-service` | caller chat body | gateway auth/tenant guard, then AI service; messaging content must only enter through gated messaging bridge | Boundary documented |
| AI service agent tools | `ai-service` | internal tools / future model backend | prompt/tool context | must not receive messaging content except through gated messaging paths | Boundary documented |
| Cron/retry jobs | embedding, sentiment retry, knowledge batch | AI service or derived tables | queued message-derived content | same per-message gate immediately before payload assembly | Gated by caller |

## Derived Artifact Lifecycle

The following artifacts are message-derived and must be included in GDPR export,
erasure, retention, and legal-hold decisions:

- `messages.embedding`
- `embeddings_metadata`
- `message_analysis`
- `message_entity_references`
- `knowledge_entries`
- AI conversation messages produced by `AiChatBridgeService`
- notification logs/tokens that reference chat notifications
- `messaging.messaging_outbox` payloads carrying AI or messaging lifecycle events

Erasure rule: when user consent is revoked or a user is deleted, remove or
anonymize derived artifacts for that tenant/user without touching other tenants
or other anonymized users. Legal hold may preserve message content, but sender
identity and non-held derived artifacts still follow the privacy workflow.

## Release Evidence

Before production promotion, attach evidence that:

- denied consent results in no `request.ai.*`, custom MCP HTTP request, embedding,
  sentiment, or knowledge payload;
- AI chat context excludes non-consenting human authors;
- semantic search and embeddings are tenant/user scoped;
- GDPR/export/erasure covers the derived artifacts listed above;
- legal hold behavior is explicit for held channels.
