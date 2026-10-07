import * as z from "zod";
import { SessionExportQuerySchema, type SessionExportQuery } from "@marea/protocol";
import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";
import { EvaluationRequestError } from "../evaluation/evaluation-client.boundary.js";

const Students = z
  .object({
    students: z
      .array(z.object({ id: z.string(), name: z.string(), classId: z.string() }).strict())
      .max(2001),
  })
  .strict();
export interface SessionExportClient {
  students(signal: AbortSignal): Promise<z.infer<typeof Students>["students"]>;
  download(query: SessionExportQuery, signal: AbortSignal): Promise<Blob>;
}
export function sessionExportClient(fetchRequest: DashboardFetch): SessionExportClient {
  const request = async (action: string, body: object, signal: AbortSignal) => {
    const response = await fetchRequest(`/api/v1/dashboard/session-export/${action}`, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new EvaluationRequestError(response.status);
    return response;
  };
  return {
    async students(signal) {
      return Students.parse(await (await request("students", {}, signal)).json()).students;
    },
    async download(query, signal) {
      const response = await request("download", SessionExportQuerySchema.parse(query), signal);
      if (response.headers.get("content-type") !== "application/zip")
        throw new Error("Invalid export response.");
      return response.blob();
    },
  };
}

export function saveSessionDownload(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "marea-sessions.zip";
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}
