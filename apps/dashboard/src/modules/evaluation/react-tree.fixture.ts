import {
  Children,
  isValidElement,
  type FunctionComponent,
  type ReactElement,
  type ReactNode,
} from "react";

interface ElementProperties {
  readonly children?: ReactNode;
  readonly disabled?: boolean;
  readonly value?: string;
  readonly onClick?: () => void;
  readonly onChange?: (event: { readonly currentTarget: { readonly value: string } }) => void;
}

/** Expand only these synchronous, stateless review components for handler contract tests. */
export function reviewElements(node: ReactNode): readonly ReactElement<ElementProperties>[] {
  return Children.toArray(node).flatMap((child) => {
    if (!isValidElement<ElementProperties>(child)) return [];
    if (typeof child.type === "function") {
      const component = child.type as FunctionComponent<ElementProperties>;
      const rendered = component(child.props);
      if (rendered instanceof Promise)
        throw new Error("Review fixture expects synchronous components.");
      return reviewElements(rendered);
    }
    return [child, ...reviewElements(child.props.children)];
  });
}

export function reviewButton(elements: readonly ReactElement<ElementProperties>[], label: string) {
  const button = elements.find(
    (element) => element.type === "button" && element.props.children === label,
  );
  if (button === undefined) throw new Error(`Missing review button: ${label}`);
  return button;
}
