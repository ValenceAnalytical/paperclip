import { useMemo, useState, type ComponentType } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, CheckCircle2, Clock3, DollarSign, ListChecks, PlayCircle } from "lucide-react";
import type { KpiAgentRow, KpiFilters, KpiOverview, KpiTrendBucket } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { kpiApi } from "@/api/kpi";
import { projectsApi } from "@/api/projects";
import { AgentIdentity } from "@/components/AgentIdentity";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useDateRange } from "@/hooks/useDateRange";
import { queryKeys } from "@/lib/queryKeys";
import { cn, formatCents, formatTokens } from "@/lib/utils";

interface AuditKpiProps {
  companyId: string;
}

function formatMs(value: number | null): string {
  if (value == null) return "—";
  if (value < 1000) return `${Math.round(value)}ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = seconds / 60;
  return `${minutes.toFixed(1)}m`;
}

function percent(numerator: number, denominator: number): string {
  if (denominator === 0) return "0%";
  return `${Math.round((numerator / denominator) * 100)}%`;
}

function totalTokens(cost: KpiAgentRow["cost"]): number | null {
  if (cost.inputTokens == null && cost.cachedInputTokens == null && cost.outputTokens == null) return null;
  return (cost.inputTokens ?? 0) + (cost.cachedInputTokens ?? 0) + (cost.outputTokens ?? 0);
}

function MetricTile({ label, value, subtitle, icon: Icon }: {
  label: string;
  value: string;
  subtitle: string;
  icon: ComponentType<{ className?: string }>;
}) {
  return (
    <Card className="block p-4" aria-label={`${label}: ${value}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-(length:--text-micro) uppercase tracking-(--tracking-eyebrow) text-muted-foreground">{label}</div>
          <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">{subtitle}</div>
        </div>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
      </div>
    </Card>
  );
}

function KpiTrendChart({ buckets }: { buckets: KpiTrendBucket[] }) {
  const maxRuns = Math.max(1, ...buckets.map((bucket) => bucket.runCount.total));
  const maxCost = Math.max(1, ...buckets.map((bucket) => bucket.costCents ?? 0));
  const chartLabel = buckets
    .map((bucket) => `${bucket.bucketStart.slice(0, 10)}: ${bucket.runCount.total} runs, ${bucket.costCents == null ? "unknown cost" : formatCents(bucket.costCents)}`)
    .join("; ");

  if (buckets.length === 0) {
    return <EmptyState icon={BarChart3} message="No trend data for this window." />;
  }

  return (
    <figure className="space-y-3">
      <div className="flex h-48 items-end gap-2 rounded-lg border border-border bg-muted/20 p-4" role="img" aria-label={chartLabel}>
        {buckets.map((bucket) => {
          const runHeight = Math.max(6, Math.round((bucket.runCount.total / maxRuns) * 144));
          const successHeight = Math.max(4, Math.round((bucket.runCount.succeeded / maxRuns) * 144));
          const costHeight = bucket.costCents == null ? 0 : Math.max(4, Math.round((bucket.costCents / maxCost) * 64));
          return (
            <div key={bucket.bucketStart} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1">
              <div className="flex h-36 w-full items-end justify-center gap-1">
                <span className="w-2 rounded-t bg-primary/70" style={{ height: runHeight }} title={`${bucket.runCount.total} total runs`} />
                <span className="w-2 rounded-t bg-emerald-500/70" style={{ height: successHeight }} title={`${bucket.runCount.succeeded} succeeded runs`} />
              </div>
              <div className={cn("w-full rounded-t bg-amber-500/60", bucket.costCents == null && "bg-transparent")} style={{ height: costHeight }} title={bucket.costCents == null ? "unknown cost" : formatCents(bucket.costCents)} />
              <div className="max-w-full truncate text-(length:--text-micro) text-muted-foreground">{bucket.bucketStart.slice(5, 10)}</div>
            </div>
          );
        })}
      </div>
      <figcaption className="text-xs text-muted-foreground">
        Daily UTC buckets. Blue = total runs, green = succeeded runs, amber = reported cost; missing cost renders as a gap.
      </figcaption>
    </figure>
  );
}

