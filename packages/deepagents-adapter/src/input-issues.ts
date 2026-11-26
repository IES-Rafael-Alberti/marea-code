import type * as z from "zod";

/** One line per problem, naming the parameter, so a model can correct its own call. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.join(".");
      return where === "" ? issue.message : `${where}: ${issue.message}`;
    })
    .join("; ");
}
