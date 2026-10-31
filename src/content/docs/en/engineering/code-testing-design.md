---
title: "Code Quality, Testing, and Design"
description: "Identify code smells, refactor safely, determine test boundaries, and use design patterns when necessary."
---

Code quality is not about "looking tidy." It is reflected in whether others can understand it, whether modifications can be localized, whether errors can be detected, whether tests are stable, and whether the system can evolve at a controllable cost when changes occur. Long code is not necessarily bad, and short code is not necessarily good; the key is whether the structure expresses the real problem.

## 1. Code Smells as Design Signals

Code smells are not style checklists but early signals of maintenance costs.

| Code Smell | Manifestation | Possible Cause |
| --- | --- | --- |
| Long Function | A function does too many things | Lack of responsibility boundaries, logic mixed together |
| Large Class/Module | Many fields and methods | Aggregates multiple concepts |
| Duplicate Code | Same logic copied in multiple places | Lack of reusable boundaries |
| Too Many Parameters | Calls need to remember many positional parameters | Concept not properly modeled |
| Deep Nesting | Multiple layers of if/for | Conditions can be returned early or extracted |
| Mysterious Naming | `data`, `temp`, `handle` | Meaning is not expressed |
| Data Clumps | Several fields always appear together | Should extract a value object |
| Divergent Change | One change requires updating many unrelated files | Responsibilities are scattered |
| Shotgun Surgery | A concept is dispersed in many places | Lack of encapsulation |
| Feature Envy | Function accesses lots of data from other objects | Behavior might be in the wrong place |
| Over-Abstraction | Many interfaces wrap just one layer | Designed for imaginary changes |

Code smells should be judged in context. A one-time script can be written plainly; a core service that is maintained long-term needs clearer boundaries.

## 2. Complexity and Readability

Cyclomatic complexity roughly counts the number of independent branching paths. Conditions, loops, and boolean combinations increase paths; high complexity means more test cases and higher cognitive cost.

However, complexity metrics cannot replace judgment. A simple switch may be clearer than multiple layers of abstraction; a short function may hide expensive side effects. The common goal is to reduce **cognitive load**:

- Names explain intent, not implementation details.
- A function works at a consistent level of abstraction.
- Dependencies are explicitly passed in, not hidden in global state.
- Side effects are separated from pure computation.
- Error paths are clear, not relying on special return values.
- Key invariants are expressed with types, assertions, or tests.

### 2.1 Comments

Comments should explain "why" and non-obvious constraints, not reiterate code line by line. Outdated comments are more dangerous than none. Complex algorithms, business rules, compatibility reasons, and temporary workarounds are worth documenting.

## 3. Refactoring

Refactoring is adjusting internal structure without changing external behavior. It is not the same as rewriting, nor simply fixing bugs along the way.

Safe refactoring process:

```text
Confirm current action
  → There is testing or reproducible verification
  Small steps to change the structure
  Check at each step of operation
  Behavior unchanged
```

### 3.1 Common Techniques

- Extract Function: Name a piece of logic with an independent purpose and move it out.
- Inline Function: Remove wrappers that only forward without adding meaning.
- Rename: Make names convey domain meaning.
- Introduce Parameter Object: Model parameters that always appear together.
- Extract Class/Module: Aggregate data and related behavior.
- Move Function: Place behavior close to the data it depends on most.
- Replace Conditionals with Polymorphism: When branches proliferate based on type.
- Replace Inheritance with Composition: Avoid inheritance hierarchies carrying multiple variations.
- Split Phase: Separate reading, computing, and writing.

Refactor in small steps. Changing structure, renaming, altering behavior, or upgrading dependencies should be done separately; otherwise, if something fails, it's impossible to determine the cause.

### 3.2 Add Safety Nets First

If the code lacks tests, you can first:

- Add characterization tests to record current actual behavior.
- Use input-output snapshots to compare before and after refactoring.
- Add logs or assertions to verify paths.
- Run real requests in a controlled environment.

What is recorded is the "current behavior," which does not necessarily represent the "correct behavior." If bugs are found, fix them separately; do not mix them into refactoring.

## 4. Code Review

The goal of a review is to reduce risk, not to show who is smarter.

Prioritize checking:

1. Whether requirements are correctly implemented and if boundaries are missed.
2. Permissions, data security, error handling, and rollback.
3. Interfaces, database migrations, and compatibility.
4. Concurrency, resource release, timeouts, and retries.
5. Whether tests cover critical risks.
6. Whether naming and structure are understandable to future maintainers.

Formatting issues can be handled by automated tools. Review comments should explain the problem, impact, and suggestion, rather than just say "this is bad." The author is responsible for changes but should not treat the review as a guessing game.

### 4.1 Review Size

Very large change sets are hard to review seriously. Split submissions into independently verifiable logic, but do not split every minor change into pieces that cannot run. There must be a clear sequence between database migrations, code, and configuration changes.

## 5. Testing Layers

Testing is not about quantity but about capturing the most important risks at the lowest cost.

| Layer | What It Validates | Characteristics |
| --- | --- | --- |
| Unit Test | Rules of a single function, class, or module | Fast, stable, precise localization |
| Integration Test | Modules with database, queue, or external adapters | Closer to real scenarios, higher preparation cost |
| Contract Test | Schema and behavior between services | Prevents version incompatibility |
| End-to-End Test | Key user paths | Most confident, slowest, most fragile |
| Performance/Stress Test | Latency, throughput, resource limits | Requires real data and monitoring |
| Security Test | Input, permissions, dependencies, and configuration | Requires attacker perspective |

