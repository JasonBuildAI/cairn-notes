---
title: "Entry, Cloud Resources, and Security"
description: "From DNS, TLS, proxies, and load balancing, to VPC, IAM, object storage, and infrastructure as code."
---

When a user opens a website, the request goes through domain name resolution, network connection, encryption negotiation, edge nodes, load balancing, and reverse proxy before finally reaching the application. Cloud platforms break these steps into many configurable resources. Configuration errors often do not manifest as "code exceptions," but rather as timeouts, certificate errors, 403, 502, cross-region latency, or quietly exposed data.

## 1. The path of an external request

```text
Browser
  → DNS
  Public network / Edge
  → TLS Terminate
  → WAF / CDN
  Load Balancing
  → Reverse Proxy / API Gateway
  Application Services
  → Database / Cache / Object Storage
```

Each layer can be healthy while the entire chain fails. When troubleshooting, first determine where the request stops, instead of guessing from the lowest level of the code.

## 2. DNS

DNS resolves domain names to IPs or other records. Common records:

| Record | Function |
| --- | --- |
| A | Domain name to IPv4 address |
| AAAA | Domain name to IPv6 address |
| CNAME | Domain alias to another domain |
| MX | Mail server |
| TXT | Text information for verification, SPF, DKIM, etc. |
| NS | Which name servers are responsible for the domain |

### 2.1 Recursive Resolution

```text
Browser/System Cache
  Local recursive parser
  Root server
  Top-level domain server
  Authoritative Name Server
  → Return records and cache
```

TTL determines how long the cache lasts. After modifying the record, the old value may persist until the TTL expires. When migrating services, you can first lower the TTL and then switch back to it. Don't assume "DNS takes effect worldwide immediately after saving it." 

### 2.2 Common Faults

- Incorrect recorded values or missing points at the end. 
- CNAME conflicts with other records. 
- Expired domain name, incorrect NS configuration. 
- Hybrid IPv4/IPv6, client selection of unavailable paths. 
- Intranet resolution differs from public network resolution. 
- The domain name covered by the certificate does not match the resolution target. 

## 3. HTTPS and TLS

TLS solves three things: verifying server identity, negotiating keys, and encrypting transmission. HTTPS stands for HTTP over TLS. 

### 3.1 Certificate

The certificate is issued by a trusted certificate issuer, binding the domain name to the public key. Client verification: 

- Whether the certificate is still valid. 
- Whether the domain matches the domain. 
- Whether the certificate chain can be traced back to the trusted root certificate. 
- Whether the signature is correct. 
- Whether the certificate has been revoked or there are other strategic issues. 

Expired certificates, incomplete links, and domain mismatches are common issues. Automatic renewal and expiration alerts should be included in operations and maintenance; don't wait for the browser to report errors. 

### 3.2 TLS Handshake

Modern TLS typically includes: 

1. The client negotiates protocol versions and encryption suites with the server. 
2. The server provides the certificate. 
3. Client-side validation certificate. 
4. Both parties establish a shared key. 
5. Subsequent application of encrypted data transmission. 

TLS 1.3 simplifies handshakes and defaults to stronger security attributes. Legacy protocols and weak suites may be rejected by compliance or browsers. Certificates can be configured differently for different domain names via SNI. 

### 3.3 TLS Termination Position

TLS can be terminated at CDN, load balancing, gateway, or application. After termination, HTTP may still be used internally, so network isolation and trusted links must be ensured. If the application requires raw protocol, client IP, or end-to-end encryption, it must properly handle forwarders or perform secondary encryption. 

## 4. Reverse prying, load balancing, and gateways

### 4.1 Reverse Proxy

Reverse proxies represent the server in receiving client requests. Common capabilities include: 

- Route to different backends. 
- Terminate TLS. 
- Compress, cache, rewrite paths and headers. 
- Limit request bodies, timeouts, and concurrency. 
- Hide internal topology. 

Path prefixes, tail slashes, and override rules in proxy configurations are prone to errors. When forwarding, `Host`, `X-Forwarded-For`, `X-Forwarded-Proto` and request IDs must be preserved or set, and only headers from known proxies are trusted. 

