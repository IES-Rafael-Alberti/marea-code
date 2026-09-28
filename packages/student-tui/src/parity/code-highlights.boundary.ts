import hljs from "highlight.js";
import { PALETTE } from "./tokens.js";

export interface CodePart {
  readonly text: string;
  readonly fg: string;
  readonly attributes: number;
}
const ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
} as const;
const SCOPES: Readonly<Record<string, { fg: string; attributes: number }>> = {
  "hljs-keyword": { fg: PALETTE.code, attributes: 0 },
  "hljs-number": { fg: PALETTE.code, attributes: 0 },
  "hljs-built_in": { fg: PALETTE.code, attributes: 0 },
  "hljs-title function_": { fg: PALETTE.code, attributes: 8 },
  "hljs-title class_": { fg: PALETTE.code, attributes: 8 },
  "hljs-string": { fg: "#74be9b", attributes: 0 },
  "hljs-comment": { fg: PALETTE.mutedDim, attributes: 4 },
};
const PLAIN = { fg: "#ffffff", attributes: 0 };

/** Highlight explicitly named languages offline; unknown fences remain literal text. */
export function highlightCode(code: string, language: string): CodePart[] {
  if (hljs.getLanguage(language) === undefined) return [{ text: code, ...PLAIN }];
  const output = hljs.highlight(code, { language, ignoreIllegals: true }).value;
  const scopes = Array.of<{
    name: string;
    style: { fg: string; attributes: number } | undefined;
  }>();
  const parts: CodePart[] = [];
  for (const token of output.matchAll(/<span class="([^"]+)">|<\/span>|([^<]+)/gu)) {
    if (token[1] !== undefined) scopes.push({ name: token[1], style: SCOPES[token[1]] });
    else if (token[0] === "</span>") scopes.pop();
    else {
      const text = token[0].replace(
        /&amp;|&lt;|&gt;|&quot;|&#x27;/gu,
        (entity) => ENTITIES[entity as keyof typeof ENTITIES],
      );
      const scope = scopes.at(-1);
      parts.push(...styledParts(text, scope, language));
    }
  }
  return parts;
}

function styledParts(
  text: string,
  scope: { name: string; style: { fg: string; attributes: number } | undefined } | undefined,
  language: string,
): CodePart[] {
  if (scope?.style !== undefined) {
    const { style, name } = scope;
    const operator = name === "hljs-keyword" && ["and", "or", "not", "in", "is"].includes(text);
    return [{ text, ...(operator ? { fg: "#d17e92", attributes: 1 } : style) }];
  }
  const parts: CodePart[] = [];
  if (language === "python" || language === "py") {
    for (const word of text.matchAll(/[A-Za-z_]\w*|[+*/%=<>!-]+|[^A-Za-z_+*/%=<>!-]+/gu)) {
      const value = word[0];
      parts.push({
        text: value,
        fg: /[A-Za-z_]/u.test(value) ? PALETTE.link : PLAIN.fg,
        attributes: /[+*/%=<>!-]/u.test(value) ? 1 : 0,
      });
    }
  } else parts.push({ text, ...PLAIN });
  return parts;
}