The number and proportion of tests depend on the system. Pure functions with many business rules are suitable for unit tests; database queries and permission boundaries need integration tests; key paths like payment and login are worth end-to-end testing.

### 5.1 AAA Structure

```text
Arrange: Prepare inputs and dependencies
Act: Execute the behavior under test
Assert: Verify output and side effects
```

Test names should specify the scenario and expectations, such as "refuse to place orders when stock exceeds limits," rather than `testCreateOrder2`. 

### 5.2 Good Unit Testing

- Only verify one behavior. 
- Clear input, independent of execution order. 
- Does not rely on the real network, current time, or random numbers. 
- Failure messages can indicate which rule is wrong. 
- Do not duplicate implementation details, otherwise the test will fail during refactoring. 

Time, random numbers, and UUIDs should be injectable or controllable. Database testing should use independent schemas, transaction rollbacks, or containers to avoid shared states. 

## 6. Test the double

When dependence is slow, uncontrollable, or has side effects, the following can be used: 

- **Stub**: Returns the preset result. 
- **Mock**: Verify that an interaction has occurred. 
- **Fake**: Implemented simplified but workable, such as memory warehousing. 
- **Spy**: Records calls and allows real execution. 

Alternative dependencies reduce authenticity. Don't mock everything and then claim "integration test passed." Critical permissions, serialization, database constraints, and network errors should be verified in environments closer to reality. 

## 7. TDD and Coverage

### 7.1 TDD

Red—Green—Reconstruction: 

1. Write a failed test describing the expected behavior. 
2. Let it pass with minimal implementation. 
3. Refactoring under test protection. 

TDD helps clarify interfaces and boundaries first, but is not suitable for all exploratory tasks. The key is not formality, but testing whether verifiable requirements are expressed before implementation. 

### 7.2 Coverage Rate

Line coverage indicates how many lines have been executed; branch coverage observes the branch conditions. High coverage does not prove correct: 

- Asserting that it may be empty. 
- Testing may only take the happy path. 
- Override code does not represent business risk coverage. 
- Tests written to improve numbers increase maintenance costs. 

Coverage can serve as a signal for discovering blind spots, not as a quality objective itself. Critical paths, permissions, amounts, concurrency, and error handling should be clearly tested. 

### 7.3 Flaky Test

Occasional failed tests can undermine trust. Common causes: 

- Relying on real time, networks, or execution sequences. 
- Concurrent shared state. 
- Asynchronous waiting is insufficient or fixed sleep. 
- Test data is not isolated. 
- Randomly input unfixed seeds. 

Failure logs, isolation of test data, and use waitable conditions rather than simple reruns. Long-term flaky tests must either be fixed or deleted; masking cannot be repeated indefinitely. 

## 8. Design patterns

Design patterns are the common language for common problems, not a mandatory directory. 

| Pattern | Problem Solved | When Not to Use |
| --- | --- | --- |
| Strategy | Replaceable algorithm or rule | Only one or two stable branches |
| Adapter | Unify different external interfaces | Direct conversion is simpler |
| Decorator | Overlay behavior without modifying the original object | Too many layers make tracking difficult |
| Factory | Package Creation Logic and Selection | Create only a fixed object |
| Observer | State changes notify multiple parties | Implicit event chains are difficult to debug |
| Singleton | Globally unique instance | Difficulty in hiding dependencies and test isolation |

### 8.1 Combination Favors Inheritance

Inheritance expresses "one akind," while combinatorial expressions express "possessing a certain capability." When subclasses need to combine multiple variation dimensions, inheritance can easily explode. Prioritize extracting behaviors into composable components or strategies. 

### 8.2 Avoid Overdesign

If there is only one implementation, one direction of change, and one point of use, interfaces and factories may simply add jumps. Design patterns should be introduced when changes have already appeared or are clearly foreseeable, and protected by testing. 

## 9. Boundaries and misdesign

Good code clearly fails at the boundary: 

- Validate untrusted inputs. 
- Represent different failures using exceptions, result types, or error codes. 
- Do not swallow errors or expose internal anomalies directly to users. 
- Resources can also be released on abnormal paths. 
- Retries are only used for recoverable errors and operate on idempotents. 
- Logs carry context but do not disclose sensitive information. 

Error handling is not `try/catch` everything. It is necessary to clarify which layer is responsible for recovery, which layer is responsible for transformation, and which layer is responsible for informing users. 

## 10. Pre-delivery inspection

1. Are key behaviors and boundaries tested? 
2. Whether the new code introduces shared variable states or resource leaks. 
3. Whether interfaces and database changes are compatible. 
4. Whether the error path has logs and stable responses. 
5. Whether documents need to be updated, configured, or migrated. 
6. Whether to run format, static checks, unit and integration tests. 
7. Code review focuses on risk and maintainability, rather than just picking styles. 

## Checklist

- Whether the code structure and naming represent the real domain. 
- Whether functions are on the same abstraction layer and whether side effects are clear. 
- Whether bad taste is driven by actual change costs to fix it. 
- Whether refactoring involves testing or reproducible validation. 
- Test whether normal, boundary, error, and permissions are covered. 
- Whether unit, integration, contract, and end-to-end boundaries are distinguished. 
- Testing whether it is determined, isolated, readable, and can be localized if failure is possible. 
- Whether coverage is a signal, not a goal. 
- Does the design pattern address real changes and avoid excessive abstraction? 
- Whether the error and resource release paths are complete.
