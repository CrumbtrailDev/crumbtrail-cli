import copy from "./copy.json";

export const witnessCopy = (
  key: keyof typeof copy,
  vars: Record<string, string> = {},
) =>
  copy[key].replace(
    /\{(\w+)\}/g,
    (_, name: string) => vars[name] ?? `{${name}}`,
  );
