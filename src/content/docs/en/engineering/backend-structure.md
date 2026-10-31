---
title: "Backend structure, language, and client"
description: "From runtime, framework, and layering to project boundaries, client forms, and domain-specific languages."
---

The backend is not just a "language for writing APIs + a database." It is a set of boundaries that require long-term maintenance: how requests enter, where business rules reside, how data access is isolated, which modules can depend on which modules, and what responsibilities the client and server respectively hold.

Language and framework determine how things are expressed, while structure determines the cost of changes. In the early stages of a project, putting everything in one file can still go live, but when requirements change, multiple people collaborate, or debugging is needed, whether the boundaries are clear becomes the main issue.

## 1. Language Choice Depends on Constraints

Differences in syntax between languages are usually not the hardest part. What really needs comparison are runtime models, concurrency approaches, type systems, ecosystems, deployment, and team experience.

| Language | Common Advantages | Points to Watch |
| --- | --- | --- |
| Python | Rich ecosystem, direct expression, mature data and scripting tools | Global interpreter lock/concurrency model, type hints require tooling, performance hotspots |
| JavaScript/TypeScript | Shared language front and back-end, event loop, large ecosystem | Single-thread CPU blocking, runtime type checking, dependency complexity |
| Go | Fast compilation, simple deployment, intuitive concurrency primitives | Trade-offs in generics and ecosystem, error handling style, framework choices |
| Java/Kotlin | Strong typing, mature JVM ecosystem, complete toolchain | Startup and memory, framework complexity, too many abstraction layers |
| C# | Strong typing, cross-platform runtime, enterprise ecosystem | Platform and team experience, deployment size |
| Rust | Memory and concurrency safety, strong performance | Learning curve, development speed, ecosystem maturity varies by domain |

"Performance" should not be judged only by benchmarks. Databases, networks, serialization, and disks often affect end-to-end latency more than language execution speed. CPU-intensive, memory-sensitive, or high-concurrency scenarios need closer attention to runtime.

### 1.1 Type Systems and Runtime

Static types can catch field and call errors at compile time but cannot prove data validity at runtime. Dynamic types are more flexible, requiring schema validation and tests at boundaries. Strongly-typed languages may still encounter nulls at runtime, deserialization issues, and database type mismatches.

### 1.2 Memory and Concurrency

Garbage-collected languages reduce manual memory management but can cause pauses and memory peaks; manual memory management provides control but increases the risk of errors. Threads, coroutines, async tasks, and message passing each have suitable scenarios. Regardless of the primitives a language provides, shared mutable state requires explicit synchronization.

### 1.3 Questions for Selection

1. Can the team maintain it, not just write the first version?
2. Is the target platform and deployment suitable?
3. Are critical libraries, database drivers, and observation tools mature?
4. Can types and schemas be enforced at boundaries?
5. Are performance bottlenecks truly at the language layer?
6. Costs for recruiting, upgrades, security patches, and long-term support.

## 2. Role of Web Frameworks

Frameworks usually handle routing, request parsing, middleware, responses, dependency injection, and error handling. They allow the first API to start quickly but do not automatically provide a good structure.

A request usually goes through:

```text
HTTP Server → Framework Middleware → Routing
    → Controller/Processor → Application Service
    → Domain Rules → Storage/External Adapter → Database/API
```

Framework selection should consider:

- Whether the request model is synchronous, asynchronous, or a mix of both.
- Support for middleware, authentication, validation, and schema.
- Whether testing tools can easily replace dependencies.
- Observability, deployment, and process management methods.
- Version upgrades and security maintenance.

Do not register all objects just because the framework provides a dependency injection container; and do not write business logic into route handler functions just because the framework is simple.

## 3. Layering and Dependency Direction

The goal of layering is to isolate changes, not to create a large number of files.

### 3.1 Common Four Layers

