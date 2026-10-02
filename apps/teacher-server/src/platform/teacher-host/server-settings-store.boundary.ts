import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readBoundedBytes } from "../operator/operator-filesystem-loader.js";
import { currentUid, privateDescendantKind } from "../operator-cli/private-path.js";
import {
  ServerSettingsError,
  ServerSettingsSchema,
  type ServerSettings,
  type ServerSettingsStore,
} from "../../server-settings/contracts.js";

/** Used only while the host or offline CLI owns the installation lock. */
export function serverSettingsStore(root: string): ServerSettingsStore {
  const path = join(root, "config", "server-settings.json");
  const read = (): ServerSettings | null => {
    if (!existsSync(path)) return null;
    if (privateDescendantKind(root, path, currentUid()) !== "file")
      throw new ServerSettingsError(503);
    return ServerSettingsSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readBoundedBytes(path, 262144))),
    );
  };
  return {
    read,
    write(value, expectedRevision) {
      const current = read();
      if ((current?.revision ?? -1) !== expectedRevision) throw new ServerSettingsError(409);
      const bytes = JSON.stringify(ServerSettingsSchema.parse(value));
      if (
        Buffer.byteLength(bytes) > 262144 ||
        privateDescendantKind(root, join(root, "config"), currentUid()) !== "directory"
      )
        throw new ServerSettingsError(400);
      const stage = `${path}.${randomUUID()}.stage`;
      const descriptor = openSync(stage, "wx", 0o600);
      try {
        // Durability across power loss and descriptor release are not observable in tests.
        // Stryker disable BlockStatement
        try {
          writeFileSync(descriptor, bytes);
          // Stryker disable next-line CallExpression: see above.
          fsyncSync(descriptor);
        } finally {
          // Stryker disable next-line CallExpression: see above.
          closeSync(descriptor);
        }
        // Stryker restore BlockStatement
        // Creation links so it can never replace a file; under the installation lock both forms
        // produce the same result, so the distinction is defensive.
        // Stryker disable next-line ConditionalExpression: equivalent without concurrent creation.
        if (current === null) linkSync(stage, path);
        else renameSync(stage, path);
      } finally {
        if (existsSync(stage)) unlinkSync(stage);
      }
    },
  };
}
