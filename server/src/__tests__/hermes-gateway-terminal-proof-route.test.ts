import express from "express";
import request from "supertest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  activityLog,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { queuedCommentQueueRevision } from "../services/issue-queued-comment-queue.js";

const support = await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("Hermes gateway terminal-proof route", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("hermes-terminal-proof-route-");
    db = createDb(database.connectionString);
  }, 30000);

  afterAll(async () => { await database?.cleanup(); });

  beforeEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(activityLog);
    await db.delete(agentWakeupRequests);
    await db.delete(issueComments);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  function app(actor: Record<string, unknown> | null = boardActor("board")) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { if (actor) (req as any).actor = actor; next(); });
    app.use("/api", issueRoutes(db, {} as any, { taskWatchdogEnqueueWakeup: null }));
    app.use(errorHandler);
    return app;
  }

  function boardActor(userId: string, companyIds?: string[]) {
    return { type: "board", userId, companyIds, memberships: (companyIds ?? []).map(companyId => ({ companyId, membershipRole: "owner", status: "active" })), source: "cloud_tenant", isInstanceAdmin: false };
  }

  async function withFakeHermes<T>(status: string, fn: (baseUrl: string, seen: string[]) => Promise<T>) {
    const seen: string[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", chunk => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        seen.push(`${req.method} ${req.url}`);
        if (req.method === "GET" && req.url?.startsWith("/v1/runs/")) {
          res.writeHead(status === "missing" ? 404 : 200, { "content-type": "application/json" });
          res.end(status === "missing" ? JSON.stringify({ error: "missing" }) : JSON.stringify({ run_id: req.url.split("/").pop(), status }));
          return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    try { return await fn(baseUrl, seen); }
    finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }

  async function seed(baseUrl: string) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), queueId = randomUUID(), commentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Route Co", issuePrefix: "RTE" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board", status: "active", membershipRole: "owner", updatedAt: new Date() });
    await ensureHumanRoleDefaultGrants(db, { companyId, principalId: "board", membershipRole: "owner", grantedByUserId: null });
    await db.insert(agents).values({ id: agentId, companyId, name: "Hermes", role: "engineer", status: "active", adapterType: "hermes_gateway", adapterConfig: { apiBaseUrl: baseUrl, apiKey: "test-hermes-key" } });
    await db.insert(issues).values({ id: issueId, companyId, title: "ACC-111", status: "blocked", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, runtimeMode: "legacy", status: "cancelled", errorCode: "operator_interrupted", finishedAt: new Date(), contextSnapshot: { issueId }, runnerProfileJson: { adapterDispatch: { adapterType: "hermes_gateway" } } });
    await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorType: "user", authorUserId: "operator", body: "continue", createdAt: new Date(), updatedAt: new Date() });
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId, agentId, source: "automation", reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: "system", payload: { issueId, commentId, _paperclipWakeContext: { issueId, wakeCommentIds: [commentId] }, queuedCommentInterrupt: { actorId: "board", requestedAt: new Date().toISOString() } } });
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: runId, status: "resolved", outcome: "blocked", nextAction: "blocked", evidence: { runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } });
    await appendHeartbeatRunEvent(db, { companyId, runId, agentId, eventType: "hermes_gateway.approval.requested", stream: "system", level: "warn", payload: { schema: "paperclip.hermes_gateway.approval_request.v1", paperclipRunId: runId, companyId, agentId, hermesRunId: "old-hermes-run", requestId: randomUUID(), status: "pending" } });
    const revision = queuedCommentQueueRevision({ queueId, comments: [{ id: commentId, updatedAt: (await db.select({ updatedAt: issueComments.updatedAt }).from(issueComments).where(eq(issueComments.id, commentId)))[0]!.updatedAt }] });
    return { companyId, agentId, issueId, runId, queueId, commentId, revision };
  }

  it("requires board auth and company access", async () => {
    await withFakeHermes("completed", async baseUrl => {
      const f = await seed(baseUrl);
      const body = { queueId: f.queueId, revision: f.revision, targetRunId: f.runId, hermesRunId: "old-hermes-run" };
      expect((await request(app(null)).post(`/api/issues/${f.issueId}/queued-comments/hermes-gateway-terminal-proof`).send(body)).status).not.toBe(200);
      expect((await request(app({ type: "agent", agentId: f.agentId, companyId: f.companyId, source: "agent_key" })).post(`/api/issues/${f.issueId}/queued-comments/hermes-gateway-terminal-proof`).send(body)).status).not.toBe(200);
      expect((await request(app(boardActor("other", [randomUUID()]))).post(`/api/issues/${f.issueId}/queued-comments/hermes-gateway-terminal-proof`).send(body)).status).not.toBe(200);
    });
  });

  it("records a scoped receipt only for the current queue revision and durable old Hermes run association", async () => {
    await withFakeHermes("completed", async (baseUrl, seen) => {
      const f = await seed(baseUrl);
      const route = `/api/issues/${f.issueId}/queued-comments/hermes-gateway-terminal-proof`;
      const stale = await request(app(boardActor("board", [f.companyId]))).post(route).send({ queueId: f.queueId, revision: "stale", targetRunId: f.runId, hermesRunId: "old-hermes-run" });
      expect(stale.status).toBe(409);
      const mismatch = await request(app(boardActor("board", [f.companyId]))).post(route).send({ queueId: f.queueId, revision: f.revision, targetRunId: f.runId, hermesRunId: "arbitrary-completed-run" });
      expect(mismatch.status).toBe(409);
      const ok = await request(app(boardActor("board", [f.companyId]))).post(route).send({ queueId: f.queueId, revision: f.revision, targetRunId: f.runId, hermesRunId: "old-hermes-run" });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.receipt).toMatchObject({ paperclipRunId: f.runId, hermesRunId: "old-hermes-run", queueId: f.queueId, association: "historical_approval_event" });
      const [action] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, f.issueId), eq(issueRecoveryActions.companyId, f.companyId)));
      expect(action.evidence.hermesGatewayTerminalProof).toMatchObject({ hermesRunId: "old-hermes-run", queueId: f.queueId });
      expect(seen.filter(line => line === "GET /v1/runs/old-hermes-run")).toHaveLength(1);
      expect(seen.some(line => line.startsWith("POST "))).toBe(false);
    });
  });

  it("fails closed when the associated Hermes run is still live or unknown", async () => {
    for (const status of ["running", "missing"]) {
      await withFakeHermes(status, async baseUrl => {
        const f = await seed(baseUrl);
        const response = await request(app(boardActor("board", [f.companyId]))).post(`/api/issues/${f.issueId}/queued-comments/hermes-gateway-terminal-proof`).send({ queueId: f.queueId, revision: f.revision, targetRunId: f.runId, hermesRunId: "old-hermes-run" });
        expect(response.status).toBe(409);
        const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
        expect(action.evidence.hermesGatewayTerminalProof).toBeUndefined();
      });
      await db.delete(issueRecoveryActions);
      await db.delete(activityLog);
      await db.delete(agentWakeupRequests);
      await db.delete(issueComments);
      await db.delete(heartbeatRunEvents);
      await db.delete(heartbeatRuns);
      await db.delete(issues);
      await db.delete(agents);
      await db.delete(principalPermissionGrants);
      await db.delete(companyMemberships);
      await db.delete(companies);
    }
  });
});
