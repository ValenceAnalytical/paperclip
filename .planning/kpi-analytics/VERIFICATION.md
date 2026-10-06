# KPI Analytics — Verification Checklist

Date: 2026-10-06

Each row maps a requirement to the evidence that proves it. Fill in after
run.

## Formulas

| Requirement | Verified by |
|---|---|
| runCount broken out by status | `kpi-analytics.test.ts > overview counts by status` |
| Retries counted via `retry_of_run_id IS NOT NULL` | `kpi-analytics.test.ts > counts retries only when retry_of_run_id set` |
| Duration p50/p95 only for succeeded runs with both timestamps | `kpi-analytics.test.ts > duration percentiles exclude unfinished and non-succeeded` |
| Cost null when zero rows | `kpi-analytics.test.ts > cost null when no cost events` |
| Coverage percent reported | `kpi-analytics.test.ts > coverage percent reflects runs with cost / total` |
| Duplicate cost events for same run count once at coverage | `kpi-analytics.test.ts > duplicate cost events do not double-count runs` |
| Approval wait only when both timestamps present | `kpi-analytics.test.ts > approval wait tracked vs not-tracked` |
| Task done distinct from run success | `kpi-analytics.test.ts > tasks done counts issues status done regardless of run outcome` |

## Isolation

| Requirement | Verified by |
|---|---|
| No cross-company read at service layer | `kpi-analytics.test.ts > seeded two companies, cross reads return only own rows` |
| Agent key cross-company request → 403 | `kpi.test.ts > agent key cross-company 403` |
| Board user not in company → 403 | `kpi.test.ts > board without membership 403` |
| Unknown company id → 404 | `kpi.test.ts > unknown company 404` |

## Filters, bounds

| Requirement | Verified by |
|---|---|
| agentId filter restricts both run and cost queries | `kpi-analytics.test.ts > agent filter applied` |
| projectId filter via context_snapshot | `kpi-analytics.test.ts > project filter applied` |
| provider filter restricts cost only, flagged | `kpi-analytics.test.ts > provider filter flags runsIgnored` |
| Bad `from` → 400 | `kpi.test.ts > bad from returns 400` |
| Zero-data window → 200 with nulls | `kpi.test.ts > zero data window` |

## UI

| Requirement | Verified by |
|---|---|
| Loading, empty, error states | `AuditKpi.test.tsx` three cases |
| Accessibility: table caption, headings | `AuditKpi.test.tsx > a11y assertions` |

## Typecheck / build

- `pnpm --filter @paperclipai/shared typecheck`
- `pnpm --filter @paperclipai/server typecheck`
- `pnpm --filter @paperclipai/ui typecheck`

## Honest gaps

Reported in EXECUTION.md §Risks and in the final implementation report.
