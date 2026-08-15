/**
 * The encoder against the golden fixtures.
 *
 * These files are the whole contract with the decoder in the other repository:
 * neither side imports the other, so a format change that does not change a
 * fixture is a change that broke the format silently, and it would fail months
 * later at read time with the evidence already gone.
 *
 * The comparison is structural (`JSON.parse` deep equality) rather than byte
 * for byte, because Prettier owns formatting in each repository separately and
 * whitespace cannot reach a stored session: a chunk is gzipped before it is
 * ever written.
 */

import { describe, expect, it } from "vitest";
import { ChunkBuilder } from "../replay/chunk";
import { ReplayEventTag } from "../replay/format";
import { NodeIds, serializeNode } from "../replay/serialize";
import goldenChunk0 from "./fixtures/replay/chunk-0.json";

/**
 * The page `chunk-0.json` describes, parsed as real DOM.
 *
 * Written on one line deliberately: whitespace between tags is a text node, and
 * a text node is a node with an id, so a prettier version of this markup would
 * be a different tree from the one the fixture pins.
 */
const CHECKOUT_HTML =
  "<!DOCTYPE html><html><head><title>Checkout</title></head><body>" +
  '<div class="cart"><span class="total">$42.00</span></div>' +
  '<input type="email" name="email"></body></html>';

function checkoutPage(): Document {
  return new DOMParser().parseFromString(CHECKOUT_HTML, "text/html");
}

describe("golden fixture chunk-0", () => {
  it("is what the encoder produces for the page it describes", () => {
    const doc = checkoutPage();
    const chunk = new ChunkBuilder(0, 1784731358410);
    const ids = new NodeIds();
    const options = {
      masking: "inputs_masked" as const,
      intern: (value: string) => chunk.intern(value),
      ids,
    };

    const root = serializeNode(doc, options);
    chunk.push([ReplayEventTag.Snapshot, 0, root, 1280, 720]);

    // The input is node 11: document 1, doctype 2, html 3, head 4, title 5,
    // its text 6, body 7, div 8, span 9, its text 10, input 11. Ids are
    // assigned in document order, which is what makes them reproducible.
    const inputId = ids.known(doc.querySelector("input") as Node);
    expect(inputId).toBe(11);
    const totalTextId = ids.known(
      doc.querySelector("span.total")?.firstChild as Node,
    );
    expect(totalTextId).toBe(10);

    chunk.push([
      ReplayEventTag.Pointer,
      120,
      [
        [0, 640, 360],
        [40, 648, 372],
      ],
    ]);
    chunk.push([ReplayEventTag.Interact, 400, inputId, chunk.intern("click")]);
    chunk.push([
      ReplayEventTag.Input,
      900,
      inputId,
      chunk.intern("****@*****.com"),
      null,
    ]);
    chunk.push([
      ReplayEventTag.Mutation,
      1500,
      [],
      [],
      [],
      [[totalTextId, chunk.intern("$38.00")]],
    ]);
    chunk.push([
      ReplayEventTag.Navigate,
      2000,
      chunk.intern("https://shop.example.com/checkout"),
    ]);
    chunk.push([ReplayEventTag.Gap, 2100, 30000, chunk.intern("idle")]);

    expect(JSON.parse(JSON.stringify(chunk.toJSON()))).toEqual(goldenChunk0);
  });

  it("interns strings in first-seen order, which is the order an encoder meets them", () => {
    const chunk = new ChunkBuilder(0, 0);
    const ids = new NodeIds();
    serializeNode(checkoutPage(), {
      masking: "inputs_masked",
      intern: (value: string) => chunk.intern(value),
      ids,
    });
    // Tag before its attributes, attributes before children. A table in any
    // other order is one no encoder could have produced, which would leave the
    // contract unsatisfiable on this side while every decoder test still passed.
    expect(chunk.toJSON().s.slice(0, 8)).toEqual([
      "html",
      "head",
      "title",
      "Checkout",
      "body",
      "div",
      "class",
      "cart",
    ]);
  });
});
