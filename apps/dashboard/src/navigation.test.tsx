import { isValidElement, type ReactNode, type ReactElement } from "react";
import { expect, it, vi } from "vitest";
import { DashboardApp, type DashboardAppProperties } from "./dashboard-app.js";
import { startDashboard } from "./start-dashboard.js";
import { GovernanceController } from "./modules/governance/governance-controller.js";
import { controllerClient } from "./modules/governance/governance-controller.fixture.js";
import { reviewElements } from "./modules/evaluation/react-tree.fixture.js";
import { evaluationClientFixture } from "./modules/evaluation/evaluation.fixture.js";
import type { SessionsClient } from "./modules/sessions/sessions-client.boundary.js";
import type { NoticeClient } from "./modules/sessions/notice-client.boundary.js";

function syntheticBrowser() {
  const document: Partial<Document> = {
    getElementById: vi.fn<Document["getElementById"]>().mockReturnValue({} as HTMLElement),
    documentElement: { lang: "" } as HTMLElement,
  };
  return { document: document as Document, language: "en" };
}

interface NavigationProperties {
  readonly children?: ReactNode;
  readonly hidden?: boolean;
  readonly className?: string;
  readonly "aria-label"?: string;
  readonly "aria-current"?: string;
}
it.each(["es", "en", "eu"] as const)(
  "exposes only authorized %s tasks and exactly one active panel",
  async (locale) => {
    const controller = new GovernanceController(controllerClient(), vi.fn());
    await controller.load();
    const labels =
      locale === "es"
        ? ["Sesiones", "Enseñanza", "Skills", "Administración"]
        : locale === "eu"
          ? ["Saioak", "Irakaskuntza", "Skill-ak", "Administrazioa"]
          : ["Sessions", "Teaching", "Skills", "Administration"];
    const ids = ["sessions", "teaching", "skills", "administration"];
    for (const [index, section] of ids.entries()) {
      const app = (
        <DashboardApp
          locale={locale}
          navigation={{ section, select: vi.fn() }}
          governance={{ controller, state: controller.state }}
        />
      );
      const elements = reviewElements(app) as readonly ReactElement<NavigationProperties>[];
      const navigation = elements.find((element) => element.props.className === "task-navigation");
      expect(navigation?.props["aria-label"]).toBe(
        locale === "es"
          ? "Navegación principal"
          : locale === "eu"
            ? "Nabigazio nagusia"
            : "Main navigation",
      );
      const buttons = reviewElements(
        navigation?.props.children,
      ) as readonly ReactElement<NavigationProperties>[];
      expect(buttons.map((button) => button.props.children)).toEqual(labels);
      expect(buttons.map((button) => button.props["aria-current"])).toEqual(
        ids.map((_, current) => (current === index ? "page" : undefined)),
      );
      const panels = elements.filter(
        (element) => element.type === "div" && typeof element.props.hidden === "boolean",
      );
      expect(panels.map((panel) => panel.props.hidden)).toEqual(
        ids.map((_, current) => current !== index),
      );
    }
    const guest = reviewElements(
      <DashboardApp locale={locale} />,
    ) as readonly ReactElement<NavigationProperties>[];
    const guestNav = guest.find((element) => element.props.className === "task-navigation");
    const buttons = reviewElements(
      guestNav?.props.children,
    ) as readonly ReactElement<NavigationProperties>[];
    expect(buttons.map((button) => button.props.children)).toEqual(labels.slice(0, 3));
    expect(buttons.map((button) => button.props["aria-current"])).toEqual([
      "page",
      undefined,
      undefined,
    ]);
    controller.dispose();
  },
);
it.each([
  [true, false],
  [false, true],
  [true, true],
] as const)(
  "creates the workspace only with both read and notice clients (%s, %s)",
  async (hasRead, hasNotice) => {
    const read: SessionsClient = {
      ...evaluationClientFixture(),
      classes: vi.fn().mockResolvedValue({ runs: [], nextBeforeRunId: null }),
    };
    const notices: NoticeClient = { publish: vi.fn(), query: vi.fn() };
    let last: ReactNode;
    const handle = startDashboard(
      syntheticBrowser(),
      { load: vi.fn().mockRejectedValue(new Error("unavailable")) },
      () => ({
        render: (node) => {
          last = node;
        },
        unmount: vi.fn(),
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      hasNotice ? notices : undefined,
      hasRead ? read : undefined,
    );
    await handle.ready;
    expect(isValidElement<DashboardAppProperties>(last)).toBe(true);
    if (!isValidElement<DashboardAppProperties>(last)) throw new Error("Missing app");
    expect(last.props.navigation?.section).toBe("sessions");
    expect(last.props.workspace?.classes).toEqual(hasRead && hasNotice ? [] : undefined);
    handle.dispose();
  },
);
it("places evaluation exclusively inside the selected session when a workspace is present", async () => {
  const rendered: ReactNode[] = [];
  const client = evaluationClientFixture();
  const handle = startDashboard(
    syntheticBrowser(),
    { load: vi.fn().mockRejectedValue(new Error("unavailable")) },
    () => ({ render: (node) => rendered.push(node), unmount: vi.fn() }),
    client,
    undefined,
    undefined,
    undefined,
    undefined,
    { publish: vi.fn(), query: vi.fn() },
    { ...client, classes: vi.fn().mockResolvedValue({ runs: [], nextBeforeRunId: null }) },
  );
  await handle.ready;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const html = renderToStaticMarkup(rendered.at(-1));
  expect(html).toContain("session-workspace");
  expect(html).not.toContain("evaluation-module");
  handle.dispose();
});
it("keeps customization reachable without teaching classes or module data", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const client = evaluationClientFixture();
  const html = renderToStaticMarkup(
    <DashboardApp
      locale="en"
      profiles={{
        fetch: vi.fn(),
        sessions: { ...client, classes: vi.fn() },
        notices: { publish: vi.fn(), query: vi.fn() },
      }}
    />,
  );
  expect(html.match(/<option/gu)).toHaveLength(1);
  expect(html).toContain("Select a class");
  expect(html).toContain("Main navigation");
});
it("does not start legacy unscoped reads when the profile host owns module lifecycle", async () => {
  const active = { load: vi.fn() };
  const sessions = { ...evaluationClientFixture(), classes: vi.fn() };
  const notices = { publish: vi.fn(), query: vi.fn() };
  const handle = startDashboard(
    syntheticBrowser(),
    active,
    () => ({ render: vi.fn(), unmount: vi.fn() }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    notices,
    sessions,
    { fetch: vi.fn(), sessions, notices },
  );
  await handle.ready;
  expect(active.load).not.toHaveBeenCalled();
  expect(sessions.classes).not.toHaveBeenCalled();
  handle.dispose();
});
it("hides administration while governance access is still unknown", () => {
  const controller = new GovernanceController(controllerClient(), vi.fn());
  const state = { ...controller.state, access: undefined } as never;
  const elements = reviewElements(
    <DashboardApp locale="en" governance={{ controller, state }} />,
  ) as readonly ReactElement<NavigationProperties>[];
  const navigation = elements.find((element) => element.props.className === "task-navigation");
  const buttons = reviewElements(
    navigation?.props.children,
  ) as readonly ReactElement<NavigationProperties>[];
  expect(buttons.map((button) => button.props.children)).toEqual([
    "Sessions",
    "Teaching",
    "Skills",
  ]);
});
