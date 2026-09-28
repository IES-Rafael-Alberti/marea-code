import { ClassSessionsResponseSchema, ActiveRunDashboardResponseSchema } from "@marea/protocol";
import { isValidElement, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DashboardApp, type DashboardAppProperties } from "./dashboard-app.js";
import { signedOutSession } from "./modules/session/sign-in.fixture.js";
import { getDashboardMessages, selectDashboardLocale } from "./messages.js";
import type { ActiveRunsClient } from "./modules/active-runs/active-runs-client.boundary.js";
import { startDashboard } from "./start-dashboard.js";
import { ActiveRunsModule } from "./modules/active-runs/active-runs-module.js";
import { formatDateTime } from "@marea/i18n";
import { evaluationClientFixture } from "./modules/evaluation/evaluation.fixture.js";
import { reviewButton, reviewElements } from "./modules/evaluation/react-tree.fixture.js";
import {
  skillAuthoringClientFixture,
  skillAuthoringPropertiesFixture,
} from "./modules/skill-authoring/skill-authoring.fixture.js";
import { controllerClient } from "./modules/governance/governance-controller.fixture.js";
import {
  mockClient,
  classSummary,
  classesPage,
} from "./modules/teaching/teaching-controller.fixture.js";

const emptyResponse = ActiveRunDashboardResponseSchema.parse({
  kind: "active-runs-response",
  protocolVersion: "0.1",
  requestId: "request:dashboard",
  generatedAt: "2026-09-03T08:00:00.000Z",
  viewer: { role: "teacher", displayName: "Ada" },
  runs: [],
  nextCursor: null,
});

const activeResponse = ActiveRunDashboardResponseSchema.parse({
  ...emptyResponse,
  runs: [
    {
      runId: "run:one",
      studentDisplayName: "Lin",
      classDisplayName: "Computing",
      projectDisplayName: "Sea Garden",
      state: "active",
      startedAt: "2026-09-03T08:00:00.000Z",
      lastActivityAt: "2026-09-03T08:01:00.000Z",
      highestDurableSequence: 3,
      pendingApproval: true,
    },
    {
      runId: "run:two",
      studentDisplayName: "Sam",
      classDisplayName: "Computing",
      projectDisplayName: "Weather Clock",
      state: "active",
      startedAt: "2026-09-03T08:00:00.000Z",
      lastActivityAt: "2026-09-03T08:02:00.000Z",
      highestDurableSequence: 1,
      pendingApproval: false,
    },
  ],
});

function createRootRecorder(): {
  readonly rendered: ReactNode[];
  readonly root: Root;
  readonly unmount: ReturnType<typeof vi.fn>;
} {
  const rendered: ReactNode[] = [];
  const unmount = vi.fn();
  return {
    rendered,
    unmount,
    root: {
      render: (children): void => {
        rendered.push(children);
      },
      unmount,
    },
  };
}

function createDocument(root: HTMLElement | null): Document {
  return {
    documentElement: { lang: "" },
    getElementById: (id: string): HTMLElement | null => (id === "root" ? root : null),
  } as Document;
}

