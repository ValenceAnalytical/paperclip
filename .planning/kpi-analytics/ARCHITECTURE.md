# KPI Analytics — Architectural Choice

Date: 2026-10-06

## Decision

Build an **isolated read-model** service and GET-only route surface over the
existing authoritative tables, slot the UI into the existing **Audit hub** as
a new section. Do not create new tables, migrations, columns, recorders, or
touch any mutating service.

## Why this shape

### Options considered

| Option | Verdict | Reason |
|---|---|---|
| Plugin SDK extension (write a Paperclip plugin that exposes KPI UI) | **Rejected.** The plugin SDK (`packages/plugins/`) today exposes UI iframes/static resources and plugin-owned DB namespaces, but does not expose scoped read access to the host's authoritative `heartbeat_runs`/`cost_events` tables without private hooks. Attempting it would either duplicate data into a plugin namespace (parallel recorder, forbidden) or require a private host hook. |
| Port Surfers `agent_kpis` recorder | **Rejected.** The Surfers review already concluded (`surfers-feature-review-20261006.md`): synthetic parallel data, mixes task-completion with quality, double-counts/undercounts subscription cost, no coverage reporting. |
| New top-level `/kpi` page in Sidebar.tsx | **Rejected.** Sidebar.tsx is in the merge-conflict zone the Hermes bridge candidate is navigating. Mandate: no new sidebar entries. |
| Isolated read-model + GET routes + Audit section | **Chosen.** Low conflict, respects AGENTS.md core rules (company scoping, contract sync, no spec drift), reuses `assertCompanyAccess` and `access.decide`, slots into Audit alongside Costs where this analysis already belongs. |

### Why Audit, not Dashboard

Audit's existing sections (`activity`, `runs`, `costs`, `budgets`, `timeline`) are the operator's "what already happened" surface. KPIs are a derived view of the same raw material. Dashboard is live/present state. Analytics belongs beside Runs and Costs, not beside live cards.

## Component map

```
packages/shared/src/types/kpi.ts          — API contract shared across layers
server/src/services/kpi-analytics.ts      — read-only aggregation (Drizzle)
server/src/routes/kpi.ts                  — GET endpoints, auth gates
server/src/routes/index.ts                — re-export
server/src/services/index.ts              — re-export
server/src/app.ts                         — mount at /api
ui/src/api/kpi.ts                         — fetch wrappers + query keys
ui/src/pages/audit/AuditKpi.tsx           — page component
ui/src/pages/audit/audit-navigation.ts    — add 'analytics' section
ui/src/pages/audit/AuditHub.tsx           — route analytics → AuditKpi
ui/src/App.tsx                            — add route alias /activity/analytics
```

## Data flow

```
            Browser (AuditKpi page)
                   │
                   ▼
           /api/companies/:id/kpi/overview
           /api/companies/:id/kpi/trend
           /api/companies/:id/kpi/by-agent
                   │  (auth: assertCompanyAccess + access.decide)
                   ▼
             kpi-analytics service
                   │
   ┌───────────────┼────────────────┬────────────────┐
   ▼               ▼                ▼                ▼
heartbeat_runs  cost_events      issues           approvals
(status, retry) (cost, tokens)   (status=done)    (created/decided)
```

No table is written. No service outside this surface is called for mutation.

## Permission scheme

Reuses the exact pattern from `server/src/routes/costs.ts`:

1. `assertCompanyAccess(req, companyId)` — board user must have company in `req.actor.companyIds`; agent key must be bound to the same company.
2. `access.decide({ action: 'company_scope:read', ... })` — honor fine-grained access policy. Deny → HTTP 403 "KPIs are outside this actor's authorization boundary".
3. Unknown company → 404 (same oracle-safe pattern used elsewhere).

No new permission or role is introduced.

## Database queries (sketch)

### Overview

```sql
-- One query bundle, parameters: companyId, from, to, [agentId], [projectId], [provider]
SELECT
  count(*)                                              AS total,
  count(*) FILTER (WHERE status = 'succeeded')          AS succeeded,
  count(*) FILTER (WHERE status = 'failed')             AS failed,
  count(*) FILTER (WHERE status = 'cancelled')          AS cancelled,
  count(*) FILTER (WHERE status IN ('queued','running')) AS pending,
  count(*) FILTER (WHERE retry_of_run_id IS NOT NULL)   AS retries,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY ...)      AS p50_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY ...)     AS p95_ms
FROM heartbeat_runs
WHERE company_id = $1 AND created_at >= $2 AND created_at < $3
  [AND agent_id = $4]
  [AND context_snapshot ->> 'projectId' = $5];
-- NOTE: provider filter does NOT constrain runs. See REQUIREMENTS §Filters.
```

### Cost / coverage

```sql
-- Cost (sum, null when zero rows):
SELECT
  sum(cost_cents) AS total_cents,
  sum(input_tokens) AS input_tokens,
  sum(cached_input_tokens) AS cached_tokens,
  sum(output_tokens) AS output_tokens,
  count(DISTINCT heartbeat_run_id) AS runs_with_cost
FROM cost_events
WHERE company_id = $1 AND occurred_at >= $2 AND occurred_at < $3
  [filters];

-- Null coalesced on application side so unknown stays null.
```

Double-count guard: `runs_with_cost` uses `count(distinct heartbeat_run_id)`. Cost sum stays on the raw rows and never joins through runs.

## Operational properties

- All queries parameterized; no string interpolation.
- Range window is `[from, to)` so day buckets stitch without overlap.
- Null distinction preserved end-to-end: service returns `number | null`,
  shared type is `number | null`, UI renders "—" for null and "0" for zero.
- Coverage percent is always included so observers can see how much of the
  cost picture is actually measured.
