import { inspectPrivatePath } from "@marea/private-filesystem";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdtempSync,
  openSync,
  realpathSync,
  unlinkSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { MAX_TEACHING_CONFIGURATION_BYTES } from "@marea/protocol";
import type { InstallationCapability } from "../../governance/authority.js";
import { parseOperatorDocument } from "./operator-configuration-parser.js";
import { loadOperatorConfiguration } from "./operator-filesystem-loader.js";
import { OperatorConfigurationError } from "./operator-configuration-errors.js";

export function policyBytes(document: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(document));
  if (bytes.byteLength > MAX_TEACHING_CONFIGURATION_BYTES)
    throw new OperatorConfigurationError(
      "too-large",
      "Operator configuration exceeds its byte bound.",
    );
  parseOperatorDocument(JSON.parse(bytes.toString("utf8")) as unknown);
  return bytes;
}

/** Hard-link publication is create-only, including for dangling destination symlinks. */
export function publishGovernancePolicy(
  authority: InstallationCapability,
  outputPath: string,
  bytes: Buffer,
): void {
  authority.assertOwned();
  if (!isAbsolute(outputPath) || outputPath.includes("\0"))
    throw new OperatorConfigurationError(
      "invalid-path",
      "Choose a new absolute private output path.",
    );
  try {
    publishStagedPolicy(authority, outputPath, bytes);
  } catch (error) {
    if (error instanceof OperatorConfigurationError) throw error;
    throw new OperatorConfigurationError(
      "io-failure",
      "Private policy publication did not complete.",
    );
  }
}

function publishStagedPolicy(
  authority: InstallationCapability,
  outputPath: string,
  bytes: Buffer,
): void {
  let stage: string | undefined;
  let file: string | undefined;
  try {
    const parent = dirname(outputPath);
    if (realpathSync(parent) !== parent || inspectPrivatePath(parent) !== "directory")
      throw new OperatorConfigurationError(
        "invalid-path",
        "Choose a canonical private output directory.",
      );
    stage = mkdtempSync(join(parent, ".marea-policy-"));
    const stagedFile = join(stage, "policy.json");
    const descriptor = openSync(stagedFile, "wx", 0o600);
    file = stagedFile;
    try {
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    loadOperatorConfiguration(file, MAX_TEACHING_CONFIGURATION_BYTES);
    authority.assertOwned();
    linkSync(file, outputPath);
  } finally {
    if (file !== undefined) unlinkSync(file);
    if (stage !== undefined) rmdirSync(stage);
  }
}
