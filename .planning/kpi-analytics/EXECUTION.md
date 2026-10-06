# KPI Analytics — Phased Execution Plan

Date: 2026-10-06

## Phase 1 — Shared contract (packages/shared)

1. Create `packages/shared/src/types/kpi.ts` with:
   - `KpiRange` (from/to ISO)
   - `KpiFilters` (agentId?, projectId?, provider?)
   - `KpiOverview`, `KpiTrendBucket`, `KpiAgentRow`
   - `KpiRunCounts`, `KpiDuration`, `KpiCost`, `KpiCoverage`, `KpiApprovalWait`
   - `KpiProviderOption` (for filter populator)
2. Export from `packages/shared/src/types/index.ts`.
3. Re-export from `packages/shared/src/index.ts`.
4. Typecheck shared.

## Phase 2 — Service (server)

1. Create `server/src/services/kpi-analytics.ts`.
2. Factory `kpiAnalyticsService(db: Db)` exporting `{ overview, trend, byAgent, providerOptions }` async functions.
3. Each function accepts `{ companyId, range, filters }`.
4. Implement with Drizzle queries matching ARCHITECTURE.md sketch:
   - FILTERed aggregates on `heartbeat_runs`
   - Separate aggregate on `cost_events`
   - Coverage computed from runs vs runs-with-cost
   - Approval wait via `percentile_cont` on `(decidedAt - createdAt)`
5. Export from `server/src/services/index.ts`.

## Phase 3 — Routes (server)

1. Create `server/src/routes/kpi.ts`.
2. Three GET endpoints under `/companies/:companyId/kpi/{overview,trend,by-agent}`.
3. Fourth endpoint: `/companies/:companyId/kpi/filter-options` returns distinct providers for filter populator.
4. Each endpoint: `assertCompanyAccess` + `assertCompanyKpiReadAllowed` (mirror of Costs pattern).
5. Parse `from`, `to`, `agentId`, `projectId`, `provider` from query string with the same `parseCostDateRange` helper imported from `./costs`.
6. Register in `server/src/routes/index.ts`.
7. Mount in `server/src/app.ts` right after the cost route mount.

## Phase 4 — UI (ui)

1. Create `ui/src/api/kpi.ts` with fetch wrappers.
2. Add query keys to `ui/src/lib/queryKeys.ts` under a new `kpi` namespace.
3. Create `ui/src/pages/audit/AuditKpi.tsx`.
4. Edit `ui/src/pages/audit/audit-navigation.ts` to add `analytics` section.
5. Edit `ui/src/pages/audit/AuditHub.tsx` to route the new section.
6. Edit `ui/src/App.tsx` to add `/activity/analytics` route alias.

## Phase 5 — Tests

Service unit tests (`server/src/services/__tests__/kpi-analytics.test.ts`):
- Overview formulas (counts, p50/p95, cost sum)
- Null coverage (zero cost rows → null, coveragePercent reports)
- Duplicate guard (two cost events for same run → one run counted)
- Status filtering (failed/cancelled/queued/running excluded from "succeeded")
- Retry counting (`retry_of_run_id` not null)
- Agent/project/provider filters applied correctly
- Multi-company isolation (seed two companies, assert cross-reads blocked at service level by companyId predicate)
- Approval wait tracked vs not-tracked flag

Route tests (`server/src/routes/__tests__/kpi.test.ts`):
- Unauthenticated → 401 (relies on existing middleware)
- Agent key cross-company → 403
- Board user not in company → 403
- Unknown companyId → 404
- Zero data window → 200 with null cost / zero counts
- Date bounds validation (bad `from`)

UI tests (`ui/src/pages/audit/AuditKpi.test.tsx`):
- Loading state renders skeletons
- Empty state message
- Error state message
- Partial state (runs but no cost → "—" + coverage 0)

## Phase 6 — Verification

1. `pnpm --filter @paperclipai/shared typecheck`
2. `pnpm --filter @paperclipai/server typecheck`
3. `pnpm --filter @paperclipai/ui typecheck`
4. Targeted vitest:
   - `pnpm --filter @paperclipai/server test:run --run src/services/__tests__/kpi-analytics.test.ts`
   - `pnpm --filter @paperclipai/server test:run --run src/routes/__tests__/kpi.test.ts`
   - `pnpm --filter @paperclipai/ui test:run --run src/pages/audit/AuditKpi.test.tsx`
5. (Optional) `pnpm dev` + Playwright screenshot if feasible with a seeded instance.
6. Local commit with Conventional Commits message `feat(kpi): add company-scoped KPI analytics read-model and dashboard`.
7. Write `/home/forrest/accumark-production/paperclip/kpi-implementation-20261006.md`.

## Risks and gaps (honest)

- `heartbeat_runs.context_snapshot->>'projectId'` is nullable. The projectId
  filter may legitimately return 0 runs even when cost rows exist for that
  project. This is a true data gap, not a bug; the UI discloses it.
- The `provider` column lives on `cost_events` only. Run-level metrics
  cannot be constrained by provider without changing the heartbeat path, so
  the response reports `providerFilterRunsIgnored: true` when `provider` is
  set.
- Day-bucket time series ignores the user's local timezone and shows UTC
  only. The requirements made UTC explicit.
- No E2E Playwright screenshot was promised; it's attempted on best effort.
