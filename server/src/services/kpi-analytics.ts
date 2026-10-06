import { and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, costEvents, heartbeatRuns, issues } from "@paperclipai/db";
import type {
  KpiAgentRow,
  KpiApprovalWait,
  KpiByAgent,
  KpiCost,
  KpiCoverage,
  KpiDuration,
  KpiFilterOptions,
  KpiFilters,
  KpiOverview,
  KpiRange,
  KpiRunCounts,
  KpiTrend,
  KpiTrendBucket,
} from "@paperclipai/shared";

export interface KpiServiceInput {
  companyId: string;
  range: KpiRange;
  filters?: Partial<KpiFilters>;
}

const DEFAULT_FILTERS: KpiFilters = { agentId: null, projectId: null, provider: null };

function normalizeFilters(input: Partial<KpiFilters> | undefined): KpiFilters {
  return {
    agentId: input?.agentId?.trim() || null,
    projectId: input?.projectId?.trim() || null,
    provider: input?.provider?.trim() || null,
  };
}

function parseRange(range: KpiRange): { from: Date; to: Date } {
  const from = new Date(range.from);
  const to = new Date(range.to);
  if (Number.isNaN(from.getTime())) throw new Error("invalid KPI range: 'from'");
  if (Number.isNaN(to.getTime())) throw new Error("invalid KPI range: 'to'");
  if (to <= from) throw new Error("invalid KPI range: 'to' must be after 'from'");
  return { from, to };
}

/** Build the `where` predicate list for a heartbeat_runs scan, honoring filters. */
function runWhere(
  companyId: string,
  from: Date,
  to: Date,
  filters: KpiFilters,
) {
  const conditions = [
    eq(heartbeatRuns.companyId, companyId),
    gte(heartbeatRuns.createdAt, from),
    lt(heartbeatRuns.createdAt, to),
  ];
  if (filters.agentId) conditions.push(eq(heartbeatRuns.agentId, filters.agentId));
  if (filters.projectId) {
    conditions.push(sql`${heartbeatRuns.contextSnapshot} ->> 'projectId' = ${filters.projectId}`);
  }
  return and(...conditions);
}

function costWhere(
  companyId: string,
  from: Date,
  to: Date,
  filters: KpiFilters,
) {
  const conditions = [
    eq(costEvents.companyId, companyId),
    gte(costEvents.occurredAt, from),
    lt(costEvents.occurredAt, to),
  ];
  if (filters.agentId) conditions.push(eq(costEvents.agentId, filters.agentId));
  if (filters.projectId) conditions.push(eq(costEvents.projectId, filters.projectId));
  if (filters.provider) conditions.push(eq(costEvents.provider, filters.provider));
  return and(...conditions);
}

