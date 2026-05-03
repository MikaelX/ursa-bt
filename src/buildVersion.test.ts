import { describe, expect, it } from "vitest";
import { buildAppVersion } from "./buildVersion";

describe("buildAppVersion", () => {
  it("returns a non-empty semantic label", () => {
    const v = buildAppVersion();
    expect(typeof v).toBe("string");
    expect(v.length).toBeGreaterThan(0);
  });
});
