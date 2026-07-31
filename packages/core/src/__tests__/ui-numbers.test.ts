import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../event-bus";
import type { BugEvent, CrumbtrailConfig } from "../types";
import {
  CAPTURE_GAP_EVENT_KIND,
  DEFAULT_CONFIG,
  UI_LAYOUT_EVENT_KIND,
  UI_NUM_EVENT_KIND,
} from "../types";
import { REDACTED_VALUE } from "../redaction";
import {
  parseNumericToken,
  scanUiNumbers,
  uiNumbersCollector,
  UI_NUM_MAX_SCAN_ELEMENTS,
  UI_NUM_SETTLE_MS,
} from "../collectors/ui-numbers";

function makeConfig(
  overrides: Partial<CrumbtrailConfig> = {},
): CrumbtrailConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function collect() {
  const events: BugEvent[] = [];
  const bus = new EventBus();
  bus.subscribe((batch) => events.push(...batch));
  const cleanup = uiNumbersCollector(bus, makeConfig());
  return { events, bus, cleanup };
}

function uiNumEvents(events: BugEvent[]): BugEvent[] {
  return events.filter((event) => event.k === UI_NUM_EVENT_KIND);
}

function captureGapEvents(events: BugEvent[]): BugEvent[] {
  return events.filter((event) => event.k === CAPTURE_GAP_EVENT_KIND);
}

/**
 * Let happy-dom deliver queued MutationObserver callbacks. Delivery rides
 * happy-dom's internally captured (real) timer functions, so fake-timer
 * advancement never fires it — yield real event-loop turns via setImmediate,
 * which the fake-timer config below leaves unmocked.
 */
const realSetTimeout = setTimeout;

async function flushObserverDelivery(): Promise<void> {
  await new Promise((resolve) => realSetTimeout(resolve, 5));
}

async function settle(bus: EventBus): Promise<void> {
  // Two delivery+advance rounds: observer delivery can land after the first
  // fake-timer advancement, leaving the armed debounce for the second round.
  for (let round = 0; round < 2; round += 1) {
    await flushObserverDelivery();
    vi.advanceTimersByTime(UI_NUM_SETTLE_MS);
  }
  bus.flush();
}

describe("parseNumericToken", () => {
  it("parses currency values", () => {
    expect(parseNumericToken("$199.00")).toEqual({ value: 199, unit: "$" });
    expect(parseNumericToken("$1,234.56")).toEqual({
      value: 1234.56,
      unit: "$",
    });
    expect(parseNumericToken("16.42")).toEqual({ value: 16.42 });
    expect(parseNumericToken("8.25%")).toEqual({ value: 8.25, unit: "%" });
  });

  it("rejects prose containing numbers", () => {
    expect(parseNumericToken("3 items in your cart")).toBeNull();
    expect(parseNumericToken("")).toBeNull();
    expect(parseNumericToken("free")).toBeNull();
  });

  it("parses decimal-comma locales", () => {
    expect(parseNumericToken("$129,00", "de-DE")).toEqual({
      value: 129,
      unit: "$",
    });
    expect(parseNumericToken("$1.234,56", "de-DE")).toEqual({
      value: 1234.56,
      unit: "$",
    });
    // fr-FR groups thousands with narrow no-break space.
    expect(parseNumericToken("1 234,56 €", "fr-FR")).toEqual({
      value: 1234.56,
      unit: "€",
    });
    // Comma-decimal needs no lang hint when the shape is unambiguous.
    expect(parseNumericToken("129,00")).toEqual({ value: 129 });
  });

  it("breaks the ambiguous three-digit-tail tie with the page language", () => {
    expect(parseNumericToken("1,234", "en-US")).toEqual({ value: 1234 });
    expect(parseNumericToken("1,234", "de-DE")).toEqual({ value: 1.234 });
    expect(parseNumericToken("1.234", "en-US")).toEqual({ value: 1.234 });
    expect(parseNumericToken("1.234", "de-DE")).toEqual({ value: 1234 });
    // ja-JP groups with commas and uses dot decimals, like en.
    expect(parseNumericToken("$1,235", "ja-JP")).toEqual({
      value: 1235,
      unit: "$",
    });
  });

  it("parses Arabic-Indic digits and separators", () => {
    expect(parseNumericToken("١٢٩٫٠٠", "ar-EG")).toEqual({ value: 129 });
    expect(parseNumericToken("$١٬٢٣٤٫٥٦", "ar-EG")).toEqual({
      value: 1234.56,
      unit: "$",
    });
  });

  it("rejects incoherent separator shapes", () => {
    expect(parseNumericToken("1,23,4", "en-US")).toBeNull();
    expect(parseNumericToken("1.2.3,4.5")).toBeNull();
    expect(parseNumericToken("12,3456")).toBeNull();
  });
});

