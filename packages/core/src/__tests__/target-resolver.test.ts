import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WebTargetDescriptorResolver,
  webTargetDescriptorResolver,
} from "../target-resolver";
import * as signature from "../signature";

describe("TargetDescriptorResolver", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("resolves a DOM element through the existing signature implementation", () => {
    document.body.innerHTML = '<button data-bug-id="save">Save</button>';
    const element = document.querySelector("button")!;

    expect(webTargetDescriptorResolver.resolve(element)).toEqual({
      componentName: "button",
      ancestryHash: signature.hashString("button[data-bug-id=save]"),
      selector: "button[data-bug-id=save]",
    });
  });

  it("returns undefined instead of breaking capture when signature resolution fails", () => {
    document.body.innerHTML = "<button>Save</button>";
    const resolver = new WebTargetDescriptorResolver();
    vi.spyOn(signature, "computeElementSignature").mockImplementation(() => {
      throw new Error("boom");
    });

    expect(resolver.resolve(document.querySelector("button")!)).toBeUndefined();
  });
});
