import { describe, expect, it } from "vitest";
import { buildRunBodyForTest } from "./execute.js";

function ctx(overrides: Record<string, unknown> = {}): any {
  return {
    runId: "run-A",
    authToken: "paperclip-run-token-A",
    agent: { id: "agent-A", companyId: "company-A", name: "Nova" },
    config: {
      paperclipApiUrl: "http://127.0.0.1:9130",
      payloadTemplate: {
        input: "",
        run_env: { PAPERCLIP_API_KEY: "malicious", BAD_KEY: "bad" },
      },
      ...(overrides.config as Record<string, unknown> | undefined),
    },
    context: { taskId: "issue-A", paperclipWake: {}, ...(overrides.context as Record<string, unknown> | undefined) },
    ...overrides,
  };
}

describe("Hermes gateway run_env", () => {
  it("sends only Paperclip run-scoped credentials from harness context", () => {
    const body = buildRunBodyForTest(ctx(), "paperclip:company:company-A:agent:agent-A:issue:issue-A");
    expect(body.run_env).toEqual({
      PAPERCLIP_API_URL: "http://127.0.0.1:9130",
      PAPERCLIP_API_KEY: "paperclip-run-token-A",
      PAPERCLIP_RUN_ID: "run-A",
      PAPERCLIP_COMPANY_ID: "company-A",
      PAPERCLIP_AGENT_ID: "agent-A",
      PAPERCLIP_TASK_ID: "issue-A",
    });
    expect(JSON.stringify(body.run_env)).not.toContain("malicious");
    expect(JSON.stringify(body.run_env)).not.toContain("BAD_KEY");
  });

  it("fails closed by omitting run_env when the harness token is missing", () => {
    const body = buildRunBodyForTest(ctx({ authToken: "" }), null);
    expect(body).not.toHaveProperty("run_env");
  });

  it("isolates concurrent run bodies", () => {
    const a = buildRunBodyForTest(ctx({ runId: "run-A", authToken: "token-A" }), null);
    const b = buildRunBodyForTest(ctx({ runId: "run-B", authToken: "token-B" }), null);
    expect((a.run_env as Record<string, string>).PAPERCLIP_API_KEY).toBe("token-A");
    expect((b.run_env as Record<string, string>).PAPERCLIP_API_KEY).toBe("token-B");
    expect((a.run_env as Record<string, string>).PAPERCLIP_RUN_ID).toBe("run-A");
    expect((b.run_env as Record<string, string>).PAPERCLIP_RUN_ID).toBe("run-B");
  });
});
