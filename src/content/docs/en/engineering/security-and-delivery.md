---
title: "Security, Open Source, and Technology Delivery"
description: "From threat models and web attack surfaces, to dependencies, licenses, technology choices, and maintainable delivery."
---

Security is not just adding a layer of 'checks' before going live, and technical delivery is not just pushing the code. Systems need to define assets, trust boundaries, attack surfaces, and the impact of failures from the design stage; delivery, on the other hand, requires versioning, documentation, licensing, migration, and rollback information.

## 1. Start with a Threat Model

A threat model is not about listing all attacks, but answering four questions:

1. What are we protecting: accounts, funds, privacy, internal documents, keys, availability.
2. Who might attack: external anonymous users, logged-in users, malicious employees, third-party services, supply chain.
3. Where are the trust boundaries: browser to server, service to database, between tenants, internal network to public network.
4. What happens if assets are compromised: leakage, tampering, loss, denial of service, unauthorized operations.

### 1.1 Data Flow Diagram

```text
Browser → CDN/WAF → API → business services
                         ├→ Database
                         Object Storage
                         Third party
                         └→ Message Queue → Worker
```

Mark identity, data, encryption, and permission checks on each arrow. Paths without clear identity and boundaries are usually sources of risk.

### 1.2 STRIDE

| Threat | Meaning | Example |
| --- | --- | --- |
| Spoofing | Impersonation | Hijacking sessions, forging callbacks |
| Tampering | Data tampering | Modifying prices, request parameters |
| Repudiation | Denying actions | Missing audit logs |
| Information disclosure | Information leakage | Unauthorized access, public buckets |
| Denial of service | Denial of service | Resource exhaustion, oversized requests |
| Elevation of privilege | Privilege escalation | Ordinary users performing admin actions |

Provide each threat with an executable control: authentication, signing, auditing, encryption, rate limiting, permission checks.

## 2. Authentication, Sessions, and Permissions

- Authentication answers "Who are you?"; authorization answers "What can you do?"
- Hiding buttons on the front end is not authorization; the back end must check every protected resource.
- Session cookies should set `HttpOnly`, `Secure`, and appropriate `SameSite`.
- JWTs must validate signature, algorithm, expiration, issuer, and audience; do not only base64-encode sensitive information.
- OAuth/OIDC should use authorization code PKCE, state, and strict callback whitelists.
- API keys should be rotatable, revocable, and permission-limited; they must not be placed on the front end.

### 2.1 Object-level permissions

A common overreach is modifying the ID in the URL:

```http
GET /documents/123
```

If the system only checks 'user is logged in,' an attacker can enumerate other documents. Each access should verify:

- Whether the user belongs to the tenant.
- Whether the user has read/edit permissions for the resource.
- Whether the current state of the resource allows the operation.
- Whether shared links have an expiration period and minimal scope.

### 2.2 Secure Sessions

After a successful login, session IDs should be rotated to prevent session fixation. Logging out should revoke the server-side session or refresh tokens. Sensitive operations can require secondary authentication. Passwords should be stored using dedicated password hashing algorithms with a unique salt per user, not using plain SHA/MD5.

## 3. Common Web Attack Surfaces

### 3.1 Injection

Concatenating untrusted input into SQL, commands, templates, or ORM raw fragments may change the program's semantics.

```ts
// Error: concatenated input
db.query(`SELECT * FROM users WHERE email = '${email}'`);

// Correct: Parameterized Query
db.query("SELECT * FROM users WHERE email = $1", [email]);
```

Parametric queries are suitable for data values; Table names, column names, and sorting directions cannot be parameterized arbitrarily; whitelists should be used. Shell commands should use parameter arrays whenever possible to avoid `shell: true` and string concatenation. 

### 3.2 XSS

Unescaped user content enters HTML, and scripts may be executed in other browsers. Risks include session theft, impersonation operations, and reading page data. 

Protection: 

- Default output encoding. 
- Use less `innerHTML`; must undergo reliable purification when used. 
- CSP restricts script sources, but CSP is not the only line of defense. 
- Rich text uses strict whitelisting. 
- Cookies use `HttpOnly` to reduce the risk of tokens being read by scripts. 

### 3.3 CSRF

Browsers automatically carry cookies, and malicious sites may trick users into sending authentication requests. 

Protection: 

- Use `SameSite` Cookies. 
- Write operation requirements with CSRF tokens or custom headers. 
- Execute state changes without GET. 
- Secondary confirmation of critical operations. 

### 3.4 SSRF

When the server initiates a request based on a user-provided URL, it may be induced to access the intranet, metadata services, or local management ports. 

Protection: 

- Target domain whitelist. 
- After parsing, check the IP address to block private addresses and loopback addresses. 
- Arbitrary protocols and redirect redirects are prohibited. 
- Use independent outbound proxies and minimal network permissions. 

### 3.5 File Upload

- Limit size, type, and quantity. 
- Verify actual content, not just trust extensions and Content-Type. 
- Regenerate filenames to avoid path traversal and control characters. 
- Scanning for malicious content after uploading. 
- Isolate storage from execution environment, using private access or short-term signed URLs. 

### 3.6 Deserialization and External Data

Deserialization of untrusted objects may trigger code execution, resource exhaustion, or type confusion. Prioritize using pure data formats and schema validation, limiting nesting depth, number of fields, and total size. Third-party webhooks should verify signatures and timestamps to prevent forgery and replay. 

## 4. Encryption and keys

### 4.1 Transmission and Storage

