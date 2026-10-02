import { describe, expect, it } from "vitest";
import { compareVersions, isNewerVersion } from "../src/platform/updates";

describe("app update version comparison", () => {
  it("compares numerically, not as text", () => {
    expect(isNewerVersion("0.1.10", "0.1.9")).toBe(true);
    expect(isNewerVersion("0.2.0", "0.1.99")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true);
  });
  it("ignores a leading v and treats equal versions as not newer", () => {
    expect(isNewerVersion("v0.1.8", "0.1.8")).toBe(false);
    expect(compareVersions("v0.1.8", "0.1.8")).toBe(0);
    expect(compareVersions("0.1", "0.1.0")).toBe(0);
  });
  it("never offers an older release", () => {
    expect(isNewerVersion("0.1.7", "0.1.8")).toBe(false);
  });
  it("sorts pre-releases before the release", () => {
    expect(isNewerVersion("0.2.0", "0.2.0-beta.1")).toBe(true);
    expect(isNewerVersion("0.2.0-beta.1", "0.2.0")).toBe(false);
    expect(isNewerVersion("0.2.0-beta.2", "0.2.0-beta.1")).toBe(true);
  });
});
