import { Children, isValidElement, type FunctionComponent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RunClosureError, type RunClosureClient } from "./run-closure-client.boundary.js";
import { runClosureMessages } from "./run-closure-messages.js";

type Slot = object | string | number | boolean | null;
const hooks = vi.hoisted(() => ({
  values: [] as Slot[],
  index: 0,
  refs: [] as { current: Slot }[],
  refIndex: 0,
  effects: [] as (() => undefined | (() => void))[],
  dependencies: [] as (readonly Slot[] | undefined)[],
  renders: 0,
}));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: Slot) => {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [
      hooks.values[index],
      (value: Slot | ((previous: Slot) => Slot)) => {
        hooks.values[index] =
          typeof value === "function"
            ? (value as (previous: Slot) => Slot)(hooks.values[index] ?? null)
            : value;
        hooks.renders += 1;
      },
    ];
  },
  useRef: (initial: Slot) => {
    const index = hooks.refIndex++;
    return (hooks.refs[index] ??= { current: initial });
  },
  useEffect: (effect: () => undefined | (() => void), dependencies?: readonly Slot[]) => {
    hooks.effects.push(effect);
    hooks.dependencies.push(dependencies);
  },
}));

import { ClosureFlow } from "./run-closure-flow.js";
import {
  EndClassSessionsControl,
  EndSessionControl,
  type ClosableRun,
} from "./run-closure-controls.js";

interface Host {
  type: string;
  props: {
    children?: ReactNode;
    onClick?: () => void;
    onKeyDown?: (event: { key: string }) => void;
    disabled?: boolean;
    role?: string;
    className?: string;
    "aria-modal"?: string;
    "aria-labelledby"?: string;
    "aria-describedby"?: string;
  };
}

/** Expands function components so a rendered tree can be searched like a page. */
function expand(node: ReactNode): Host[] {
  return Children.toArray(node).flatMap((child) => {
    if (!isValidElement<Host["props"]>(child)) return [];
    if (typeof child.type === "function") {
      return expand((child.type as FunctionComponent<Host["props"]>)(child.props) as ReactNode);
    }
    return [{ type: child.type, props: child.props }, ...expand(child.props.children)];
  });
}

const text = (host: Host): string =>
  Children.toArray(host.props.children)
    .map((child) => (typeof child === "string" ? child : ""))
    .join("");

function page(component: () => ReactNode) {
  const draw = () => {
    hooks.index = 0;
    hooks.refIndex = 0;
    hooks.effects = [];
    hooks.dependencies = [];
    return expand(component());
  };
  return {
    draw,
    button: (label: string) => {
      const found = draw().find((host) => host.type === "button" && text(host) === label);
      if (found === undefined) throw new Error(`Missing button ${label}`);
      return found.props;
    },
    has: (label: string) => draw().some((host) => host.type === "button" && text(host) === label),
    texts: () =>
      draw()
        .map(text)
        .filter((entry) => entry !== ""),
  };
}

const m = runClosureMessages("en");
const ana = { runId: "run:ana", studentDisplayName: "Ana", pendingApproval: true };
const ben = { runId: "run:ben", studentDisplayName: "Ben", pendingApproval: false };
const cy = { runId: "run:cy", studentDisplayName: "Cy" };
const dee = { runId: "run:dee", studentDisplayName: "Dee", pendingApproval: true };

function client() {
  const closeRun = vi.fn();
  const closeClassRuns = vi.fn();
  closeRun.mockResolvedValue({});
  closeClassRuns.mockResolvedValue({});
  const closures: RunClosureClient = { closeRun, closeClassRuns };
  return { closures, closeRun, closeClassRuns };
}

