import { useEffect } from "react";
/** All settings forms retain their draft on failure and protect it when leaving the page. */
export function useFormDraft(dirty: boolean): void {
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", prevent);
    return () => {
      window.removeEventListener("beforeunload", prevent);
    };
  }, [dirty]);
}