function client(result: "failed" | "ready"): ActiveRunsClient {
  return {
    load: () =>
      result === "ready" ? Promise.resolve(emptyResponse) : Promise.reject(new Error("offline")),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("dashboard localization", () => {
  it("selects English from a case-insensitive language tag", () => {
    expect(selectDashboardLocale("EN-gb")).toBe("en");
    expect(getDashboardMessages("en")).toEqual({
      activeRunsHeading: "Active sessions",
      activeRunsLoading: "Loading active sessions",
      activeRunsError: "Active sessions could not be loaded",
      activeRunsEmpty: "Waiting for active sessions",
      approvalPending: "Approval pending",
      classLabel: "Class",
      eyebrow: "Teacher dashboard",
      heading: "Class activity",
      lastActivityLabel: "Last activity",
      projectLabel: "Project",
      studentLabel: "Student",
      languageLabel: "Interface language",
      languageOptions: { automatic: "Automatic", es: "Castellano", en: "English", eu: "Euskara" },
      languageSaveFailed:
        "The interface language could not be saved. It is active for this session only.",
      mainNavigation: "Main navigation",
      navigation: {
        sessions: "Sessions",
        teaching: "Teaching",
        skills: "Skills",
        administration: "Administration",
      },
    });
  });

  it("uses Spanish for Spanish and unsupported languages", () => {
    expect(selectDashboardLocale("es-ES")).toBe("es");
    expect(selectDashboardLocale("fr-FR")).toBe("es");
    expect(getDashboardMessages("es")).toEqual({
      activeRunsHeading: "Sesiones activas",
      activeRunsLoading: "Cargando sesiones activas",
      activeRunsError: "No se han podido cargar las sesiones activas",
      activeRunsEmpty: "Esperando sesiones activas",
      approvalPending: "Aprobación pendiente",
      classLabel: "Clase",
      eyebrow: "Panel docente",
      heading: "Actividad de clase",
      lastActivityLabel: "Última actividad",
      projectLabel: "Proyecto",
      studentLabel: "Estudiante",
      languageLabel: "Idioma de la interfaz",
      languageOptions: { automatic: "Automático", es: "Castellano", en: "English", eu: "Euskara" },
      languageSaveFailed:
        "No se ha podido guardar el idioma de la interfaz. Solo estará activo durante esta sesión.",
      mainNavigation: "Navegación principal",
      navigation: {
        sessions: "Sesiones",
        teaching: "Enseñanza",
        skills: "Skills",
        administration: "Administración",
      },
    });
  });
});

describe("DashboardApp", () => {
  it("formats active runs in Spanish when the standalone module has no locale", () => {
    const html = renderToStaticMarkup(
      <ActiveRunsModule
        messages={getDashboardMessages("es")}
        state={{ status: "ready", response: activeResponse }}
      />,
    );
    expect(html).toContain(formatDateTime("es", "2026-09-03T08:01:00.000Z"));
  });
  it("ignores an unsupported selector value without changing the preference", () => {
    const onPreferenceChange = vi.fn();
    const tree = DashboardApp({ locale: "es", onPreferenceChange, session: signedOutSession });
    const select = reviewElements(tree).find((element) => element.type === "select");
    if (select === undefined) throw new Error("Missing interface language selector");
    select.props.onChange?.({ currentTarget: { value: "unsupported" } });
    expect(onPreferenceChange).not.toHaveBeenCalled();
    select.props.onChange?.({ currentTarget: { value: "en" } });
    expect(onPreferenceChange).toHaveBeenCalledWith("en");
  });

  it("renders loading, failure, and empty module states", () => {
    const loading = renderToStaticMarkup(<DashboardApp locale="es" />);
    const failed = renderToStaticMarkup(<DashboardApp locale="en" state={{ status: "failed" }} />);
    const empty = renderToStaticMarkup(
      <DashboardApp locale="en" state={{ response: emptyResponse, status: "ready" }} />,
    );

    expect(loading).toContain("Cargando sesiones activas");
    expect(loading).toContain('aria-live="polite"');
    expect(failed).toContain("Active sessions could not be loaded");
    expect(empty).toContain("Waiting for active sessions");
    expect(
      renderToStaticMarkup(
        <DashboardApp locale="eu" languageSaveWarning session={signedOutSession} />,
      ),
    ).toContain("Ezin izan da interfazearen hizkuntza gorde");
  });

  it("renders active runs and pending approvals", () => {
    const html = renderToStaticMarkup(
      <DashboardApp locale="en" state={{ response: activeResponse, status: "ready" }} />,
    );

    expect(html).toContain("Lin");
    expect(html).toContain("Sea Garden");
    expect(html).toContain("Weather Clock");
    expect(html).toContain("Approval pending");
    expect(html.match(/Approval pending/gu)).toHaveLength(1);
  });

  it("renders the composed authoring module when supplied", () => {
    const authoring = skillAuthoringPropertiesFixture();
    const html = renderToStaticMarkup(<DashboardApp locale="en" authoring={authoring} />);
    expect(html).toContain("Skill authoring");
    expect(renderToStaticMarkup(<DashboardApp locale="en" />)).not.toContain("Skill authoring");
  });
});

describe("startDashboard", () => {
  it("loads, renders and disposes the composed administration controller", async () => {
    const recorder = createRootRecorder();
    const governance = controllerClient();
    const handle = startDashboard(
      { document: createDocument({} as HTMLElement), language: "en" },
      client("ready"),
      () => recorder.root,
      undefined,
      undefined,
      undefined,
      governance,
    );
    await handle.ready;
    expect(renderToStaticMarkup(recorder.rendered.at(-1))).toContain("Center administration");
    expect(governance.centers).toHaveBeenCalledOnce();
    handle.dispose();
    expect((governance.access.mock.calls[0]?.[0] as AbortSignal | undefined)?.aborted).toBe(true);
  });

  it("mounts teaching independently of active runs and disposes its requests", async () => {
    const recorder = createRootRecorder();
    const teaching = mockClient();
    teaching.classes.mockResolvedValue(classesPage([classSummary()]));
    const handle = startDashboard(
      { document: createDocument({} as HTMLElement), language: "en" },
      client("failed"),
      () => recorder.root,
      undefined,
      teaching,
    );
    await handle.ready;
    expect(renderToStaticMarkup(recorder.rendered.at(-1))).toContain(
      "Class teaching configuration",
    );
    expect(renderToStaticMarkup(recorder.rendered.at(-1))).toContain("Physics");
    expect(teaching.classes).toHaveBeenCalledOnce();
    reviewButton(reviewElements(recorder.rendered.at(-1)), "Reload classes").props.onClick?.();
    await vi.waitFor(() => {
      expect(renderToStaticMarkup(recorder.rendered.at(-1))).toContain("Physics");
    });
    expect(teaching.classes).toHaveBeenCalledTimes(2);
    handle.dispose();
    expect(teaching.classes.mock.calls[0]?.[1].aborted).toBe(true);
    expect(recorder.unmount).toHaveBeenCalledOnce();
  });
  it("loads and disposes the composed authoring controller", async () => {
    const recorder = createRootRecorder();
    const handle = startDashboard(
      { document: createDocument({} as HTMLElement), language: "en" },
      client("ready"),
      () => recorder.root,
      undefined,
      undefined,
      skillAuthoringClientFixture(),
    );
    await handle.ready;
    expect(renderToStaticMarkup(recorder.rendered.at(-1))).toContain("Skill authoring");
    handle.dispose();
    expect(recorder.unmount).toHaveBeenCalledOnce();
  });
  it("mounts the evaluation controller, rerenders its results and disposes its requests", async () => {
    const recorder = createRootRecorder();
    const evaluation = evaluationClientFixture();
    const handle = startDashboard(
      { document: createDocument({} as HTMLElement), language: "en" },
      client("ready"),
      () => recorder.root,
      evaluation,
    );
    await handle.ready;
    expect(renderToStaticMarkup(recorder.rendered.at(-1))).toContain("Session evaluation");
    reviewButton(reviewElements(recorder.rendered.at(-1)), "Load sessions").props.onClick?.();
    await vi.waitFor(() => {
      expect(renderToStaticMarkup(recorder.rendered.at(-1))).toContain("Boundary tests");
    });
    expect(evaluation.sessions).toHaveBeenCalledOnce();
    handle.dispose();
    expect(evaluation.sessions.mock.calls[0]?.[1].aborted).toBe(true);
    expect(recorder.unmount).toHaveBeenCalledOnce();
  });

  it("does not render a late response after unmounting, with or without evaluation enabled", async () => {
    const recorder = createRootRecorder();
    const pending = Promise.withResolvers<typeof emptyResponse>();
    const handle = startDashboard(
      { document: createDocument({} as HTMLElement), language: "en" },
      { load: () => pending.promise },
      () => recorder.root,
    );
    handle.dispose();
    pending.resolve(emptyResponse);
    await handle.ready;
    expect(recorder.rendered).toHaveLength(1);
    expect(recorder.unmount).toHaveBeenCalledOnce();
  });
  it("mounts loading and loaded states", async () => {
    const container = {} as HTMLElement;
    const document = createDocument(container);
    const recorder = createRootRecorder();

    const handle = startDashboard(
      { document, language: "en-US" },
      client("ready"),
      (receivedContainer): Root => {
        expect(receivedContainer).toBe(container);
        return recorder.root;
      },
    );
    await handle.ready;

    expect(handle.root).toBe(recorder.root);
    expect(document.documentElement.lang).toBe("en");
    expect(recorder.rendered).toHaveLength(2);
    expect(renderToStaticMarkup(recorder.rendered[0])).toContain("Loading active sessions");
    expect(renderToStaticMarkup(recorder.rendered[1])).toContain("Waiting for active sessions");
    expect(renderToStaticMarkup(recorder.rendered[1])).not.toContain("Session evaluation");
  });

  it("renders a failure returned by the client", async () => {
    const recorder = createRootRecorder();
    const handle = startDashboard(
      { document: createDocument({} as HTMLElement), language: "es" },
      client("failed"),
      () => recorder.root,
    );

    await handle.ready;

    expect(recorder.rendered).toHaveLength(2);
    expect(renderToStaticMarkup(recorder.rendered[1])).toContain(
      "No se han podido cargar las sesiones activas",
    );
  });

  it("fails when the release document has no mount point", () => {
    expect(() =>
      startDashboard(
        { document: createDocument(null), language: "es" },
        client("ready"),
        () => createRootRecorder().root,
      ),
    ).toThrow("Dashboard root element is missing.");
  });
});
it("preserves mounted modules while switching task navigation", async () => {
  const recorder = createRootRecorder();
  const handle = startDashboard(
    { document: createDocument({} as HTMLElement), language: "es" },
    client("ready"),
    () => recorder.root,
  );
  await handle.ready;
  const elements = () => reviewElements(recorder.rendered.at(-1));
  reviewButton(elements(), "Enseñanza").props.onClick?.();
  expect(renderToStaticMarkup(recorder.rendered.at(-1))).toContain('aria-current="page">Enseñanza');
  reviewButton(elements(), "Skills").props.onClick?.();
  expect(renderToStaticMarkup(recorder.rendered.at(-1))).toContain('aria-current="page">Skills');
  reviewButton(elements(), "Sesiones").props.onClick?.();
  expect(renderToStaticMarkup(recorder.rendered.at(-1))).toContain('aria-current="page">Sesiones');
  reviewButton(reviewElements(<DashboardApp locale="en" />), "Teaching").props.onClick?.();
  handle.dispose();
});

it("changes the document language and stores the preference without restarting modules", async () => {
  const document = createDocument({} as HTMLElement);
  const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };
  const recorder = createRootRecorder();
  const load = vi.fn().mockResolvedValue(emptyResponse);
  const activeRuns: ActiveRunsClient = { load };
  const handle = startDashboard(
    { document, language: "en-US", storage },
    activeRuns,
    () => recorder.root,
  );
  await handle.ready;
  const rendered = recorder.rendered.at(-1);
  if (!isValidElement<DashboardAppProperties>(rendered)) throw new Error("Missing dashboard app");
  rendered.props.onPreferenceChange?.("eu");
  expect(document.documentElement.lang).toBe("eu");
  expect(storage.setItem).toHaveBeenCalledWith("marea.dashboard.interface-language.v1", "eu");
  expect(load).toHaveBeenCalledOnce();
  handle.dispose();
});

it("warns when a language change cannot persist because storage is unavailable", async () => {
  const document = createDocument({} as HTMLElement);
  const recorder = createRootRecorder();
  const load = vi.fn().mockResolvedValue(emptyResponse);
  const handle = startDashboard(
    { document, language: "en-US", storage: undefined },
    { load },
    () => recorder.root,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      current: vi.fn().mockResolvedValue({ status: "signed-out" }),
      signIn: vi.fn(),
      signOut: vi.fn(),
    },
  );
  try {
    await handle.ready;
    const rendered = recorder.rendered.at(-1);
    if (!isValidElement<DashboardAppProperties>(rendered)) throw new Error("Missing dashboard app");
    expect(rendered.props.languageSaveWarning).toBe(false);
    rendered.props.onPreferenceChange?.("es");
    expect(document.documentElement.lang).toBe("es");
    expect(renderToStaticMarkup(recorder.rendered.at(-1))).toContain(
      "No se ha podido guardar el idioma de la interfaz. Solo estará activo durante esta sesión.",
    );
    expect(load).not.toHaveBeenCalled();
  } finally {
    handle.dispose();
  }
});

it("composes a session workspace without a teaching editor and disposes its polling", async () => {
  const recorder = createRootRecorder();
  const workspaceClient = {
    ...evaluationClientFixture(),
    classes: vi.fn().mockResolvedValue(
      ClassSessionsResponseSchema.parse({
        kind: "class-sessions-response",
        protocolVersion: "0.1",
        requestId: "request:one",
        runs: [],
        nextBeforeRunId: null,
      }),
    ),
  };
  const handle = startDashboard(
    { document: createDocument({} as HTMLElement), language: "es" },
    client("ready"),
    () => recorder.root,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { publish: vi.fn(), query: vi.fn() },
    workspaceClient,
  );
  await handle.ready;
  expect(renderToStaticMarkup(recorder.rendered.at(-1))).toContain(
    "Selecciona una sesión para seguir la conversación",
  );
  expect(workspaceClient.classes).toHaveBeenCalledOnce();
  handle.dispose();
});
