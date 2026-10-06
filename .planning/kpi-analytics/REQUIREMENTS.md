# KPI Analytics — Requirements

Date: 2026-10-06
Branch: feature/kpi-analytics
Base commit: a9c081d7f90dce4a9534c274721e2c1b612c5365
Author: Forrest / Claude Opus 4.7 (1M)

## Goal

Deliver a working, company-scoped KPI dashboard that reports what already happened in the Paperclip control plane. Read authoritative tables; do not introduce a new recorder, a parallel event log, or any mutation to the heartbeat/approval/adapter hot paths.

## Non-goals (explicit)

- No new recorder or `agent_kpis`-style table.
- No automatic CEO wakeups, prompt mutation, or self-improvement loops.
- No touching heartbeat/adapters/approval/auth/runtime defaults.
- No port of Surfers code (`/home/forrest/Projects/paperclip-surfers-review`) — concepts only; separate attribution if any snippet is lifted.
- No PR/push; local commit only.

## Scope

A company-scoped KPI dashboard with:

- An explicit UTC date window (default last 7 days UTC, caller may override).
- Optional filters where the authoritative metadata supports them:
  - `agentId` (`heartbeat_runs.agent_id`, `cost_events.agent_id`)
  - `projectId` (`cost_events.project_id`; runs: `context_snapshot ->> 'projectId'`)
  - `provider` (`cost_events.provider`)
- Overview cards, trend time series, per-agent breakdown table.
- Loading / empty / error / accessible states.
- Tests covering formulas, isolation, duplicate guards, status filters, filter bounds, zero and cross-company denial.

## Metric contracts (authoritative definitions)

All metrics are company-scoped. Window boundaries are `[from, to)` on `occurred_at` (cost) and `created_at` or `started_at` (runs), interpreted UTC.

### Runs

Source: `heartbeat_runs` filtered by `company_id`, created or started within the window.

- `runCount.total` — all runs whose `created_at ∈ [from, to)`.
- `runCount.succeeded` — subset where `status = 'succeeded'`.
- `runCount.failed` — subset where `status = 'failed'`.
- `runCount.cancelled` — subset where `status = 'cancelled'`.
- `runCount.pending` — subset where `status ∈ ('queued','running')`.
- `runCount.retries` — subset where `retry_of_run_id IS NOT NULL`. Observable, not inferred.

Status taxonomy anchor: see `packages/db/src/schema/heartbeat_runs.ts:28` (default `'queued'`). Values observed in heartbeat.ts: `queued | running | succeeded | failed | cancelled`.

### Duration

- `durationMs.p50`, `durationMs.p95` — Postgres `percentile_cont` over
  `extract(epoch from (finished_at - started_at)) * 1000` for runs where
  `status = 'succeeded' AND started_at IS NOT NULL AND finished_at IS NOT NULL`.
- Return `null` for a percentile if fewer than N=1 completed runs.

### Cost / tokens

Source: `cost_events`.

- `costCents.total` — `sum(cost_cents)` over window + filter predicates.
  Return `null` when there are zero rows (unknown ≠ 0); otherwise the sum.
- `tokens.input / cachedInput / output` — same aggregation; `null` on empty.
- Double-count guard: when attributing cost **to runs**, count distinct `heartbeat_run_id` only. The sum of cost cents never re-joins through runs; it stays on `cost_events` to avoid fan-out.

### Coverage

- `runsWithCost` — distinct `heartbeat_runs.id` where ≥ 1 `cost_events` row joins.
- `runsWithoutCost` — total runs minus runsWithCost.
- `coveragePercent` — `runsWithCost / max(1,total) * 100`, rounded 2dp. Reported explicitly so observers know unknown cost is unknown, not zero.

### Task done

Source: `issues`.

- `tasksDone` — distinct `issues.id` where `status = 'done'` and
  `updated_at ∈ [from, to)` within the company. Independent of run success.

### Approval wait

Source: `approvals` (confirmed `created_at` + `decided_at` columns —
see `packages/db/src/schema/approvals.ts`).

- `approvalWaitMs.p50 / p95` — percentile over `(decided_at - created_at)` ms
  for rows where `decided_at ∈ [from, to) AND decided_at IS NOT NULL`.
- `approvalCount` — count of such rows.
- When no durable timestamps are returned by the query (both pivotal cols set
  on ≥ 1 row), report `tracked: false` and `null` percentiles rather than 0.

### Per-agent table

For each agent that has ≥ 1 run **or** ≥ 1 cost event in window:
- `agentId`, `agentName`
- `runCount.{total,succeeded,failed,cancelled,retries}`
- `costCents` (null if no cost events)
- `tokens.{input,cachedInput,output}` (null if no cost events)
- `durationMs.{p50,p95}` (null if no completed runs)

### Trend series

For each UTC day in the window (bucket size: `day`; weeks collapse to days
in dashboards up to 90-day windows, flagged as a non-goal to widen later):
- `bucketStart` (ISO UTC midnight)
- `runCount.{total,succeeded,failed}`
- `costCents` (null if no cost events bucket)

## Filters

Each filter is independent and additive via `AND`.
- `agentId` — single UUID; applies to runs (`heartbeat_runs.agent_id`) and cost (`cost_events.agent_id`).
- `projectId` — single UUID; applies to cost (`cost_events.project_id`), runs via `context_snapshot ->> 'projectId'` (nullable, so a project filter may legitimately return 0).
- `provider` — single string; applies to `cost_events.provider` only. Does not restrict run count because runs do not carry provider metadata.

Filter precedence rule: when `provider` is set, run-level metrics are
reported unfiltered **and the response flags `providerFilterRunsIgnored: true`** so the UI can disclose honestly.

## Auth & isolation

Reuse existing patterns from `server/src/routes/costs.ts`:
- `assertCompanyAccess(req, companyId)` on every endpoint.
- `access.decide({ action: 'company_scope:read', resource: { type: 'company', companyId } })` gate.
- No cross-company reads; agent API keys bound to their own company only.
- 404 on unknown company IDs (do not leak existence).

## Observability path

Reads only the "run log" path from AGENTS.md §7. No OpenTelemetry span attributes. No Paperclip telemetry events. Qualifies for "no extra review" per that policy.

## Deliverables

- `.planning/kpi-analytics/*.md` (this directory)
- `packages/shared/src/types/kpi.ts`
- `server/src/services/kpi-analytics.ts`
- `server/src/routes/kpi.ts` + registration
- `ui/src/api/kpi.ts`
- `ui/src/pages/audit/AuditKpi.tsx`
- Audit shell wiring (`audit-navigation.ts`, `AuditHub.tsx`, `App.tsx`)
- Tests: service, route, UI
- Implementation report at `/home/forrest/accumark-production/paperclip/kpi-implementation-20261006.md`
