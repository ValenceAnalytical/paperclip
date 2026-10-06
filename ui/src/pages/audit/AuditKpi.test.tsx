// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditKpi } from "./AuditKpi";

const overview = {
  companyId: "company-1",
  range: { from: "2026-10-01T00:00:00.000Z", to: "2026-10-08T00:00:00.000Z" },
  filters: { agentId: null, projectId: null, provider: null },
  providerFilterRunsIgnored: false,
  runCounts: { total: 2, succeeded: 1, failed: 1, cancelled: 0, pending: 0, retries: 0 },
  duration: { p50Ms: 60_000, p95Ms: 120_000, sampleSize: 2 },
  cost: { totalCents: 42, inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
  coverage: { runsWithCost: 1, runsWithoutCost: 1, coveragePercent: 50, eventWindowSpendCents: 42 },
  tasksDone: 1,
  approvalWait: {
    tracked: true,
    p50Ms: 180_000,
    p95Ms: 180_000,
    sampleSize: 1,
    scope: "company" as const,
    projectFilterIgnored: true,
  },
};

vi.mock("@/hooks/useDateRange", () => ({
  useDateRange: () => ({
    from: "2026-10-01T00:00:00.000Z",
    to: "2026-10-08T00:00:00.000Z",
    customReady: true,
  }),
}));

vi.mock("@/api/kpi", () => ({
  kpiApi: {
    overview: vi.fn(async () => overview),
    trend: vi.fn(async () => ({
      companyId: "company-1",
      range: overview.range,
      filters: overview.filters,
      providerFilterRunsIgnored: false,
      buckets: [],
    })),
    byAgent: vi.fn(async () => ({
      companyId: "company-1",
      range: overview.range,
      filters: overview.filters,
      providerFilterRunsIgnored: false,
      rows: [],
    })),
    filterOptions: vi.fn(async () => ({ providers: ["openai"] })),
  },
}));

vi.mock("@/api/agents", () => ({ agentsApi: { list: vi.fn(async () => []) } }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: vi.fn(async () => []) } }));
vi.mock("@/components/AgentIdentity", () => ({
  AgentIdentity: ({ agent }: { agent: { name: string } }) => <span>{agent.name}</span>,
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
});

function renderKpi() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  root.render(
    <QueryClientProvider client={client}>
      <AuditKpi companyId="company-1" />
    </QueryClientProvider>,
  );
  return container;
}

describe("AuditKpi", () => {
  it("labels coverage, completed tasks, and board approval wait semantics", async () => {
    const node = renderKpi();

    await vi.waitFor(() => expect(node.textContent).toContain("KPI analytics"));

    expect(node.textContent).toContain("50% selected-run cost coverage");
    expect(node.textContent).toContain("Task completed_at; not updated_at or run success");
    expect(node.textContent).toContain("Board company wait");
    expect(node.textContent).toContain("project filter ignored");
  });
});
