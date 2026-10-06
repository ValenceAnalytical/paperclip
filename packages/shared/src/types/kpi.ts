/**
 * KPI analytics API contract.
 *
 * This is a derived, read-only view over the authoritative `heartbeat_runs`,
 * `cost_events`, `issues`, and `approvals` tables. All metrics are
 * company-scoped and use an explicit UTC date window. Null is reserved for
 * "unknown / not measured"; zero is reserved for "measured and empty".
 */

export interface KpiRange {
  /** ISO 8601 UTC lower bound, inclusive. */
  from: string;
  /** ISO 8601 UTC upper bound, exclusive. */
  to: string;
}

export interface KpiFilters {
  agentId: string | null;
  projectId: string | null;
  provider: string | null;
}

export interface KpiRunCounts {
  total: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  pending: number;
  retries: number;
}

export interface KpiDuration {
  /** p50 of (finished_at - started_at) in milliseconds for succeeded runs; null if none. */
  p50Ms: number | null;
  /** p95 of same; null if none. */
  p95Ms: number | null;
  /** How many succeeded runs with both timestamps contributed to the percentiles. */
  sampleSize: number;
}

export interface KpiCost {
  /** sum(cost_cents); null when zero cost events match. */
  totalCents: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
}

export interface KpiCoverage {
  /** Distinct heartbeat_run_ids on cost_events within window & filters. */
  runsWithCost: number;
  /** Runs with no corresponding cost event. */
  runsWithoutCost: number;
  /** 2dp percentage of total runs with ≥ 1 cost event. */
  coveragePercent: number;
}

export interface KpiApprovalWait {
  tracked: boolean;
  p50Ms: number | null;
  p95Ms: number | null;
  sampleSize: number;
}

export interface KpiOverview {
  companyId: string;
  range: KpiRange;
  filters: KpiFilters;
  /** When true, provider filter was set so run-level counts are unfiltered. */
  providerFilterRunsIgnored: boolean;
  runCounts: KpiRunCounts;
  duration: KpiDuration;
  cost: KpiCost;
  coverage: KpiCoverage;
  tasksDone: number;
  approvalWait: KpiApprovalWait;
}

export interface KpiTrendBucket {
  /** ISO 8601 UTC midnight of the bucket day. */
  bucketStart: string;
  runCount: {
    total: number;
    succeeded: number;
    failed: number;
  };
  /** Null when the day has no cost events. */
  costCents: number | null;
}

export interface KpiTrend {
  companyId: string;
  range: KpiRange;
  filters: KpiFilters;
  providerFilterRunsIgnored: boolean;
  buckets: KpiTrendBucket[];
}

export interface KpiAgentRow {
  agentId: string;
  agentName: string | null;
  runCounts: KpiRunCounts;
  duration: KpiDuration;
  cost: KpiCost;
}

export interface KpiByAgent {
  companyId: string;
  range: KpiRange;
  filters: KpiFilters;
  providerFilterRunsIgnored: boolean;
  rows: KpiAgentRow[];
}

export interface KpiFilterOptions {
  providers: string[];
}
