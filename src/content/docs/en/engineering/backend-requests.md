---
title: "Requests, Interfaces, and Authentication"
description: "From HTTP requests entering the service to API contracts, serialization, identity, and permissions, understand the complete chain of the backend boundaries."
---

The most basic work of the backend is to receive requests, verify identities, execute rules, read and write data, and return interpretable results. The framework merely organizes these steps. The real difficulty lies at the boundaries: what counts as valid input, who has the authority to execute, what state should be left if the operation fails, and how the client knows whether it succeeded.

## 1. The Complete Path of a Request

```text
Client
  │ URL, method, header, request body
  ▼
DNS → TCP → TLS → Ingress Proxy/Load Balancer
  │
Application server
  │ Analysis HTTP → Middleware → Routing
  ▼
Controller → Business Service → Data Access → External Dependency
  │
  ▼
Response: status code + header + response body
```

Every step can potentially fail. The domain may not resolve, the connection may be refused, the certificate may expire, the proxy may return a 502, the route may not exist, authentication may fail, the database may timeout, and in the end, it may all manifest as "the API is not working," but the ways to handle each issue are completely different.

### 1.1 Middleware

Middleware sits before the request enters the business code or after the response leaves, and is often responsible for:

- Generating request IDs and establishing a logging context.
- Parsing cookies, authentication information, and content types.
- Limiting request body size, rate limiting, and checking IPs/tenants.
- Compression, CORS, security headers, and cache control.
- Catching exceptions and converting internal errors into stable responses.

The order of middleware affects behavior. For example, authentication must occur before business routes, logging context should be established as early as possible, and error handling is usually placed at the outermost layer. Wrong order might cause unauthenticated requests to trigger expensive queries first, or error responses might lack a request ID.

### 1.2 Controllers, Services, and Data Access

- **Controllers** handle the HTTP boundary: read parameters, call services, and select status codes.
- **Service layer** handles business rules: permissions, state transitions, transactions, and combinations of multiple operations.
- **Data access layer** handles queries and persistence, but does not decide whether the business logic allows certain actions.

Stuffing database queries, permission checks, and response assembly all into the controller may work in the short term, but it is hard to test and reuse. Not every small interface needs to be split into three layers; split them when boundaries are complex, but do not mix different responsibilities into an unexplainable function.

## 2. Core Concepts of HTTP

HTTP is a request/response protocol. The request includes method, target, version, headers, and an optional request body; the response includes status code, headers, and response body.

```http
POST /api/orders HTTP/1.1
Content-Type: application/json
Authorization: Bearer <token>

{"items":[{"sku":"A-1","quantity":2}]}
```

```http
HTTP/1.1 201 Created
Content-Type: application/json
Location: /api/orders/ord_123

{"id":"ord_123","status":"pending"}
```

### 2.1 Methods

| Method | Semantics | Should Be Idempotent |
| --- | --- | --- |
| GET | Read resource | Yes |
| HEAD | Read response headers | Yes |
| POST | Create resource or submit operation | Not required |
| PUT | Replace target resource entirely | Yes |
| PATCH | Partially modify resource | Depends on design |
| DELETE | Delete resource | Usually |

Method semantics affect caching, retries, proxies, and client behavior. Do not put all operations into GET; GET should not cause side effects or carry sensitive information such as passwords in the URL or logs.

### 2.2 Status Codes

Just understand the categories and common codes:

- `2xx`: Success. `200` Generally OK, `201` Created, `204` Success but no body.
- `3xx`: Redirect or cache related. `301/308` Permanent redirect, `302/307` Temporary redirect.
- `4xx`: Request or permission issues. `400` Parameter error, `401` Unauthenticated, `403` Authenticated but no permission, `404` Not found, `409` Conflict, `422` Semantic validation failed, `429` Rate limit.
- `5xx`: Server failed to complete. `500` Uncategorized error, `502` Invalid upstream response, `503` Temporarily unavailable, `504` Upstream timeout.

Status codes are not decorations. With correct error classification, the client can decide whether to retry, log in, prompt the user, or stop.

### 2.3 Headers

Common headers and their uses:

| Header | Function |
| --- | --- |
| `Content-Type` | Data format of request or response |
| `Accept` | Format the client wants to receive |
| `Authorization` | Credentials, such as Bearer token |
| `Cache-Control` | Cache policy |
| `ETag` / `If-None-Match` | Conditional requests and version validation |
| `Idempotency-Key` | Make repeated write requests safely retryable |
| `X-Request-Id` | Trace requests across services |
| `Set-Cookie` | Server sets Cookie |
| `Retry-After` | Recommended wait time for rate limiting or temporary unavailability |

Custom headers should also have clear semantics, considering whether proxies forward them and whether logs record sensitive values.

## 3. API Contract

Interface documentation is not an "attachment for others to read" but a contract between the client and the server. The contract should at least include:

