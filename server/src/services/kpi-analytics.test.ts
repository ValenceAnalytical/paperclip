import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  approvals,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { kpiAnalyticsService } from "./kpi-analytics.js";

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

describePg("kpiAnalyticsService", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let otherCompanyId: string;
  let agentA: string;
  let agentB: string;
  let runSucceeded: string;
  let runFailed: string;
  let runRetry: string;
  let projectId: string;
  const from = "2026-10-01T00:00:00.000Z";
  const to = "2026-10-08T00:00:00.000Z";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-kpi-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    companyId = randomUUID();
    otherCompanyId = randomUUID();
    agentA = randomUUID();
    agentB = randomUUID();
    runSucceeded = randomUUID();
    runFailed = randomUUID();
    runRetry = randomUUID();
    projectId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "KPI Co", issuePrefix: `K${companyId.slice(0, 6)}`, requireBoardApprovalForNewAgents: false },
      { id: otherCompanyId, name: "Other Co", issuePrefix: `O${otherCompanyId.slice(0, 6)}`, requireBoardApprovalForNewAgents: false },
    ]);
    await db.insert(agents).values([
      { id: agentA, companyId, name: "Nova", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: agentB, companyId, name: "Flynn", role: "engineer", status: "active", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(projects).values({ id: projectId, companyId, name: "Project KPI", status: "active" });
    await db.insert(heartbeatRuns).values([
      { id: runSucceeded, companyId, agentId: agentA, status: "succeeded", createdAt: new Date("2026-10-02T00:00:00Z"), startedAt: new Date("2026-10-02T00:00:00Z"), finishedAt: new Date("2026-10-02T00:01:00Z"), contextSnapshot: { projectId } },
      { id: runFailed, companyId, agentId: agentA, status: "failed", createdAt: new Date("2026-10-03T00:00:00Z"), contextSnapshot: { projectId } },
      { id: runRetry, companyId, agentId: agentB, status: "cancelled", createdAt: new Date("2026-10-04T00:00:00Z"), retryOfRunId: runFailed },
      { id: randomUUID(), companyId: otherCompanyId, agentId: agentA, status: "succeeded", createdAt: new Date("2026-10-02T00:00:00Z") },
    ]);
    await db.insert(costEvents).values([
      { companyId, agentId: agentA, heartbeatRunId: runSucceeded, provider: "openai", model: "gpt", costCents: 10, inputTokens: 100, cachedInputTokens: 5, outputTokens: 20, occurredAt: new Date("2026-10-02T00:00:30Z"), projectId },
      { companyId, agentId: agentA, heartbeatRunId: runSucceeded, provider: "openai", model: "gpt", costCents: 15, inputTokens: 50, cachedInputTokens: 0, outputTokens: 10, occurredAt: new Date("2026-10-02T00:00:45Z"), projectId },
      { companyId, agentId: agentB, heartbeatRunId: null, provider: "anthropic", model: "claude", costCents: 5, inputTokens: 20, cachedInputTokens: 0, outputTokens: 4, occurredAt: new Date("2026-10-04T00:00:00Z") },
      { companyId: otherCompanyId, agentId: agentA, provider: "openai", model: "gpt", costCents: 999, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, occurredAt: new Date("2026-10-02T00:00:00Z") },
    ]);
    await db.insert(issues).values([
      { companyId, title: "Done", status: "done", priority: "medium", assigneeAgentId: agentA, updatedAt: new Date("2026-10-03T00:00:00Z"), projectId },
      { companyId: otherCompanyId, title: "Other Done", status: "done", priority: "medium", assigneeAgentId: agentA, updatedAt: new Date("2026-10-03T00:00:00Z") },
    ]);
    await db.insert(approvals).values({ companyId, type: "tool", status: "approved", payload: {}, createdAt: new Date("2026-10-02T00:00:00Z"), decidedAt: new Date("2026-10-02T00:02:00Z") });
  });

  afterEach(async () => {
    await db.delete(approvals);
    await db.delete(costEvents);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => tempDb?.cleanup());

  it("computes counts, duration, duplicate-safe coverage, cost, tasks, and approvals", async () => {
    const result = await kpiAnalyticsService(db).overview({ companyId, range: { from, to } });
    expect(result.runCounts).toEqual({ total: 3, succeeded: 1, failed: 1, cancelled: 1, pending: 0, retries: 1 });
    expect(result.duration).toEqual({ p50Ms: 60_000, p95Ms: 60_000, sampleSize: 1 });
    expect(result.cost).toEqual({ totalCents: 30, inputTokens: 170, cachedInputTokens: 5, outputTokens: 34 });
    expect(result.coverage).toEqual({ runsWithCost: 1, runsWithoutCost: 2, coveragePercent: 33.33 });
    expect(result.tasksDone).toBe(1);
    expect(result.approvalWait).toEqual({ tracked: true, p50Ms: 120_000, p95Ms: 120_000, sampleSize: 1 });
  });

  it("preserves unknown cost as null and discloses provider filter limits", async () => {
    const result = await kpiAnalyticsService(db).overview({ companyId, range: { from, to }, filters: { provider: "missing" } });
    expect(result.providerFilterRunsIgnored).toBe(true);
    expect(result.runCounts.total).toBe(3);
    expect(result.cost.totalCents).toBeNull();
    expect(result.coverage).toEqual({ runsWithCost: 0, runsWithoutCost: 3, coveragePercent: 0 });
  });

  it("applies agent and project filters without leaking other companies", async () => {
    const result = await kpiAnalyticsService(db).overview({ companyId, range: { from, to }, filters: { agentId: agentA, projectId } });
    expect(result.runCounts.total).toBe(2);
    expect(result.cost.totalCents).toBe(25);
    expect(result.tasksDone).toBe(1);
  });
});