- Use HTTPS for external communications, and internal sensitive links should also be encrypted or isolated. 
- Databases, backups, object storage, and keys should be statically encrypted. 
- Encryption cannot replace access control; Anyone with the key can still read the plaintext. 
- Passwords use irreversible hashes, not lossy encryption. 

### 4.2 Key Management

Keys must not be written into source code, images, frontend packages, logs, or chat logs. Use key management services or environment injection, isolate by purpose and environment, and rotate regularly. Access keys must be audited, and if leaked, they should be able to be quickly revoked and rotated. 

## 5. Dependence on supply chains

Libraries, build tools, container images, and CI plugins that projects rely on can all become entry points for attacks. 

- Lock the dependencies and keep the lockfile. 
- Only install from trusted sources; watch out for fake package names. 
- Review installation scripts and build permissions. 
- Regularly scan for known vulnerabilities, but don't just look at the number scanned. 
- Generate SBOM or at least record direct dependencies with versions. 
- Building product signatures, verifications, and proof of origin improves traceability. 

Whether dependency vulnerabilities can be exploited depends on the call path, input boundaries, and runtime permissions. Before upgrading or fixing, read the change instructions to avoid automatic upgrades causing damage. 

## 6. Secure delivery process

```text
Demand and Threat Model
  → Design and Permission Review
  Coding and Static Analysis
  → Dependency/Image Scanning
  → Test (including permissions and injection)
  Gray release
  Monitoring and Emergency Response
```

Security checks should be automated as much as possible, but tools should not replace design reviews. A system that passes scanning may still allow any user to read someone else's order. 

### 6.1 Minimum Privileges

- Service accounts only have the necessary resource permissions. 
- CI/CD deployment credentials are isolated by environment. 
- Database users should not share administrator accounts. 
- Containers do not run as root. 
- Cloud storage is private by default. 
- Internal tools must also be certified and audited. 

### 6.2 Audit

Important operations record who did what on which resource at what time and what the results were. Audit logs should be tamper-proof and access restricted; they cannot be deleted arbitrarily like ordinary debugging logs. Privacy data must be desensitized before being written to audits. 

## 7. Open source collaboration and licensing

When using open source projects, you need to understand licenses, not just "downloadable on GitHub." 

Common licenses are generally divided into: 

- Flexible type: MIT, Apache-2.0, BSD, usually allowed for modification and commercial use, but retains copyright/license statements. 
- Weak copyleft: LGPL, etc., with specific requirements for linking methods and distribution. 
- Strong copyleft: GPL/AGPL, may require source code openness when distributing or providing network services. 
- Non-commercial/shared identification: CC BY-NC-SA, etc., restricting commercial use and requiring attribution and the same license. 

The license terms need to be read in their original text, especially the following: 

- Whether commercial use is permitted. 
- Whether the modified source code is required to be made public. 
- Whether same-format sharing is required. 
- Whether the NOTICE, copyright, and source are retained. 
- Whether databases, fonts, images, and model weights are under separate licenses. 

### 7.1 Participate in Open Source

- Read the contribution guidelines and code of conduct. 
- Search for existing issues first, then ask questions. 
- One change solves a clear problem. 
- Do not submit code of unknown origin or that conflicts with project licenses. 
- Respect maintainers' time and project boundaries. 

## 8. Technical selection

Selection is not about seeking the "strongest technology," but about finding the simplest solution that fits current constraints. 

To compare: 

- Requirements and performance objectives. 
- Team experience and maintenance skills. 
- Ecosystem, documentation, community, and long-term support. 
- Deployment, operations, monitoring, and migration costs. 
- Safety, licensing, and supplier risks. 

### 8.1 Common Traps

- Resume-driven: Introducing unnecessary complexity to use new technologies. 
- Blind pursuit: Ignoring stability, migration, and team learning costs. 
- Look only at the benchmark: The test environment differs from the distribution of real data. 
- Ignore exit costs: data locking, proprietary APIs, and migration difficulties. 
- Overdesign: Pre-splitting the system for non-existent scale. 

### 8.2 ADR

Architecture decision records should state:

```text
Background and Constraints
Alternative plan
Decision
Reason
Cost and risk
Validation metrics
Rollback/Exit Conditions
```

ADR lets future readers know the assumptions at the time, rather than only seeing the results.

## 9. Technical Writing

Documentation is part of the deliverables. What's most needed is not long tutorials, but the ability to answer practical questions:

- What problem the project solves and what it doesn't.
- How to install, configure, start, and verify.
- Key concepts and architecture diagrams.
- Data models, interfaces, and error codes.
- Operations, backups, failures, and rollback.
- Known limitations and licenses.

### 9.1 Writing Principles

- Write tasks that the reader needs to complete first.
- Examples must be runnable, with consistent commands and paths.
- Specify versions, prerequisites, and expected outcomes clearly.
- Use short paragraphs, tables, and checklists to reduce scanning costs.
- Do not include sensitive information, internal addresses, or personal data in public documentation.
- Documentation should be updated with code; outdated content is more dangerous than none.

## 10. Delivery Checklist

1. Are threat models, assets, and trust boundaries clearly defined?
2. Are identities, sessions, and object-level permissions validated on the server side?
3. Are inputs, uploads, callbacks, and external URLs treated as untrusted?
4. Are keys separated from code and images, and can they be rotated?
5. Are dependencies and images locked, scanned, and traceable?
6. Are licenses, copyrights, and sources of third-party assets checked?
7. Are there tests, staged deployments, monitoring, and rollback?
8. Does the documentation explain installation, configuration, interfaces, limitations, and failure handling?
9. Are selection decisions recorded along with trade-offs, risks, and exit criteria?
10. Does external release protect privacy, keys, and internal topology?
