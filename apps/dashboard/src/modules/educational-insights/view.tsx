import { useEffect, useRef, useState } from "react";
import { insightsMessages } from "./messages.js";
import { useInsightModel, type InsightViewProps } from "./model.js";
import { MapView } from "./map-view.js";
import { ProgressView } from "./progress-view.js";
import { ReportsView } from "./reports-view.js";
export type { InsightViewProps } from "./model.js";
export function InsightView(props: InsightViewProps) {
  const m = insightsMessages(props.locale);
  const element = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (props.kind !== "map" || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      setVisible(entries.some((entry) => entry.isIntersecting));
    });
    if (element.current !== null) observer.observe(element.current);
    return () => {
      observer.disconnect();
    };
  }, [props.kind]);
  return (
    <section className="educational-insight" ref={element}>
      <h2>{m[props.kind]}</h2>
      {props.classId === null ? (
        <p>{m.selectClass}</p>
      ) : (
        <InsightContent
          key={`${props.classId}:${props.kind}`}
          {...props}
          visible={visible}
          classId={props.classId}
        />
      )}
    </section>
  );
}
function InsightContent(props: InsightViewProps & { readonly classId: string }) {
  const model = useInsightModel(props);
  const { error, m, busy, load } = model;
  const shared = (
    <>
      {error && <p role="alert">{m.error}</p>}
      <button type="button" disabled={busy} onClick={() => void load()}>
        {m.refresh}
      </button>
    </>
  );
  const Component =
    props.kind === "map" ? MapView : props.kind === "progress" ? ProgressView : ReportsView;
  return <Component model={model} props={props} shared={shared} />;
}
