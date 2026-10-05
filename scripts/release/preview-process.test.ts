import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => mock);
import { runForeground } from "./preview-process.boundary.js";
afterEach(() => {
  vi.restoreAllMocks();
});

it("forwards stop signals, waits for orderly exit and removes its handlers", async () => {
  const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
  mock.spawn.mockReturnValue(child);
  const remove = vi.spyOn(process, "removeListener");
  const running = runForeground("marea", ["--lang", "es"], {
    MAREA_SERVER_URL: "https://school.test",
  });
  expect(mock.spawn).toHaveBeenCalledWith("marea", ["--lang", "es"], {
    stdio: "inherit",
    env: { MAREA_SERVER_URL: "https://school.test" },
  });
  const interrupt = (process.listeners("SIGINT") as (() => void)[]).at(-1);
  const terminate = (process.listeners("SIGTERM") as (() => void)[]).at(-1);
  interrupt?.();
  terminate?.();
  expect(child.kill.mock.calls).toEqual([["SIGINT"], ["SIGTERM"]]);
  child.emit("exit", 0);
  expect(await running).toBe(0);
  expect(remove).toHaveBeenCalledWith("SIGINT", interrupt);
  expect(remove).toHaveBeenCalledWith("SIGTERM", terminate);
});

it("reports failure to spawn and interrupted children", async () => {
  for (const event of ["error", "exit"]) {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    mock.spawn.mockReturnValue(child);
    const before = process.listenerCount("SIGINT");
    const running = runForeground("missing", [], {});
    child.emit(event, null);
    if (event === "error") await expect(running).rejects.toThrow("Could not start");
    else expect(await running).toBe(1);
    expect(process.listenerCount("SIGINT")).toBe(before);
  }
});
