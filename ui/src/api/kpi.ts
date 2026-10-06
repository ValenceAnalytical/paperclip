import type { KpiByAgent, KpiFilterOptions, KpiFilters, KpiOverview, KpiTrend } from "@paperclipai/shared";
import { api } from "./client";

export interface KpiQuery extends Partial<KpiFilters> {
  from?: string | null;
  to?: string | null;
}

function params(query: KpiQuery = {}) {
  const search = new URLSearchParams();
  if (query.from) search.set("from", query.from);
  if (query.to) search.set("to", query.to);
  if (query.agentId) search.set("agentId", query.agentId);
  if (query.projectId) search.set("projectId", query.projectId);
  if (query.provider) search.set("provider", query.provider);
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export const kpiApi = {
  overview: (companyId: string, query?: KpiQuery) =>
    api.get<KpiOverview>(`/companies/${encodeURIComponent(companyId)}/kpi/overview${params(query)}`),
  trend: (companyId: string, query?: KpiQuery) =>
    api.get<KpiTrend>(`/companies/${encodeURIComponent(companyId)}/kpi/trend${params(query)}`),
  byAgent: (companyId: string, query?: KpiQuery) =>
    api.get<KpiByAgent>(`/companies/${encodeURIComponent(companyId)}/kpi/by-agent${params(query)}`),
  filterOptions: (companyId: string) =>
    api.get<KpiFilterOptions>(`/companies/${encodeURIComponent(companyId)}/kpi/filter-options`),
};