/** Coerce a drizzle numeric aggregate to number | null, preserving unknown. */
function nullableInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function queryRunCounts(
  db: Db,
  companyId: string,
  from: Date,
  to: Date,
  filters: KpiFilters,
): Promise<KpiRunCounts & { durationP50Ms: number | null; durationP95Ms: number | null; durationSample: number }> {
  const row = await db
    .select({
      total: sql<number>`count(*)::int`,
      succeeded: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'succeeded')::int`,
      failed: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'failed')::int`,
      cancelled: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'cancelled')::int`,
      pending: sql<number>`count(*) filter (where ${heartbeatRuns.status} in ('queued','running'))::int`,
      retries: sql<number>`count(*) filter (where ${heartbeatRuns.retryOfRunId} is not null)::int`,
      durationP50Ms: sql<string | null>`
        percentile_cont(0.5) within group (
          order by extract(epoch from (${heartbeatRuns.finishedAt} - ${heartbeatRuns.startedAt})) * 1000
        ) filter (
          where ${heartbeatRuns.status} = 'succeeded'
            and ${heartbeatRuns.startedAt} is not null
            and ${heartbeatRuns.finishedAt} is not null
        )
      `,
      durationP95Ms: sql<string | null>`
        percentile_cont(0.95) within group (
          order by extract(epoch from (${heartbeatRuns.finishedAt} - ${heartbeatRuns.startedAt})) * 1000
        ) filter (
          where ${heartbeatRuns.status} = 'succeeded'
            and ${heartbeatRuns.startedAt} is not null
            and ${heartbeatRuns.finishedAt} is not null
        )
      `,
      durationSample: sql<number>`
        count(*) filter (
          where ${heartbeatRuns.status} = 'succeeded'
            and ${heartbeatRuns.startedAt} is not null
            and ${heartbeatRuns.finishedAt} is not null
        )::int
      `,
    })
    .from(heartbeatRuns)
    .where(runWhere(companyId, from, to, filters))
    .then((rows) => rows[0]);

  return {
    total: Number(row?.total ?? 0),
    succeeded: Number(row?.succeeded ?? 0),
    failed: Number(row?.failed ?? 0),
    cancelled: Number(row?.cancelled ?? 0),
    pending: Number(row?.pending ?? 0),
    retries: Number(row?.retries ?? 0),
    durationP50Ms: nullableInt(row?.durationP50Ms),
    durationP95Ms: nullableInt(row?.durationP95Ms),
    durationSample: Number(row?.durationSample ?? 0),
  };
}

async function queryCost(
  db: Db,
  companyId: string,
  from: Date,
  to: Date,
  filters: KpiFilters,
): Promise<KpiCost & { runsWithCost: number }> {
  const row = await db
    .select({
      total: sql<string | null>`sum(${costEvents.costCents})`,
      inputTokens: sql<string | null>`sum(${costEvents.inputTokens})`,
      cachedInputTokens: sql<string | null>`sum(${costEvents.cachedInputTokens})`,
      outputTokens: sql<string | null>`sum(${costEvents.outputTokens})`,
      rowCount: sql<number>`count(*)::int`,
      runsWithCost: sql<number>`count(distinct ${costEvents.heartbeatRunId}) filter (where ${costEvents.heartbeatRunId} is not null)::int`,
    })
    .from(costEvents)
    .where(costWhere(companyId, from, to, filters))
    .then((rows) => rows[0]);

  const hasRows = Number(row?.rowCount ?? 0) > 0;
  return {
    totalCents: hasRows ? Number(row?.total ?? 0) : null,
    inputTokens: hasRows ? Number(row?.inputTokens ?? 0) : null,
    cachedInputTokens: hasRows ? Number(row?.cachedInputTokens ?? 0) : null,
    outputTokens: hasRows ? Number(row?.outputTokens ?? 0) : null,
    runsWithCost: Number(row?.runsWithCost ?? 0),
  };
}

async function queryTasksDone(
  db: Db,
  companyId: string,
  from: Date,
  to: Date,
  filters: KpiFilters,
): Promise<number> {
  const conditions = [
    eq(issues.companyId, companyId),
    eq(issues.status, "done"),
    gte(issues.updatedAt, from),
    lt(issues.updatedAt, to),
  ];
  if (filters.projectId) conditions.push(eq(issues.projectId, filters.projectId));
  if (filters.agentId) conditions.push(eq(issues.assigneeAgentId, filters.agentId));

  const row = await db
    .select({ count: sql<number>`count(distinct ${issues.id})::int` })
    .from(issues)
    .where(and(...conditions))
    .then((rows) => rows[0]);
  return Number(row?.count ?? 0);
}

async function queryApprovalWait(
  db: Db,
  companyId: string,
  from: Date,
  to: Date,
): Promise<KpiApprovalWait> {
  const row = await db
    .select({
      sample: sql<number>`count(*)::int`,
      p50: sql<string | null>`percentile_cont(0.5) within group (order by extract(epoch from (${approvals.decidedAt} - ${approvals.createdAt})) * 1000)`,
      p95: sql<string | null>`percentile_cont(0.95) within group (order by extract(epoch from (${approvals.decidedAt} - ${approvals.createdAt})) * 1000)`,
    })
    .from(approvals)
    .where(
      and(
        eq(approvals.companyId, companyId),
        isNotNull(approvals.decidedAt),
        gte(approvals.decidedAt, from),
        lt(approvals.decidedAt, to),
      ),
    )
    .then((rows) => rows[0]);

  const sample = Number(row?.sample ?? 0);
  if (sample === 0) {
    return { tracked: false, p50Ms: null, p95Ms: null, sampleSize: 0 };
  }
  return {
    tracked: true,
    p50Ms: nullableInt(row?.p50),
    p95Ms: nullableInt(row?.p95),
    sampleSize: sample,
  };
}

export function kpiAnalyticsService(db: Db) {
  return {
    overview: async (input: KpiServiceInput): Promise<KpiOverview> => {
      const filters = normalizeFilters(input.filters);
      const { from, to } = parseRange(input.range);

      const [runs, cost, tasksDone, approvalWait] = await Promise.all([
        queryRunCounts(db, input.companyId, from, to, filters),
        queryCost(db, input.companyId, from, to, filters),
        queryTasksDone(db, input.companyId, from, to, filters),
        queryApprovalWait(db, input.companyId, from, to),
      ]);

      const runsWithCost = Math.min(cost.runsWithCost, runs.total);
      const runsWithoutCost = Math.max(0, runs.total - runsWithCost);
      const coverage: KpiCoverage = {
        runsWithCost,
        runsWithoutCost,
        coveragePercent:
          runs.total === 0
            ? 0
            : Number(((runsWithCost / runs.total) * 100).toFixed(2)),
      };

      const duration: KpiDuration = {
        p50Ms: runs.durationP50Ms,
        p95Ms: runs.durationP95Ms,
        sampleSize: runs.durationSample,
      };

      const runCounts: KpiRunCounts = {
        total: runs.total,
        succeeded: runs.succeeded,
        failed: runs.failed,
        cancelled: runs.cancelled,
        pending: runs.pending,
        retries: runs.retries,
      };

      const costShape: KpiCost = {
        totalCents: cost.totalCents,
        inputTokens: cost.inputTokens,
        cachedInputTokens: cost.cachedInputTokens,
        outputTokens: cost.outputTokens,
      };

      return {
        companyId: input.companyId,
        range: input.range,
        filters,
        providerFilterRunsIgnored: filters.provider != null,
        runCounts,
        duration,
        cost: costShape,
        coverage,
        tasksDone,
        approvalWait,
      };
    },

    trend: async (input: KpiServiceInput): Promise<KpiTrend> => {
      const filters = normalizeFilters(input.filters);
      const { from, to } = parseRange(input.range);

      const runRows = await db
        .select({
          bucket: sql<string>`to_char(date_trunc('day', ${heartbeatRuns.createdAt} at time zone 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
          total: sql<number>`count(*)::int`,
          succeeded: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'succeeded')::int`,
          failed: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'failed')::int`,
        })
        .from(heartbeatRuns)
        .where(runWhere(input.companyId, from, to, filters))
        .groupBy(sql`date_trunc('day', ${heartbeatRuns.createdAt} at time zone 'UTC')`)
        .orderBy(sql`date_trunc('day', ${heartbeatRuns.createdAt} at time zone 'UTC')`);

      const costRows = await db
        .select({
          bucket: sql<string>`to_char(date_trunc('day', ${costEvents.occurredAt} at time zone 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
          totalCents: sql<string | null>`sum(${costEvents.costCents})`,
          rowCount: sql<number>`count(*)::int`,
        })
        .from(costEvents)
        .where(costWhere(input.companyId, from, to, filters))
        .groupBy(sql`date_trunc('day', ${costEvents.occurredAt} at time zone 'UTC')`)
        .orderBy(sql`date_trunc('day', ${costEvents.occurredAt} at time zone 'UTC')`);

      const costByBucket = new Map<string, number | null>();
      for (const row of costRows) {
        const hasRows = Number(row.rowCount ?? 0) > 0;
        costByBucket.set(row.bucket, hasRows ? Number(row.totalCents ?? 0) : null);
      }

      const runByBucket = new Map<string, { total: number; succeeded: number; failed: number }>();
      for (const row of runRows) {
        runByBucket.set(row.bucket, {
          total: Number(row.total ?? 0),
          succeeded: Number(row.succeeded ?? 0),
          failed: Number(row.failed ?? 0),
        });
      }

      const bucketKeys = new Set<string>([...runByBucket.keys(), ...costByBucket.keys()]);
      const buckets: KpiTrendBucket[] = [...bucketKeys]
        .sort()
        .map((bucketStart) => ({
          bucketStart,
          runCount: runByBucket.get(bucketStart) ?? { total: 0, succeeded: 0, failed: 0 },
          costCents: costByBucket.has(bucketStart) ? costByBucket.get(bucketStart)! : null,
        }));

      return {
        companyId: input.companyId,
        range: input.range,
        filters,
        providerFilterRunsIgnored: filters.provider != null,
        buckets,
      };
    },

    byAgent: async (input: KpiServiceInput): Promise<KpiByAgent> => {
      const filters = normalizeFilters(input.filters);
      const { from, to } = parseRange(input.range);

      const runRows = await db
        .select({
          agentId: heartbeatRuns.agentId,
          agentName: agents.name,
          total: sql<number>`count(*)::int`,
          succeeded: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'succeeded')::int`,
          failed: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'failed')::int`,
          cancelled: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'cancelled')::int`,
          pending: sql<number>`count(*) filter (where ${heartbeatRuns.status} in ('queued','running'))::int`,
          retries: sql<number>`count(*) filter (where ${heartbeatRuns.retryOfRunId} is not null)::int`,
          durationP50Ms: sql<string | null>`
            percentile_cont(0.5) within group (
              order by extract(epoch from (${heartbeatRuns.finishedAt} - ${heartbeatRuns.startedAt})) * 1000
            ) filter (
              where ${heartbeatRuns.status} = 'succeeded'
                and ${heartbeatRuns.startedAt} is not null
                and ${heartbeatRuns.finishedAt} is not null
            )
          `,
          durationP95Ms: sql<string | null>`
            percentile_cont(0.95) within group (
              order by extract(epoch from (${heartbeatRuns.finishedAt} - ${heartbeatRuns.startedAt})) * 1000
            ) filter (
              where ${heartbeatRuns.status} = 'succeeded'
                and ${heartbeatRuns.startedAt} is not null
                and ${heartbeatRuns.finishedAt} is not null
            )
          `,
          durationSample: sql<number>`
            count(*) filter (
              where ${heartbeatRuns.status} = 'succeeded'
                and ${heartbeatRuns.startedAt} is not null
                and ${heartbeatRuns.finishedAt} is not null
            )::int
          `,
        })
        .from(heartbeatRuns)
        .leftJoin(agents, eq(agents.id, heartbeatRuns.agentId))
        .where(runWhere(input.companyId, from, to, filters))
        .groupBy(heartbeatRuns.agentId, agents.name);

      const costRows = await db
        .select({
          agentId: costEvents.agentId,
          agentName: agents.name,
          totalCents: sql<string | null>`sum(${costEvents.costCents})`,
          inputTokens: sql<string | null>`sum(${costEvents.inputTokens})`,
          cachedInputTokens: sql<string | null>`sum(${costEvents.cachedInputTokens})`,
          outputTokens: sql<string | null>`sum(${costEvents.outputTokens})`,
          rowCount: sql<number>`count(*)::int`,
        })
        .from(costEvents)
        .leftJoin(agents, eq(agents.id, costEvents.agentId))
        .where(costWhere(input.companyId, from, to, filters))
        .groupBy(costEvents.agentId, agents.name);

      const byAgent = new Map<string, KpiAgentRow>();

      for (const row of runRows) {
        byAgent.set(row.agentId, {
          agentId: row.agentId,
          agentName: row.agentName,
          runCounts: {
            total: Number(row.total ?? 0),
            succeeded: Number(row.succeeded ?? 0),
            failed: Number(row.failed ?? 0),
            cancelled: Number(row.cancelled ?? 0),
            pending: Number(row.pending ?? 0),
            retries: Number(row.retries ?? 0),
          },
          duration: {
            p50Ms: nullableInt(row.durationP50Ms),
            p95Ms: nullableInt(row.durationP95Ms),
            sampleSize: Number(row.durationSample ?? 0),
          },
          cost: {
            totalCents: null,
            inputTokens: null,
            cachedInputTokens: null,
            outputTokens: null,
          },
        });
      }

      for (const row of costRows) {
        const existing = byAgent.get(row.agentId);
        const hasRows = Number(row.rowCount ?? 0) > 0;
        const cost: KpiCost = {
          totalCents: hasRows ? Number(row.totalCents ?? 0) : null,
          inputTokens: hasRows ? Number(row.inputTokens ?? 0) : null,
          cachedInputTokens: hasRows ? Number(row.cachedInputTokens ?? 0) : null,
          outputTokens: hasRows ? Number(row.outputTokens ?? 0) : null,
        };
        if (existing) {
          existing.cost = cost;
        } else {
          byAgent.set(row.agentId, {
            agentId: row.agentId,
            agentName: row.agentName,
            runCounts: { total: 0, succeeded: 0, failed: 0, cancelled: 0, pending: 0, retries: 0 },
            duration: { p50Ms: null, p95Ms: null, sampleSize: 0 },
            cost,
          });
        }
      }

      const rows = [...byAgent.values()].sort((a, b) => {
        if (b.runCounts.total !== a.runCounts.total) return b.runCounts.total - a.runCounts.total;
        return (b.cost.totalCents ?? -1) - (a.cost.totalCents ?? -1);
      });

      return {
        companyId: input.companyId,
        range: input.range,
        filters,
        providerFilterRunsIgnored: filters.provider != null,
        rows,
      };
    },

    filterOptions: async (companyId: string): Promise<KpiFilterOptions> => {
      const rows = await db
        .selectDistinct({ provider: costEvents.provider })
        .from(costEvents)
        .where(eq(costEvents.companyId, companyId))
        .orderBy(costEvents.provider);
      return { providers: rows.map((row) => row.provider).filter((p): p is string => !!p) };
    },
  };
}
