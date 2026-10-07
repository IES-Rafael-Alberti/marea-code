import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { PreviewInstall, previewInstallCommands } from "./preview-install.js";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("generates commands for the exact server version and address, without allowing shell metacharacters", () => {
  expect(
    previewInstallCommands("school/marea", "0.1.0-preview.2", "https://school.test/path"),
  ).toEqual({
    posix:
      "curl -fsSL 'https://github.com/school/marea/releases/download/v0.1.0-preview.2/install.sh' | sh -s -- student --server 'https://school.test'",
    windows:
      "& ([scriptblock]::Create((Invoke-RestMethod 'https://github.com/school/marea/releases/download/v0.1.0-preview.2/install.ps1'))) -Component student -Server 'https://school.test'",
    releases: "https://github.com/school/marea/releases",
  });
  for (const origin of [
    "http://10.0.4.25:18787",
    "http://192.168.1.20:18787",
    "http://school.test",
  ])
    expect(previewInstallCommands("a/b", "0.1.0-preview.1", origin)?.posix).toContain(origin);
  for (const origin of [
    "http://localhost:18787",
    "http://127.0.0.1:18787",
    "http://[::1]:18787",
    "ftp://school.test",
    "https://school'quote.test",
  ])
    expect(previewInstallCommands("a/b", "0.1.0-preview.1", origin)).toBeNull();
  expect(previewInstallCommands("bad;repo", "0.1.0-preview.1", "https://school.test")).toBeNull();
  expect(previewInstallCommands("a/b", "0.1.0", "https://school.test")).toBeNull();
});

it("uses the server LAN address when the teacher opens localhost, and explains missing access", () => {
  vi.stubGlobal("window", { location: { origin: "http://localhost:18787" } });
  vi.stubEnv("VITE_MAREA_PREVIEW_REPOSITORY", "school/marea");
  vi.stubEnv("VITE_MAREA_PREVIEW_VERSION", "0.1.0-preview.16");
  const markup = renderToStaticMarkup(
    <PreviewInstall locale="es" origins={["http://127.0.0.1:18787", "http://10.0.4.25:18787"]} />,
  );
  expect(markup).toContain("http://10.0.4.25:18787");
  expect(markup).toContain("--server &#x27;http://10.0.4.25:18787&#x27;");
  expect(markup).not.toContain("localhost");
  expect(markup).not.toContain("127.0.0.1");
  const missing = renderToStaticMarkup(<PreviewInstall locale="es" />);
  expect(missing).toContain("marea-teacher --allow-http");
  expect(missing).not.toContain("<textarea");
});

it("hides unpublished builds and renders selectable commands in all supported languages", () => {
  vi.stubGlobal("window", { location: { origin: "https://school.test" } });
  vi.stubEnv("VITE_MAREA_PREVIEW_REPOSITORY", "");
  vi.stubEnv("VITE_MAREA_PREVIEW_VERSION", "");
  expect(PreviewInstall({ locale: "en" })).toBeNull();
  vi.stubEnv("VITE_MAREA_PREVIEW_REPOSITORY", "school/marea");
  expect(PreviewInstall({ locale: "en" })).toBeNull();
  vi.stubEnv("VITE_MAREA_PREVIEW_VERSION", "0.1.0");
  expect(PreviewInstall({ locale: "en" })).toBeNull();
  vi.stubEnv("VITE_MAREA_PREVIEW_VERSION", "0.1.0-preview.1");
  for (const locale of ["es", "en", "eu"] as const) {
    const markup = renderToStaticMarkup(<PreviewInstall locale={locale} />);
    expect(markup).toMatchSnapshot(locale);
    expect(markup).toContain("Windows PowerShell");
    expect(markup).toContain("macOS / Linux");
    expect(markup).toContain("Marea 0.1.0-preview.1");
    expect(markup.toLowerCase().match(/readonly=""/gu)).toHaveLength(2);
    expect(markup).toContain("school.test");
  }
});

it("validates complete metadata and keeps non-browser builds inert", () => {
  for (const repo of ["!school/marea", "school/marea!"])
    expect(previewInstallCommands(repo, "1.2.3-preview.4", "https://school.test")).toBeNull();
  for (const version of ["!1.2.3-preview.4", "1.2.3-preview.4!"])
    expect(previewInstallCommands("school/marea", version, "https://school.test")).toBeNull();
  expect(
    previewInstallCommands("school/marea", "11.22.33-preview.44", "https://school.test")?.posix,
  ).toContain("v11.22.33-preview.44/");
  expect(previewInstallCommands("school/marea", "1.2.3-preview.4", "ftp://localhost")).toBeNull();
  vi.stubGlobal("window", undefined);
  vi.stubEnv("VITE_MAREA_PREVIEW_REPOSITORY", "school/marea");
  vi.stubEnv("VITE_MAREA_PREVIEW_VERSION", "");
  expect(PreviewInstall({ locale: "en" })).toBeNull();
});
