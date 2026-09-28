import { describe, expect, it, vi } from "vitest";

import { enforceHalsteadDifficulty, runHalsteadCheck } from "./check-halstead.boundary.js";

function report(fileName: string, difficulty: number): string {
  return JSON.stringify([
    {
      file_name: fileName,
      halstead: { difficulty },
    },
  ]);
}

describe("Halstead difficulty gate", () => {
  it("reports a file below the required limit", () => {
    const writeLine = vi.fn();

    enforceHalsteadDifficulty(report("packages/shared/src/value.ts", 79.99), writeLine);

    expect(writeLine).toHaveBeenCalledWith(
      "packages/shared/src/value.ts: Halstead difficulty 79.99",
    );
  });

  it("rejects a file at the limit", () => {
    expect(() => {
      enforceHalsteadDifficulty(report("apps/student/src/main.ts", 80), vi.fn());
    }).toThrow("Halstead difficulty must be below 80: apps/student/src/main.ts (80.00)");
  });

  it("reports every file above the limit", () => {
    const analyzedFiles = JSON.stringify([
      { file_name: "apps/student/src/main.ts", halstead: { difficulty: 80 } },
      { file_name: "packages/shared/src/value.ts", halstead: { difficulty: 81 } },
    ]);

    expect(() => {
      enforceHalsteadDifficulty(analyzedFiles, vi.fn());
    }).toThrow(
      "Halstead difficulty must be below 80: apps/student/src/main.ts (80.00), packages/shared/src/value.ts (81.00)",
    );
  });

  it("rejects malformed analyzer output at the boundary", () => {
    expect(() => {
      enforceHalsteadDifficulty('[{"file_name":"missing-metrics.ts"}]', vi.fn());
    }).toThrow();
  });

  it("runs the analyzer before enforcing its report", () => {
    const analyze = vi.fn(() => report("packages/shared/src/value.ts", 12));
    const writeLine = vi.fn();

    runHalsteadCheck(analyze, writeLine);

    expect(analyze).toHaveBeenCalledOnce();
    expect(writeLine).toHaveBeenCalledWith(
      "packages/shared/src/value.ts: Halstead difficulty 12.00",
    );
  });
});
