import * as z from "zod";

import type { AcceptanceHarness } from "./harness.js";

const StoredEventRowsSchema = z.array(
  z
    .object({
      event_id: z.string(),
      event_type: z.string(),
      payload_json: z.string(),
      sequence: z.bigint(),
    })
    .strict(),
);

export type StoredEventRow = z.infer<typeof StoredEventRowsSchema>[number];

export function storedEvents(value: AcceptanceHarness): StoredEventRow[] {
  return StoredEventRowsSchema.parse(
    value.database.readAll(
      "SELECT event_id, event_type, payload_json, sequence FROM marea_run_events ORDER BY sequence",
    ),
  );
}