function AgentTable({ rows }: { rows: KpiAgentRow[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <caption className="sr-only">KPI metrics by agent</caption>
        <thead className="bg-muted/50 text-xs uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
          <tr>
            <th scope="col" className="px-4 py-3 text-left">Agent</th>
            <th scope="col" className="px-4 py-3 text-right">Runs</th>
            <th scope="col" className="px-4 py-3 text-right">Succeeded</th>
            <th scope="col" className="px-4 py-3 text-right">Failed</th>
            <th scope="col" className="px-4 py-3 text-right">Cancelled</th>
            <th scope="col" className="px-4 py-3 text-right">Retries</th>
            <th scope="col" className="px-4 py-3 text-right">p50</th>
            <th scope="col" className="px-4 py-3 text-right">Cost</th>
            <th scope="col" className="px-4 py-3 text-right">Tokens</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.agentId} className="border-t border-border">
              <td className="px-4 py-3">
                <AgentIdentity agent={{ id: row.agentId, name: row.agentName ?? "Agent" }} size="sm" />
              </td>
              <td className="px-4 py-3 text-right tabular-nums">{row.runCounts.total}</td>
              <td className="px-4 py-3 text-right tabular-nums">{row.runCounts.succeeded}</td>
              <td className="px-4 py-3 text-right tabular-nums">{row.runCounts.failed}</td>
              <td className="px-4 py-3 text-right tabular-nums">{row.runCounts.cancelled}</td>
              <td className="px-4 py-3 text-right tabular-nums">{row.runCounts.retries}</td>
              <td className="px-4 py-3 text-right tabular-nums">{formatMs(row.duration.p50Ms)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{row.cost.totalCents == null ? "—" : formatCents(row.cost.totalCents)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{totalTokens(row.cost) == null ? "—" : formatTokens(totalTokens(row.cost)!)} </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AuditKpi({ companyId }: AuditKpiProps) {
  const { from, to, customReady } = useDateRange();
  const [agentId, setAgentId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [provider, setProvider] = useState("");

  const filters: Partial<KpiFilters> & { from?: string; to?: string } = useMemo(() => ({
    from: from || undefined,
    to: to || undefined,
    agentId: agentId || undefined,
    projectId: projectId || undefined,
    provider: provider || undefined,
  }), [agentId, from, projectId, provider, to]);

  const dataQuery = useQuery({
    queryKey: queryKeys.audit.kpi(companyId, filters),
    queryFn: async () => {
      const [overview, trend, byAgent] = await Promise.all([
        kpiApi.overview(companyId, filters),
        kpiApi.trend(companyId, filters),
        kpiApi.byAgent(companyId, filters),
      ]);
      return { overview, trend, byAgent };
    },
    enabled: !!companyId && customReady,
    refetchInterval: 30_000,
    staleTime: 5_000,
  });

  const filterQuery = useQuery({
    queryKey: queryKeys.audit.kpiOptions(companyId),
    queryFn: async () => {
      const [options, agents, projects] = await Promise.all([
        kpiApi.filterOptions(companyId),
        agentsApi.list(companyId),
        projectsApi.list(companyId, { includeArchived: true }),
      ]);
      return { options, agents, projects };
    },
    enabled: !!companyId,
    staleTime: 30_000,
  });

  if (dataQuery.isLoading) return <PageSkeleton />;

  if (dataQuery.error) {
    return (
      <Card className="border-destructive/40">
        <CardHeader><CardTitle>KPI analytics unavailable</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          {dataQuery.error instanceof Error ? dataQuery.error.message : "You do not have access to KPIs for this organization."}
        </CardContent>
      </Card>
    );
  }

  const overview: KpiOverview | undefined = dataQuery.data?.overview;
  const isEmpty = overview && overview.runCounts.total === 0 && overview.cost.totalCents == null && overview.tasksDone === 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">KPI analytics</h2>
          <p className="mt-1 text-sm text-muted-foreground">UTC window {overview?.range.from ?? from ?? "default"} → {overview?.range.to ?? to ?? "default"}</p>
          {overview?.providerFilterRunsIgnored ? (
            <p className="mt-1 text-xs text-amber-600">Provider is only present on cost records, so run counts are not provider-filtered.</p>
          ) : null}
        </div>
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">
          Agent
          <select className="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground" value={agentId} onChange={(event) => setAgentId(event.target.value)}>
            <option value="">All agents</option>
            {filterQuery.data?.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">
          Project
          <select className="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">All projects</option>
            {filterQuery.data?.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">
          Provider
          <select className="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground" value={provider} onChange={(event) => setProvider(event.target.value)}>
            <option value="">All providers</option>
            {filterQuery.data?.options.providers.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
      </div>

      {isEmpty ? <EmptyState icon={BarChart3} message="No KPI data for the selected window. Try widening the date range." /> : null}

      {overview ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          <MetricTile label="Runs" value={String(overview.runCounts.total)} subtitle={`${overview.runCounts.succeeded} S / ${overview.runCounts.failed} F / ${overview.runCounts.cancelled} C · retries ${overview.runCounts.retries}`} icon={PlayCircle} />
          <MetricTile label="Succeeded" value={String(overview.runCounts.succeeded)} subtitle={`${percent(overview.runCounts.succeeded, overview.runCounts.total)} of total runs`} icon={CheckCircle2} />
          <MetricTile label="Duration p50" value={formatMs(overview.duration.p50Ms)} subtitle={`p95 ${formatMs(overview.duration.p95Ms)} · n=${overview.duration.sampleSize}`} icon={Clock3} />
          <MetricTile label="Spend" value={overview.cost.totalCents == null ? "—" : formatCents(overview.cost.totalCents)} subtitle={`${overview.coverage.coveragePercent}% selected-run cost coverage`} icon={DollarSign} />
          <MetricTile label="Tasks done" value={String(overview.tasksDone)} subtitle="Task completed_at; not updated_at or run success" icon={ListChecks} />
          <MetricTile
            label="Approval wait"
            value={overview.approvalWait.tracked ? formatMs(overview.approvalWait.p50Ms) : "not tracked"}
            subtitle={overview.approvalWait.tracked
              ? `Board ${overview.approvalWait.scope} wait · p95 ${formatMs(overview.approvalWait.p95Ms)} · n=${overview.approvalWait.sampleSize}${overview.approvalWait.projectFilterIgnored ? " · project filter ignored" : ""}`
              : `No durable board decisions in window${overview.approvalWait.projectFilterIgnored ? " · project filter ignored" : ""}`}
            icon={Clock3}
          />
        </div>
      ) : null}

      <Card>
        <CardHeader><CardTitle>UTC trend</CardTitle></CardHeader>
        <CardContent><KpiTrendChart buckets={dataQuery.data?.trend.buckets ?? []} /></CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>By agent</CardTitle></CardHeader>
        <CardContent><AgentTable rows={dataQuery.data?.byAgent.rows ?? []} /></CardContent>
      </Card>
    </div>
  );
}
