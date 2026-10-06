import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
      {
        companyId,
        title: "Done",
        status: "done",
        priority: "medium",
        assigneeAgentId: agentA,
        projectId,
        completedAt: new Date("2026-10-03T00:00:00Z"),
        updatedAt: new Date("2026-10-03T00:00:00Z"),
      },
      // Status 'done' but no completed_at — must not count: proves we filter on
      // completed_at, not updated_at.
      {
        companyId,
        title: "Done but no completed_at",
        status: "done",
        priority: "medium",
        assigneeAgentId: agentA,
        updatedAt: new Date("2026-10-03T00:30:00Z"),
      },
      {
        companyId: otherCompanyId,
        title: "Other Done",
        status: "done",
        priority: "medium",
        assigneeAgentId: agentA,
        completedAt: new Date("2026-10-03T00:00:00Z"),
        updatedAt: new Date("2026-10-03T00:00:00Z"),
      },
    ]);
    await db.insert(approvals).values({ companyId, type: "tool", status: "approved", payload: {}, requestedByAgentId: agentA, createdAt: new Date("2026-10-02T00:00:00Z"), decidedAt: new Date("2026-10-02T00:02:00Z") });
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
    expect(result.coverage).toEqual({
      runsWithCost: 1,
      runsWithoutCost: 2,
      coveragePercent: 33.33,
      eventWindowSpendCents: 30,
    });
    expect(result.tasksDone).toBe(1);
    expect(result.approvalWait).toEqual({
      tracked: true,
      p50Ms: 120_000,
      p95Ms: 120_000,
      sampleSize: 1,
      scope: "company",
      projectFilterIgnored: false,
    });
  });

  it("preserves unknown cost as null and discloses provider filter limits", async () => {
    const result = await kpiAnalyticsService(db).overview({ companyId, range: { from, to }, filters: { provider: "missing" } });
    expect(result.providerFilterRunsIgnored).toBe(true);
    expect(result.runCounts.total).toBe(3);
    expect(result.cost.totalCents).toBeNull();
    expect(result.coverage).toEqual({
      runsWithCost: 0,
      runsWithoutCost: 3,
      coveragePercent: 0,
      eventWindowSpendCents: null,
    });
  });

  it("applies agent and project filters without leaking other companies", async () => {
    const result = await kpiAnalyticsService(db).overview({ companyId, range: { from, to }, filters: { agentId: agentA, projectId } });
    expect(result.runCounts.total).toBe(2);
    expect(result.cost.totalCents).toBe(25);
    expect(result.tasksDone).toBe(1);
  });

  it("counts tasksDone by completed_at, not updated_at", async () => {
    // The 'Done but no completed_at' issue was updated inside the window
    // but has no completed_at; it must NOT be counted. If this test
    // ever reports 2, the service has regressed to filtering on updated_at.
    const result = await kpiAnalyticsService(db).overview({ companyId, range: { from, to } });
    expect(result.tasksDone).toBe(1);

    // Insert another done issue whose completed_at is outside the window —
    // also must not count.
    await db.insert(issues).values({
      companyId,
      title: "Done last month",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentA,
      completedAt: new Date("2026-09-20T00:00:00Z"),
      updatedAt: new Date("2026-10-04T00:00:00Z"),
    });
    const after = await kpiAnalyticsService(db).overview({ companyId, range: { from, to } });
    expect(after.tasksDone).toBe(1);
  });

  it("includes failed and cancelled completed runs in duration population", async () => {
    // Give the failed and cancelled runs real timestamps so they contribute
    // alongside the succeeded run. All three are 'completed' per the taxonomy.
    await db
      .update(heartbeatRuns)
      .set({
        startedAt: new Date("2026-10-03T00:00:00Z"),
        finishedAt: new Date("2026-10-03T00:02:00Z"),
      })
      .where(eq(heartbeatRuns.id, runFailed));
    await db
      .update(heartbeatRuns)
      .set({
        startedAt: new Date("2026-10-04T00:00:00Z"),
        finishedAt: new Date("2026-10-04T00:00:30Z"),
      })
      .where(eq(heartbeatRuns.id, runRetry));

    const result = await kpiAnalyticsService(db).overview({ companyId, range: { from, to } });
    // Three completed runs with timestamps now contribute.
    expect(result.duration.sampleSize).toBe(3);
    // p50 is the middle duration (60s); durations: 30s / 60s / 120s.
    expect(result.duration.p50Ms).toBe(60_000);
    expect(result.duration.p95Ms).not.toBeNull();
  });

  it("does not count a cost event in window for a run outside the selected cohort", async () => {
    // Add a cost event tied to a run that lives OUTSIDE the window. The cost
    // event itself is in-window but its run is not in the selected cohort,
    // so coverage must not increase. Event-window spend may still see it.
    const outsideCohortRun = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: outsideCohortRun,
      companyId,
      agentId: agentA,
      status: "succeeded",
      // Run createdAt is BEFORE the window — not in the cohort.
      createdAt: new Date("2026-09-20T00:00:00Z"),
      startedAt: new Date("2026-09-20T00:00:00Z"),
      finishedAt: new Date("2026-09-20T00:01:00Z"),
    });
    await db.insert(costEvents).values({
      companyId,
      agentId: agentA,
      heartbeatRunId: outsideCohortRun,
      provider: "openai",
      model: "gpt",
      costCents: 50,
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 5,
      // The cost event IS inside the event window.
      occurredAt: new Date("2026-10-02T12:00:00Z"),
    });

    const result = await kpiAnalyticsService(db).overview({ companyId, range: { from, to } });
    // Cohort runs unchanged (3). Coverage must stay at runSucceeded only.
    expect(result.runCounts.total).toBe(3);
    expect(result.coverage.runsWithCost).toBe(1);
    expect(result.coverage.coveragePercent).toBe(33.33);
    // Event-window spend WILL include the extra 50 cents; disclose honestly.
    expect(result.coverage.eventWindowSpendCents).toBe(80);
  });

  it("excludes a selected run from coverage when its cost event is outside the event window", async () => {
    // A new run in-cohort whose only cost event occurred BEFORE the window.
    // Coverage must not count it; cohort is 4 but runsWithCost stays 1.
    const inCohortNoCostInWindow = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: inCohortNoCostInWindow,
      companyId,
      agentId: agentA,
      status: "succeeded",
      createdAt: new Date("2026-10-05T00:00:00Z"),
    });
    await db.insert(costEvents).values({
      companyId,
      agentId: agentA,
      heartbeatRunId: inCohortNoCostInWindow,
      provider: "openai",
      model: "gpt",
      costCents: 99,
      occurredAt: new Date("2026-09-25T00:00:00Z"), // BEFORE window
    });

    const result = await kpiAnalyticsService(db).overview({ companyId, range: { from, to } });
    expect(result.runCounts.total).toBe(4);
    expect(result.coverage.runsWithCost).toBe(1);
  });

  it("filters approval wait by requested_by_agent_id and reports scope", async () => {
    // Insert an approval requested by a different agent that would otherwise
    // qualify. With agent filter, only agentA's approval contributes.
    await db.insert(approvals).values({
      companyId,
      type: "tool",
      status: "approved",
      payload: {},
      requestedByAgentId: agentB,
      createdAt: new Date("2026-10-02T00:00:00Z"),
      decidedAt: new Date("2026-10-02T00:30:00Z"), // 30 min — different latency
    });

    const resAgent = await kpiAnalyticsService(db).overview({
      companyId,
      range: { from, to },
      filters: { agentId: agentA },
    });
    expect(resAgent.approvalWait.scope).toBe("agent");
    expect(resAgent.approvalWait.sampleSize).toBe(1);
    expect(resAgent.approvalWait.p50Ms).toBe(120_000);

    // Project filter alone yields companywide scope and flags the ignore.
    const resProject = await kpiAnalyticsService(db).overview({
      companyId,
      range: { from, to },
      filters: { projectId },
    });
    expect(resProject.approvalWait.scope).toBe("company");
    expect(resProject.approvalWait.projectFilterIgnored).toBe(true);
    // Both approvals are companywide — sampleSize 2.
    expect(resProject.approvalWait.sampleSize).toBe(2);
  });
});
