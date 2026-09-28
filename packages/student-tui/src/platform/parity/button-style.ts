import { PALETTE } from "../../parity/tokens.js";

const STYLES: Readonly<Record<string, { edge: string; bottom: string; text: string }>> = {
  [PALETTE.buttonApprove]: {
    edge: PALETTE.buttonApproveEdge,
    bottom: "#008139",
    text: PALETTE.buttonApproveText,
  },
  [PALETTE.buttonApproveFocused]: {
    edge: PALETTE.buttonApproveEdge,
    bottom: "#008139",
    text: PALETTE.buttonApproveFocusedText,
  },
  [PALETTE.buttonReject]: {
    edge: PALETTE.buttonRejectEdge,
    bottom: "#780028",
    text: PALETTE.buttonRejectText,
  },
  [PALETTE.buttonPrimary]: {
    edge: PALETTE.buttonPrimaryEdge,
    bottom: "#004295",
    text: PALETTE.buttonPrimaryText,
  },
};
export function buttonStyle(background: string, disabled: boolean) {
  if (disabled)
    return {
      edge:
        background === PALETTE.buttonRetryDisabled ? PALETTE.surface : PALETTE.buttonDisabledEdge,
      bottom: background === PALETTE.buttonRetryDisabled ? "#0f0f0f" : "#151515",
      text: PALETTE.buttonDisabledText,
    };
  return (
    STYLES[background] ?? { edge: PALETTE.buttonDefaultEdge, bottom: "#0d0d0d", text: PALETTE.text }
  );
}
