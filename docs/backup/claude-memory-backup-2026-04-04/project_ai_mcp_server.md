---
name: AI chat uses existing ai-service MCP server
description: Messaging AI chat must route questions to the existing ai-service MCP server (port 3008), not create a separate AI pipeline
type: project
---

The messaging service's AI chat feature (channel type = 'ai') must route all user questions to the EXISTING `ai-service` at port 3008, which already has:
- MCP server with tool access (get_tanks, get_water_quality, get_batches, etc.)
- Chat/conversation modules
- Claude API integration
- Tenant-scoped context injection

**Why:** The ai-service is already a fully functional MCP server with domain tools. Building a separate AI pipeline in messaging-service would duplicate functionality and diverge from the existing architecture. The messaging-service should act as a thin bridge — persist the message, forward to ai-service via NATS, persist the AI response.

**How to apply:**
- `ai-chat-bridge.service.ts` must use NATS request-reply to `request.ai.chat` (existing ai-service endpoint)
- Do NOT embed AI models directly in messaging-service
- Embedding generation (all-MiniLM-L6-v2) and sentiment analysis (DistilBERT) run IN ai-service, not messaging-service
- messaging-service only: persists messages, manages channels, handles WebSocket delivery
- ai-service: processes AI queries, generates embeddings, runs sentiment analysis, returns results via NATS

Existing ai-service architecture (port 3008):
- Chat endpoint: POST /api/v2/ai/chat (streaming, Claude API)
- AgentRunnerService: orchestrates Claude + tools
- Tool registry: water_chemistry, sensor_config, farm_query, actuation
- Personas: operator-v1, manager-v1, expert-v1, supervisor-v1
- Tool safety: requiresConfirmation flag for dangerous operations
- Tenant-scoped: tenantId from JWT, schemaName for DB queries

User priority: MCP server integration is the TOP priority for AI features.
