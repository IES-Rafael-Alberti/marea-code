/** An explicit --server overrides the saved or environment URL for this invocation only. */
export function parseServerArguments(
  argv: readonly string[],
): { readonly arguments: readonly string[]; readonly serverUrl: string | undefined } | undefined {
  const remaining: string[] = [];
  let serverUrl: string | undefined;
  const pending = argv.values();
  for (const argument of pending) {
    if (argument !== "--server" && !argument.startsWith("--server=")) {
      remaining.push(argument);
      continue;
    }
    const value = argument === "--server" ? pending.next().value : argument.slice(9);
    if (
      serverUrl !== undefined ||
      value === undefined ||
      value.trim() === "" ||
      value.startsWith("--")
    )
      return undefined;
    serverUrl = value.trim();
  }
  return { arguments: remaining, serverUrl };
}
