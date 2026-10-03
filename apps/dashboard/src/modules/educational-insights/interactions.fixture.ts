import { Children, isValidElement, type ReactNode, type ReactElement } from "react";
import { vi } from "vitest";
import { insightsMessages } from "./messages.js";
import { insightsClient } from "./client.js";
import type { useInsightModel, InsightViewProps } from "./model.js";
interface Props {
  children?: ReactNode;
  disabled?: boolean;
  value?: string | number;
  onClick?: () => void;
  onChange?: (event: { currentTarget: { value: string; checked: boolean } }) => void;
  onSubmit?: (event: { preventDefault: () => void }) => void;
  open?: boolean;
  student?: { displayName: string };
  model?: object;
  props?: object;
}
export function elements(node: ReactNode): ReactElement<Props>[] {
  return Children.toArray(node).flatMap((child) => {
    if (!isValidElement<Props>(child)) return [];
    return [child, ...elements(child.props.children)];
  });
}
export function button(node: ReactNode, label: string) {
  const found = elements(node).find((e) => e.type === "button" && e.props.children === label);
  if (!found) throw new Error(`Missing button ${label}`);
  return found.props;
}
export const props: InsightViewProps & { classId: string } = {
  kind: "map",
  classId: "class:a",
  locale: "es",
  fetchRequest: vi.fn(),
  navigate: vi.fn().mockResolvedValue(true),
};
export function model(): ReturnType<typeof useInsightModel> {
  return {
    m: insightsMessages("es"),
    client: insightsClient(vi.fn()),
    abort: { current: new AbortController() },
    error: false,
    setError: vi.fn(),
    busy: false,
    data: null,
    setData: vi.fn(),
    page: null,
    setPage: vi.fn(),
    selectedReport: null,
    setSelectedReport: vi.fn(),
    report: null,
    setReport: vi.fn(),
    from: "2026-09-27T00:00",
    setFrom: vi.fn(),
    to: "2026-09-28T00:00",
    setTo: vi.fn(),
    load: vi.fn().mockResolvedValue(undefined),
    action: vi.fn().mockResolvedValue(undefined),
  };
}
export const criterion = {
  key: "key",
  skillId: "skill",
  code: "C1",
  statement: "Test boundaries",
  level: 2,
  levels: ["One", "Two", "Three", "Four"],
  epoch: 0,
};
export const report = {
  id: "report",
  state: "complete",
  from: "from",
  to: "to",
  completed: 1,
  total: 1,
  students: [{ alias: "A", displayName: "Ana" }],
  result: null,
};
