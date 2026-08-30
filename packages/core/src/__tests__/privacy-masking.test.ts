/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Crumbtrail } from "../crumbtrail";
import { buildMaskedDomSnapshot, maskElementDescriptor } from "../masking";
import { computeElementPath } from "../signature";
import { DEFAULT_CONFIG } from "../types";

function makeTransport() {
  return {
    sendEvents: vi.fn().mockResolvedValue(undefined),
    sendBlob: vi.fn().mockResolvedValue(undefined),
    startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    sendBugReport: vi.fn().mockResolvedValue(undefined),
  };
}

describe("production privacy masking", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
    history.replaceState({}, "", "/");
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("persists a rage click artifact with no private browser or database values", async () => {
    vi.useFakeTimers();
    history.replaceState(
      {},
      "",
      "/checkout?receipt=URL-private-value-123#private-fragment",
    );
    document.body.innerHTML = `
      <button id="rage" aria-label="Rage private aria">Rage private text</button>
      <a id="private-link" href="/receipt?value=URL-private-value-123#private-fragment">Receipt</a>
      <section data-crumbtrail-unmask id="unmask-parent">
        <span id="unmask-child">Descendant private text</span>
        <input id="unmask-child-input" placeholder="Descendant private placeholder" aria-label="Descendant private aria">
      </section>
      <input id="masked-input" placeholder="Private placeholder" aria-label="Private aria label" aria-description="Private aria description">
      <select id="masked-select" aria-label="Private select aria">
        <option value="catalog-option-value">Private option text</option>
      </select>
      <section data-crumbtrail-block id="blocked">Blocked private text <input id="blocked-input"></section>
    `;
    const maskedInput = document.querySelector(
      "#masked-input",
    ) as HTMLInputElement;
    const unmaskedChildInput = document.querySelector(
      "#unmask-child-input",
    ) as HTMLInputElement;
    const blockedInput = document.querySelector(
      "#blocked-input",
    ) as HTMLInputElement;
    const maskedSelect = document.querySelector(
      "#masked-select",
    ) as HTMLSelectElement;
    maskedInput.value = "masked private value one two three";
    unmaskedChildInput.value = "descendant private value four five six";
    blockedInput.value = "blocked-value-789";

    const transport = makeTransport();
    const logger = Crumbtrail.init({
      transportInstance: transport,
      autoFlagOnSignals: true,
      rageClickThreshold: 3,
      rageClickWindowMs: 1_000,
      autoFlagDebounceMs: 0,
      environment: false,
      network: false,
      flushIntervalMs: 100_000,
      flushBufferSize: 1_000,
      describeInteractionElement: (element) => {
        const select =
          element instanceof HTMLSelectElement ? element : undefined;
        const selected = select?.selectedOptions[0];
        return {
          tag: element.tagName,
          txt: element.textContent,
          placeholder: element.getAttribute("placeholder"),
          "aria-label": element.getAttribute("aria-label"),
          "aria-description": element.getAttribute("aria-description"),
          selectedOptionText: selected?.text,
          selectedOptionValue: selected?.value,
          href: element instanceof HTMLAnchorElement ? element.href : undefined,
        };
      },
    });

    maskedInput.dispatchEvent(new Event("input", { bubbles: true }));
    unmaskedChildInput.dispatchEvent(new Event("input", { bubbles: true }));
    maskedSelect.dispatchEvent(new Event("change", { bubbles: true }));
    blockedInput.dispatchEvent(new Event("input", { bubbles: true }));
    const paste = new Event("paste", { bubbles: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { getData: () => "Clipboard private value" },
    });
    maskedInput.dispatchEvent(paste);
    document
      .querySelector("#unmask-child")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    document
      .querySelector("#blocked")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const privateLink = document.querySelector("#private-link");
    privateLink?.addEventListener("click", (event) => event.preventDefault());
    privateLink?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    logger.addEvent({
      type: "db.diff",
      data: {
        table: "customers",
        pk: { id: 42 },
        after: { name: "Database private value", email: "db@example.test" },
        connection: {
          host: "private-db.internal",
          database: "tenant_private",
          role: "replica",
        },
      },
    });
    logger.addEvent({
      type: "db.diff.bulk",
      data: {
        table: "customers",
        samplePks: [{ id: 42, email: "bulk@example.test" }],
        values: [{ name: "Bulk database private value" }],
      },
    });

    const rageButton = document.querySelector("#rage") as HTMLButtonElement;
    rageButton.click();
    rageButton.click();
    rageButton.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(transport.sendBugReport).toHaveBeenCalledTimes(1);
    expect(transport.sendBugReport.mock.calls[0][0].tags).toContain(
      "auto:rage-click",
    );
    const events = transport.sendBugReport.mock.calls[0][1] as Array<{
      k: string;
      d: Record<string, unknown>;
    }>;
    const persisted = [
      ...transport.startSession.mock.calls.map((call) => call[1]),
      ...transport.sendEvents.mock.calls.flatMap((call) => call[0]),
      ...transport.sendBugReport.mock.calls.map((call) => call[0]),
      ...transport.sendBugReport.mock.calls.flatMap((call) => call[1]),
    ];
    const captured = JSON.stringify(persisted);
    const leaks = [
      "Rage private text",
      "Rage private aria",
      "masked private value one two three",
      "Descendant private text",
      "descendant private value four five six",
      "Descendant private placeholder",
      "Descendant private aria",
      "Private placeholder",
      "Private aria label",
      "Private aria description",
      "Private select aria",
      "Private option text",
      "Blocked private text",
      "blocked-value-789",
      "Database private value",
      "db@example.test",
      "Clipboard private value",
      '"id":42',
      "bulk@example.test",
      "Bulk database private value",
      "private-db.internal",
      "tenant_private",
      "blocked-input",
      "URL-private-value-123",
      "private-fragment",
    ];

    for (const leak of leaks) expect(captured).not.toContain(leak);

    // A `<select>` value is an enum the developers wrote, not something a user typed, and it is kept
    // for the same reason the same string is kept in a request body. The option's visible TEXT is
    // still masked, because that is page content.
    expect(captured).toContain("catalog-option-value");

    const dbDiff = events.find((event) => event.k === "db.diff");
    expect(dbDiff?.d.after).toEqual({
      name: "******** ******* *****",
      email: "***************",
    });
    expect(dbDiff?.d.pk).toEqual({ id: "[REDACTED]" });
    expect(dbDiff?.d.connection).toEqual({
      host: "*******************",
      database: "**************",
      role: "replica",
    });
    const dbDiffBulk = events.find((event) => event.k === "db.diff.bulk");
    expect(dbDiffBulk?.d.samplePks).toEqual([
      { id: "[REDACTED]", email: "*****************" },
    ]);
    expect(dbDiffBulk?.d.values).toEqual([
      { name: "**** ******** ******* *****" },
    ]);
    const domSnapshot = events.find((event) => event.k === "dom.snap");
    expect(domSnapshot?.d.html).toContain('placeholder="******* ***********"');
    expect(domSnapshot?.d.html).toContain('value="********************"');
    expect(domSnapshot?.d.html).not.toContain("Blocked private text");

    await logger.stop();
  });
});