describe("scanUiNumbers element budget", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("returns a region map for a DOM within budget", () => {
    document.body.innerHTML = `<dl class="totals"><dt>Total</dt><dd>$9.99</dd></dl>`;
    const scan = scanUiNumbers(document.body);
    expect(scan).not.toBeNull();
    expect(scan!.truncated).toEqual([]);
    expect(scan!.regions.get("dl.totals")).toEqual([
      { label: "Total", value: 9.99, unit: "$" },
    ]);
  });

  it("returns null (over budget) when the element count exceeds the cap", () => {
    // A tiny injected cap keeps the DOM small: three elements over a cap of 1.
    document.body.innerHTML = `<dl class="totals"><dt>Total</dt><dd>$9.99</dd></dl>`;
    expect(scanUiNumbers(document.body, undefined, 1)).toBeNull();
  });

  it("captures a labeled rendered ISO day without serializing surrounding text", () => {
    document.body.innerHTML = `
      <ul class="order-list">
        <li>
          <strong>Order #1</strong>
          <span>2026-07-28 <span class="badge"> · Today</span> · placed</span>
        </li>
      </ul>`;
    const scan = scanUiNumbers(document.body);
    expect(scan?.regions.get("ul.order-list")).toContainEqual({
      label: "Order #1",
      value: Math.floor(Date.UTC(2026, 6, 28) / 86_400_000),
      unit: "iso-day",
    });
  });

  it("drops rendered ISO days under sensitive labels", () => {
    document.body.innerHTML = `<dl><dt>Birthdate</dt><dd>1990-01-02</dd></dl>`;
    expect(scanUiNumbers(document.body)?.regions.get("dl")).toBeUndefined();
  });
});