- Path, method, authentication, and permissions.
- Input fields, types, required status, range, and default values.
- Successful response structure and status codes.
- Stable error codes, error messages, and field errors.
- Pagination, sorting, filtering, and idempotency rules.
- Timeout, retry, rate limiting, and long task behavior.

### 3.1 Resource Naming

REST style usually uses nouns to represent resources:

```text
GET    /api/orders?status=paid&cursor=...
GET    /api/orders/{orderId}
POST   /api/orders
PATCH  /api/orders/{orderId}
DELETE /api/orders/{orderId}
```

Do not write verb-like `getOrder` in the URL, unless the operation is indeed not a resource operation, for example `POST /api/orders/{id}/cancel` represents a business-semantic conversion.

### 3.2 Idempotence

Idempotence means that repeating the same request should result in the same final business effect. GET, PUT, and DELETE are usually designed to be idempotent, whereas POST creation requests can easily cause duplicates.

After a client timeout, it may not know if the request was successful and may retry. If the server creates a new order on each retry, duplicate side effects will occur. Solutions include:

- Client generates `Idempotency-Key`, and the server saves the processing result.
- The database uses unique constraints or business idempotency keys.
- Write operations check the status first before deciding whether to execute.
- Return a queryable operation ID for scenarios where the result cannot be confirmed.

"Retrying three times" cannot replace idempotent design. Retrying only makes duplicates more apparent.

### 3.3 Pagination

Offset pagination is simple:

```http
GET /api/orders?page=3&pageSize=20
```

But when data is inserted frequently, duplicates or skips may occur. Cursor-based pagination uses stable sorting fields and positions:

```http
GET /api/orders?limit=20&cursor=eyJjcmVhdGVkQXQiOi...
```

Cursors need verifiable, non-forgeable positions to prevent unauthorized access; sort fields should be stable, usually adding a unique ID as the final comparison item.

### 3.4 Versions and Compatibility

Version changes are not just about adding `v2` in the path. Adding fields, extending enums, changing default values, and changes in error structures all involve compatibility:

- Adding optional fields is usually backward compatible.
- Deleting fields, changing types, and changing semantics are usually breaking changes.
- Adding new values to an enum may cause older clients to crash.
- Time, amounts, and large numbers should have clear formats and precision.
- When a new client calls an old server, should the server ignore unknown inputs or reject them?

Prioritize designing an evolvable schema before deciding whether versioning is necessary. Versioning brings multiple sets of logic and migration costs; it is not a free isolation wall.

## 4. Common API Styles

| Style | Advantages | Cost |
| --- | --- | --- |
| REST/JSON | General, readable, widely supported | Interface may bloat when querying complex data |
| GraphQL | Client fetches fields as needed, reducing multiple requests | Query complexity, caching, permissions, and rate limiting are more complex |
| gRPC/Protobuf | Strong schema, binary efficiency, suitable for internal calls | Browser support, debugging, and gateway adaptation costs |
| Webhook | Event-driven, no polling needed | Duplicate delivery, signatures, retries, and ordering issues |
| File/Stream | Upload and download, real-time results | Range requests, backpressure, resumable transfers, and resource release |

When selecting a model, consider the caller, data scale, and failure mode, not the vector diagram. For public integration, prioritize generality; for internal high-frequency services, schema and performance may be more important.

### 4.1 Webhooks Must Also Have a Contract

A webhook is 'your server being actively called by another server.' To handle it:

- Signature verification and timestamping to prevent forgery and replay.
- Event ID and idempotent processing.
- Timeout, retry, and dead letter.
- Out-of-order arrival and duplicate delivery.
- The version field is backward compatible.

A quick acknowledgment from the recipient does not mean that the business processing is complete; the status of asynchronous tasks needs to be queryable.

## 5. Serialization and Data Formats

Serialization turns in-memory objects into transmittable bytes, while deserialization restores bytes back into objects. The choice of format affects readability, size, schema, compatibility, and security.

| Format | Features | Suitable for |
| --- | --- | --- |
| JSON | Readable, general-purpose, weakly typed | Public APIs, configuration files |
| Protobuf | Compact, strong schema, code generation | Inter-service RPC, high throughput |
| MessagePack | Binary, relatively compact | Internal interfaces, specific clients |
| CSV | Simple tables, widely used tools | Data import and export |
| Custom Binary | Controllable, Extremely High Efficiency | Audio & Video, Protocols, Low-Level Systems |

Regardless of format, it must be processed:

- Whether unknown fields are ignored, preserved, or rejected.
- Numeric precision, time format, null values, and default values.
- Character encoding and maximum length.
- Schema version and migration.
- Resource and security risks when deserializing untrusted data.

JSON does not have native date and precise decimal types; large integers may exceed JavaScript's safe integer range. When transmitting large IDs externally, strings can be used, and amounts can be represented using integers in the smallest currency unit or an explicit string format.

## 6. Authentication and Authorization

**Authentication** answers 'Who are you,' while **authorization** answers 'What can you do.' The two cannot be mixed together, nor should they be executed only on the frontend.

