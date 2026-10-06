export interface InstallationProgress {
  stage(message: string): void;
  update(message: string): void;
  finish(): void;
}

/** Report actual work, throttle streamed bytes, and keep redirected output free of escapes. */
export function installationProgress(): InstallationProgress {
  let lastUpdate = -Infinity;
  let inline = false;
  const finish = () => {
    if (inline) process.stderr.write("\n");
    inline = false;
  };
  return {
    stage(message) {
      finish();
      process.stderr.write(`${message}\n`);
      lastUpdate = -Infinity;
    },
    update(message) {
      const now = Date.now();
      if (now - lastUpdate < 1_000) return;
      lastUpdate = now;
      inline = process.stderr.isTTY;
      process.stderr.write(inline ? `\r\u001b[2K${message}` : `${message}\n`);
    },
    finish,
  };
}
