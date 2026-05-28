# Farm Service Error Contract

## Shape

Client-facing errors use `FarmAppError` semantics:

| Field           | Meaning                                          |
| --------------- | ------------------------------------------------ |
| `code`          | stable machine code                              |
| `userMessage`   | safe user-facing text                            |
| `fieldPath`     | optional field path for validation failures      |
| `retryable`     | whether retry can succeed without user changes   |
| `statusCode`    | HTTP status for REST or mapped GraphQL extension |
| `correlationId` | request correlation identifier                   |

## Rules

- No SQL, password, token, private key, or connection detail in client errors.
- Validation failures identify fields.
- Concurrency conflicts return retryable domain errors.
- Restore conflicts return domain errors.
- Unknown operation authorization returns 403 with correlation ID.

## Common Codes

| Code                           | Status | Retryable         |
| ------------------------------ | ------ | ----------------- |
| `FARM_VALIDATION_FAILED`       | 400    | false             |
| `FARM_NOT_FOUND`               | 404    | false             |
| `FARM_PERMISSION_DENIED`       | 403    | false             |
| `FARM_TENANT_CONTEXT_REQUIRED` | 400    | false             |
| `FARM_CONFLICT`                | 409    | depends on reason |
| `FARM_RATE_LIMITED`            | 429    | true              |
| `FARM_DEPENDENCY_UNAVAILABLE`  | 503    | true              |