### 6.1 Session and Cookie

The server creates a session, the browser saves the cookie, and it is automatically carried with requests. Key attributes:

- `HttpOnly`: JavaScript cannot read it, reducing the risk of XSS theft.
- `Secure`: Send only via HTTPS.
- `SameSite`: Restrict cross-site carrying to reduce CSRF.
- `Path`, `Domain`, `Expires`: Control the effective range.

Sessions are suitable for traditional web applications; the server can revoke sessions, but storage and horizontal scaling need to be handled.

### 6.2 JWT / Bearer Token

JWT puts claims and signatures in the token, allowing the server to validate them statelessly. Note:

- Verify the signature algorithm and key, do not accept `none` or incorrect algorithms.
- Check the expiration time, issuer, audience, and purpose.
- Do not put sensitive information into the payload, because it is only encoded, not encrypted.
- When revocation is difficult, use short-lived tokens, refresh tokens, or server-side blacklists.

JWT is not the 'safer' default answer, it just puts the state in a different place.

### 6.3 OAuth / OIDC

OAuth mainly addresses third-party authorization, and OIDC provides identity information on top of it. The authorization code flow uses `state` to prevent request forgery, and PKCE prevents the authorization code from being intercepted. The callback URL must match the whitelist, and the scope should be minimized.

### 6.4 API Key

API Key is suitable for machine calls and service-level quotas, but it requires:

- Transmit only over secure channels.
- Permissions can be rotated, revoked, and restricted.
- Do not place it in the frontend, URL, or public logs.
- Associated with user identity, tenant, and rate limiting.

### 6.5 Authorization Model

| Model | Example |
| --- | --- |
| RBAC | Administrator, Editor, Read-Only Roles |
| ABAC | Determines based on attributes such as department, resource tags, and time |
| Resource-level permissions | Only the document owner or collaborators can edit |
| Tenant Isolation | Users can only access data belonging to their own tenant |

Each protected resource must check object-level permissions. A user being logged in does not mean they can read any order; after modifying the ID in the URL, the backend must still determine whether access is allowed.

## 7. Input Validation and Error Contracts

All data from external sources should be considered untrusted: request body, query parameters, path, headers, cookies, uploaded filenames, third-party callbacks. Validation should include at least:

- Type, required, length, range, format.
- Whether the business status allows this operation.
- Identity and object-level permissions.
- Resource size, page limit, and file type.

Error responses should be stable, machine-readable, and not expose internal implementation:

```json
{
  "error": {
    "code": "ORDER_NOT_PAYABLE",
    "message": "The current order cannot be paid",
    "fields": {},
    "requestId": "req_123"
  }
}
```

Do not return stack traces, SQL statements, internal hostnames, keys, or full third-party responses in the production environment. Logs can record more detailed reasons, but they should be sanitized and associated with the request ID.

## 8. Long Requests, Uploads, and Streaming Responses

Ordinary requests should return as quickly as possible to avoid connections being occupied for a long time. Time-consuming tasks can:

1. Return a task ID immediately.
2. Put the task into a queue.
3. Be processed by a worker process and update the status.
4. Allow the client to get progress via polling, SSE, or WebSocket.
5. Provide cancellation, retry, and result expiration strategies.

When uploading files, consider:

- Request body size limits and streaming processing.
- Validation of file type, extension, and actual content.
- Direct upload to object storage and temporary signed URLs.
- Resume uploads, chunking, and range requests.
- Filename injection, virus scanning, quotas, and cleanup.

Streaming responses should define the semantics of "how much data has been sent before failure." If the client retries after receiving partial content, it may duplicate execution or cause incorrect concatenation.

## 9. How to Choose a Framework

Web frameworks usually provide routing, middleware, request parsing, response serialization, and dependency injection. When choosing, consider:

- Team language experience and ecosystem.
- Request handling model (synchronous, asynchronous, event loop).
- Type and schema support.
- Middleware, authentication, database, and testing tools.
- Deployment method, memory usage, and startup time.
- Community maintenance and security updates.

Differences between frameworks in different languages are generally less important than clear input validation, error boundaries, permission models, and testability. A framework can help get the first interface running quickly but cannot decide transactions, idempotency, and permissions for you.

## Checklist

1. Does each interface have clear inputs, outputs, error codes, and permissions?
2. Do write operations have idempotency strategies to prevent duplicate side effects during retries?
3. Are authentication and authorization performed on the server side, and is object-level permission checked?
4. Are cookies, tokens, and API keys in the correct place, and is rotation and revocation in place?
5. Are pagination, sorting, and filtering limited and able to be traversed stably?
6. Does the serialization format handle precision, time, and schema compatibility?
7. Are long requests, uploads, streaming responses, and cancellation defined?
8. Are errors traceable while not exposing internal details?
9. Do logs have request IDs and are sensitive fields sanitized?
10. Do API documentation and actual behavior match?