### 4.2 Load Balling

| Layer | Based | Features |
| --- | --- | --- |
| L4 | IP, port, connection | Fast, does not understand HTTP, suitable for TCP/UDP |
| L7 | Paths, headers, cookies | Flexible routing, capable of grayscale and content splitting |

Common algorithms: 

- Polling: Assigned in order. 
- Weighted polling: Allocated based on instance capability. 
- Least Connections: Gives instances with fewer current connections. 
- Consistency hash: Try to place the same key on the same instance. 

Health checks determine whether instances enter traffic. Too lenient checks send traffic to faulty instances, while too strict disconnect all instances when dependent. Session stickiness can simplify stateful applications but reduces balancing and increases fault impact. 

### 4.3 API Gateway and WAF

API gateways centrally handle authentication, rate limiting, routing, protocol transitions, logs, and quotas. They should not become a stack of all business logic. WAFs filter common web attacks but cannot replace input validation, permissions, and code security. 

CDN caches static content and stays close to users. Dynamic content, personalized responses, and sensitive data must be cautiously caught; cache keys must include language, tenant, and identity-related dimensions. 

## 5. The basic resource model of cloud platforms

| Resources | Functions | Key Issues |
| --- | --- | --- |
| Virtual Machine | Complete Operating System Example | Patches, Scaling Capacity, Startup Time |
| Container Services | Run and manage containers | Network, Mirror, Orchestration, Permissions |
| Serverless functions | Code executed by event | Cold start, duration, connection, vendor binding |
| Hosted database | Database operation and maintenance are handled by the platform | Connection, backup, parameters, version, cost |
| Object storage | Saving files and static resources | Access policies, lifecycle, consistency |
| Block Storage | Disk mounted to the instance | Capacity, IOPS, snapshot, availability zone |
| Message queue | Asynchronous communication | Repeat, sequencing, holding, and backlog |
| Key Services | Storing Keys and Certificates | Permissions, Rotation, Auditing |

### 5.1 Zones and Availability Zones

A region refers to a geographic area, while an availability zone is a relatively independent facility within a region. Multiple availability zones improve fault tolerance for single data centers, while multi-region areas enhance regional-level disaster recovery, but they bring cross-region latency, data replication, and costs. 

Do not confuse "deployment in two availability zones" with "automatic global consistency." Databases, object storage, and caches each have replication models that need to be confirmed separately. 

### 5.2 Shared Responsibility

Cloud providers are responsible for the security of physical facilities, virtualization layers, and some managed services; Users are responsible for identity, configuration, data, applications, and access policies. Hosted databases do not automatically set minimum permissions for you, and object storage is not automatically secure just because it is "in the cloud." 

## 6. VPC is isolated from the network

Virtual Private Cloud (VPC) provides isolated address space. Subnets are divided into availability zones and routing, security groups, and network ACLs control traffic. 

Common structures:

```text
Public network
  Public subnet: Load Balancer/Ingress
  → Private network subnet: Application services
  Private subnet: databases, caches, internal services
```

Principles: 

- Databases and caches are not directly exposed to the public network. 
- Only the necessary entry subnet has public network routes. 
- Outbound access is conducted via NAT or proxy and audited. 
- Manage port access via bastion machine, VPN, or private connection. 
- Security groups are open by minimal port and source, without using `0.0.0.0/0` to save trouble. 
- Intranet services should also have identity authentication and authorization; the "intranet" should not be treated as a security boundary. 

Private endpoints can connect managed services to VPCs, reducing public network exposure. Connections across VPCs, accounts, and local data centers require clear routing, DNS, and trust relationships. 

## 7. IAM: Identity and Permissions

IAM (Identity and Access Management) manages "who can operate on what resources." Core concepts typically include: 

- **Subjects**: Users, groups, service roles, external identities. 
- **Strategy**: Which operations are allowed or denied. 
- **Resources**: Buckets being accessed, databases, queues, etc. 
- **Roles**: A set of permissions that can be temporarily assumed. 

