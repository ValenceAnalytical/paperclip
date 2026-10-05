// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { HeartbeatRun, HeartbeatRunEvent } from "@paperclipai/shared";
import { afterEach, expect, it, vi } from "vitest";
import { LogViewer } from "./AgentDetail";
import { LogViewer as ProductionLogViewer } from "./AgentDetail.production";

const { log, events, workspaceOperations, resolveHermesApproval, state } = vi.hoisted(() => ({
  log: vi.fn(),
  events: vi.fn<() => Promise<HeartbeatRunEvent[]>>(async () => []),
  workspaceOperations: vi.fn(async () => []),
  resolveHermesApproval: vi.fn(),
  state: { queryData: [] as unknown[] },
}));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: { log, events, workspaceOperations, resolveHermesApproval } }));
vi.mock("@tanstack/react-query", async (original) => ({
  ...await original<typeof import("@tanstack/react-query")>(),
  useQuery: (config: { queryKey?: readonly unknown[] }) => {
    const key = Array.isArray(config.queryKey) ? config.queryKey : [];
    if (key[0] === "heartbeat-run" && key[2] === "workspace-operations") return { data: [] };
    return { data: state.queryData };
  },
  useMutation: (config: { mutationFn: (input: unknown) => Promise<unknown>; onSuccess?: () => void }) => ({
    mutate: (input: unknown) => { void config.mutationFn(input).then(() => config.onSuccess?.()); },
    isPending: false,
    isError: false,
    variables: undefined,
    error: null,
  }),
}));
vi.mock("../adapters", () => ({
  getUIAdapter: () => null,
  onAdapterChange: () => () => {},
  buildTranscript: (lines: unknown[]) => lines,
}));
vi.mock("../components/transcript/RunTranscriptView", () => ({
  RunTranscriptView: ({ entries }: { entries: Array<{ chunk: string }> }) => <div>{entries.map(line => line.chunk).join(" ")}</div>,
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  state.queryData = [];
  log.mockReset();
  events.mockReset();
  workspaceOperations.mockReset();
  resolveHermesApproval.mockReset();
});

it.each([LogViewer, ProductionLogViewer])("retains legacy history and reads only the next offset on visibility recovery (%#)", async (Viewer) => {
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const row = (seq: number, chunk: string) => JSON.stringify({ seq, ts: `2026-09-10T12:00:0${seq}Z`, stream: "stdout", chunk }) + "\n";
  const first = row(1, "retained history");
  const second = row(2, "new output");
  log.mockResolvedValueOnce({ content: first, nextOffset: first.length });
  const run = { id: "run-1", companyId: "company-1", agentId: "agent-1", status: "succeeded", logRef: "log" } as HeartbeatRun;
  events.mockResolvedValue([]);
  workspaceOperations.mockResolvedValue([]);
  resolveHermesApproval.mockResolvedValue({ accepted: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Viewer run={run} adapterType="codex_local" />));
    expect(container.textContent).toContain("retained history");
    await act(async () => {
      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("retained history");
    let complete!: (value: { content: string; nextOffset: number }) => void;
    log.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    await act(async () => {
      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(container.textContent).toContain("retained history");
    expect(log).toHaveBeenLastCalledWith("run-1", first.length, expect.any(Number));
    await act(async () => complete({ content: second, nextOffset: first.length + second.length }));
    expect(container.textContent).toContain("retained history new output");
    log.mockResolvedValueOnce({ content: first, nextOffset: first.length });
    await act(async () => root.render(<Viewer run={{ ...run, id: "run-2" }} adapterType="codex_local" />));
    expect(log).toHaveBeenLastCalledWith("run-2", 0, expect.any(Number));
    expect(container.textContent).not.toContain("new output");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("shows pending Hermes approvals with redacted preview and resolves approve-once through the scoped API", async () => {
  const approvalEvent = {
    id: 701,
    seq: 7,
    runId: "run-1",
    agentId: "agent-1",
    companyId: "company-1",
    eventType: "hermes_gateway.approval.requested",
    stream: "system",
    level: "warn",
    message: "Hermes approval requested",
    color: null,
    createdAt: new Date("2026-10-03T18:00:00.000Z"),
    payload: {
      schema: "paperclip.hermes_gateway.approval_request.v1",
      requestId: "approval-123",
      hermesRunId: "hermes-run-abc",
      description: "Approve shell command",
      reason: "Needs operator confirmation",
      command: "printf '[REDACTED]'",
      cwd: "/workspace/project",
      expiresAt: "2099-01-01T00:00:00.000Z",
      displayDigest: "local:abc123",
    },
  } as HeartbeatRunEvent;
  state.queryData = [approvalEvent];
  log.mockResolvedValueOnce({ content: "", nextOffset: 0 });
  events.mockResolvedValueOnce([approvalEvent]).mockResolvedValueOnce([]);
  workspaceOperations.mockResolvedValue([]);
  resolveHermesApproval.mockResolvedValue({ accepted: true, duplicate: false });
  const run = { id: "run-1", companyId: "company-1", agentId: "agent-1", status: "running", logRef: "log" } as HeartbeatRun;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<LogViewer run={run} adapterType="hermes" />));
    expect(container.textContent).toContain("Hermes approval required");
    expect(container.textContent).toContain("Approve shell command");
    expect(container.textContent).toContain("[REDACTED]");
    expect(container.textContent).toContain("Digest local:abc123");
    const approveButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Approve once");
    expect(approveButton).toBeTruthy();
    await act(async () => approveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(resolveHermesApproval).toHaveBeenCalledWith({ runId: "run-1", requestId: "approval-123", choice: "once" });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it.each([LogViewer, ProductionLogViewer])("polls logs when WebSocket construction fails and recovers on retry (%#)", async (Viewer) => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.stubGlobal("WebSocket", undefined);
  log.mockResolvedValue({ content: "", nextOffset: 0 });
  const run = { id: "run-1", companyId: "company-1", agentId: "agent-1", status: "running", logRef: "log" } as HeartbeatRun;
  const root = createRoot(document.createElement("div"));
  const sockets: Array<{ onopen: (() => void) | null; close: () => void }> = [];
  try {
    await act(async () => root.render(<Viewer run={run} adapterType="codex_local" />));
    const initialReads = log.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(log.mock.calls.length).toBeGreaterThan(initialReads);
    expect(events).toHaveBeenCalled();
    vi.stubGlobal("WebSocket", class {
      onopen = null;
      close = vi.fn();
      constructor() { sockets.push(this); }
    });
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(sockets).toHaveLength(1);
    await act(async () => sockets[0].onopen?.());
    const readsWhenConnected = log.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(log).toHaveBeenCalledTimes(readsWhenConnected);
  } finally {
    await act(async () => root.unmount());
  }
  expect(sockets[0].close).toHaveBeenCalled();
});