/**
 * `maskAllInputs` decides how a masked value is rendered. It is not a second, independent decision
 * about whether to mask, and when it behaved like one it silently overrode the redaction policy that
 * had already cleared the field.
 */
describe("application-declared input keeps", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  async function typedValues(
    keepFields: string[],
    redaction: Record<string, unknown> = {},
  ) {
    document.body.innerHTML = `
      <input id="filter" name="maxPrice">
      <input id="who" name="fullName">
    `;
    const filter = document.querySelector("#filter") as HTMLInputElement;
    const who = document.querySelector("#who") as HTMLInputElement;
    filter.value = "250";
    who.value = "Ada Lovelace";

    const transport = makeTransport();
    const logger = Crumbtrail.init({
      transportInstance: transport,
      environment: false,
      network: false,
      flushIntervalMs: 100_000,
      flushBufferSize: 1_000,
      redaction: { keepFields, ...redaction },
    });

    filter.dispatchEvent(new Event("input", { bubbles: true }));
    who.dispatchEvent(new Event("input", { bubbles: true }));
    await logger.stop();

    return transport.sendEvents.mock.calls
      .flatMap(
        ([events]) => events as Array<{ k: string; d: { val?: unknown } }>,
      )
      .filter((event) => event.k === "inp")
      .map((event) => String(event.d.val));
  }

  it("records a number the shopper typed", async () => {
    expect(await typedValues([])).toContain("250");
  });

  it("masks a name the shopper typed", async () => {
    const values = await typedValues([]);

    expect(values.some((value) => value.includes("Ada"))).toBe(false);
  });

  // The deployment-level opt-out counsel required.
  it("records nothing a user typed when the application opts out", async () => {
    const values = await typedValues(["maxPrice", "fullName"], {
      captureInputValues: false,
    });

    expect(values.some((value) => value.includes("250"))).toBe(false);
    expect(values.some((value) => value.includes("Ada"))).toBe(false);
  });

  it("records free text in a field the application named", async () => {
    expect(await typedValues(["fullName"])).toContain("Ada Lovelace");
  });
});

