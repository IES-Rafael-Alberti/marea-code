import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  copiedPluginFixture,
  expectCatalogError,
  replaceFixtureText,
  temporaryRoot,
} from "../tests/fixtures/plugin-catalog/catalog-testkit.js";
import { generatePluginCatalog } from "./generate-plugin-catalog.js";

describe("plugin catalog manifest validation", () => {
  it("rejects duplicate IDs across different plugin kinds", async () => {
    const fixture = await copiedPluginFixture();
    await replaceFixtureText(
      join(fixture.plugins, "telemetry", "synthetic-exporter", "plugin.json"),
      "org.marea.fixture-telemetry",
      "org.marea.fixture-inference",
    );

    await expectCatalogError(
      generatePluginCatalog({
        pluginsDirectory: fixture.plugins,
        outputFile: join(fixture.root, "catalog.ts"),
        mode: "write",
      }),
      "DUPLICATE_PLUGIN_ID",
      "globally unique",
    );
  });

  it("rejects an incompatible plugin API version with its field in the diagnostic", async () => {
    const fixture = await copiedPluginFixture();
    await replaceFixtureText(
      join(fixture.plugins, "dashboard-themes", "synthetic-theme", "plugin.json"),
      '"apiVersion": "2.0"',
      '"apiVersion": "9.0"',
    );

    await expectCatalogError(
      generatePluginCatalog({
        pluginsDirectory: fixture.plugins,
        outputFile: join(fixture.root, "catalog.ts"),
        mode: "write",
      }),
      "INVALID_MANIFEST",
      "apiVersion",
    );
  });

  it("renders nested manifest issue paths without ambiguity", async () => {
    const fixture = await copiedPluginFixture();
    await replaceFixtureText(
      join(fixture.plugins, "inference", "synthetic-provider", "plugin.json"),
      '"runtimeTargets": ["teacher-server"]',
      '"runtimeTargets": ["dashboard-browser"]',
    );

    await expectCatalogError(
      generatePluginCatalog({
        pluginsDirectory: fixture.plugins,
        outputFile: join(fixture.root, "catalog.ts"),
        mode: "write",
      }),
      "INVALID_MANIFEST",
      "runtimeTargets.0",
    );
  });

  it("rejects malformed JSON, invalid fields, and unsafe relationships", async () => {
    const malformedFixture = await copiedPluginFixture();
    const malformedManifest = join(
      malformedFixture.plugins,
      "dashboard-modules",
      "synthetic-module",
      "plugin.json",
    );
    await writeFile(malformedManifest, "{", "utf8");
    await expectCatalogError(
      generatePluginCatalog({
        pluginsDirectory: malformedFixture.plugins,
        outputFile: join(malformedFixture.root, "catalog.ts"),
        mode: "write",
      }),
      "INVALID_MANIFEST",
      "plugin.json must contain valid JSON",
    );

    const invalidFixture = await copiedPluginFixture();
    await replaceFixtureText(
      join(invalidFixture.plugins, "inference", "synthetic-provider", "plugin.json"),
      '"configurationVersion": 1',
      '"configurationVersion": 0',
    );
    await replaceFixtureText(
      join(invalidFixture.plugins, "inference", "synthetic-provider", "plugin.json"),
      '"configurationVersion": 0,',
      '"configurationVersion": 0,\n  "unexpected": true,',
    );
    await expectCatalogError(
      generatePluginCatalog({
        pluginsDirectory: invalidFixture.plugins,
        outputFile: join(invalidFixture.root, "catalog.ts"),
        mode: "write",
      }),
      "INVALID_MANIFEST",
      "; ",
    );

    const relationshipFixture = await copiedPluginFixture();
    await replaceFixtureText(
      join(relationshipFixture.plugins, "inference", "synthetic-provider", "plugin.json"),
      '"configurationVersion": 1,',
      '"configurationVersion": 1,\n  "requiredDependencies": ["org.marea.fixture-inference"],',
    );
    await expectCatalogError(
      generatePluginCatalog({
        pluginsDirectory: relationshipFixture.plugins,
        outputFile: join(relationshipFixture.root, "catalog.ts"),
        mode: "write",
      }),
      "INVALID_MANIFEST",
      "manifest: Dependency and conflict IDs",
    );
  });

  it("rejects manifest traversal before resolving an entrypoint", async () => {
    const fixture = await copiedPluginFixture();
    await replaceFixtureText(
      join(fixture.plugins, "inference", "synthetic-provider", "plugin.json"),
      "./src/index.ts",
      "../escape.ts",
    );

    await expectCatalogError(
      generatePluginCatalog({
        pluginsDirectory: fixture.plugins,
        outputFile: join(fixture.root, "catalog.ts"),
        mode: "write",
      }),
      "INVALID_MANIFEST",
      "parent traversal",
    );
  });
});

