/** @jsxImportSource @opentui/react */
import { useRenderer } from "@opentui/react";
import { useEffect, useState } from "react";
import { PALETTE } from "../../parity/tokens.js";

export function ClipboardNotice({
  text,
  quitHint,
}: {
  readonly text: string;
  readonly quitHint: string;
}) {
  const renderer = useRenderer();
  const [visible, setVisible] = useState<string | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = (message: string) => {
      clearTimeout(timer);
      setVisible(message);
      timer = setTimeout(() => {
        setVisible(null);
      }, 1500);
    };
    const copied = () => {
      show(text);
    };
    const quit = () => {
      show(quitHint);
    };
    renderer.on("marea:copied", copied);
    renderer.on("marea:quit-hint", quit);
    return () => {
      renderer.off("marea:copied", copied);
      renderer.off("marea:quit-hint", quit);
      clearTimeout(timer);
    };
  }, [renderer, text, quitHint]);
  return visible ? (
    <box position="absolute" bottom={4} right={2} backgroundColor={PALETTE.surface} padding={1}>
      <text fg={PALETTE.text}>{visible}</text>
    </box>
  ) : null;
}
