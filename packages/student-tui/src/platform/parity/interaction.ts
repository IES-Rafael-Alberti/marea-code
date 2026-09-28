import type { Ref } from "react";
import type { ReferenceConversation } from "../adaptive-scrollbox.boundary.js";

export interface ParityInteraction {
  readonly focus: string;
  readonly scroll: Ref<ReferenceConversation>;
  activate(id: string): void;
  focusOn(id: string): void;
}
