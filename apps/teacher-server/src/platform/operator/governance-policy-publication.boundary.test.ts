import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallationCapability } from "../../governance/authority.js";

const fs = vi.hoisted(() => ({
  closeSync: vi.fn(),
  fsyncSync: vi.fn(),
  linkSync: vi.fn(),
  mkdtempSync: vi.fn(() => "/private/owned-stage"),
  openSync: vi.fn(() => 7),
  realpathSync: vi.fn(() => "/private"),
  lstatSync: vi.fn(() => ({
    mode: 0o40700,
    uid: process.getuid?.() ?? 0,
    isDirectory: (): boolean => true,
    isFile: (): boolean => false,
  })),
  unlinkSync: vi.fn(),
  rmdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
const validate = vi.hoisted(() => vi.fn());
vi.mock("node:fs", () => fs);
vi.mock("./operator-filesystem-loader.js", () => ({ loadOperatorConfiguration: validate }));
import { publishGovernancePolicy } from "./governance-policy-publication.boundary.js";

describe("private immutable policy publication failure boundary", () => {
  const assertOwned = vi.fn<() => undefined>();
  const authority: InstallationCapability = {
    kind: "exclusive-installation-owner",
    installationRoot: "/private",
    assertOwned,
  };
  const bytes = Buffer.from('{"version":1,"classes":[]}');
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("durably writes a uniquely owned stage, validates it, rechecks ownership and publishes create-only", () => {
    publishGovernancePolicy(authority, "/private/policy.json", bytes);
    expect(assertOwned).toHaveBeenCalledTimes(2);
    expect(fs.mkdtempSync).toHaveBeenCalledWith("/private/.marea-policy-");
    expect(fs.openSync).toHaveBeenCalledWith("/private/owned-stage/policy.json", "wx", 0o600);
    expect(fs.writeFileSync).toHaveBeenCalledWith(7, bytes);
    expect(fs.fsyncSync).toHaveBeenCalledWith(7);
    expect(fs.closeSync).toHaveBeenCalledWith(7);
    expect(validate).toHaveBeenCalledWith("/private/owned-stage/policy.json", 4_194_304);
    expect(fs.linkSync).toHaveBeenCalledWith(
      "/private/owned-stage/policy.json",
      "/private/policy.json",
    );
    expect(fs.unlinkSync).toHaveBeenCalledWith("/private/owned-stage/policy.json");
    expect(fs.rmdirSync).toHaveBeenCalledWith("/private/owned-stage");
    expect(validate.mock.invocationCallOrder[0]).toBeLessThan(
      fs.linkSync.mock.invocationCallOrder[0] ?? 0,
    );
    expect(assertOwned.mock.invocationCallOrder[1]).toBeLessThan(
      fs.linkSync.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it.each([
    "openSync",
    "writeFileSync",
    "fsyncSync",
    "closeSync",
    "linkSync",
    "unlinkSync",
    "rmdirSync",
  ] as const)("sanitizes %s failure without reporting success or leaking paths", (operation) => {
    fs[operation].mockImplementationOnce(() => {
      throw new Error("private /sensitive/installation secret");
    });
    expect(() => {
      publishGovernancePolicy(authority, "/private/policy.json", bytes);
    }).toThrow("Private policy publication did not complete.");
    if (operation === "openSync") expect(fs.unlinkSync).not.toHaveBeenCalled();
    if (operation !== "linkSync" && operation !== "unlinkSync" && operation !== "rmdirSync")
      expect(fs.linkSync).not.toHaveBeenCalled();
  });

  it("refuses to publish after lock loss or rejected staged validation", () => {
    assertOwned
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("Private lock lost");
      });
    expect(() => {
      publishGovernancePolicy(authority, "/private/policy.json", bytes);
    }).toThrow("Private policy publication did not complete.");
    expect(fs.linkSync).not.toHaveBeenCalled();
    validate.mockImplementationOnce(() => {
      throw new Error("Private invalid policy");
    });
    expect(() => {
      publishGovernancePolicy(authority, "/private/policy.json", bytes);
    }).toThrow("Private policy publication did not complete.");
    expect(fs.linkSync).not.toHaveBeenCalled();
    expect(fs.rmdirSync).toHaveBeenCalledTimes(2);
  });

  it("rejects a non-directory parent before creating a stage", () => {
    fs.lstatSync.mockReturnValueOnce({
      mode: 0o100600,
      uid: process.getuid?.() ?? 0,
      isDirectory: () => false,
      isFile: () => true,
    });
    expect(() => {
      publishGovernancePolicy(authority, "/private/policy.json", bytes);
    }).toThrow("Choose a canonical private output directory.");
    expect(fs.mkdtempSync).not.toHaveBeenCalled();
  });

  it("rejects a directory alias even when permissions and directory type are valid", () => {
    fs.realpathSync.mockReturnValueOnce("/canonical-private");
    expect(() => {
      publishGovernancePolicy(authority, "/private/policy.json", bytes);
    }).toThrow("Choose a canonical private output directory.");
    expect(fs.mkdtempSync).not.toHaveBeenCalled();
  });
});
