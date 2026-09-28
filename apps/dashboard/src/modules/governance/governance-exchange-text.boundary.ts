import { ClassExchangeSchema, type ClassExchange } from "@marea/protocol";

/** Parses administrator-pasted package text; anything that is not a valid package is null. */
export function parseClassExchangeText(text: string): ClassExchange | null {
  try {
    const parsed = ClassExchangeSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
