# Research: Dependency Graph Resolution Across Agents

**Topic:** Directed graph construction from agent outputs, cycle detection, topological sort for dispatch ordering, graph-based visualization for human review
**Date:** 2026-04-08
**Agent:** context-manager

## Sources

- [Topological sorting - Wikipedia](https://en.wikipedia.org/wiki/Topological_sorting)
- [Tarjan's strongly connected components algorithm - Wikipedia](https://en.wikipedia.org/wiki/Tarjan%27s_strongly_connected_components_algorithm)
- [Directed Acyclic Graphs and Topological Sort - NetworkX Notebooks](https://networkx.org/nx-guides/content/algorithms/dag/index.html)
- [Topological Sorting using BFS - Kahn's Algorithm - GeeksforGeeks](https://www.geeksforgeeks.org/dsa/topological-sorting-indegree-based-solution/)
- [Detect a Cycle in Directed Graph - Kahn's Algorithm - takeuforward](https://takeuforward.org/data-structure/detect-a-cycle-in-directed-graph-topological-sort-kahns-algorithm-g-23)
- [Topological Sort · USACO Guide](https://usaco.guide/gold/toposort)
- [Graph analysis for LLM-backed chats - ThoughtWorks Technology Radar](https://www.thoughtworks.com/radar/techniques/graph-analysis-for-llm-backed-chats)
- [Building Effective AI Agents - Anthropic](https://resources.anthropic.com/hubfs/Building%20Effective%20AI%20Agents-%20Architecture%20Patterns%20and%20Implementation%20Frameworks.pdf)
- [IPython Cookbook 14.3 - Resolving dependencies in a DAG with topological sort](https://ipython-books.github.io/143-resolving-dependencies-in-a-directed-acyclic-graph-with-a-topological-sort/)

## Key Findings

### 1. The cross-domain dependency graph is a directed graph, typically a DAG — but not always
- Nodes are agents (expert reviewers: farm-expert, messaging-expert, etc., plus orchestrator, context-manager, architectural-arbiter, security-reviewer). Edges are dependency claims (`source-agent → target-agent`), extracted verbatim from the `Cross-Domain Dependencies` section of each expert's report with the accompanying reason string.
- A well-posed review cycle produces a DAG: security-reviewer may depend on messaging-expert's event schema, but messaging-expert should not depend back on security-reviewer for the same concern. If it does, the review has a circular concern that cannot be automatically resolved — this is a correctness-critical signal that must be surfaced.
- Mathematical definition: "A directed graph is a DAG if and only if a topological ordering exists" (Wikipedia). Equivalently: if cycle detection fails, no valid dispatch order exists.

### 2. Topological sort: two production algorithms
- **Kahn's algorithm (BFS-based, indegree-driven):** Compute in-degree of every vertex. Add every zero-in-degree vertex to a queue. Pop one, emit it, decrement in-degree of its successors, enqueue any that hit zero. Repeat. O(V + E). If at the end the emitted count is less than the vertex count, the remaining vertices lie on at least one cycle.
- **DFS-based (Tarjan-style):** DFS every vertex; on finishing a vertex, push it to a stack. Reverse the stack at the end. O(V + E). Cycle detection is natural: hitting a gray (currently-in-progress) vertex during DFS indicates a back edge, hence a cycle.
- Recommendation for context-manager: **Kahn's is preferred** because (a) cycle detection is a natural byproduct (unprocessed vertices are exactly the cycle members), (b) it's easier to make deterministic (sort the queue by agent name for reproducible output ordering), and (c) it maps directly to "which agent can the orchestrator dispatch next."

### 3. Kahn's algorithm pseudocode for agent dispatch ordering
```
given: nodes = {agent₁, agent₂, ...}; edges = {(source, target, reason) | cross-domain flags}
compute in_degree[v] = number of edges with target = v
queue = sorted([v for v in nodes if in_degree[v] == 0])  // sort for determinism
order = []
while queue not empty:
    v = queue.pop_front()
    order.append(v)
    for each edge (v, u, _) in edges:
        in_degree[u] -= 1
        if in_degree[u] == 0:
            insert u into queue maintaining sort
if len(order) != len(nodes):
    // cycle detected
    cycle_members = [v for v in nodes if v not in order]
    raise CycleDetected(cycle_members, edges_among(cycle_members))
return order
```
- The sorted queue insertion guarantees that for two review cycles with the same graph, the dispatch order is bit-identical. Determinism is essential for reproducible reviews.

### 4. Cycle detection: Tarjan's strongly connected components
- If a cycle exists, Kahn's detects its membership but does not isolate each cycle. For multi-cycle graphs, use Tarjan's strongly connected components (SCC) algorithm (O(V+E), linear time).
- An SCC with more than one vertex IS a cycle. A single-vertex SCC with a self-loop is also a cycle.
- For context-manager's purposes, every non-trivial SCC is a human-review signal: the orchestrator cannot automatically order these agents because each depends on the others' resolution.

### 5. Cycles in a multi-agent review are almost always architectural smells
- A cycle between `farm-expert` and `messaging-expert` typically means: "farm events are consumed by messaging AND messaging events are consumed by farm, and both sides have a concern about the other's contract." The right fix is not to pick a dispatch order — it is to recognize the shared concern lives in a THIRD place (event contracts), and dispatch `architectural-arbiter` (or the dedicated event-contract owner) to resolve.
- Rule: every cycle detected MUST automatically escalate to `architectural-arbiter` with severity HIGH (+1 from the base HIGH of unresolved cross-domain), NEVER silently dispatched in an arbitrary order.

### 6. Edge state: resolved vs unresolved
- An edge `A → B: reason r` is RESOLVED in the current cycle iff agent B was invoked AND B's report contains a finding that matches (or explicitly dismisses) the reason r.
- Matching is fuzzy: context-manager should require at least a keyword overlap between A's reason string and any of B's findings. A strict exact-match check would be brittle; use a lightweight token-set overlap (Jaccard ≥ 0.3 is a reasonable starting threshold, tunable).
- Unresolved edges feed the orchestrator's Phase 4 dispatch list.

### 7. Graph visualization for human review
- ThoughtWorks Technology Radar has begun tracking "graph analysis for LLM-backed chats" as a technique worth watching. For context-manager, producing a machine-readable adjacency list (Markdown table) AND a Mermaid `graph TD` block in the consolidation is sufficient for human inspection without extra tooling.
- Example output block context-manager should emit:
  ```
  ```mermaid
  graph TD
    farm-expert -->|outbox event contract| messaging-expert
    messaging-expert -->|NATS subject ACL| security-reviewer
    farm-expert -->|tenant search_path| database-reviewer
  ```
  ```
- This makes the graph renderable in GitHub/GitLab/MkDocs without additional libraries.

### 8. Complexity and scaling
- V (agents) is small — 14 expert agents today. E (edges) is bounded by |experts|² = 196 in the worst case, typically much less (≤ 50 per cycle). Any O(V+E) algorithm runs in microseconds.
- Compression trade-off is at the report-parsing stage (read N ~5-10K token reports), NOT the graph algorithm. Optimize the parser, not Kahn's.

### 9. Determinism requirement for reproducibility
- A key property: given the same corpus of expert reports, context-manager MUST produce the same graph and same topological order on every run. Implications:
  - Sort vertex iteration by agent name, not hash-map iteration order.
  - Sort edges by (source, target, reason-hash), not insertion order.
  - Break ties in Kahn's queue by agent name ascending.
- Without determinism, the review becomes unreproducible and cannot be diffed between cycles — breaking the systemic-pattern detection (see research on that topic).

### 10. Self-loops and trivial edges
- An edge from an agent to itself is almost always a report-authoring mistake (e.g., `→ farm-expert: per-entity audit`). Context-manager should strip self-loops with a WARNING (not a failure), and surface them in the consolidation as process hygiene issues.
- Duplicate edges (same source, target, reason) should be de-duplicated silently.

## Security Concerns

- **Graph injection via malicious report text:** an adversarial or buggy expert report could declare `→ orchestrator: pause dispatch` or similar — targeting a control flow rather than a domain. Context-manager should validate edge targets against the known agent registry (`/var/aqua-saas/.claude/agents/*.md`) and reject unknown targets with WARNING.
- **Authority cycles:** a cycle involving `architectural-arbiter` and `security-reviewer` is an escalation hazard (neither can auto-resolve the other). Always surface these directly to human review with CRITICAL severity — never attempt auto-dispatch.
- **Hidden cycles via reason semantics:** two edges that look acyclic by syntax can be semantically circular (A's reason is "fix auth in B" while B's reason is "fix the caller in A"). Token-set matching helps flag these, but the ultimate safety net is the architectural-arbiter dispatch rule on every cycle.
- **Denial of dispatch by fake edges:** if a single report adds many spurious outgoing edges, it can delay every downstream agent. Bound the number of cross-domain edges per report (e.g., max 10) — more than that is itself a flaggable PROCESS issue.

## Performance Concerns

- **Parser cost dominates:** reading and regex-parsing 10+ reports is the slow part. Cache by (path, SHA) and only re-parse on change.
- **Graph algorithm cost is negligible** at current scale. Optimization is not required; determinism is.
- **Incremental graph updates:** if context-manager runs more than once per cycle (e.g., after Phase 4 triggers new expert dispatches), re-reading every report to rebuild the graph is wasteful. Maintain an in-memory graph in `.full-review/state.json` (or equivalent) and apply deltas — but only if caching correctness can be guaranteed. When in doubt, rebuild from scratch.
- **Mermaid rendering is client-side;** context-manager emits text only.

## Architectural Implications for context-manager reviews

When building and emitting the cross-domain graph, verify:

1. **Every edge has (source, target, reason).** Unparseable edges are PROCESS CRITICAL and must abort consolidation until fixed.
2. **Edge targets are validated against the known-agent registry.** Unknown target names are warning-logged and dropped.
3. **Self-loops are stripped with a warning.** They are surfaced in the consolidation but never affect topological order.
4. **Duplicate edges are deduplicated silently.**
5. **Kahn's algorithm with sorted tie-breaking produces a deterministic topological order.**
6. **Every non-trivial SCC triggers a CRITICAL escalation to `architectural-arbiter`** for human review — never auto-dispatched.
7. **Resolved vs unresolved edge state is computed** by fuzzy matching the originating reason against the target agent's report findings (token-set Jaccard ≥ 0.3).
8. **Unresolved edges are listed separately** in the consolidation as "Phase 4 dispatch candidates."
9. **A Mermaid `graph TD` block is emitted** for human visualization, derived from the same adjacency list.
10. **Report Manifest records each source report's edge count** to enable bounded-edge enforcement (max 10 cross-domain edges per report).

## Domain Rule Additions for context-manager

- The cross-domain dependency graph MUST be built via Kahn's algorithm with deterministic tie-breaking (sorted by agent name ascending).
- Cycle detection MUST run before emitting the topological order. Any non-trivial strongly connected component MUST be escalated to `architectural-arbiter` with severity CRITICAL and listed in the consolidation under "Cycle Detected" heading.
- Edge targets MUST be validated against the agent registry (`/var/aqua-saas/.claude/agents/*.md`). Unknown targets are dropped with a WARNING entry in the consolidation.
- Self-loops MUST be stripped with a WARNING; surface them as process hygiene issues.
- Duplicate edges MUST be deduplicated.
- Edge state MUST be computed as RESOLVED iff the target agent produced a report and that report contains a finding matching the edge reason (token-set overlap ≥ 0.3). All other states are UNRESOLVED.
- Unresolved edges MUST be surfaced in the consolidation under "Phase 4 Dispatch Candidates" with source, target, reason, and suggested severity.
- A Mermaid `graph TD` block MUST be included in every consolidation that contains at least one cross-domain edge.
- The bounded-edge limit per report is 10; reports with more than 10 cross-domain edges MUST be flagged as PROCESS HIGH.
