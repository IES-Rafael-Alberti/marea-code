import { isValidElement, type ReactElement, type ReactNode } from "react";

/**
 * Walks a rendered element tree so a test can assert on what a component put
 * on screen without a terminal. Components are called as plain functions, the
 * way the rest of this package's screen tests already do.
 */

export interface FlatNode {
  readonly children: readonly ReactNode[];
  /** The React key, which is how a list keeps its identity across renders. */
  readonly key: string | null;
  readonly props: Readonly<Record<string, unknown>>;
  readonly type: string;
}

function typeName(element: ReactElement): string {
  const { type } = element;
  if (typeof type === "string") return type;
  return typeof type === "function" ? type.name || "component" : "unknown";
}

function isElement(node: ReactNode): node is ReactElement {
  return isValidElement(node);
}

type Component = (props: Record<string, unknown>) => ReactNode;

/**
 * Expands a function component by calling it. Every component here is a pure
 * function of its props with no hooks, which is what the rest of this
 * package's screen tests already rely on.
 */
function expand(node: ReactElement): ReactNode {
  return (node.type as Component)((node.props ?? {}) as Record<string, unknown>);
}

/** Every element in the tree, parents before children. */
export function flatten(node: ReactNode): readonly FlatNode[] {
  if (Array.isArray(node)) return node.flatMap((child: ReactNode) => flatten(child));
  if (!isElement(node)) return [];
  if (typeof node.type === "function") {
    // A component's own key belongs to whatever it renders, so a list of
    // components can still be checked for stable identity.
    const [root, ...rest] = flatten(expand(node));
    if (root === undefined) return [];
    return [{ ...root, key: root.key ?? node.key }, ...rest];
  }
  const props = (node.props ?? {}) as Record<string, unknown>;
  const children = "children" in props ? props.children : undefined;
  const list = Array.isArray(children) ? (children as ReactNode[]) : [children as ReactNode];
  return [
    { children: list, key: node.key, props, type: typeName(node) },
    ...list.flatMap((child: ReactNode) => flatten(child)),
  ];
}

/** Every element of one kind, in order. */
export function nodesOfType(node: ReactNode, type: string): readonly FlatNode[] {
  return flatten(node).filter((found) => found.type === type);
}

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((child: ReactNode) => textOf(child)).join("");
  if (!isElement(node)) return "";
  if (typeof node.type === "function") return textOf(expand(node));
  const props = (node.props ?? {}) as Record<string, unknown>;
  return "children" in props ? textOf(props.children as ReactNode) : "";
}

/** Everything the tree would print, as one string. */
export function renderedText(node: ReactNode): string {
  return textOf(node);
}

/** One line per `text` element, in order. */
export function textLines(node: ReactNode): readonly string[] {
  return nodesOfType(node, "text").map((found) => textOf(found.children));
}
