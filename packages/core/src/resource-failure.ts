const RESOURCE_URL_PROPERTIES: Record<string, readonly string[]> = {
  script: ["src"],
  link: ["href"],
  img: ["currentSrc", "src"],
  iframe: ["src"],
  frame: ["src"],
  audio: ["currentSrc", "src"],
  video: ["currentSrc", "src"],
  source: ["src"],
  track: ["src"],
  object: ["data"],
  embed: ["src"],
  input: ["src"],
};

export interface ResourceFailure {
  element: string;
  url: string;
}

/** Resolves only browser-managed resource targets, never runtime error targets. */
export function resourceFailureForTarget(
  target: EventTarget | null,
): ResourceFailure | undefined {
  if (!target || typeof target !== "object") return undefined;

  const element = target as Element & Record<string, unknown>;
  const tagName =
    typeof element.tagName === "string" ? element.tagName.toLowerCase() : "";
  const properties = RESOURCE_URL_PROPERTIES[tagName];
  if (!properties) return undefined;

  for (const property of properties) {
    const value = element[property];
    if (typeof value !== "string" || value.length === 0) continue;
    try {
      return {
        element: tagName,
        url: new URL(value, document.baseURI).href,
      };
    } catch {
      return { element: tagName, url: value };
    }
  }

  const getAttribute = element.getAttribute;
  if (typeof getAttribute === "function") {
    for (const attribute of properties) {
      const value = getAttribute.call(element, attribute);
      if (!value) continue;
      try {
        return {
          element: tagName,
          url: new URL(value, document.baseURI).href,
        };
      } catch {
        return { element: tagName, url: value };
      }
    }
  }

  return undefined;
}
