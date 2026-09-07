import { describe, it, expect } from "vitest";
import { loadEnvFile } from "../../shared/env.js";

describe("loadEnvFile", () => {
  it("does not throw when .env file is missing", () => {
    expect(() => loadEnvFile(".nonexistent-env-file")).not.toThrow();
  });
});
