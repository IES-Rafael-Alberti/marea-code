export default {
  mount: (element: HTMLElement): (() => void) => {
    element.textContent = "Synthetic fixture";
    return () => {
      element.textContent = "";
    };
  },
};
