import type { RenderContext, ScrollBoxOptions } from "@opentui/core";
import { baseComponents } from "@opentui/react";
import { GEOMETRY } from "../parity/tokens.js";
interface Options extends ScrollBoxOptions {
  contentBottomInset?: number;
}
/** Fit actual native wrapped rows rather than estimating from newline counts. */
export class ReferenceConversation extends baseComponents.scrollbox {
  protected override onUpdate(deltaTime: number): void {
    super.onUpdate(deltaTime);
    // OpenTUI clamps the thumb when its range reaches zero, but does not restore
    // its size when content grows again unless the viewport also resizes.
    this.verticalScrollBar.slider.viewPortSize = this.verticalScrollBar.viewportSize;
  }
}
export class ReferenceScrollbox extends ReferenceConversation {
  private inset: number;
  constructor(context: RenderContext, options: Options) {
    super(context, { ...options, height: GEOMETRY.outputMaxRows });
    this.inset = options.contentBottomInset ?? 0;
  }
  set contentBottomInset(value: number) {
    this.inset = value;
    this.requestRender();
  }
  protected override onUpdate(deltaTime: number): void {
    super.onUpdate(deltaTime);
    const used = this.getChildren().reduce(
      (bottom, child) => Math.max(bottom, child.y + child.height - this.content.y),
      0,
    );
    const height = Math.min(GEOMETRY.outputMaxRows, used + this.inset);
    if (this.height !== height) this.height = height;
  }
}
declare module "@opentui/react" {
  interface OpenTUIComponents {
    referenceScrollbox: typeof ReferenceScrollbox;
    referenceConversation: typeof ReferenceConversation;
  }
}