// `sanitizeElement` removes blocked CHILDREN and never tested the root it was
// handed, so a snapshot scoped to a blocked element serialized the whole
// subtree with only ordinary masking — the strongest opt-out the SDK offers,
// silently defeated.
describe("buildMaskedDomSnapshot and data-crumbtrail-block", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  // Ordinary masking is not the same guarantee: an element marked
  // data-crumbtrail-unmask contributes clear text through it by design, and
  // structure, ids and hrefs survive it entirely. Inside a blocked subtree none
  // of that may be serialized at all.
  it("returns nothing for a root that is itself blocked", () => {
    document.body.innerHTML =
      '<section data-crumbtrail-block id="pay-panel">' +
      "<span data-crumbtrail-unmask>Card 4111111111111111</span>" +
      '<a id="receipt-for-alice" href="/receipts/alice@example.com">Receipt</a>' +
      "</section>";

    const html = buildMaskedDomSnapshot(
      document.querySelector("#pay-panel") as HTMLElement,
      DEFAULT_CONFIG,
    );

    expect(html).not.toContain("4111111111111111");
    expect(html).not.toContain("alice@example.com");
    expect(html).not.toContain("receipt-for-alice");
  });

  it("returns nothing for a root inside a blocked ancestor", () => {
    document.body.innerHTML =
      '<section data-crumbtrail-block><div id="inner">' +
      "<span data-crumbtrail-unmask>Card 4111111111111111</span></div></section>";

    const html = buildMaskedDomSnapshot(
      document.querySelector("#inner") as HTMLElement,
      DEFAULT_CONFIG,
    );

    expect(html).not.toContain("4111111111111111");
  });

  it("still snapshots an ordinary root", () => {
    document.body.innerHTML = '<section id="ok"><p>Total</p></section>';

    const html = buildMaskedDomSnapshot(
      document.querySelector("#ok") as HTMLElement,
      DEFAULT_CONFIG,
    );

    expect(html).toContain("<p>");
  });
});

describe("structural path redaction", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  const masking = { ...DEFAULT_CONFIG, maskAllText: true as const };

  it("redacts a PII-shaped id even though the path quotes it", () => {
    // The path writes `[id="user-a@b.com"]`. The classifier reads the value,
    // not the quotes, so the quotes come off before the shape is judged.
    document.body.innerHTML = '<button id="user-alice@example.com">go</button>';
    const el = document.querySelector("button") as HTMLElement;
    const masked = maskElementDescriptor(
      el,
      { path: computeElementPath(el) },
      masking,
    );

    expect(masked.path).not.toContain("alice@example.com");
    expect(masked.path).toBe('button[id="[REDACTED]"]');
  });

  it("leaves an ordinary id alone, quotes intact", () => {
    document.body.innerHTML = '<button data-testid="cart/item">go</button>';
    const el = document.querySelector("button") as HTMLElement;
    const masked = maskElementDescriptor(
      el,
      { path: computeElementPath(el) },
      masking,
    );

    expect(masked.path).toBe('button[data-testid="cart/item"]');
  });
});
