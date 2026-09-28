import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("node:child_process", () => mocks);
import { verifySignature } from "./install.boundary.js";
it("requires successful exact-identity cosign verification with bounded execution", () => {
  mocks.spawnSync.mockReturnValue({ status: 0 });
  verifySignature("manifest", "bundle", "trusted-workflow");
  expect(mocks.spawnSync).toHaveBeenCalledWith(
    "cosign",
    [
      "verify-blob",
      "--bundle",
      "bundle",
      "--certificate-identity",
      "trusted-workflow",
      "--certificate-oidc-issuer",
      "https://token.actions.githubusercontent.com",
      "manifest",
    ],
    { encoding: "utf8", timeout: 120000 },
  );
  for (const status of [1, null]) {
    mocks.spawnSync.mockReturnValue({ status });
    expect(() => {
      verifySignature("manifest", "bundle", "trusted-workflow");
    }).toThrow("nothing activated");
  }
});