### 7.1 Minimum privileges

Least privilege is not "read-only," but rather the scope of operations and resources that are exactly needed by the task. Common errors: 

- The app uses an administrator account. 
- Development and production share the same set of credentials. 
- Write the key into code or mirror. 
- Permission policy uses wildcard resources. 
- Permissions are not reclaimed after resignation or project completion. 

Services should use workload identities or short-term credentials, rather than long-term static keys. Role permissions are split by environment and task; Sensitive operations require stricter approvals and audits. 

### 7.2 Strategy Judgment

Cloud IAM often includes account-level policies, resource policies, permission boundaries, organizational policies, and session policies simultaneously. Ultimately, permissions are not just about one place. When checking for 403, confirm: 

1. Check whether the caller's identity is correct. 
2. What is the exact name of the operation? 
3. Whether the resource ARN/path matches. 
4. Is there an explicit refusal? 
5. Whether KMS decryption, log writing, or cross-service authorization are missing. 
6. Check if the temporary voucher is expired. 

## 8. Object storage and CDN security

Object storage is suitable for large files and static resources, but misconfigurations may lead to public leaks. 

Inspection items: 

- By default, whether public access is enabled. 
- Whether the bucket policy only allows necessary entities and operations. 
- Whether the owner and ACL of the uploaded object are clearly defined. 
- Whether static website hosting has accidentally exposed private files. 
- Whether the presigned URL has a short validity period and minimum permissions. 
- Whether server-side encryption, version control, and access logs are enabled. 
- Whether the lifecycle cleans up temporary files and old versions. 

When caching public content on CDNs, avoid caching responses with identity information to other users. Cache keys, `Vary`, `Cache-Control`, and origin authentication must be designed together. 

## 9. Infrastructure is code

IaC describes cloud resources in code, with common tools including Terraform, CloudFormation, Plumi, and Kubernetes manifests. 

Advantages: 

- Changes have versions, are censorable, and rollback possible. 
- Environments can be created repeatedly. 
- Resource relationships can be analyzed using tools. 
- Reduced manual console drift. 

Risks: 

- The state file contains sensitive information and resource mapping, and must be encrypted and access restricted. 
- Manual modifications cause drift, which requires detection and convergence. 
- `plan` Resources may be accidentally deleted if they do not match the real environment. 
- Provider or module upgrades may change behavior. 
- Code merging does not mean the resource is securely applied.

```text
Code modification → Format/validation → Plan → Review differences
  → Apply → Verify → Record status and changes
```

The production environment should restrict who can apply changes, using approval and auditing. Keys, certificates, and database passwords should be referenced through key management and not written directly in the state or code.

## 10. Common Troubleshooting

| Symptom | Priority Check |
| --- | --- |
| Domain cannot be resolved | DNS records, NS, TTL, resolver cache |
| Certificate error | Validity period, domain name, certificate chain, SNI |
| Connection timeout | Security group, routing, NAT, target port, health check |
| 403 | Identity, policy, resource policy, explicit deny, KMS permissions |
| 404 | Routing, path rewriting, backend prefix, object key |
| 502/504 | Backend unreachable, application crash, timeout, proxy buffering |
| CDN returns old content | TTL, cache key, refresh, origin cache headers |
| Accessible internally but not externally | Subnet routing, public IP, load balancer listener |

## Checklist

- Check if DNS records, TTL, IPv4/IPv6 match the certificates.
- Check if TLS certificates auto-renew, and if the certificate chain and protocol version meet requirements.
- Check if proxies and load balancers correctly pass host, protocol, client IP, and request ID.
- Check if health checks can recognize genuinely unavailable services without removing all due to temporary glitches.
- Ensure database, cache, and management ports are limited to the private network.
- Verify that security groups are minimally open and outbound access is controlled.
- Ensure applications use short-term credentials with least privileges rather than long-term admin keys.
- Ensure object storage blocks public access and pre-signed URLs are short-lived.
- Check if IaC state is encrypted, locked, access-restricted, and drift is detected.
- Ensure critical cloud resources have logging, alerts, backup, and recovery processes.
