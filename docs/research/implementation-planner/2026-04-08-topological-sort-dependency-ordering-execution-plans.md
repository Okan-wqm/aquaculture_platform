---
Topic: Dependency ordering for implementation packages — Kahn's algorithm, cycle detection, parallelizable vs serial identification, and deterministic execution order.
---

## Sources

- Thomas H. Cormen et al., "Introduction to Algorithms" (CLRS), 4th ed. — Chapter 22.4 Topological Sort (Kahn's BFS variant + DFS variant)
- Wikipedia, "Topological sorting" — Kahn's algorithm pseudocode and cycle detection proof
  https://en.wikipedia.org/wiki/Topological_sorting
- Robert Tarjan, "Depth-first search and linear graph algorithms" (SIAM J. Comput., 1972) — SCC algorithm for cycle isolation
- Donald Knuth, "The Art of Computer Programming Vol. 1" — topological sort discussion (original algorithm genealogy)
- Microsoft Learn, "Dependency management in Azure DevOps pipelines"
  https://learn.microsoft.com/en-us/azure/devops/pipelines/
- DORA Research, "State of DevOps Report 2023" — Lead Time for Changes, deployment frequency
  https://dora.dev/research/
- Google Engineering Practices, "Code Review — What to Review"
  https://google.github.io/eng-practices/review/

## Key Findings

### Kahn's Algorithm

Pseudocode for package dependency resolution:
```
1. Build directed graph G where edge (A → B) means "A must be committed before B"
2. Compute in-degree for every node
3. Initialize queue Q with all nodes of in-degree 0 (no prerequisites)
4. while Q is not empty:
     n ← Q.dequeue()  // deterministic: sort Q by package-slug ascending before dequeue
     emit(n)
     for each neighbor m of n:
         in-degree[m] -= 1
         if in-degree[m] == 0: Q.enqueue(m)
5. if emitted count < total node count: CYCLE DETECTED (remaining nodes form cycles)
```

**Deterministic tie-breaking rule**: when multiple packages have in-degree 0 simultaneously (parallelizable candidates), sort by package slug ascending (lexicographic). This ensures bit-identical execution order across plan re-generations — required for diff-based cycle-over-cycle comparison and automated verification logs.

### Cycle Detection

- Kahn's algorithm detects cycles as a natural by-product: if the algorithm terminates with emitted count < total node count, a cycle exists. The remaining un-emitted nodes form one or more cycles.
- To isolate WHICH packages form cycles (when multiple independent cycles exist), run Tarjan's SCC algorithm on the remaining subgraph. Each non-trivial SCC (size > 1) is one cycle.
- Cycles in the package dependency graph ALWAYS indicate a shared concern that cannot be implemented independently. In the aqua-saas context, the most common cause is a shared event contract change that two packages each depend on — neither can go first. This is an architectural conflict requiring arbitration.

### Prerequisite vs Co-requisite

- **Prerequisite (hard dependency)**: Package B cannot compile, test, or run correctly without Package A having been committed first. Example: a new entity field is a prerequisite for the handler that uses it.
- **Co-requisite (soft dependency)**: Packages A and B are logically coupled but can be committed in either order. Both must be committed before the final verification gate. Example: two independent guard fixes in the same request pipeline.
- Co-requisites are NOT represented as directed edges in the DAG — they are noted as peer packages in the plan. Representing co-requisites as directed edges artificially serializes parallelizable work.

### Parallelizable vs Serial Identification

- Packages with no dependency edges between them are **parallelizable**: they can be implemented and committed in parallel branches, merged in any order.
- In the aqua-saas NestJS CQRS architecture, command handlers and query handlers in different bounded contexts are almost always parallelizable — they share no TypeORM entities and no event contracts.
- Packages involving entity changes are serial relative to any downstream handler, event publisher, or migration that uses that entity.
- GraphQL schema changes (resolver → subgraph schema → gateway supergraph) must be serialized in that order; no step can be skipped.

### DAG Construction from Review Findings

- Build edges by scanning the Affected Files list of each package for shared symbols:
  - If Package A exports a new TypeORM entity field and Package B imports/uses that entity → A → B edge
  - If Package A changes an event contract interface and Package B changes a producer/consumer of that interface → A → B edge (A first)
  - If Package A is a migration and Package B uses the new column → A → B edge
  - If Package A modifies a shared lib (`libs/backend-common`, `libs/event-contracts`) and Package B modifies a consumer of that lib → A → B edge
- Edge construction must be exhaustive: missing an edge causes an out-of-order commit that breaks the build.

### Deterministic Ordering in Practice

- The Google eng-practices guide on code review emphasizes that review order should be deterministic for audit and rollback purposes. This applies equally to implementation order.
- DORA's Lead Time for Changes metric is directly improved by correct topological ordering: parallel work reduces serial wait time, which is the dominant driver of lead time.

## Security Concerns

- Security-fixing packages should be ordered as early as possible in the topological sequence (within their DAG constraints). A security fix that is delayed behind lower-priority packages extends the exposure window.
- If a security package has no dependencies, it MUST be placed at position 1 (first in queue) by overriding the tie-breaking sort rule for security-tagged packages.

## Performance Concerns

- Building the DAG is O(V + E) using adjacency lists. For 50+ packages, this is negligible.
- A cycle in the DAG discovered at plan generation time costs seconds to resolve. A cycle discovered during execution (after 30 commits) costs hours. Cycle detection at planning time is mandatory.

## Architectural Implications

- The execution plan's topological order is the platform's "safe commit sequence". Any deviation from this order (e.g., committing a handler before its prerequisite entity change) will produce a broken intermediate state visible to CI.
- For the aqua-saas GraphQL federation architecture, package ordering must respect the federation composition order: schema changes in a subgraph → gateway supergraph re-composition → frontend query updates. Violating this order breaks the gateway build.
- CQRS command/event package ordering: entity field → command DTO → command handler → event emitter → event consumer. Missing any step in this chain leaves partially implemented CQRS flows that pass TypeScript compilation but fail integration tests.

## Domain Rule Additions

1. Construct a DAG where edge (A → B) means Package A must be committed before Package B. Edges arise from shared entities, event contracts, shared libs, and migrations.
2. Apply Kahn's algorithm with deterministic tie-break (sort zero-in-degree packages by slug ascending) to produce the execution sequence.
3. Cycles in the DAG must be isolated via Tarjan's SCC and escalated to architectural-arbiter — they are never auto-resolved.
4. Parallelizable packages (no edges between them) are explicitly identified in the plan as such. Co-requisites are noted as peer annotations, not DAG edges.
5. Security-tagged packages with no prerequisite dependencies are placed first in the execution sequence, overriding lexicographic tie-breaking.
