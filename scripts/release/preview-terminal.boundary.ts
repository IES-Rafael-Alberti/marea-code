import { createInterface } from "node:readline/promises";
import {
  PasswordValidationError,
  readPassword,
} from "../../apps/teacher-server/src/platform/operator-cli/input.js";
import { setupAnswers, type SetupAnswers } from "./preview-setup.boundary.js";

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

export function secret(prompt: string): Promise<string> {
  const result = readPassword(
    process.stdin,
    false,
    (text) => process.stderr.write(text === "Password: " ? prompt : text),
    new AbortController().signal,
  );
  process.stdin.resume();
  return result;
}

export async function serverQuestions(): Promise<{ answers: SetupAnswers; password: string }> {
  const center = await question("Nombre del centro");
  const classroom = await question("Primera clase", "Clase de prueba");
  const teacher = await question("Nombre del profesor");
  const login = await question("Usuario del profesor", "profe");
  const password = await teacherPassword();
  const port = Number(await question("Puerto local", "18787"));
  process.stderr.write(
    "Para HTTPS, usa un proxy hacia este puerto. Para HTTP en el aula, arranca marea-teacher --allow-http.\n",
  );
  const origin = await question(
    "Dirección pública del servidor",
    `http://127.0.0.1:${String(port)}`,
  );
  const google =
    (await question("¿Configurar Google Workspace? (s/n)", "n")).toLowerCase() === "s"
      ? {
          domain: await question("Dominio del centro"),
          clientId: await question("ID del cliente OAuth de escritorio"),
          clientSecret: await secret("Secreto del cliente OAuth: "),
        }
      : undefined;
  return {
    answers: setupAnswers.parse({ center, classroom, teacher, login, port, origin, google }),
    password,
  };
}

async function teacherPassword(): Promise<string> {
  process.stderr.write(
    "La contraseña debe tener entre 12 y 256 caracteres. No se mostrará al escribir.\n",
  );
  for (;;) {
    try {
      const password = await secret("Contraseña del profesor: ");
      if (password === (await secret("Repite la contraseña: "))) return password;
      process.stderr.write("Las contraseñas no coinciden. Vuelve a introducirlas.\n");
    } catch (error) {
      if (!(error instanceof PasswordValidationError)) throw error;
      process.stderr.write(
        "Contraseña no válida: usa entre 12 y 256 caracteres. Inténtalo de nuevo.\n",
      );
    }
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
