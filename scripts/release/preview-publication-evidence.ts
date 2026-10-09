interface PublicationRun {
  readonly head_sha: string;
  readonly conclusion: string | null;
}
interface PublicationJob {
  readonly name: string;
  readonly conclusion: string | null;
  readonly steps?: readonly { readonly name: string; readonly conclusion: string | null }[];
}

/** Advertising metadata can be retried after publication; native and public-install gates cannot. */
export function hasVerifiedPublication(
  run: PublicationRun,
  commit: string,
  jobs: readonly PublicationJob[],
): boolean {
  if (
    run.head_sha !== commit ||
    !jobs.some((job) => job.name === "publish" && job.conclusion === "success")
  )
    return false;
  if (run.conclusion === "success") return true;
  if (run.conclusion !== "failure") return false;
  const channel = jobs.find((job) => job.name === "available-channel");
  if (channel?.conclusion !== "failure" || channel.steps === undefined) return false;
  const tested = channel.steps.some(
    (step) =>
      step.name ===
        "Verify public student and server installs, retained data and clean reinstall" &&
      step.conclusion === "success",
  );
  const failures = channel.steps
    .filter((step) => step.conclusion === "failure")
    .map((step) => step.name);
  return (
    tested &&
    failures.length === 1 &&
    failures.includes("Make the tested publication available without recommending it")
  );
}
