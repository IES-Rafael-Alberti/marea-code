/** Bounded dynamic-programming glob matching; no regular-expression backtracking. */
export function projectGlob(pattern: string, path: string): boolean {
  const memo = new Map<string, boolean>();
  const match = (p: number, s: number): boolean => {
    const key = `${String(p)}:${String(s)}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    if (p === pattern.length) result = s === path.length;
    else if (pattern[p] === "*") {
      const deep = pattern[p + 1] === "*";
      const next = p + (deep ? 2 : 1);
      if (deep && pattern[next] === "/") {
        result = match(next + 1, s);
        for (const slash of path.slice(s).matchAll(/\//g)) {
          if (result) break;
          result = match(next + 1, s + slash.index + 1);
        }
      } else {
        result =
          match(next, s) || (path.slice(s) !== "" && (deep || path[s] !== "/") && match(p, s + 1));
      }
    } else
      result =
        (pattern[p] === path[s] || (pattern[p] === "?" && path[s] !== "/")) && match(p + 1, s + 1);
    memo.set(key, result);
    return result;
  };
  return match(0, 0);
}
