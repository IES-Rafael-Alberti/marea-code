import type { PointerOrigin } from "./parity/pointer-action.js";
import { ReferenceScrollbox, ReferenceConversation } from "./adaptive-scrollbox.boundary.js";
import { RGBA } from "@opentui/core";
import type { BoxOptions, OptimizedBuffer, RenderContext } from "@opentui/core";
import { baseComponents, extend } from "@opentui/react";

interface ReferenceBoxOptions extends BoxOptions {
  referenceBottomColor?: string;
  referencePressed?: boolean;
  referenceBorder?: "tall" | "button" | null;
}

class ReferenceBox extends baseComponents.box {
  referencePointerOrigin: PointerOrigin = null;
  private pressed: boolean;
  private bottomColor: string | undefined;
  private variant: "tall" | "button" | null;
  constructor(context: RenderContext, options: ReferenceBoxOptions) {
    super(context, options);
    this.bottomColor = options.referenceBottomColor;
    this.pressed = options.referencePressed ?? false;
    this.variant = options.referenceBorder ?? null;
  }
  set referencePressed(value: boolean) {
    this.pressed = value;
    this.requestRender();
  }
  set referenceBottomColor(value: string | undefined) {
    this.bottomColor = value;
    this.requestRender();
  }
  set referenceBorder(value: "tall" | "button" | null) {
    this.variant = value;
    this.requestRender();
  }
  protected override renderSelf(buffer: OptimizedBuffer): void {
    super.renderSelf(buffer);
    if (this.variant === null || this.width < 2 || this.height < 2) return;
    const { x, y, width, height } = this;
    const draw = (text: string, left: number, top: number) => {
      buffer.drawText(text, left, top, this.borderColor, this.backgroundColor);
    };
    if (this.variant === "button") {
      const lower =
        this.bottomColor === undefined ? this.borderColor : RGBA.fromHex(this.bottomColor);
      buffer.drawText(
        (this.pressed ? "▁" : "▔").repeat(width),
        x,
        y,
        this.pressed ? lower : this.borderColor,
        this.backgroundColor,
      );
      buffer.drawText(
        (this.pressed ? "▔" : "▁").repeat(width),
        x,
        y + height - 1,
        this.pressed ? this.borderColor : lower,
        this.backgroundColor,
      );
      return;
    }
    if (width > 2) {
      draw("▔".repeat(width - 2), x + 1, y);
      draw("▁".repeat(width - 2), x + 1, y + height - 1);
    }
    for (let row = 0; row < height; row++) {
      buffer.drawText("▊", x, y + row, this.backgroundColor, this.borderColor);
      draw("▎", x + width - 1, y + row);
    }
  }
}

declare module "@opentui/react" {
  interface OpenTUIComponents {
    referenceBox: typeof ReferenceBox;
  }
}

export function registerReferenceBoxes(): void {
  extend({
    referenceBox: ReferenceBox,
    referenceScrollbox: ReferenceScrollbox,
    referenceConversation: ReferenceConversation,
  });
}
