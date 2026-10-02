/** The task has no model or limits yet; administrators can jump to the server settings. */
export function UnconfiguredNotice({
  text,
  action,
  configure,
}: {
  readonly text: string;
  readonly action: string;
  readonly configure?: (() => void) | undefined;
}) {
  return (
    <p>
      {text}{" "}
      {configure && (
        <button type="button" onClick={configure}>
          {action}
        </button>
      )}
    </p>
  );
}
