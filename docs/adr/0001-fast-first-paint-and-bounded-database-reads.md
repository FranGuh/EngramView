# ADR 0001: Render immediately and bound database reads

- **Status:** Accepted
- **Date:** 2026-07-20
- **Owners:** EngramView maintainers

## Decision

EngramView will render a theme-aware HTML shell before React starts, recover visibly from frontend boot failures, and make memory loading request-driven rather than effect-chained. Database optimizations will preserve the read-only boundary: EngramView may optimize its queries and connection lifecycle, but will not migrate or index the Engram-owned database.

## Context and evidence

Tauri can show its window before the JavaScript bundle mounts React. The document provides only an empty `#root`, while application styles arrive through JavaScript, so the WebView's white default is visible. Database requests begin after React mounts and do not cause this first-paint gap. Without an error boundary, an early frontend exception can also leave a permanent blank window.

The audit found avoidable reads:

- Startup queries memories for **All projects**, then auto-selects the first project and discards the global result after querying again.
- A project, search, or sort change on a later page can query that old page, reset to page 1, and query again.
- Development `StrictMode` can replay unsafe effects.
- Every page request repeats both the page query and `COUNT`, even when the count inputs did not change.
- `(? IS NULL OR project = ?)` weakens index use versus dedicated query shapes.
- `ORDER BY datetime(updated_at)` adds per-row conversion and can prevent direct index ordering.
- Each command opens and configures a read-only SQLite connection, adding a fixed setup cost.
- Project aggregation is set-based; no N+1 query was found.

Warm-cache measurements were approximately 26.36 ms for a global page, 11.25 ms for a project page, 11.58 ms for a project count, and 0.0077 ms for a detail lookup. These are diagnostic baselines, not end-to-end figures: they exclude cold I/O, IPC, WebView work, and concurrent Engram writes.

## Detailed scope

### First paint and failure recovery

1. Add a small inline shell to `index.html` with a theme-aware background, branding, and loading state. React replaces it on mount.
2. Add a top-level React error boundary with a useful recovery message.
3. Keep the shell dependency-free and modest; it is startup infrastructure, not a second UI.

### Query state and request lifecycle

1. Resolve the initial project before requesting memories; do not issue a result that will immediately be discarded.
2. Coordinate filter and page effects with a stable filter key. A changed project, normalized search, or sort resets a non-first page and returns before issuing a request.
3. Deduplicate only identical in-flight requests and use effect cleanup guards so stale responses cannot update visible data, loading, or errors.
4. Treat `StrictMode` replay as a correctness test: initial and list requests are deduplicated only while in flight, then released for retry and freshness.

### SQL and result boundaries

1. Use separate All-projects and project-scoped SQL instead of nullable `OR` predicates.
2. Preserve `datetime(...)` ordering because the external database does not enforce one canonical timestamp text representation.
3. Compute count and rows inside the same read transaction snapshot. Do not trust client-supplied totals or cache counts across externally owned writes.
4. Return only fields consumed by list and detail views; never send full memory content in list payloads.
5. Keep offset pagination for the numbered-page UI. Consider keyset pagination only if deep-page measurements justify its arbitrary-jump, reverse-navigation, and total-page complexity.

### Connection and project-cache boundaries

1. Consider a small managed read-only connection strategy only after measuring gains and proving safe coexistence with external Engram writes. Every connection retains read-only flags, busy timeout, and `PRAGMA query_only`.
2. Deduplicate project-summary reads only while in flight. Refresh on window focus when the previous successful refresh is at least 30 seconds old; transient startup failures expose an explicit Retry action.
3. Pooling and project caching are not prerequisites for the first rollout. Removing duplicate requests is lower risk and higher confidence.

## Schema ownership and safety constraint

EngramView reads an externally owned Engram database. It must not create indexes, migrate tables, persist pragmas, or otherwise mutate that schema. Candidate indexes on memory timestamps or session project/start time belong in Engram itself. Read performance does not justify weakening this boundary.

## Rejected alternatives

| Alternative | Tradeoff and reason rejected |
| --- | --- |
| Hide Tauri until `frontend-ready` | Removes the flash but adds cross-process coordination, timeout recovery, and a greater risk that startup appears hung. Reconsider only if the shell is insufficient. |
| Keep the default WebView background | Minimal work, but preserves the white flash and provides no failure feedback. |
| Add indexes from EngramView | May accelerate reads, but violates schema ownership and increases another application's write/storage costs. |
| Pool immediately | May reduce setup overhead, but adds lifecycle and concurrency complexity before duplicate reads are removed and remeasured. |
| Adopt keyset pagination now | Helps deep sequential scans, but conflicts with arbitrary numbered pages and complicates totals and reverse navigation. |
| Cache all results indefinitely | Reduces reads, but makes externally written data stale and increases memory and invalidation risk. |

## Consequences

### Benefits

- Meaningful, theme-correct first paint and actionable boot failures.
- Fewer startup, filter-change, and page-reset reads.
- Stale responses cannot overwrite newer intent.
- SQL shapes become easier to optimize and measure.
- The read-only trust boundary remains explicit.

### Costs and risks

- A small amount of startup styling exists outside React and must remain theme-aligned.
- Coordinated effects and stale-request guards add frontend lifecycle complexity.
- Repeating `COUNT` preserves external-write correctness but retains measurable page-navigation cost.
- `datetime(...)` preserves compatibility with legacy timestamp representations but limits index-order optimization.
- Managed connections retain resources longer and must handle external writers and application suspension safely.

## Rollout and verification

1. Add the shell and error boundary. Verify light/dark cold starts and a forced render failure in packaged Tauri.
2. Centralize query state, remove discarded startup work, and guard stale responses. Instrument command counts and verify one intended list request per startup or user transition; development replay must not corrupt visible state.
3. Split non-search SQL, retain defensive timestamp conversion, and keep count plus rows in one read snapshot. Compare cold/warm timings, query plans, row counts, and IPC payload sizes with the audit baseline.
4. Consider managed connections or project-summary caching only if new measurements identify them as material bottlenecks.

Required checks: frontend build/tests, Rust tests/checks, paging/search/sort smoke tests, external-write freshness, database-busy behavior, and proof that database bytes and schema remain unchanged.

## Rollback

Each stage is independently reversible:

- Remove the inline shell while retaining the error boundary if theme synchronization regresses.
- Restore the prior loader without reverting SQL improvements if coordinated query behavior regresses.
- Restore previous SQL ordering if legacy timestamps fail lexical validation.
- Restore nullable non-search predicates without changing the database contract.
- Return to per-command connections if managed connections cause locking, suspension, or freshness faults.

Rollback must never mutate the Engram schema to compensate for viewer behavior.

