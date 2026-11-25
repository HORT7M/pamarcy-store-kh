import type { Dict } from "./dictionaries";

type Path<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Path<T[K], `${P}${K}.`>;
}[keyof T & string];
export type TKey = Path<Dict>;

export function makeT(dict: Dict) {
  return (key: TKey, vars?: Record<string, string | number>): string => {
    const v = key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], dict);
    let s = typeof v === "string" ? v : key;
    if (vars) {
      for (const [k, val] of Object.entries(vars)) {
        const replacement = String(val);
        s = s.replaceAll(`{${k}}`, () => replacement);
      }
    }
    return s;
  };
}
