import { expect, it, vi } from "vitest";
const filesystem = vi.hoisted(() => ({
  lstatSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  realpathSync: vi.fn(),
}));
vi.mock("node:fs", () => filesystem);
import { ordinaryFiles } from "./files.boundary.js";
it("sorts a deliberately unordered filesystem and rejects canonical ancestor changes", () => {
  filesystem.realpathSync.mockImplementation((path: string) => path);
  filesystem.readdirSync.mockImplementation((path: string) =>
    path === "/root" ? ["z", "a", "licenses", "licenses.json"] : ["bun.txt"],
  );
  filesystem.lstatSync.mockImplementation((path: string) => ({
    isDirectory: () => path === "/root" || path === "/root/licenses",
    isSymbolicLink: () => false,
    isFile: () => path !== "/root",
    nlink: 1,
  }));
  expect(ordinaryFiles("/root")).toEqual(["a", "licenses.json", "licenses/bun.txt", "z"]);
  filesystem.realpathSync.mockReturnValue("/different-root");
  expect(() => ordinaryFiles("/root")).toThrow("Noncanonical release directory");
});
