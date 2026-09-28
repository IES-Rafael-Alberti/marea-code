/** @jsxImportSource @opentui/react */
import type { ReactNode } from "react";

import { PALETTE } from "../../parity/tokens.js";

/**
 * The frame an approval and a question set share: a boxed panel on the panel
 * colour, amber while it is waiting for the student and quiet once it is not.
 */

export interface InlinePanelProperties {
  readonly children: ReactNode;
  readonly id?: string | undefined;
  readonly resolved: boolean;
}

export function InlinePanel({ children, resolved, id }: InlinePanelProperties) {
  return (
    <box
      {...(id === undefined ? {} : { id })}
      backgroundColor={PALETTE.surface}
      border
      borderColor={resolved ? PALETTE.panel : PALETTE.warning}
      flexDirection="column"
      marginBottom={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
    >
      {children}
    </box>
  );
}
