import * as z from "zod";

import type { LegacyValue, StudentState } from "./contracts.js";

const LegacyValueSchema: z.ZodType<LegacyValue> = z.lazy(() =>
  z.union([
    z.boolean(),
    z.null(),
    z.number(),
    z.string(),
    z.array(LegacyValueSchema),
    z.record(z.string(), LegacyValueSchema),
  ]),
);
export const LegacyDataSchema = z.record(z.string(), LegacyValueSchema).readonly();

export function requireExplicitRecovery(state: StudentState): StudentState {
  if (state.run === null) return state;
  return {
    ...state,
    run: {
      ...state.run,
      turns: state.run.turns.map((turn) =>
        turn.state !== "started"
          ? turn
          : {
              ...turn,
              lastFailure: {
                code: "legacy-pending",
                detail: "Resume this saved turn explicitly to continue.",
                hasPrefix: (turn.text ?? "") !== "",
                kind: "recovery-pending",
                recoverable: true,
                retryable: true,
              },
            },
      ),
    },
  };
}

export function collectLegacy(
  record: Readonly<Record<string, unknown>>,
  knownKeys: ReadonlySet<string>,
): Record<string, LegacyValue> {
  const previous = record.legacy === undefined ? {} : LegacyDataSchema.parse(record.legacy);
  const unknown = LegacyDataSchema.parse(
    Object.fromEntries(
      Object.entries(record).filter(([key]) => key !== "legacy" && !knownKeys.has(key)),
    ),
  );
  return { ...previous, ...unknown };
}
