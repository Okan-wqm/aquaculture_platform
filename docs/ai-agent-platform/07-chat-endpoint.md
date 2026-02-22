# 07 - Chat Endpoint with SSE Streaming

## Overview

The chat endpoint provides a REST API for interacting with the AI agent. It uses Server-Sent Events (SSE) to stream responses in real time, allowing the frontend to display tool calls, intermediate results, and the final AI message as they happen.

## Endpoint

```
POST /api/v2/ai/chat
```

### Request Body

```json
{
  "message": "What is the current ammonia level in pond 3?",
  "conversationId": "optional-uuid-for-continuation",
  "persona": "operator-v1"
}
```

| Field            | Type   | Required | Description                                      |
|------------------|--------|----------|--------------------------------------------------|
| `message`        | string | Yes      | The user's chat message (must not be empty)      |
| `conversationId` | string | No       | UUID to continue an existing conversation        |
| `persona`        | string | No       | Agent persona profile (default: `operator-v1`)   |

### Headers

| Header             | Required | Description                          |
|--------------------|----------|--------------------------------------|
| `Authorization`    | Yes      | Bearer JWT token                     |
| `X-Tenant-Id`      | No       | Tenant ID (extracted from JWT if absent) |
| `X-Correlation-Id` | No       | Request correlation ID for tracing   |
| `X-Request-Id`     | No       | Alternative correlation ID header    |

## SSE Event Stream

The response uses `Content-Type: text/event-stream` with `Cache-Control: no-cache` and `Connection: keep-alive`. The `X-Correlation-Id` response header carries the correlation ID.

Headers are flushed immediately via `res.flushHeaders()` before the agent loop begins.

### `start`
Sent immediately when the request is accepted.
```json
{"type": "start", "conversationId": null}
```

### `tool_call`
Sent when the agent invokes a tool.
```json
{"type": "tool_call", "name": "calculate_ammonia_toxicity", "input": {"totalAmmoniacalNitrogen": 1.5, "pH": 7.8, "temperature": 25, "salinity": 15}}
```

### `tool_result`
Sent when a tool returns its result. Follows the corresponding `tool_call` event.
```json
{"type": "tool_result", "name": "calculate_ammonia_toxicity", "result": {"nh3_mgL": 0.0123, "status": "safe"}}
```

### `message`
The final AI response with token usage.
```json
{
  "type": "message",
  "conversationId": "uuid",
  "content": "The ammonia level is within safe range...",
  "tokenUsage": {"input": 150, "output": 42, "total": 192}
}
```

### `done`
Signals the end of the stream.
```json
{"type": "done"}
```

### `error`
Sent if an error occurs after the stream has started (headers already sent).
```json
{"type": "error", "message": "Rate limit exceeded. Resets at 2026-02-21T12:00:00.000Z"}
```

If the error occurs before headers are sent, a standard HTTP error response is returned instead.

## Authentication Flow

1. Client sends request with `Authorization: Bearer <jwt>` header
2. Gateway middleware decodes the JWT and attaches `req.user` (with `sub`, `tenantId`, `roles`)
3. Gateway middleware sets `req.tenantId` from the JWT or `X-Tenant-Id` header
4. Gateway proxies the request to the AI service, forwarding all auth headers
5. AI service middleware chain runs: CorrelationId -> UserContext -> TenantContext -> TenantSchema
6. Chat controller validates that `tenantId` and `userId` are present (returns 401 if missing)
7. Chat controller validates that `message` is non-empty (returns 400 if missing)
8. Schema name is derived from tenant ID for the `ChatRequest`

## Gateway Proxy

The gateway forwards all `/api/v2/ai/*` requests to the AI service using a raw HTTP proxy. This preserves SSE streaming -- the proxy pipes the upstream response directly to the client without buffering.

```
Client --> Gateway (api/v2/ai/chat) --> AI Service (api/v2/ai/chat)
                                    <-- SSE stream piped back
```

## Conversation Listing (Placeholder)

```
POST /api/v2/ai/conversations
```

Returns `{ conversations: [] }`. Will be expanded to support listing and searching past conversations.

## Error Handling

The controller distinguishes between two error scenarios:

1. **Pre-stream errors** (headers not yet sent): Thrown as `HttpException` with appropriate status code (401 Unauthorized, 400 Bad Request, 500 Internal Server Error)
2. **Mid-stream errors** (headers already sent): Sent as an SSE `error` event, then the stream is ended with `res.end()`

## Files

- `apps/ai-service/src/chat/chat.controller.ts` - ChatController (POST /api/v2/ai/chat, POST /api/v2/ai/conversations)
- `apps/ai-service/src/chat/chat.module.ts` - ChatModule (imports AgentModule)
