import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import * as z from "zod";
import {
  currentUid,
  privateDescendantKind,
} from "../../apps/teacher-server/src/platform/operator-cli/private-path.js";

export const onboardingMarker = "onboarding-pending.json";
const ownerFile = "onboarding-owner.json";
const Record = z
  .object({
    pid: z.number().int().positive(),
    stage: z.string().regex(/^\.onboarding-[A-Za-z0-9]+$/u),
    url: z.url().refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "http:" &&
        url.hostname === "127.0.0.1" &&
        url.pathname === "/dashboard/setup.html"
      );
    }),
  })
  .strict();

export function markOnboardingPending(root: string): void {
  writeFileSync(join(root, onboardingMarker), '{"format":1}', { flag: "wx", mode: 0o600 });
}

export function onboardingPending(root: string): boolean {
  const path = join(root, onboardingMarker);
  if (!existsSync(path)) return false;
  if (privateDescendantKind(root, path, currentUid()) !== "file")
    throw new Error("Invalid onboarding marker");
  z.object({ format: z.literal(1) })
    .strict()
    .parse(JSON.parse(readFileSync(path, "utf8")));
  return true;
}

function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && (error as NodeJS.ErrnoException).code === "ESRCH");
  }
}

/** A dead first-run process owns only a private scratch tree; no installed school is removed. */
export function existingOnboarding(root: string): string | null {
  const path = join(root, ownerFile);
  if (!existsSync(path)) return null;
  if (privateDescendantKind(root, path, currentUid()) !== "file")
    throw new Error("Invalid onboarding owner");
  const status = lstatSync(path);
  const owner = Record.parse(JSON.parse(readFileSync(path, "utf8")));
  if (processRunning(owner.pid)) return owner.url;
  const stage = join(root, owner.stage);
  if (existsSync(stage)) {
    if (privateDescendantKind(root, stage, currentUid()) !== "directory")
      throw new Error("Invalid onboarding scratch directory");
    rmSync(stage, { recursive: true });
  }
  const current = lstatSync(path);
  if (
    current.dev !== status.dev ||
    current.ino !== status.ino ||
    current.mtimeMs !== status.mtimeMs
  )
    throw new Error("Onboarding ownership changed");
  rmSync(path);
  return null;
}

export function ownOnboarding(root: string, url: string) {
  const stage = mkdtempSync(join(root, ".onboarding-"));
  const path = join(root, ownerFile);
  try {
    writeFileSync(
      path,
      JSON.stringify(Record.parse({ pid: process.pid, stage: basename(stage), url })),
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    rmSync(stage, { recursive: true });
    throw error;
  }
  const identity = lstatSync(path);
  return {
    stage,
    close() {
      const current = lstatSync(path, { throwIfNoEntry: false });
      if (current?.dev === identity.dev && current.ino === identity.ino) rmSync(path);
      rmSync(stage, { recursive: true, force: true });
    },
  };
}
