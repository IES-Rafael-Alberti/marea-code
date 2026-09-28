/** Coalesce streamed text, but flush interactions and final output immediately. */
export function createRenderSchedule(render: () => void) {
  let pending: ReturnType<typeof setTimeout> | undefined;
  return {
    request(streaming: boolean): void {
      if (streaming) {
        pending ??= setTimeout(() => {
          pending = undefined;
          render();
        }, 33);
      } else {
        clearTimeout(pending);
        pending = undefined;
        render();
      }
    },
    dispose(): void {
      clearTimeout(pending);
    },
  };
}
