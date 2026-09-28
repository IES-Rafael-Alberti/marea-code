/** Keep terminal labels intact at narrow widths, including slashes and hyphens. */
export function fittingWords(text: string, width: number): string {
  if (text.length <= width) return text;
  const prefix = text.slice(0, Math.max(0, width) + 1);
  const boundary = prefix.lastIndexOf(" ");
  return prefix.slice(0, Math.max(0, boundary)).trimEnd();
}

export interface WordPart {
  readonly text: string;
  readonly command: boolean;
}
/** Insert explicit word breaks because native Unicode wrapping splits `/details`. */
export function wrapParts(parts: readonly WordPart[], width: number): WordPart[] {
  let column = 0;
  let pending = "";
  const result: WordPart[] = [];
  for (const part of parts) {
    for (const word of part.text.split(/( )/u)) {
      if (word === "") continue;
      if (word === " ") {
        pending += word;
        continue;
      }
      const prefix = column > 0 && column + pending.length + word.length > width ? "\n" : pending;
      result.push({ text: prefix + word, command: part.command });
      column = prefix === "\n" ? word.length : column + prefix.length + word.length;
      pending = "";
    }
  }
  return result;
}