beforeEach(() => {
  hooks.values = [];
  hooks.refs = [];
  hooks.renders = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("ending one session", () => {
  it("shows no dialog until asked, then names the student and warns about a pending approval", () => {
    const { closures, closeRun } = client();
    const onClosed = vi.fn();
    const view = page(() => (
      <EndSessionControl client={closures} locale="en" run={ana} onClosed={onClosed} />
    ));
    expect(view.texts()).toEqual([m.endSession]);
    view.button(m.endSession).onClick?.();
    const texts = view.texts();
    expect(texts).toContain(m.oneTitle);
    expect(texts).toContain(m.oneBody("Ana"));
    expect(texts).toContain(m.onePending("Ana"));
    expect(texts).toContain(m.evaluationNote);
    expect(texts).toContain(m.cancel);
    expect(texts).toContain(m.confirmOne);
    const dialog = view.draw().find((host) => host.props.role === "alertdialog");
    expect(dialog?.props["aria-modal"]).toBe("true");
    expect(dialog?.props["aria-labelledby"]).toBe("close-run:ana-title");
    expect(dialog?.props["aria-describedby"]).toBe("close-run:ana-body");
    expect(closeRun).not.toHaveBeenCalled();
  });

  it("does not warn when no approval is pending or the view cannot tell", () => {
    for (const run of [ben, cy]) {
      hooks.values = [];
      hooks.refs = [];
      const view = page(() => (
        <EndSessionControl client={client().closures} locale="en" run={run} onClosed={vi.fn()} />
      ));
      view.button(m.endSession).onClick?.();
      expect(view.texts()).toContain(m.oneBody(run.studentDisplayName));
      expect(view.texts()).not.toContain(m.onePending(run.studentDisplayName));
    }
  });

  it("cancels with the button or Escape and never closes anything", () => {
    const { closures, closeRun } = client();
    const view = page(() => (
      <EndSessionControl client={closures} locale="en" run={ana} onClosed={vi.fn()} />
    ));
    view.button(m.endSession).onClick?.();
    view.button(m.cancel).onClick?.();
    expect(view.has(m.cancel)).toBe(false);
    view.button(m.endSession).onClick?.();
    const dialog = view.draw().find((host) => host.props.role === "alertdialog");
    dialog?.props.onKeyDown?.({ key: "Enter" });
    expect(view.has(m.cancel)).toBe(true);
    dialog?.props.onKeyDown?.({ key: "Escape" });
    expect(view.has(m.cancel)).toBe(false);
    expect(closeRun).not.toHaveBeenCalled();
  });

  it("ends the run once confirmed, disables the dialog while waiting, and tells the host", async () => {
    const { closures, closeRun } = client();
    const release = Promise.withResolvers<object>();
    closeRun.mockReturnValue(release.promise);
    const onClosed = vi.fn();
    const view = page(() => (
      <EndSessionControl client={closures} locale="en" run={ana} onClosed={onClosed} />
    ));
    view.button(m.endSession).onClick?.();
    view.button(m.confirmOne).onClick?.();
    expect(closeRun).toHaveBeenCalledWith(
      "run:ana",
      expect.stringMatching(/^close:/u),
      expect.any(AbortSignal),
    );
    expect(view.button(m.ending).disabled).toBe(true);
    expect(view.button(m.cancel).disabled).toBe(true);
    expect(onClosed).not.toHaveBeenCalled();
    release.resolve({});
    await vi.waitFor(() => {
      expect(onClosed).toHaveBeenCalledTimes(1);
    });
    expect(view.has(m.cancel)).toBe(false);
  });

  it("reports a failure inside the dialog and retries the same request key", async () => {
    const { closures, closeRun } = client();
    closeRun.mockRejectedValueOnce(new Error("offline"));
    const onClosed = vi.fn();
    const view = page(() => (
      <EndSessionControl client={closures} locale="en" run={ana} onClosed={onClosed} />
    ));
    view.button(m.endSession).onClick?.();
    view.button(m.confirmOne).onClick?.();
    await vi.waitFor(() => {
      expect(view.texts()).toContain(m.failed);
    });
    expect(view.draw().some((host) => host.props.role === "alert")).toBe(true);
    expect(view.button(m.confirmOne).disabled).toBe(false);
    expect(onClosed).not.toHaveBeenCalled();
    view.button(m.confirmOne).onClick?.();
    await vi.waitFor(() => {
      expect(onClosed).toHaveBeenCalledTimes(1);
    });
    expect(closeRun.mock.calls[1]?.[1]).toBe(closeRun.mock.calls[0]?.[1]);
    expect(view.texts()).not.toContain(m.failed);
  });

  it.each([
    [new RunClosureError({ kind: "offline" }), m.offline],
    [new RunClosureError({ kind: "unavailable" }), m.unavailable],
    [new RunClosureError({ kind: "forbidden" }), m.forbidden],
    [new RunClosureError({ kind: "expired" }), m.expired],
    [
      new RunClosureError({ kind: "server", requestId: "request:abc" }),
      m.serverFailed("request:abc"),
    ],
    [new RunClosureError(), m.failed],
  ])("shows a distinct message for each failure: %#", async (error, text) => {
    const { closures, closeRun } = client();
    closeRun.mockRejectedValueOnce(error);
    const view = page(() => (
      <EndSessionControl client={closures} locale="en" run={ana} onClosed={vi.fn()} />
    ));
    view.button(m.endSession).onClick?.();
    view.button(m.confirmOne).onClick?.();
    await vi.waitFor(() => {
      expect(view.texts()).toContain(text);
    });
  });

  it("uses the latest host callbacks and aborts a pending request when unmounted", () => {
    const { closures, closeRun } = client();
    closeRun.mockReturnValue(new Promise(() => undefined));
    const view = page(() => (
      <EndSessionControl client={closures} locale="en" run={ana} onClosed={vi.fn()} />
    ));
    view.button(m.endSession).onClick?.();
    view.button(m.confirmOne).onClick?.();
    const signal = closeRun.mock.calls[0]?.[2] as AbortSignal;
    const cleanup = hooks.effects.map((effect) => effect());
    expect(signal.aborted).toBe(false);
    for (const dispose of cleanup) dispose?.();
    expect(signal.aborted).toBe(true);
  });

  it("redraws when a confirmation opens and keeps the flow as the effect dependency", () => {
    const view = page(() => (
      <EndSessionControl client={client().closures} locale="en" run={ana} onClosed={vi.fn()} />
    ));
    view.button(m.endSession).onClick?.();
    expect(hooks.values[0]).toBe(1);
    expect(hooks.dependencies[0]?.[0]).toBeInstanceOf(ClosureFlow);
  });

  it("is a plain button in server-rendered markup", () => {
    expect(
      renderToStaticMarkup(
        <EndSessionControl client={client().closures} locale="es" run={ana} onClosed={vi.fn()} />,
      ),
    ).toContain(runClosureMessages("es").endSession);
  });
});

describe("ending all sessions of a class", () => {
  it("offers nothing when no run is open", () => {
    const view = page(() => (
      <EndClassSessionsControl
        client={client().closures}
        locale="en"
        classId="class:a"
        runs={[]}
        onClosed={vi.fn()}
      />
    ));
    expect(view.draw()).toEqual([]);
  });

  it("lists every student and warns only about the pending approvals", () => {
    const view = page(() => (
      <EndClassSessionsControl
        client={client().closures}
        locale="en"
        classId="class:a"
        runs={[ana, ben, cy, dee]}
        onClosed={vi.fn()}
      />
    ));
    view.button(m.endAllSessions).onClick?.();
    const texts = view.texts();
    expect(texts).toContain(m.classTitle(4));
    expect(texts).toContain(m.classBody);
    expect(texts).toContain("Ana");
    expect(texts).toContain("Ben");
    expect(texts).toContain("Cy");
    expect(texts).toContain("Dee");
    expect(texts).toContain(m.classPending("Ana, Dee"));
    expect(texts).toContain(m.confirmClass(4));
    const dialog = view.draw().find((host) => host.props.role === "alertdialog");
    expect(dialog?.props["aria-labelledby"]).toBe("close-class-class:a-title");
  });

  it("lists nobody before the dialog is opened with a run list", () => {
    const view = page(() => (
      <EndClassSessionsControl
        client={client().closures}
        locale="en"
        classId="class:a"
        runs={[ana]}
        onClosed={vi.fn()}
      />
    ));
    view.draw();
    (hooks.refs[1]?.current as ClosureFlow).open();
    expect(view.draw().some((host) => host.type === "li")).toBe(false);
  });

  it("shows no approval warning when nobody has one pending", () => {
    const view = page(() => (
      <EndClassSessionsControl
        client={client().closures}
        locale="en"
        classId="class:a"
        runs={[ben, cy]}
        onClosed={vi.fn()}
      />
    ));
    view.button(m.endAllSessions).onClick?.();
    expect(view.texts().some((entry) => entry.includes("approval pending"))).toBe(false);
    expect(view.draw().some((host) => host.props.className === "closure-warning")).toBe(false);
  });

  it("closes exactly the runs that were listed when the dialog opened, even if the page changes", async () => {
    const { closures, closeClassRuns } = client();
    const onClosed = vi.fn();
    let runs: ClosableRun[] = [ana, ben];
    const view = page(() => (
      <EndClassSessionsControl
        client={closures}
        locale="en"
        classId="class:a"
        runs={runs}
        onClosed={onClosed}
      />
    ));
    view.button(m.endAllSessions).onClick?.();
    runs = [ana, ben, cy];
    view.button(m.confirmClass(2)).onClick?.();
    expect(closeClassRuns).toHaveBeenCalledWith(
      "class:a",
      ["run:ana", "run:ben"],
      expect.stringMatching(/^close:/u),
      expect.any(AbortSignal),
    );
    await vi.waitFor(() => {
      expect(onClosed).toHaveBeenCalledTimes(1);
    });
  });

  it("can be cancelled without closing anything", () => {
    const { closures, closeClassRuns } = client();
    const view = page(() => (
      <EndClassSessionsControl
        client={closures}
        locale="en"
        classId="class:a"
        runs={[ana]}
        onClosed={vi.fn()}
      />
    ));
    view.button(m.endAllSessions).onClick?.();
    view.button(m.cancel).onClick?.();
    expect(view.has(m.cancel)).toBe(false);
    expect(closeClassRuns).not.toHaveBeenCalled();
  });
});
