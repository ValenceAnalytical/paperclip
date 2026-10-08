// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HeartbeatRunEvent } from "@paperclipai/shared";
import { collectHermesApprovalRequests, HermesApprovalCards } from "./HermesApprovalCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  root.unmount();
  container.remove();
});

async function renderCards(runEvents: Parameters<typeof HermesApprovalCards>[0]["runEvents"]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <HermesApprovalCards runEvents={runEvents} />
      </QueryClientProvider>,
    );
  });
}

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

  it("keeps active approvals actionable while compacting expired approval audit history", async () => {
    await renderCards([
      {
        runId: "run-pending",
        runStatus: "waiting_for_approval",
        events: [
          event(1, "hermes_gateway.approval.requested", {
            requestId: "pending-req",
            description: "Pending approval",
            command: "printf pending",
            requestedAt: "2026-10-04T04:00:00.000Z",
            expiresAt: "2999-01-01T00:00:00.000Z",
          }),
        ],
      },
      {
        runId: "run-expired-a",
        runStatus: "succeeded",
        events: [
          event(2, "hermes_gateway.approval.requested", {
            requestId: "expired-a",
            description: "Expired approval A",
            command: "printf expired-a",
            requestedAt: "2026-10-04T03:00:00.000Z",
            expiresAt: "2026-10-04T03:30:00.000Z",
          }),
        ],
      },
      {
        runId: "run-expired-b",
        runStatus: "cancelled",
        events: [
          event(3, "hermes_gateway.approval.requested", {
            requestId: "expired-b",
            description: "Expired approval B",
            command: "printf expired-b",
            requestedAt: "2026-10-04T02:00:00.000Z",
            expiresAt: "2026-10-04T02:30:00.000Z",
          }),
        ],
      },
    ]);

    expect(container.textContent).toContain("Pending approval");
    expect(container.textContent).toContain("printf pending");
    expect(container.textContent).toContain("Approve once");
    expect(container.textContent).toContain("Deny");
    expect(container.textContent).toContain("Hermes approval history (2)");
    expect(container.textContent).toContain("Expired approval A");
    expect(container.textContent).toContain("Expired approval B");
    const history = container.querySelector('[data-testid="hermes-approval-history"]');
    expect(history).not.toBeNull();
    expect(history?.hasAttribute("open")).toBe(false);
    expect(history?.querySelectorAll("pre")).toHaveLength(2);
    expect(container.querySelectorAll("details").length).toBeGreaterThanOrEqual(3);
  });

  it("does not render approve controls for expired-only approval history", async () => {
    await renderCards([
      {
        runId: "run-expired-only",
        runStatus: "succeeded",
        events: [
          event(1, "hermes_gateway.approval.requested", {
            requestId: "expired-only",
            description: "Expired approval only",
            command: "printf expired-only",
            expiresAt: "2026-10-04T03:59:59.000Z",
          }),
        ],
      },
    ]);

    expect(container.textContent).toContain("Hermes approval history (1)");
    expect(container.textContent).toContain("Expired approval only");
    expect(container.textContent).not.toContain("Approve once");
    expect(container.textContent).not.toContain("Deny");
    const history = container.querySelector('[data-testid="hermes-approval-history"]');
    expect(history?.hasAttribute("open")).toBe(false);
    expect(history?.querySelector("pre")?.textContent).toContain("printf expired-only");
  });
});
