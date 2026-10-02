import { isValidElement, type FunctionComponent, type ReactElement, type ReactNode } from "react";

type Value = object | string | number | boolean | null | undefined;
type Props = Record<string, Value> & { children?: ReactNode };
/** Expands hook-free components so handlers can be exercised without a DOM. */
export function tree(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap((child: ReactNode) => tree(child));
  if (!isValidElement<Props>(node)) return [];
  if (typeof node.type === "function")
    return tree((node.type as FunctionComponent<Props>)(node.props) as ReactNode);
  return [node, ...tree(node.props.children)];
}
export function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((child: ReactNode) => text(child)).join("");
  return isValidElement<Props>(node) ? text(node.props.children) : "";
}
/** The first control inside the nth label whose own text starts with the given caption. */
function labelled(nodes: ReactElement<Props>[], caption: string, index: number) {
  const label = nodes.filter((node) => node.type === "label" && text(node).startsWith(caption))[
    index
  ];
  return tree(label?.props.children);
}
/** The options of the select inside the nth matching label, as value, state and visible text. */
export function options(nodes: ReactElement<Props>[], caption: string, index = 0) {
  const select = labelled(nodes, caption, index).find((node) => node.type === "select");
  return tree(select?.props.children)
    .filter((node) => node.type === "option")
    .map((node) => ({
      value: node.props.value,
      disabled: node.props.disabled === true,
      text: text(node),
    }));
}
export function control(nodes: ReactElement<Props>[], caption: string, index = 0) {
  const found = labelled(nodes, caption, index).find((node) =>
    ["input", "select"].includes(String(node.type)),
  );
  if (found === undefined) throw new Error(`Missing control: ${caption}`);
  return found.props as {
    onChange: (event: object) => void;
    value?: Value;
    checked?: boolean;
    disabled?: boolean;
    required?: boolean;
    placeholder?: string;
    type?: string;
  };
}
export const change = (props: { onChange: (event: object) => void }, currentTarget: object) => {
  props.onChange({ currentTarget });
};
