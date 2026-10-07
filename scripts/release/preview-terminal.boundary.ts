import { createInterface } from "node:readline/promises";
export async function question(prompt: string, fallback?: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("Setup needs an interactive terminal");
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const value = (
      await terminal.question(`${prompt}${fallback === undefined ? "" : ` [${fallback}]`}: `)
    ).trim();
    return value === "" ? (fallback ?? "") : value;
  } finally {
    terminal.close();
  }
}

export async function acceptUpdate(version: string, required = false): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return false;
  return (
    (
      await question(
        required
          ? `El servidor requiere una versión compatible (${version}). ¿Instalarla para conectarte? (s/n)`
          : `Hay una nueva versión de pruebas (${version}). ¿Actualizar ahora? (s/n)`,
        "n",
      )
    ).toLowerCase() === "s"
  );
}
