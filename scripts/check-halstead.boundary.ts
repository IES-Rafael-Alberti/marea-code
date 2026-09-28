import { runFta } from "fta-cli";
import { z } from "zod";

const MAXIMUM_DIFFICULTY = 80;

const reportSchema = z.array(
  z.object({
    file_name: z.string().min(1),
    halstead: z.object({
      difficulty: z.number(),
    }),
  }),
);

type WriteLine = (line: string) => void;
type Analyze = () => string;

function parseReport(reportText: string): z.infer<typeof reportSchema> {
  const untrustedReport: unknown = JSON.parse(reportText);
  return reportSchema.parse(untrustedReport);
}

export function enforceHalsteadDifficulty(reportText: string, writeLine: WriteLine): void {
  const report = parseReport(reportText);
  const violations: string[] = [];

  for (const file of report) {
    const difficulty = file.halstead.difficulty;
    writeLine(`${file.file_name}: Halstead difficulty ${difficulty.toFixed(2)}`);

    if (difficulty >= MAXIMUM_DIFFICULTY) {
      violations.push(`${file.file_name} (${difficulty.toFixed(2)})`);
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `Halstead difficulty must be below ${String(MAXIMUM_DIFFICULTY)}: ${violations.join(", ")}`,
    );
  }
}

export function runHalsteadCheck(analyze: Analyze, writeLine: WriteLine): void {
  enforceHalsteadDifficulty(analyze(), writeLine);
}

/* v8 ignore start -- The CLI branch delegates completely to the tested gate. */
// Stryker disable all: The CLI branch delegates completely to the tested gate.
if (import.meta.main) {
  runHalsteadCheck(() => runFta(".", { json: true }), console.log);
}
// Stryker restore all
/* v8 ignore stop */
