import { describe, expect, it } from "vitest";
import { resolvePluginHostVersion } from "../app.js";
import { serverVersion } from "../version.js";

describe("plugin host version bootstrap", () => {
  it("falls back to the actual server version for plugin instanceInfo", () => {
    expect(resolvePluginHostVersion()).toBe(serverVersion);
    expect(resolvePluginHostVersion(null)).toBe(serverVersion);
    expect(resolvePluginHostVersion()).not.toBe("0.0.0");
  });

  it("preserves an explicit hostVersion override for tests and embeddings", () => {
    expect(resolvePluginHostVersion("2026.916.1-test")).toBe("2026.916.1-test");
  });
});
