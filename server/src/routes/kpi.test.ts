import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  costEvents,
  createDb,
  heartbeatRuns,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import type { AuthorizationActor } from "../services/authorization.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { kpiRoutes } from "./kpi.js";

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;
type Db = ReturnType<typeof createDb>;

function routeApp(db: Db, actor: AuthorizationActor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", kpiRoutes(db));
  app.use(errorHandler);
  return app;
}

function agentActor(companyId: string, agentId: string): AuthorizationActor {
  return {
    type: "agent",
    source: "agent_key",
    companyId,
    agentId,
    keyId: `key-${agentId}`,
  };
}

async function seedCompanyWithBoardAccess(db: Db, name: string) {
  const companyId = randomUUID();
  const userId = `user-${randomUUID()}`;
  await db.insert(companies).values({
    id: companyId,
    name: `${name} ${companyId}`,
    issuePrefix: `T${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(companyMemberships).values({
    companyId,
    principalType: "user",
    principalId: userId,
    status: "active",
    membershipRole: "owner",
    updatedAt: new Date(),
  });
  await ensureHumanRoleDefaultGrants(db, {
    companyId,
    principalId: userId,
    membershipRole: "owner",
    grantedByUserId: null,
  });
  const actor: AuthorizationActor = {
    type: "board",
    source: "session",
    userId,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    isInstanceAdmin: false,
  };
  return { companyId, userId, actor };
}

describePg("KPI routes authorization", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: Db;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("kpi-routes-auth-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => tempDb?.cleanup());

  it("denies unauthenticated KPI reads", async () => {
    const { companyId } = await seedCompanyWithBoardAccess(db, "KPI auth");
    const app = routeApp(db, { type: "none", source: "none" });

    const res = await request(app).get(`/api/companies/${companyId}/kpi/overview`);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("denies board users outside the target company", async () => {
    const allowed = await seedCompanyWithBoardAccess(db, "KPI allowed");
    const denied = await seedCompanyWithBoardAccess(db, "KPI denied");
    const app = routeApp(db, allowed.actor);

    const res = await request(app).get(`/api/companies/${denied.companyId}/kpi/overview`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("User does not have access to this company");
  });

  it("denies agent keys for another company before returning KPI data", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Agent KPI", issuePrefix: "AKPI", requireBoardApprovalForNewAgents: false },
      { id: otherCompanyId, name: "Other KPI", issuePrefix: "OKPI", requireBoardApprovalForNewAgents: false },
    ]);
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Nova",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      companyId: otherCompanyId,
      agentId,
      status: "succeeded",
      createdAt: new Date("2026-10-02T00:00:00Z"),
    });
    const app = routeApp(db, agentActor(companyId, agentId));

    const res = await request(app).get(`/api/companies/${otherCompanyId}/kpi/overview`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agent key cannot access another company");
  });

  it("returns 404 for unknown company IDs without leaking scoped data", async () => {
    const { actor } = await seedCompanyWithBoardAccess(db, "KPI known");
    const app = routeApp(db, actor);

    const res = await request(app).get(`/api/companies/${randomUUID()}/kpi/overview`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Company not found");
  });
});
