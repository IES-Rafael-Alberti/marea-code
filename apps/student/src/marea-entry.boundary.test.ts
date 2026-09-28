import { afterEach, describe, expect, it, vi } from "vitest";

describe("marea executable entry", () => {
  const originalArguments = process.argv;
  const originalLanguage = process.env.MAREA_LANG;
  const originalStateHome = process.env.MAREA_STATE_HOME;
  afterEach(() => {
    process.argv = originalArguments;
    if (originalLanguage === undefined) delete process.env.MAREA_LANG;
    else process.env.MAREA_LANG = originalLanguage;
    if (originalStateHome === undefined) delete process.env.MAREA_STATE_HOME;
    else process.env.MAREA_STATE_HOME = originalStateHome;
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it.each([undefined, "", " \t "])(
    "writes the version with MAREA_LANG=%j",
    async (language) => {
      if (language === undefined) delete process.env.MAREA_LANG;
      else process.env.MAREA_LANG = language;
      vi.resetModules();
      process.argv = ["bun", "marea", "--version"];
      const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const writeError = vi.spyOn(process.stderr, "write").mockReturnValue(true);

      const entry = await import("./marea-entry.boundary.js");
      entry.createProcessCommandOutput().error("safe error\n");

      expect(write).toHaveBeenCalledWith("0.2.0\n");
      expect(writeError).toHaveBeenCalledWith("safe error\n");
      expect(process.exitCode).toBe(0);
    },
    15_000,
  );

  it("reports an invalid environment override before starting the command", async () => {
    process.argv = ["bun", "marea"];
    process.env.MAREA_LANG = "fr-FR";
    process.env.MAREA_STATE_HOME = " /tmp/marea-test-state ";
    const writeError = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.resetModules();

    await import("./marea-entry.boundary.js");

    expect(writeError).toHaveBeenCalledWith(
      "La opción de idioma fr-FR no es válida. Usa automatic, es, en o eu.\n",
    );
    expect(process.exitCode).toBe(2);
  }, 15_000);

  it("reports an invalid command-line override in Spanish", async () => {
    process.argv = ["bun", "marea", "--lang", "fr-FR"];
    delete process.env.MAREA_LANG;
    vi.resetModules();

    const writeError = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await import("./marea-entry.boundary.js");

    expect(writeError).toHaveBeenCalledWith(
      "La opción de idioma fr-FR no es válida. Usa automatic, es, en o eu.\n",
    );
    expect(process.exitCode).toBe(2);
  }, 15_000);
});