describe("plugin catalog filesystem validation", () => {
  it("rejects entrypoints that resolve through a directory link outside the plugin", async () => {
    const fixture = await copiedPluginFixture();
    const plugin = join(fixture.plugins, "inference", "synthetic-provider");
    const outside = join(fixture.root, "outside");
    await rm(join(plugin, "src"), { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, "index.ts"), "export default {};\n", "utf8");
    await symlink(outside, join(plugin, "src"), "dir");

    await expectCatalogError(
      generatePluginCatalog({
        pluginsDirectory: fixture.plugins,
        outputFile: join(fixture.root, "catalog.ts"),
        mode: "write",
      }),
      "UNSAFE_PATH",
      "resolves outside",
    );
  });

  it("rejects a linked or missing entrypoint", async () => {
    const linkedFixture = await copiedPluginFixture();
    const linkedPlugin = join(linkedFixture.plugins, "inference", "synthetic-provider");
    await writeFile(join(linkedPlugin, "src", "target.ts"), "export default {};\n", "utf8");
    await rm(join(linkedPlugin, "src", "index.ts"));
    await symlink("target.ts", join(linkedPlugin, "src", "index.ts"), "file");
    await expectCatalogError(
      generatePluginCatalog({
        pluginsDirectory: linkedFixture.plugins,
        outputFile: join(linkedFixture.root, "catalog.ts"),
        mode: "write",
      }),
      "UNSAFE_PATH",
      "regular file",
    );

    const missingFixture = await copiedPluginFixture();
    await rm(join(missingFixture.plugins, "inference", "synthetic-provider", "src", "index.ts"));
    await expectCatalogError(
      generatePluginCatalog({
        pluginsDirectory: missingFixture.plugins,
        outputFile: join(missingFixture.root, "catalog.ts"),
        mode: "write",
      }),
      "ENTRYPOINT_NOT_FOUND",
      "Add the manifest's TypeScript entrypoint",
    );

    const directoryFixture = await copiedPluginFixture();
    const directoryEntrypoint = join(
      directoryFixture.plugins,
      "inference",
      "synthetic-provider",
      "src",
      "index.ts",
    );
    await rm(directoryEntrypoint);
    await mkdir(directoryEntrypoint);
    await expectCatalogError(
      generatePluginCatalog({
        pluginsDirectory: directoryFixture.plugins,
        outputFile: join(directoryFixture.root, "catalog.ts"),
        mode: "write",
      }),
      "UNSAFE_PATH",
      "regular file",
    );
  });

  it("rejects a missing, linked, or non-file manifest", async () => {
    const missingFixture = await copiedPluginFixture();
    await rm(join(missingFixture.plugins, "inference", "synthetic-provider", "plugin.json"));
    await expectCatalogError(
      generatePluginCatalog({
        pluginsDirectory: missingFixture.plugins,
        outputFile: join(missingFixture.root, "catalog.ts"),
        mode: "write",
      }),
      "INVALID_MANIFEST",
      "Add a regular plugin.json",
    );

    const linkedFixture = await copiedPluginFixture();
    const linkedManifest = join(
      linkedFixture.plugins,
      "inference",
      "synthetic-provider",
      "plugin.json",
    );
    await writeFile(join(linkedFixture.root, "manifest.json"), "{}\n", "utf8");
    await rm(linkedManifest);
    await symlink(join(linkedFixture.root, "manifest.json"), linkedManifest, "file");
    await expectCatalogError(
      generatePluginCatalog({
        pluginsDirectory: linkedFixture.plugins,
        outputFile: join(linkedFixture.root, "catalog.ts"),
        mode: "write",
      }),
      "INVALID_MANIFEST",
      "not a directory or symbolic link",
    );

    const directoryFixture = await copiedPluginFixture();
    const directoryManifest = join(
      directoryFixture.plugins,
      "inference",
      "synthetic-provider",
      "plugin.json",
    );
    await rm(directoryManifest);
    await mkdir(directoryManifest);
    await expectCatalogError(
      generatePluginCatalog({
        pluginsDirectory: directoryFixture.plugins,
        outputFile: join(directoryFixture.root, "catalog.ts"),
        mode: "write",
      }),
      "INVALID_MANIFEST",
      "must be a regular file",
    );
  });

  it("rejects files, unsafe names, and links in kind directories", async () => {
    const fileFixture = await copiedPluginFixture();
    await writeFile(join(fileFixture.plugins, "inference", "README.md"), "invalid\n", "utf8");
    const fileGeneration = generatePluginCatalog({
      pluginsDirectory: fileFixture.plugins,
      outputFile: join(fileFixture.root, "catalog.ts"),
      mode: "write",
    });
    await expectCatalogError(fileGeneration, "INVALID_LAYOUT", "real plugin directories");
    await expect(fileGeneration).rejects.toMatchObject({ location: "inference/README.md" });

    const nameFixture = await copiedPluginFixture();
    await mkdir(join(nameFixture.plugins, "inference", "Unsafe_Name"));
    await expectCatalogError(
      generatePluginCatalog({
        pluginsDirectory: nameFixture.plugins,
        outputFile: join(nameFixture.root, "catalog.ts"),
        mode: "write",
      }),
      "INVALID_LAYOUT",
      "portable lowercase",
    );

    const trailingNameFixture = await copiedPluginFixture();
    await mkdir(join(trailingNameFixture.plugins, "inference", "safe-name!"));
    await expectCatalogError(
      generatePluginCatalog({
        pluginsDirectory: trailingNameFixture.plugins,
        outputFile: join(trailingNameFixture.root, "catalog.ts"),
        mode: "write",
      }),
      "INVALID_LAYOUT",
      "portable lowercase",
    );

    const linkFixture = await copiedPluginFixture();
    await symlink(
      join(linkFixture.plugins, "inference", "synthetic-provider"),
      join(linkFixture.plugins, "inference", "linked-provider"),
      "dir",
    );
    await expectCatalogError(
      generatePluginCatalog({
        pluginsDirectory: linkFixture.plugins,
        outputFile: join(linkFixture.root, "catalog.ts"),
        mode: "write",
      }),
      "INVALID_LAYOUT",
    );
  });

  it("rejects an unknown top-level plugin kind", async () => {
    const fixture = await copiedPluginFixture();
    await mkdir(join(fixture.plugins, "experimental"));

    await expectCatalogError(
      generatePluginCatalog({
        pluginsDirectory: fixture.plugins,
        outputFile: join(fixture.root, "catalog.ts"),
        mode: "write",
      }),
      "INVALID_LAYOUT",
      "unknown top-level plugin kind",
    );
  });

  it("rejects a plugin kind that is a file or symbolic link", async () => {
    const fileFixture = await copiedPluginFixture();
    await rm(join(fileFixture.plugins, "telemetry"), { recursive: true });
    await writeFile(join(fileFixture.plugins, "telemetry"), "invalid\n", "utf8");
    await expectCatalogError(
      generatePluginCatalog({
        pluginsDirectory: fileFixture.plugins,
        outputFile: join(fileFixture.root, "catalog.ts"),
        mode: "write",
      }),
      "INVALID_LAYOUT",
      "Plugin kind entries must be real directories",
    );

    const linkFixture = await copiedPluginFixture();
    const outside = join(linkFixture.root, "outside-kind");
    await mkdir(outside);
    await rm(join(linkFixture.plugins, "telemetry"), { recursive: true });
    await symlink(outside, join(linkFixture.plugins, "telemetry"), "dir");
    await expectCatalogError(
      generatePluginCatalog({
        pluginsDirectory: linkFixture.plugins,
        outputFile: join(linkFixture.root, "catalog.ts"),
        mode: "write",
      }),
      "INVALID_LAYOUT",
      "symbolic links",
    );
  });

  it("rejects a plugin root that is a file or symbolic link", async () => {
    const fileRoot = await temporaryRoot("marea-plugin-root-file-");
    const pluginsFile = join(fileRoot, "plugins");
    await writeFile(pluginsFile, "invalid\n", "utf8");
    await expectCatalogError(
      generatePluginCatalog({
        pluginsDirectory: pluginsFile,
        outputFile: join(fileRoot, "catalog.ts"),
        mode: "write",
      }),
      "INVALID_LAYOUT",
      "plugin root must be a real directory",
    );

    const linkRoot = await temporaryRoot("marea-plugin-root-link-");
    const realPlugins = join(linkRoot, "real-plugins");
    await mkdir(realPlugins);
    const pluginsLink = join(linkRoot, "plugins");
    await symlink(realPlugins, pluginsLink, "dir");
    await expectCatalogError(
      generatePluginCatalog({
        pluginsDirectory: pluginsLink,
        outputFile: join(linkRoot, "catalog.ts"),
        mode: "write",
      }),
      "INVALID_LAYOUT",
      "symbolic link",
    );
  });

  it("wraps filesystem read failures with stable context", async () => {
    const fixture = await copiedPluginFixture();
    const inferenceDirectory = join(fixture.plugins, "inference");
    await chmod(inferenceDirectory, 0o000);
    try {
      await expectCatalogError(
        generatePluginCatalog({
          pluginsDirectory: fixture.plugins,
          outputFile: join(fixture.root, "catalog.ts"),
          mode: "write",
        }),
        "READ_FAILED",
        "EACCES",
      );
    } finally {
      await chmod(inferenceDirectory, 0o700);
    }
  });

  it("wraps a plugin root stat failure with stable context", async () => {
    const root = await temporaryRoot("marea-unreadable-plugin-root-");
    const plugins = join(root, "plugins");
    await mkdir(plugins);
    await chmod(root, 0o000);
    try {
      const generation = generatePluginCatalog({
        pluginsDirectory: plugins,
        outputFile: join(root, "catalog.ts"),
        mode: "write",
      });
      await expectCatalogError(generation, "READ_FAILED", "EACCES");
      await expect(generation).rejects.toMatchObject({ location: plugins });
    } finally {
      await chmod(root, 0o700);
    }
  });

  it("wraps a manifest stat failure with stable context", async () => {
    const fixture = await copiedPluginFixture();
    const pluginDirectory = join(fixture.plugins, "inference", "synthetic-provider");
    await chmod(pluginDirectory, 0o000);
    try {
      await expectCatalogError(
        generatePluginCatalog({
          pluginsDirectory: fixture.plugins,
          outputFile: join(fixture.root, "catalog.ts"),
          mode: "write",
        }),
        "READ_FAILED",
        "EACCES",
      );
    } finally {
      await chmod(pluginDirectory, 0o700);
    }
  });

  it("wraps a generated catalog read failure with stable context", async () => {
    const fixture = await copiedPluginFixture();
    const outputFile = join(fixture.root, "catalog.ts");
    await generatePluginCatalog({
      pluginsDirectory: fixture.plugins,
      outputFile,
      mode: "write",
    });
    await chmod(outputFile, 0o000);
    try {
      await expectCatalogError(
        generatePluginCatalog({
          pluginsDirectory: fixture.plugins,
          outputFile,
          mode: "check",
        }),
        "READ_FAILED",
        "EACCES",
      );
    } finally {
      await chmod(outputFile, 0o600);
    }
  });
});
