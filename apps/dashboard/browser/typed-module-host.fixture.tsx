import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { TypedDashboardModuleBrowserEntry } from "@marea/plugin-api/browser";
import { ModulePlugin, type ModuleAdapter } from "../src/profiles/module-plugin.js";
import { SessionPlugin } from "../src/profiles/session-plugin.js";
import { bindDashboardModule } from "../src/profiles/typed-module-host.js";
import { sessionPorts } from "./typed-host-data.fixture.js";
import type { SessionsController } from "../src/modules/sessions/sessions-controller.js";
import { dashboardThemeLoaders } from "@marea/plugin-runtime/browser";
import { themeProperties } from "../src/profiles/theme.js";
import type { DashboardLocale } from "../src/messages.js";

let session: SessionsController | null = null;
let original: SessionsController | null = null;
const register = (value: SessionsController | null) => {
  session = value;
};
const counts = { mounts: 0, stops: 0, aborted: 0, late: 0 };
const pending: (() => void)[] = [];
const library: TypedDashboardModuleBrowserEntry<
  object,
  { shelf: string },
  { shelf: number },
  { read: boolean }
> = {
  mount(element, context) {
    counts.mounts++;
    const input = document.createElement("input");
    input.setAttribute("aria-label", "Library draft");
    element.replaceChildren(input);
    void context.data
      .read(context.signal)
      .then((data) => {
        counts.late++;
        input.value = data.shelf;
      })
      .catch(() => undefined);
    return () => {
      counts.stops++;
      element.replaceChildren();
    };
  },
};
const adapter: ModuleAdapter = (selection) =>
  bindDashboardModule(
    () => Promise.resolve({ default: library }),
    (environment) => ({
      ...environment,
      settings: selection.settings,
      placement: selection.placement,
      capabilities: { read: true },
      message: (key) => key,
      navigation: { navigate: () => Promise.resolve(false) },
      data: {
        read: (signal) =>
          new Promise((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                counts.aborted++;
              },
              { once: true },
            );
            pending.push(() => {
              resolve({ shelf: `late:${environment.classId ?? "none"}` });
            });
          }),
      },
    }),
  );
const selection = {
  moduleId: "org.marea.module.sessions",
  configurationVersion: 1,
  enabled: true,
  settings: {},
  placement: { slot: "main", size: "wide" },
} as const;
function Fixture() {
  const [layout, setLayout] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [signedIn, setSignedIn] = useState(true);
  const [classId, setClass] = useState("class:a");
  const [status, setStatus] = useState("");
  const locale: DashboardLocale =
    new URL(location.href).searchParams.get("locale") === "eu"
      ? "eu"
      : new URL(location.href).searchParams.get("locale") === "es"
        ? "es"
        : "en";
  const module = {
    ...selection,
    placement: layout ? ({ slot: "aside", size: "compact" } as const) : selection.placement,
  };
  return (
    <>
      <button
        onClick={() => {
          setLayout(!layout);
        }}
      >
        Layout
      </button>
      <button
        onClick={() => {
          void dashboardThemeLoaders["org.marea.theme.high-contrast"]().then(
            ({ default: theme }) => {
              for (const [key, value] of Object.entries(themeProperties(theme.tokens)))
                document.documentElement.style.setProperty(key, value);
            },
          );
        }}
      >
        Theme
      </button>
      <button
        onClick={() => {
          setEnabled(!enabled);
        }}
      >
        Toggle
      </button>
      <button
        onClick={() => {
          setClass("class:b");
        }}
      >
        Class
      </button>
      <button
        onClick={() => {
          setSignedIn(false);
        }}
      >
        Logout
      </button>
      <button
        onClick={() => {
          for (const resolve of pending.splice(0)) resolve();
        }}
      >
        Resolve late
      </button>
      <button
        onClick={() => {
          void (async () => {
            if (session === null) throw new Error("No session");
            original = session;
            await session.select("run:synthetic");
            await session.openEvaluation();
            session.notice?.edit("Synthetic notice draft");
            const review = session.review;
            if (review?.state.draft == null) throw new Error("No draft");
            review.edit({ ...review.state.draft, teacherNote: "Synthetic evaluation draft" });
            setStatus("seeded");
          })();
        }}
      >
        Seed drafts
      </button>
      <button
        onClick={() => {
          setStatus(
            JSON.stringify({
              ...counts,
              same: original === session,
              notice: session?.notice?.state.draft,
              evaluation: session?.review?.state.draft?.teacherNote,
              run: session?.state.runId,
            }),
          );
        }}
      >
        Inspect
      </button>
      <output>{status}</output>
      {signedIn && enabled && (
        <>
          <SessionPlugin
            module={module}
            classId={classId}
            locale={locale}
            classes={[]}
            ports={sessionPorts}
            register={register}
          />
          <ModulePlugin
            module={{ ...module, moduleId: "synthetic.library" }}
            adapter={adapter}
            classId={classId}
            locale={locale}
          />
        </>
      )}
    </>
  );
}
const target = document.getElementById("root");
if (target === null) throw new Error("missing fixture root");
createRoot(target).render(<Fixture />);