describe("uiNumbersCollector", () => {
  let cleanups: Array<() => void>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    document.body.innerHTML = "";
    cleanups = [];
  });

  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("emits the spec snapshot for a P3-shaped dl.totals", async () => {
    document.body.innerHTML = `
      <dl class="totals">
        <dt>Subtotal</dt><dd>$199.00</dd>
        <dt>Tax (8.25%)</dt><dd>$16.42</dd>
        <dt>Shipping</dt><dd>$5.00</dd>
        <dt>Total</dt><dd>$199.00</dd>
      </dl>`;

    const { events, bus, cleanup } = collect();
    cleanups.push(cleanup);
    await settle(bus);

    const snapshots = uiNumEvents(events);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].d).toEqual({
      region: "dl.totals",
      items: [
        { label: "Subtotal", value: 199, unit: "$" },
        { label: "Tax (8.25%)", value: 16.42, unit: "$" },
        // "Shipping" must survive: `pin` is word-matched, not a substring.
        { label: "Shipping", value: 5, unit: "$" },
        { label: "Total", value: 199, unit: "$" },
      ],
      lang: null,
      dir: "ltr",
    });
  });

  it("emits only on change: identical re-settle produces nothing, a changed value re-emits", async () => {
    document.body.innerHTML = `
      <dl class="totals">
        <dt>Subtotal</dt><dd id="sub">$199.00</dd>
      </dl>`;

    const { events, bus, cleanup } = collect();
    cleanups.push(cleanup);
    await settle(bus);
    expect(uiNumEvents(events)).toHaveLength(1);

    // Same content mutated in place — settle again, no new snapshot.
    document.getElementById("sub")!.textContent = "$199.00";
    await settle(bus);
    expect(uiNumEvents(events)).toHaveLength(1);

    // Changed value — re-emits.
    document.getElementById("sub")!.textContent = "$205.00";
    await settle(bus);
    const snapshots = uiNumEvents(events);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1].d).toEqual({
      region: "dl.totals",
      items: [{ label: "Subtotal", value: 205, unit: "$" }],
      lang: null,
      dir: "ltr",
    });
  });

  it("scans a page that never settles once deferral hits the ceiling", async () => {
    // A live page (stock ticker, SSE feed) can mutate faster than
    // UI_NUM_SETTLE_MS forever. Every mutation re-arms the debounce, so
    // without the deferral ceiling the scan starves and the collector emits
    // nothing on exactly the pages where live numbers are the evidence.
    document.body.innerHTML = `
      <dl class="totals">
        <dt>Total</dt><dd id="tick">$199.00</dd>
      </dl>`;
    // Date joins the fake clock so the collector's deferral arithmetic moves
    // with advanceTimersByTime instead of real wall time.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    const { events, bus, cleanup } = collect();
    cleanups.push(cleanup);

    // 8 mutations at 400ms spacing: the settle window (500ms) never elapses
    // quietly, but total deferral (3200ms) crosses UI_NUM_MAX_WAIT_MS.
    for (let i = 0; i < 8; i += 1) {
      document.getElementById("tick")!.textContent = `$${199 + i}.00`;
      await flushObserverDelivery();
      vi.advanceTimersByTime(400);
    }
    bus.flush();

    expect(uiNumEvents(events).length).toBeGreaterThanOrEqual(1);
  });

  it("withholds an over-cap region and reports it as a capture gap", async () => {
    const rows = Array.from(
      { length: 60 },
      (_, i) => `<dt>Line ${i}</dt><dd>$${i}.00</dd>`,
    ).join("");
    document.body.innerHTML = `<dl id="big">${rows}</dl>`;

    const { events, bus, cleanup } = collect();
    cleanups.push(cleanup);
    await settle(bus);

    // Clipping to UI_NUM_MAX_ITEMS is the outcome this must never produce: a
    // region that looks whole and is not manufactures a false arithmetic
    // mismatch downstream.
    expect(uiNumEvents(events)).toHaveLength(0);
    const gaps = captureGapEvents(events);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].d).toMatchObject({
      surface: "browser",
      reason: "scan_budget_exceeded",
      droppedEventCount: 60,
    });
  });

  it("keeps capturing other regions when one is over cap", async () => {
    const rows = Array.from(
      { length: 60 },
      (_, i) => `<dt>Line ${i}</dt><dd>$${i}.00</dd>`,
    ).join("");
    document.body.innerHTML = `
      <dl id="big">${rows}</dl>
      <dl class="totals"><dt>Total</dt><dd>$9.99</dd></dl>`;

    const { events, bus, cleanup } = collect();
    cleanups.push(cleanup);
    await settle(bus);

    // Unlike the element budget, an over-cap region is not a collector fault.
    const snapshots = uiNumEvents(events);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].d).toMatchObject({ region: "dl.totals" });
    expect(captureGapEvents(events)).toHaveLength(1);
  });

  it("reports an over-cap region once, not on every rescan", async () => {
    const rows = Array.from(
      { length: 60 },
      (_, i) => `<dt>Line ${i}</dt><dd>$${i}.00</dd>`,
    ).join("");
    document.body.innerHTML = `<dl id="big">${rows}</dl>`;

    const { events, bus, cleanup } = collect();
    cleanups.push(cleanup);
    await settle(bus);

    // A dashboard mutating on a timer rescans indefinitely; the gap is a
    // statement about the region, so it is made once.
    for (let tick = 0; tick < 3; tick += 1) {
      document.querySelector("#big dd")!.textContent = `$${tick + 100}.00`;
      await settle(bus);
    }

    expect(captureGapEvents(events)).toHaveLength(1);
  });

  it("drops items with deny-listed labels entirely (no redacted-label+value pair)", async () => {
    document.body.innerHTML = `
      <dl class="totals">
        <dt>Card number</dt><dd>4242</dd>
        <dt>Balance</dt><dd>$50.00</dd>
      </dl>`;

    const { events, bus, cleanup } = collect();
    cleanups.push(cleanup);
    await settle(bus);

    const snapshots = uiNumEvents(events);
    expect(snapshots).toHaveLength(1);
    // The deny-labeled item is absent — its value (4242) must not survive
    // under a "[REDACTED]" label.
    expect(snapshots[0].d).toEqual({
      region: "dl.totals",
      items: [{ label: "Balance", value: 50, unit: "$" }],
      lang: null,
      dir: "ltr",
    });
    expect(JSON.stringify(events)).not.toContain(REDACTED_VALUE);
    expect(JSON.stringify(events)).not.toContain("4242");
  });

  it("skips Luhn-passing 13-19 digit values and absurd-length digit runs", async () => {
    document.body.innerHTML = `
      <dl class="totals">
        <dt>Reference</dt><dd>4242424242424242</dd>
        <dt>Trace</dt><dd>12345678901234567890</dd>
        <dt>Order number</dt><dd>123456789</dd>
        <dt>Total</dt><dd>$50.00</dd>
      </dl>`;

    const { events, bus, cleanup } = collect();
    cleanups.push(cleanup);
    await settle(bus);

    const snapshots = uiNumEvents(events);
    expect(snapshots).toHaveLength(1);
    // The unspaced PAN and the > 16 digit run are dropped; the 9-digit
    // order number (accepted residual) and the total are kept.
    expect(snapshots[0].d).toEqual({
      region: "dl.totals",
      items: [
        { label: "Order number", value: 123456789 },
        { label: "Total", value: 50, unit: "$" },
      ],
      lang: null,
      dir: "ltr",
    });
  });

  it("drops items whose label matches config redaction.denyFields", async () => {
    document.body.innerHTML = `
      <dl class="totals">
        <dt>Balance</dt><dd>$50.00</dd>
        <dt>Total</dt><dd>$9.99</dd>
      </dl>`;

    const events: BugEvent[] = [];
    const bus = new EventBus();
    bus.subscribe((batch) => events.push(...batch));
    const cleanup = uiNumbersCollector(
      bus,
      makeConfig({ redaction: { denyFields: ["balance"] } }),
    );
    cleanups.push(cleanup);
    await settle(bus);

    const snapshots = uiNumEvents(events);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].d).toEqual({
      region: "dl.totals",
      items: [{ label: "Total", value: 9.99, unit: "$" }],
      lang: null,
      dir: "ltr",
    });
  });

  it("drops PII-shaped region id/class fragments back to the bare tag name", async () => {
    document.body.innerHTML = `
      <dl id="user-omar@example.com">
        <dt>Balance</dt><dd>$50.00</dd>
      </dl>
      <ul class="tok-eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEFghiJKLmno">
        <li><span>Count</span> <span>3</span></li>
      </ul>`;

    const { events, bus, cleanup } = collect();
    cleanups.push(cleanup);
    await settle(bus);

    const regions = uiNumEvents(events).map(
      (event) => (event.d as { region: string }).region,
    );
    expect(regions).toContain("dl");
    expect(regions).toContain("ul");
    expect(JSON.stringify(events)).not.toContain("omar@example.com");
    expect(JSON.stringify(events)).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("keeps ordinary region identifiers intact", async () => {
    document.body.innerHTML = `
      <section id="cart-summary">
        <dl class="totals"><dt>Total</dt><dd>$9.99</dd></dl>
      </section>`;

    const { events, bus, cleanup } = collect();
    cleanups.push(cleanup);
    await settle(bus);

    const snapshots = uiNumEvents(events);
    expect(snapshots).toHaveLength(1);
    expect((snapshots[0].d as { region: string }).region).toBe("dl.totals");
  });

  it("ignores section-level aria-label but honors row-level aria-label", async () => {
    document.body.innerHTML = `
      <section aria-label="Order summary">
        <table id="cart">
          <tr aria-label="Item total"><td>$25.00</td></tr>
          <tr><td>Quantity</td><td>2</td></tr>
        </table>
      </section>`;

    const { events, bus, cleanup } = collect();
    cleanups.push(cleanup);
    await settle(bus);

    const snapshots = uiNumEvents(events);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].d).toEqual({
      region: "table#cart",
      items: [
        { label: "Item total", value: 25, unit: "$" },
        { label: "Quantity", value: 2 },
      ],
      lang: null,
      dir: "ltr",
    });
  });

  it("resolves labels from aria-label and preceding text in the same row", async () => {
    document.body.innerHTML = `
      <table id="cart">
        <tr><td>Quantity</td><td>2</td></tr>
        <tr><td aria-label="Unit price">$25.00</td></tr>
      </table>`;

    const { events, bus, cleanup } = collect();
    cleanups.push(cleanup);
    await settle(bus);

    const snapshots = uiNumEvents(events);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].d).toEqual({
      region: "table#cart",
      items: [
        { label: "Quantity", value: 2 },
        { label: "Unit price", value: 25, unit: "$" },
      ],
      lang: null,
      dir: "ltr",
    });
  });

  it("scans again after a navigation commit", async () => {
    document.body.innerHTML = "";
    const { events, bus, cleanup } = collect();
    cleanups.push(cleanup);
    await settle(bus);
    expect(uiNumEvents(events)).toHaveLength(0);

    document.body.innerHTML = `<dl class="totals"><dt>Total</dt><dd>$9.99</dd></dl>`;
    history.pushState(null, "", "/checkout");
    vi.advanceTimersByTime(UI_NUM_SETTLE_MS);
    bus.flush();

    expect(uiNumEvents(events)).toHaveLength(1);
    history.replaceState(null, "", "/");
  });

  it("degrades to a capture_gap event when the observer cannot start", () => {
    const original = globalThis.MutationObserver;
    class ExplodingObserver {
      constructor() {
        throw new TypeError("observer construction failed");
      }
    }
    vi.stubGlobal("MutationObserver", ExplodingObserver);
    try {
      const events: BugEvent[] = [];
      const bus = new EventBus();
      bus.subscribe((batch) => events.push(...batch));
      const cleanup = uiNumbersCollector(bus, makeConfig());
      cleanups.push(cleanup);
      bus.flush();

      expect(uiNumEvents(events)).toHaveLength(0);
      const gap = events.find((event) => event.k === "capture_gap");
      expect(gap?.d).toMatchObject({
        surface: "browser",
        reason: "capture_exception",
      });
      expect(cleanup).not.toThrow();
    } finally {
      vi.stubGlobal("MutationObserver", original);
      vi.unstubAllGlobals();
    }
  });

  it("disables the collector and emits a single capture_gap when a scan throws", async () => {
    document.body.innerHTML = `<dl class="totals"><dt>Total</dt><dd>$1.00</dd></dl>`;
    const { events, bus, cleanup } = collect();
    cleanups.push(cleanup);

    const spy = vi
      .spyOn(document.body, "querySelectorAll")
      .mockImplementation(() => {
        throw new Error("scan failed");
      });
    await settle(bus);
    spy.mockRestore();

    expect(uiNumEvents(events)).toHaveLength(0);
    const gaps = events.filter((event) => event.k === "capture_gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0].d).toMatchObject({
      surface: "browser",
      reason: "capture_exception",
    });

    // Disabled for the session: further mutations emit nothing.
    document.body.innerHTML = `<dl class="totals"><dt>Total</dt><dd>$2.00</dd></dl>`;
    await settle(bus);
    expect(uiNumEvents(events)).toHaveLength(0);
    expect(events.filter((event) => event.k === "capture_gap")).toHaveLength(1);
  });

  it("disables the collector with a scan_budget_exceeded gap when the DOM exceeds the scan budget", async () => {
    document.body.innerHTML = `<dl class="totals"><dt>Total</dt><dd>$1.00</dd></dl>`;
    const { events, bus, cleanup } = collect();
    cleanups.push(cleanup);

    // Simulate a page that blows the element budget without materializing tens
    // of thousands of nodes: report an over-cap length for the scan's root
    // query. scanUiNumbers bails before iterating, so only `.length` matters.
    const spy = vi
      .spyOn(document.body, "querySelectorAll")
      .mockImplementation(
        () =>
          ({ length: UI_NUM_MAX_SCAN_ELEMENTS + 1 }) as unknown as ReturnType<
            typeof document.body.querySelectorAll
          >,
      );
    await settle(bus);
    spy.mockRestore();

    expect(uiNumEvents(events)).toHaveLength(0);
    const gaps = events.filter((event) => event.k === "capture_gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0].d).toMatchObject({
      surface: "browser",
      reason: "scan_budget_exceeded",
    });

    // Disabled for the session: later mutations emit neither snapshots nor a
    // second gap.
    document.body.innerHTML = `<dl class="totals"><dt>Total</dt><dd>$2.00</dd></dl>`;
    await settle(bus);
    expect(uiNumEvents(events)).toHaveLength(0);
    expect(events.filter((event) => event.k === "capture_gap")).toHaveLength(1);
  });

  // --- Layout probe ---
  function layoutEvents(events: BugEvent[]): BugEvent[] {
    return events.filter((event) => event.k === UI_LAYOUT_EVENT_KIND);
  }

  function stubDocumentWidths(scrollW: number, clientW: number): () => void {
    const root = document.documentElement;
    const original = {
      scrollWidth: Object.getOwnPropertyDescriptor(root, "scrollWidth"),
      clientWidth: Object.getOwnPropertyDescriptor(root, "clientWidth"),
    };
    Object.defineProperty(root, "scrollWidth", {
      value: scrollW,
      configurable: true,
    });
    Object.defineProperty(root, "clientWidth", {
      value: clientW,
      configurable: true,
    });
    return () => {
      delete (root as unknown as Record<string, unknown>).scrollWidth;
      delete (root as unknown as Record<string, unknown>).clientWidth;
      if (original.scrollWidth)
        Object.defineProperty(root, "scrollWidth", original.scrollWidth);
      if (original.clientWidth)
        Object.defineProperty(root, "clientWidth", original.clientWidth);
    };
  }

  it("emits one ui.layout event for the initial navigation", async () => {
    const { events, bus, cleanup } = collect();
    cleanups.push(cleanup);
    await settle(bus);

    const layout = layoutEvents(events);
    expect(layout).toHaveLength(1);
    expect(layout[0].d).toMatchObject({
      dir: "ltr",
      lang: null,
      overflowX: 0,
      url: window.location.href,
    });
    expect(layout[0].d.scrollW).toBeTypeOf("number");
    expect(layout[0].d.clientW).toBeTypeOf("number");
  });

  it("reports horizontal overflow", async () => {
    const restore = stubDocumentWidths(1400, 1024);
    try {
      const { events, bus, cleanup } = collect();
      cleanups.push(cleanup);
      await settle(bus);

      expect(layoutEvents(events)[0].d).toMatchObject({
        scrollW: 1400,
        clientW: 1024,
        overflowX: 376,
      });
    } finally {
      restore();
    }
  });

  it("carries the document locale attributes", async () => {
    document.documentElement.lang = "de";
    document.documentElement.dir = "rtl";
    try {
      document.body.innerHTML = `<dl class="totals"><dt>Total</dt><dd>$9.99</dd></dl>`;
      const { events, bus, cleanup } = collect();
      cleanups.push(cleanup);
      await settle(bus);

      expect(layoutEvents(events)[0].d).toMatchObject({
        dir: "rtl",
        lang: "de",
      });
      expect(uiNumEvents(events)[0].d).toMatchObject({
        lang: "de",
        dir: "rtl",
      });
    } finally {
      document.documentElement.lang = "";
      document.documentElement.dir = "";
    }
  });

  it("reports active physical CSS rules under RTL without capturing selectors", async () => {
    document.documentElement.dir = "rtl";
    document.head.innerHTML = `<style>
      .rtl-row { padding: 4px 8px 4px 32px; }
      .rtl-chip { position: absolute; left: 4px; }
      .logical { margin-inline-start: auto; }
    </style>`;
    document.body.innerHTML = `
      <div class="rtl-row"><span class="rtl-chip">private text</span></div>
      <div class="logical"></div>
    `;
    try {
      const { events, bus, cleanup } = collect();
      cleanups.push(cleanup);
      await settle(bus);

      const physical = layoutEvents(events)[0].d.rtlPhysical as Array<{
        properties: string[];
        matched: number;
      }>;
      expect(physical).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            properties: expect.arrayContaining(["padding"]),
          }),
          expect.objectContaining({
            properties: expect.arrayContaining(["left"]),
          }),
        ]),
      );
      expect(JSON.stringify(physical)).not.toContain("private text");
      expect(JSON.stringify(physical)).not.toContain(".rtl-row");
      expect(JSON.stringify(physical)).not.toContain("margin-inline-start");
    } finally {
      document.documentElement.dir = "";
      document.head.innerHTML = "";
    }
  });

  it("re-emits ui.num on every SPA navigation, even when the figures repeat", async () => {
    // Two routes rendering the same total under the same structural region —
    // /cart then /checkout. Cross-view suppression used to swallow the second
    // page entirely.
    const page = `<main><dl><dt>Total</dt><dd>$42.00</dd></dl></main>`;
    document.body.innerHTML = page;
    const { events, bus, cleanup } = collect();
    cleanups.push(cleanup);
    await settle(bus);
    expect(uiNumEvents(events)).toHaveLength(1);
    expect(layoutEvents(events)).toHaveLength(1);

    history.pushState({}, "", "/checkout");
    document.body.innerHTML = page;
    await settle(bus);
    expect(uiNumEvents(events)).toHaveLength(2);
    expect(layoutEvents(events)).toHaveLength(2);

    history.pushState({}, "", "/confirm");
    document.body.innerHTML = page;
    await settle(bus);
    expect(uiNumEvents(events)).toHaveLength(3);
    expect(layoutEvents(events)).toHaveLength(3);

    for (const snapshot of uiNumEvents(events)) {
      expect(snapshot.d).toMatchObject({ lang: null, dir: "ltr" });
      expect(snapshot.d.items).toEqual([{ label: "Total", value: 42, unit: "$" }]);
    }

    window.history.replaceState(null, "", "/");
  });

  it("still suppresses an unchanged re-scan inside one view", async () => {
    document.body.innerHTML = `<main><dl><dt>Total</dt><dd>$42.00</dd></dl></main>`;
    const { events, bus, cleanup } = collect();
    cleanups.push(cleanup);
    await settle(bus);
    expect(uiNumEvents(events)).toHaveLength(1);

    // A mutation that leaves every figure identical.
    document.body.appendChild(document.createElement("span"));
    await settle(bus);
    expect(uiNumEvents(events)).toHaveLength(1);
  });

  it("emits again on a navigation commit but not on a plain DOM settle", async () => {
    const { events, bus, cleanup } = collect();
    cleanups.push(cleanup);
    await settle(bus);
    expect(layoutEvents(events)).toHaveLength(1);

    document.body.innerHTML = `<dl class="totals"><dt>Total</dt><dd>$1.00</dd></dl>`;
    await settle(bus);
    expect(layoutEvents(events)).toHaveLength(1);

    history.pushState({}, "", "/checkout");
    await settle(bus);
    expect(layoutEvents(events)).toHaveLength(2);
    expect(layoutEvents(events)[1].d.url).toContain("/checkout");

    window.history.replaceState(null, "", "/");
  });

  it("no-ops cleanly when MutationObserver is unavailable", () => {
    const original = globalThis.MutationObserver;
    vi.stubGlobal("MutationObserver", undefined);
    try {
      const events: BugEvent[] = [];
      const bus = new EventBus();
      bus.subscribe((batch) => events.push(...batch));
      const cleanup = uiNumbersCollector(bus, makeConfig());
      bus.flush();
      expect(events).toHaveLength(0);
      expect(cleanup).not.toThrow();
    } finally {
      vi.stubGlobal("MutationObserver", original);
      vi.unstubAllGlobals();
    }
  });
});
