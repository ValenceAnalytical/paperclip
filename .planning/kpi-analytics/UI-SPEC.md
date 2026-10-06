# KPI Analytics — UI Spec

Date: 2026-10-06

## Location

Audit hub, new section `Analytics`.
Route: `/activity/analytics` (also `/audit/analytics` alias via the existing
Audit redirect in `App.tsx`).

## Layout

Three stacked sections inside the existing Audit shell (title bar + tab bar
rendered by `AuditHub.tsx`).

### 1. Overview cards (top row)

Six MetricTile cards following `ui/src/pages/Costs.tsx:MetricTile`:

| Card | Primary value | Subtitle |
|---|---|---|
| Runs | `total` runs | `S / F / C` broken out + "retries: N" |
| Succeeded | number | % of total |
| Duration p50 | ms formatted (e.g., `12.3s`) or "—" | "p95: X" |
| Spend | formatted cents or "—" | coverage % |
| Tasks done | number | within window |
| Approval wait p50 | ms or "not tracked" | "p95: Y" |

### 2. Trend chart (middle)

Simple SVG line/area for `total runs` and `succeeded runs` per UTC day. Bars
beneath for cost cents per day (null days render as gaps, not zero bars).

Reuse the chart style from `ui/src/components/ActivityCharts.tsx` where
sensible to inherit tokens and tooltip styling. If that component's API is
tightly bound to an unrelated data shape, keep the chart local to AuditKpi
using the same tokens.

### 3. Per-agent table (bottom)

Columns:
- Agent (name + avatar from existing `AgentIdentity`)
- Runs (total)
- Succeeded
- Failed
- Cancelled
- Retries
- Duration p50
- Cost (— if null)
- Tokens total (sum of in + cached + out, — if null)

Sorted by Runs desc, with secondary sort by Cost desc.

## Filters

Row above overview cards:
- Date range (reuse `useDateRange` hook from Costs).
- Agent select (optional).
- Project select (optional, only if the company has projects).
- Provider select (optional, derived from distinct providers in cost_events).

The date range control already produces ISO strings; pass through unchanged
to API query string.

## States

- **Loading**: shimmer skeletons at each card and table row count = 5. Use
  `PageSkeleton` or inline `Skeleton` tokens already in use in Costs.
- **Empty** (no runs, no cost events, no tasks): `EmptyState` with icon
  "BarChart3" from lucide-react and message
  "No KPI data for the selected window." Suggest widening the range.
- **Partial** (runs exist, cost missing): render overview with "—" for cost,
  coverage subtitle shows `0% coverage`.
- **Error**: inline error card with the server message. No swallow.
- **Permission denied**: fallback copy "You do not have access to KPIs for
  this organization."

## Accessibility

- Each card is a `<section aria-labelledby>` with a heading.
- Table has `<caption>` and column header `scope="col"`.
- Trend chart has an accompanying `<figcaption>` summarizing the series and
  an aria-label listing per-day values.
- All interactive elements reachable by keyboard, visible focus ring from
  tokens.
- No colour-only encoding: status counts use text labels, not red/green
  without text.

## Design tokens

Token-only per `DESIGN.md`. No raw hex, px, or `[]` Tailwind. Reuse:
- `MetricTile` layout and `--text-micro`, `--tracking-eyebrow`
- `Card`, `CardContent`, `CardHeader`, `CardTitle`
- `cn`, `formatCents`, `formatTokens` helpers in `ui/src/lib/utils`
- `PageTabBar`, `Tabs` already present in AuditHub

No new tokens introduced.
