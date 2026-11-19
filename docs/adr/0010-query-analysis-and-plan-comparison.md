# ADR-010: Query analysis presentation and plan comparison

- Status: **Accepted** (Week 8)
- Date: 2026-11-19
- Related: ADR-002 (PlanToolkit), plan §4, §5.2 rule 10, §10 scenarios 7, 8, 19

## Context

Week 2 built the plan toolkit: Rust and TypeScript parsers behind the
`PlanToolkit` interface, with `parsePlan` and `diffPlans`. Week 4 added the
Explain action and a flat list of parsed nodes. Week 8 requires the analysis
feature itself: a plan tree, neutral explanations, the raw output one click
away, and plan comparison lite (pin a plan, change the schema, re-run, see a
node-level diff). Plan text varies between SQLite versions, so the parser must
be tested against fixtures from the selected version and unknown forms must
degrade to `OTHER`.

The architecture rule is that app code never depends on whether the Rust wasm
or the TypeScript fallback is active; the toolkit lives in the worker.

## Decision

### Tree and explanations (main thread)

- `buildPlanTree` turns the flat `(id, parentId, detail)` rows into a forest.
  A node is a root when it points at itself or at an id that is not present;
  input order is preserved, and duplicate ids are kept as roots rather than
  dropped. SQLite reports a forest (subqueries can have their own roots), not a
  single tree.
- The tree is rendered as a nested `ul[role="tree"]` with `treeitem` levels, so
  screen readers get the hierarchy without a custom widget. Full keyboard and
  screen-reader auditing remains part of the Week 9 NFR-11 pass.
- `describePlanNode` produces one neutral sentence per node. Scan, search,
  covering index, automatic index, integer primary key, temp B-tree,
  co-routine, materialization, and Bloom filter forms are described as facts.
  The text never calls an operation good, bad, fast, slow, or optimal; a
  visible note repeats that rule. Unknown details fall back to the raw text.
- Raw `id|parent|detail` rows stay in a collapsed `<details>` element, one
  click away, and are always part of the rendered plan.

### Diff (worker)

- A new worker request `diff-plans` carries two parsed `QueryPlan` objects and
  returns the toolkit's `PlanDiff`. `WorkerManager.diffPlans` and
  `DatabaseService.diffPlans` expose it; the main thread never imports a
  toolkit implementation.
- Nodes are matched by SQLite's EQP `id`, which is stable for the same query
  text. `changed` pairs show before/after, and `added`/`removed` cover shape
  changes. An unchanged plan reports an explicit empty diff.
- The pin is page state only (`{ plan, sql }`), not persisted. Reloading clears
  it; it is analysis context, not user data. Pinning the current plan shows a
  hint until the next Explain computes the diff.

### Fixtures

- `planFixtures.test.ts` pins real `EXPLAIN QUERY PLAN` rows from SQLite
  **3.54.1** (the selected `@sqlite.org/sqlite-wasm` version) and checks both
  directions: the live engine must still produce those rows, and the parser
  must produce the expected tags/operations. If the engine version changes,
  the test fails and the fixtures are updated deliberately.
- The fixtures exposed a 3.54 form the Week 2 parser did not handle:
  `SEARCH b USING AUTOMATIC COVERING INDEX (y=?)` (no index name) and
  `BLOOM FILTER ON b`. Both parsers now tag these; the Rust and TypeScript
  implementations remain line-for-line mirrors.

## Alternatives considered

- **Build the tree in Rust**: rejected. The toolkit contract already returns
  nodes; tree shape is presentation, and keeping it in a pure main-thread
  helper makes it testable without the worker.
- **Compute the diff in the UI with the TypeScript parser**: rejected. It
  would make app code depend on the active implementation, violating ADR-002.
- **Persist the pinned plan in IndexedDB**: rejected. The pin is a transient
  comparison aid; persisting it would add metadata migration surface for no
  user-visible safety benefit.
- **Label scans as bad and index searches as optimal**: rejected by the plan.
  Both can be correct depending on the query and data; the feature explains
  what SQLite does, not whether it is "right".

## Consequences

- The analysis panel keeps the raw output even when the parser sees an unknown
  form, so new SQLite versions degrade gracefully.
- Plan comparison reports node-level changes only; it is not a benchmark and
  does not claim one plan is faster.
- A SQLite upgrade requires updating the version-pinned fixtures; that is
  intentional, because plan wording and automatic-index forms change between
  versions.
- The pinned plan is lost on reload and when the tab closes. Users can pin
  again after re-running Explain.
- The diff request is serialized through the existing single-writer queue, so
  it cannot race an execution on the same connection.
