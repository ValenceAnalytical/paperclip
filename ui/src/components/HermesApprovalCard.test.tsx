// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { HeartbeatRunEvent } from "@paperclipai/shared";
import { collectHermesApprovalRequests } from "./HermesApprovalCard";

function event(
  id: number,
  eventType: string,
  payload: Record<string, unknown>,
): HeartbeatRunEvent {
  return {
    id,
    companyId: "company-1",
    runId: "run-1",
    agentId: "agent-1",
    seq: id,
    eventType,
    stream: "system",
    level: "warn",
    color: null,
    message: null,
    payload,
    createdAt: new Date("2026-10-04T04:00:00.000Z"),
  };
}

describe("collectHermesApprovalRequests", () => {
  it("projects pending, resolved, failed, and expired Hermes approval request states by exact run/request", () => {
    const requests = collectHermesApprovalRequests([
      {
        runId: "run-1",
        events: [
          event(1, "hermes_gateway.approval.requested", {
            requestId: "pending-req",
            description: "Pending request",
            expiresAt: "2999-01-01T00:00:00.000Z",
          }),
          event(2, "hermes_gateway.approval.requested", {
            requestId: "resolved-req",
            description: "Resolved request",
            expiresAt: "2999-01-01T00:00:00.000Z",
          }),
          event(3, "hermes_gateway.approval.resolved", {
            requestId: "resolved-req",
            choice: "once",
          }),
          event(4, "hermes_gateway.approval.requested", {
            requestId: "failed-req",
            description: "Failed request",
            expiresAt: "2999-01-01T00:00:00.000Z",
          }),
          event(5, "hermes_gateway.approval.dispatch_failed", {
            requestId: "failed-req",
          }),
          event(6, "hermes_gateway.approval.requested", {
            requestId: "expired-req",
            description: "Expired request",
            expiresAt: "2026-10-04T03:59:59.000Z",
          }),
        ],
      },
    ], Date.parse("2026-10-04T04:00:00.000Z"));

    expect(requests.map((request) => [request.requestId, request.status, request.choice])).toEqual([
      ["pending-req", "pending", null],
      ["resolved-req", "resolved", "once"],
      ["failed-req", "failed", null],
      ["expired-req", "expired", null],
    ]);
  });
});
