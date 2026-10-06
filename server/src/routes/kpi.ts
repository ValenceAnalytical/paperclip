import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { badRequest } from "../errors.js";
import { accessService, kpiAnalyticsService } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";

function parseDateRange(query: Record<string, unknown>) {
  const fromRaw = Array.isArray(query.from) ? query.from[0] : query.from;
  const toRaw = Array.isArray(query.to) ? query.to[0] : query.to;
  const now = new Date();
  const defaultTo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const defaultFrom = new Date(defaultTo.getTime() - 7 * 24 * 60 * 60 * 1000);
  const from = fromRaw ? new Date(String(fromRaw)) : defaultFrom;
  const to = toRaw ? new Date(String(toRaw)) : defaultTo;
  if (Number.isNaN(from.getTime())) throw badRequest("invalid 'from' date");
  if (Number.isNaN(to.getTime())) throw badRequest("invalid 'to' date");
  if (to <= from) throw badRequest("invalid date range: 'to' must be after 'from'");
  const maxWindowMs = 366 * 24 * 60 * 60 * 1000;
  if (to.getTime() - from.getTime() > maxWindowMs) {
    throw badRequest("invalid date range: maximum KPI window is 366 days");
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

function parseFilters(query: Record<string, unknown>) {
  const stringParam = (key: string) => {
    const raw = Array.isArray(query[key]) ? query[key]?.[0] : query[key];
    return typeof raw === "string" && raw.trim() ? raw.trim() : null;
  };
  return {
    agentId: stringParam("agentId"),
    projectId: stringParam("projectId"),
    provider: stringParam("provider"),
  };
}

export function kpiRoutes(db: Db) {
  const router = Router();
  const kpis = kpiAnalyticsService(db);
  const access = accessService(db);

  async function assertCompanyKpiReadAllowed(req: Parameters<typeof assertCompanyAccess>[0], res: any, companyId: string) {
    const exists = await db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!exists) {
      res.status(404).json({ error: "Company not found" });
      return false;
    }

    assertCompanyAccess(req, companyId);
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (decision.allowed) return true;
    res.status(403).json({ error: "KPIs are outside this actor's authorization boundary" });
    return false;
  }

  function requestInput(req: Parameters<Parameters<typeof router.get>[1]>[0]) {
    return { range: parseDateRange(req.query), filters: parseFilters(req.query) };
  }

  router.get("/companies/:companyId/kpi/overview", async (req, res) => {
    const companyId = req.params.companyId as string;
    if (!(await assertCompanyKpiReadAllowed(req, res, companyId))) return;
    const input = requestInput(req);
    res.json(await kpis.overview({ companyId, ...input }));
  });

  router.get("/companies/:companyId/kpi/trend", async (req, res) => {
    const companyId = req.params.companyId as string;
    if (!(await assertCompanyKpiReadAllowed(req, res, companyId))) return;
    const input = requestInput(req);
    res.json(await kpis.trend({ companyId, ...input }));
  });

  router.get("/companies/:companyId/kpi/by-agent", async (req, res) => {
    const companyId = req.params.companyId as string;
    if (!(await assertCompanyKpiReadAllowed(req, res, companyId))) return;
    const input = requestInput(req);
    res.json(await kpis.byAgent({ companyId, ...input }));
  });

  router.get("/companies/:companyId/kpi/filter-options", async (req, res) => {
    const companyId = req.params.companyId as string;
    if (!(await assertCompanyKpiReadAllowed(req, res, companyId))) return;
    res.json(await kpis.filterOptions(companyId));
  });

  return router;
}
