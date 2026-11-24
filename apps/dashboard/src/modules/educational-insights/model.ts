import { browserRandomUUID } from "../../browser-random-uuid.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as z from "zod";
import {
  mapSchema,
  progressSchema,
  overviewSchema,
  reportSchema,
  reportsSchema,
} from "./schemas.js";
import type { DashboardLocale } from "../../messages.js";
import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";
import { insightsClient } from "./client.js";
import { insightsMessages } from "./messages.js";
import { localTime } from "./local-time.js";
import { UsageHealthRequestError } from "../usage-health-client.boundary.js";

/** Generate refusals the teacher can act on, told apart by their HTTP status. */
const REFUSALS = { 409: "reportInProgress", 413: "reportTooLarge", 422: "reportPeriod" } as const;
type Refusal = (typeof REFUSALS)[keyof typeof REFUSALS];
function refusalOf(status: number): Refusal | null {
  return Object.hasOwn(REFUSALS, status) ? REFUSALS[status as keyof typeof REFUSALS] : null;
}

export interface InsightViewProps {
  readonly configure?: (() => void) | undefined;
  readonly visible?: boolean;
  readonly kind: "map" | "progress" | "reports";
  readonly classId: string | null;
  readonly locale: DashboardLocale;
  readonly fetchRequest: DashboardFetch;
  readonly navigate: (runId: string) => Promise<boolean>;
}
export function useInsightModel(props: InsightViewProps & { readonly classId: string }) {
  const m = insightsMessages(props.locale);
  const client = useMemo(() => insightsClient(props.fetchRequest), [props.fetchRequest]);
  const abort = useRef(new AbortController());
  const sequence = useRef(0);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Refusal | null>(null);
  const [data, setData] = useState<
    | z.infer<typeof mapSchema>
    | z.infer<typeof overviewSchema>
    | z.infer<typeof reportsSchema>
    | null
  >(null);
  const viewer = useRef(browserRandomUUID());
  const [page, setPage] = useState<string | null>(null);
  const [selectedReport, setSelectedReport] = useState<string | null>(null);
  const [report, setReport] = useState<z.infer<typeof reportSchema> | null>(null);
  const [from, setFrom] = useState(localTime(Date.now() - 86400000));
  const [to, setTo] = useState(localTime(Date.now()));
  const load = useCallback(async () => {
    const current = ++sequence.current;
    const valid = () => !abort.current.signal.aborted && current === sequence.current;
    try {
      if (props.kind === "map") {
        const visible = !document.hidden && (props.visible ?? true);
        const value = await client(
          props.classId,
          { kind: "map", viewerId: viewer.current, visible },
          mapSchema,
          abort.current.signal,
        );
        if (valid()) setData(value);
      } else if (props.kind === "progress") {
        const v = await client(
          props.classId,
          { kind: "overview", after: page },
          overviewSchema,
          abort.current.signal,
        );
        if (valid()) setData(v);
      } else if (selectedReport === null) {
        const v = await client(
          props.classId,
          { kind: "reports", after: page },
          reportsSchema,
          abort.current.signal,
        );
        if (valid()) setData(v);
      } else {
        const v = await client(
          props.classId,
          { kind: "report", reportId: selectedReport },
          reportSchema,
          abort.current.signal,
        );
        if (valid()) setReport(v);
      }
      setError((previous) => (valid() ? false : previous));
    } catch {
      setError((previous) => (valid() ? true : previous));
    }
  }, [props.kind, props.classId, props.visible, client, selectedReport, page]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (props.kind !== "progress") void load();
    }, 15000);
    const onVisibility = () => {
      void load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      ++sequence.current;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load, props.kind]);
  useEffect(() => {
    const controller = abort.current;
    return () => {
      controller.abort();
      if (props.kind === "map")
        void client(
          props.classId,
          { kind: "map", viewerId: viewer.current, visible: false },
          mapSchema,
          new AbortController().signal,
        ).catch(() => undefined);
    };
  }, [client, props.classId, props.kind]);
  async function action(input: object): Promise<void> {
    setBusy(true);
    setError(false);
    setNotice(null);
    try {
      const result = await client(
        props.classId,
        input,
        z.union([reportSchema, progressSchema]),
        abort.current.signal,
      );
      if (abort.current.signal.aborted) return;
      if (props.kind === "reports") {
        const parsed = reportSchema.parse(result);
        setSelectedReport(parsed.id);
        setReport(parsed);
      } else await load();
    } catch (failure) {
      if (!abort.current.signal.aborted) {
        const refusal =
          failure instanceof UsageHealthRequestError ? refusalOf(failure.status) : null;
        setNotice(refusal);
        setError(refusal === null);
      }
    } finally {
      if (!abort.current.signal.aborted) setBusy(false);
    }
  }
  return {
    m,
    client,
    abort,
    error,
    setError,
    busy,
    notice,
    data,
    setData,
    page,
    setPage,
    selectedReport,
    setSelectedReport,
    report,
    setReport,
    from,
    setFrom,
    to,
    setTo,
    load,
    action,
  };
}
