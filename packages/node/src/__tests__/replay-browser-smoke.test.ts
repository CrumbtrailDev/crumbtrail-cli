import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildReplayFlow } from "../replay/flow";
import { runReproduction } from "../replay/factory";
import type { ReplayFlowEvent } from "../replay/flow";

/**
 * Opt-in end-to-end smoke: a REAL chromium replay of a recorded flow against a
 * broken build and against the fixed build. This is the CP6 acceptance shape —
 * the same flow diverges before the fix and resolves cleanly after it.
 *
 * It is gated behind `CRUMBTRAIL_REPLAY_SMOKE=1` on purpose: the default suite
 * must never require a browser download. Run it with
 *
 *   CRUMBTRAIL_REPLAY_SMOKE=1 pnpm --filter crumbtrail-node test
 *
 * in an environment where `playwright` and its chromium binary are installed.
 */
const ENABLED = process.env.CRUMBTRAIL_REPLAY_SMOKE === "1";

const PAGE = (withConfirmButton: boolean) => `<!doctype html>
<html><body>
  <h1>Checkout</h1>
  <label for="qty">Quantity</label>
  <input id="qty" name="qty" type="number" value="1" />
  ${
    withConfirmButton
      ? '<button id="confirm" type="button">Confirm order</button>'
      : "<!-- regression: the confirm button was removed -->"
  }
</body></html>`;

function serve(
  html: string,
): Promise<{ origin: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/** The recorded session: the flow a user drove before the regression landed. */
const RECORDED: ReplayFlowEvent[] = [
  { k: "nav", d: { to: "https://shop.example.com/checkout" } },
  {
    k: "inp",
    d: {
      el: {
        sig: "sig-qty",
        path: "#qty",
        tag: "INPUT",
        type: "number",
        name: "qty",
      },
      val: "3",
    },
  },
  {
    k: "clk",
    d: {
      el: {
        sig: "sig-confirm",
        path: "#confirm",
        tag: "BUTTON",
        txt: "Confirm order",
      },
    },
  },
];

describe.skipIf(!ENABLED)("PlaywrightReproducer — real browser smoke", () => {
  let broken: Awaited<ReturnType<typeof serve>>;
  let fixed: Awaited<ReturnType<typeof serve>>;

  beforeAll(async () => {
    broken = await serve(PAGE(false));
    fixed = await serve(PAGE(true));
  });

  afterAll(async () => {
    await broken?.close();
    await fixed?.close();
  });

  it("diverges against the broken build and resolves against the fixed build", async () => {
    const run = async (origin: string) =>
      runReproduction({
        flow: buildReplayFlow({
          sourceSessionId: "ses_smoke_001",
          targetUrl: `${origin}/checkout`,
          events: RECORDED,
        }),
        allowReproduction: true,
        policy: {
          execute: true,
          allowlist: [{ origin, isolated: true }],
          stepTimeoutMs: 4_000,
        },
      });

    const before = await run(broken.origin);
    expect(before.attempted).toBe(true);
    expect(before.result?.steps.map((step) => step.resolution)).toEqual([
      "exact",
      "exact",
      "failed",
    ]);
    expect(before.result?.divergences).toHaveLength(1);
    expect(before.result?.divergences[0].sig).toBe("sig-confirm");

    const after = await run(fixed.origin);
    expect(after.attempted).toBe(true);
    expect(after.result?.steps.map((step) => step.resolution)).toEqual([
      "exact",
      "exact",
      "exact",
    ]);
    expect(after.result?.divergences).toEqual([]);
    expect(after.result?.completed).toBe(true);
  }, 60_000);
});
