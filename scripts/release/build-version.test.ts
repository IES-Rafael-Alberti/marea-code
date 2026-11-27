import { expect, it } from "vitest";
import { buildMocks } from "./build.fixture.js";
import { buildCandidate } from "./build.js";
const mocks = buildMocks();

it("injects the release version into the student build and requires the binary to report it", () => {
  const root = buildCandidate(["1.2.3", "student", "/candidate"]);
  expect(mocks.writeFileSync).toHaveBeenCalledWith(
    "/isolated/apps/student/src/release-version.ts",
    'export const INJECTED_RELEASE_VERSION: string | undefined = "1.2.3";\n',
  );
  const injected = mocks.writeFileSync.mock.calls.findIndex(
    ([path]) => path === "/isolated/apps/student/src/release-version.ts",
  );
  const compiled = mocks.spawnSync.mock.calls.findIndex(([, args]) =>
    (args as string[]).includes(`${root}/marea`),
  );
  expect(injected).toBeGreaterThan(-1);
  expect(mocks.spawnSync.mock.invocationCallOrder[compiled]).toBeGreaterThan(
    mocks.writeFileSync.mock.invocationCallOrder[injected] ?? Infinity,
  );
  const spawn = mocks.spawnSync.getMockImplementation() as (
    command: string,
    args: string[],
  ) => { status: number; stdout: string; stderr: string };
  for (const [flag, output, message] of [
    ["--version", "0.0.0-dev\n", "Student binary reports 0.0.0-dev instead of 1.2.3"],
    ["-v", "0.2.0\n", "Student binary -v differs from --version"],
  ] as const) {
    mocks.spawnSync.mockImplementation((command: string, args: string[]) =>
      command === `${root}/marea` && args[0] === flag
        ? { status: 0, stdout: output, stderr: "" }
        : spawn(command, args),
    );
    expect(() => buildCandidate(["1.2.3", "student", "/candidate"])).toThrow(message);
  }
});
