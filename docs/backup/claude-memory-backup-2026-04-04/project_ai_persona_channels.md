---
name: AI channels mapped to MCP server personas
description: Each AI messaging channel maps to a specific ai-service persona (expert, operator, manager, supervisor) or null for general chat. Architecture must support adding new AI MCP servers in the future.
type: project
---

AI messaging channels use a persona-based architecture where each AI channel is linked to a specific ai-service persona (or null for general chat).

**Current personas (ai-service, port 3008):**
- `expert-v1` → Farm Expert: tanks, batches, feeding, growth analytics
- `operator-v1` → Su Kalitesi Uzmanı: water chemistry, sensor config, calibration
- `manager-v1` → Yönetici Asistan: analytics, reporting, risk assessment
- `supervisor-v1` → SCADA AI: actuation, PLC control (requiresConfirmation)
- `null` → Genel AI: plain Claude chat without domain tools

**Channel entity change:**
- `channels.aiPersona` column (nullable VARCHAR) — stores persona ID for AI channels
- When type='ai' and aiPersona is null → general chat (no tools)
- When type='ai' and aiPersona='expert-v1' → farm expert with full tool access

**Future extensibility:**
- Architecture must support adding NEW AI MCP servers (e.g., separate SCADA AI server, hydroponics AI)
- `channels.aiServiceUrl` column (nullable) — override for custom MCP server endpoint
- Default: ai-service at NATS subject `request.ai.chat`
- Custom: direct HTTP call to specified URL

**Why:** User wants users to choose which AI expert to talk to. "Farm Expert" has farm domain tools, "Genel AI" answers anything. Future AI servers (SCADA, hydroponics) can be added without changing the messaging architecture.

**How to apply:**
- Add `aiPersona` and `aiServiceUrl` to Channel entity
- ai-chat-bridge.service.ts includes persona in NATS request payload
- NewChatPage shows AI channel creation with persona picker
- Admin can configure available AI personas per tenant