| Layer | Responsibilities | Should Not Be Responsible For |
| --- | --- | --- |
| Interface Layer/Controller | Parse input, call use cases, select a response | Complex business rules, directly constructing SQL |
| Application Layer/Service | Organize use cases, permissions, transaction boundaries | HTML/HTTP details, low-level driver details |
| Domain Layer/Domain | Business entities, value objects, rules, and invariants | Database connections, framework objects |
| Infrastructure/Repository/Adapter | Persistence, messaging, external APIs | Deciding whether business is allowed |

This is a commonly used diagram, not the only answer. Small projects can merge the application layer with the domain layer, but responsibilities should not be reversed.

### 3.2 DTO and Domain Models

DTO (Data Transfer Object) is used for data structures between interfaces or layers. It is not equal to a database entity, and it is not necessarily equal to a domain object.

```text
HTTP JSON
   ↕ DTO / schema validation
Apply Input
   ↕ Switch
Domain Object
   ↕ Mapping
Database row
```

Passing the same object directly through all layers may save code in the short term, but in the long run it can cause external fields, database fields, and business rules to contaminate each other. Renaming a field might break the API, and database migrations can affect business objects. Boundary conversions may seem cumbersome, but they can keep changes localized.

### 3.3 Dependency Inversion

The business layer should not depend on a specific class driven by a database, but should depend on the capability interface it requires:

```text
OrderService → OrderRepository (interface)
                     ↑
              PostgresOrderRepository (to achieve)
```

This way, during testing, you can replace the in-memory storage, and when changing the database, the business logic doesn't have to change accordingly. Interfaces should be defined by the users, rather than exposing all methods of the underlying implementation.

### 3.4 Anemic vs. Rich

The anemic model separates data and behavior, with business rules scattered across the service layer; the rich model puts the rules into the entity. Both can work. The key is not the label, but whether the rules have a single location, whether they can be tested without a database, and whether they are prone to generating invalid states.

## 4. Organizing project structure according to changes

A common but easily uncontrolled structure is:

```text
controllers/
services/
repositories/
utils/
```

It's fine when a project has only a few features; when there are more features, a single change may need to span five directories, and the boundaries are still unclear. Organizing by business functionality or bounded contexts is usually more durable:

```text
src/
  orders/
    http/
    application/
    domain/
    infrastructure/
  payments/
    ...
  shared/
    db/
    auth/
    observability/
```

Each function can be further layered internally. Cross-functional dependencies should be done through explicit interfaces or events, rather than direct access to the other party's internal table. 

### 4.1 Module Boundaries

A module should: 

- Exposure of a small number of stable public interfaces. 
- Hide internal data structures and implementations. 
- Own your own testing and migration. 
- Do not arbitrarily import internal files from another module. 
- Clear ownership and change rhythm. 

Both monorepo and multi-repository are just ways to organize code. Monorepo is easier for sharing and unified construction, but requires rules and permissions; Multi-repository isolation is strong, but version coordination and cross-repository modifications are more troublesome. 

## 5. Architectural style

### 5.1 Monomer

A single deployment unit contains multiple business modules. Its advantages are simple transactions, direct calls, and low deployment and debugging costs. The problem is not "lagging behind the monolith," but unclear module boundaries, all functions sharing a single database, and not being able to scale independently. 

A well-structured modular monolith is often more reliable than prematurely split microservices. 

### 5.2 Microservices

Services are split and deployed independently by business boundaries, suitable for scenarios with large teams, modules that need independent expansion, or different release schedules. The costs include: 

- Network calls replace local functions, increasing latency and partial failures. 
- After data crosses services, transactions and consistency become more difficult. 
- Requires service discovery, gateway, tracking, configuration, and deployment platforms. 
- Increased costs for version compatibility, joint debugging, and fault locating. 

The basis for splitting should be business boundaries and team ownership, not "the number of services looks more advanced." 

### 5.3 Event-Driven

