import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PreviewInstall } from "./preview-install.js";
import { change, control, tree } from "./forms.fixture.js";

const state = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: string) => {
    state.value ??= initial;
    return [
      state.value,
      (value: string) => {
        state.value = value;
      },
    ];
  },
}));
beforeEach(() => {
  state.value = null;
  vi.stubEnv("VITE_MAREA_PREVIEW_REPOSITORY", "school/marea");
  vi.stubEnv("VITE_MAREA_PREVIEW_VERSION", "0.1.0-preview.16");
  vi.stubGlobal("window", { location: { origin: "http://localhost:18787" } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("updates both installation commands when choosing a classroom network", () => {
  const origins = ["http://10.0.4.25:18787", "http://192.168.1.20:18787"];
  const render = () => tree(<PreviewInstall locale="en" origins={origins} />);
  expect(render().filter((node) => node.type === "textarea")).toHaveLength(0);
  expect(control(render(), "Server address for students").value).toBe("");
  for (const origin of origins) {
    change(control(render(), "Server address for students"), { value: origin });
    const commands = render().filter((node) => node.type === "textarea");
    expect(commands).toHaveLength(2);
    expect(commands[0]?.props.value).toContain(`--server '${origin}'`);
    expect(commands[1]?.props.value).toContain(`-Server '${origin}'`);
  }
});

it("drops a selected address when a refreshed server projection no longer offers it", () => {
  state.value = "http://192.168.1.20:18787";
  const nodes = tree(<PreviewInstall locale="en" origins={["http://10.0.4.25:18787"]} />);
  expect(control(nodes, "Server address for students").value).toBe("http://10.0.4.25:18787");
  expect(nodes.find((node) => node.type === "textarea")?.props.value).toContain(
    "http://10.0.4.25:18787",
  );
});
