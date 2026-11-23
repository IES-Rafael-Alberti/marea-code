import * as z from "zod";

export const SoftwareVersionSchema = z
  .string()
  .max(64)
  .regex(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );

export const RevisionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const ToolNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_.-]*$/);

export const SafeDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} .'-]*$/u);

/**
 * A student project directory name. One schema for opening a run and for every response
 * that echoes it, so a run that could be opened can always be listed and resumed.
 */
export const ProjectDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} ._()'-]*$/u);