Services are decoupled through events, suitable for asynchronous processes and cross-module notifications. But they must handle event order, duplication, loss, schema evolution, and final consistency. An event is a fact that has already happened, while a command is the action the other party wants to execute; the two have different meanings. 

### 5.4 Serverless

The platform handles servers and scaling capacity, while developers focus on functions or managed services. The advantages are scaling on demand and minimal maintenance; The trade-off is cold start, execution time, connection management, debugging, and vendor binding. Long connections, heavy background tasks, and predictable high loads are not necessarily suitable. 

## 6. Client form and cross-platform approach

The backend is not the only client. Understanding client constraints helps define APIs: 

| Client | Features | API Design Impact |
| --- | --- | --- |
| Web | Fast publishing, cross-platform, restricted by browser sandbox | CORS, caching, cookies, resource size |
| iOS/Android native | Good experience and system capabilities, release requires review | Version fragmentation, offline, push, permission |
| Cross-platform apps | Sharing code may sacrifice some native capabilities | Platform differences, plugin quality, and performance |
| Desktop Applications | Accessible Files, System Capabilities, and Local Resources | Updates, Signatures, Permissions, Proxies |
| CLI/Automation | No UI, scriptable, requires stable exit code | Machine-readable output, non-interactive, power, etc. |

Cross-platform is not "writing once and everywhere is the same." File paths, permissions, notifications, background restrictions, keyboards, and input methods will all differ. Sharing business logic and types is possible, but platform boundaries still need to be handled specifically. 

### 6.1 Responsibilities of the client and server

- The client is responsible for interaction, instant feedback, and partial caching, and cannot be used as a permission boundary. 
- The server is responsible for final validation, business rules, permissions, and persistence. 
- Client versions may exist for a long time, so the API must be compatible with older versions. 
- Offline operations require conflict resolution strategies, not just local queues. 

## 7. domain-specific languages and configurations

DSL (Domain-Specific Language) is an expression designed for specific problems. SQL, HTML, CSS, regexes, Terraform HCL, Kubernetes YAML, and build configurations can all be considered DSLs. 

The value of a DSL lies in turning certain rules into checkable and reusable structures. The trade-off is learning costs, toolchains, and version evolution. Before creating a DSL, teams should first confirm whether the existing format is sufficient and who will maintain the parser, error messages, and migration. 

### 7.1 Configuration and Code Boundaries

- Configure values that are suitable for environmental changes and require operational modifications. 
- Code suitable for complex logic, type constraints, and behaviors that must be tested. 
- Do not cram all business rules into YAML; Nor hardcode all environmental differences into code. 

Configuration also requires schema validation, default values, versions, and change audits. A spelling error may only surface at startup, or even silently use the wrong default value. 

## 8. How to verify the structure

You can't just look at the table of contents diagram for structural quality. Check with these questions: 

1. How many parts need to be changed to modify a business rule? 
2. Is it possible to test core rules without a database? 
3. How much internal code does a change in external API fields affect? 
4. Can new students find the entry point for a request within half an hour? 
5. Are there cyclic dependencies between modules? 
6. Is there a clear path for data migration and interface versions? 
7. If one module fails, will it drag down all modules? 

## Checklist

- Whether language choices are based on teams, ecosystems, deployments, and real bottlenecks. 
- Whether business rules are centralized and whether they are avoided scattered across controllers and SQL. 
- Whether the dependency direction points from the outer layer to the inner layer, rather than penetrating each other. 
- Whether DTOs, domain objects, and database models have necessary boundaries. 
- Whether the project is organized by business capabilities, and whether modules are clearly exposed with clear interfaces. 
- Whether there is a clear reason for monoliths, microservices, or event-driven events, rather than following trends. 
- Whether client versions, permissions, and offline behaviors are incorporated into the API design. 
- Whether the DSL and configuration have schema, default values, versions, and validation. 
- Whether critical modules can be tested without complete infrastructure.
