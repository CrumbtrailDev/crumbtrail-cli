import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Crumbtrail } from "../crumbtrail";
import { EventBus } from "../event-bus";
import { HttpTransport } from "../transports/http";

beforeEach(() => { vi.useFakeTimers(); sessionStorage.clear(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup() {
  const transport = { startSession: vi.fn().mockResolvedValue(undefined), endSession: vi.fn().mockResolvedValue(undefined), sendEvents: vi.fn().mockResolvedValue(undefined), sendSessionEvents: vi.fn().mockResolvedValue(undefined), sendBlob: vi.fn().mockResolvedValue(undefined), sendBugReport: vi.fn().mockResolvedValue(undefined) };
  const logger = Crumbtrail.init({ transportInstance: transport, maxSessionDurationMs: 300000, sessionPersistence: "memory", network: false, console: false, flushIntervalMs: 1000 });
  const bus = (logger as unknown as { bus: EventBus }).bus;
  return { logger, transport, bus };
}
it("rotates active work at five minutes and retains late request attribution", async () => {
  const { logger, transport, bus } = setup();
  const first = logger.getSessionId();
  bus.emit({ t: Date.now(), k: "net.req", d: { id: 1, sessionId: first, url: "/slow" } });
  await vi.advanceTimersByTimeAsync(300000);
  const second = logger.getSessionId();
  expect(second).not.toBe(first);
  expect(transport.endSession).toHaveBeenCalledWith(first);
  bus.emit({ t: Date.now(), k: "net.res", d: { id: 1, sessionId: first, st: 200 } });
  bus.emit({ t: Date.now(), k: "clk", d: { sel: "button.next" } });
  bus.flush();
  await Promise.resolve();
  expect(transport.sendSessionEvents).toHaveBeenCalledWith(first, expect.arrayContaining([expect.objectContaining({ k: "net.res" })]));
  expect(transport.sendSessionEvents).toHaveBeenCalledWith(second, expect.arrayContaining([expect.objectContaining({ k: "clk" })]));
  await logger.stop();
  expect(transport.endSession).toHaveBeenCalledWith(second);
  const count = transport.startSession.mock.calls.length;
  await vi.advanceTimersByTimeAsync(300000);
  expect(transport.startSession).toHaveBeenCalledTimes(count);
});
it("continues capturing while the previous interval upload is pending", async () => {
  const { logger, transport, bus } = setup();
  const first = logger.getSessionId();
  let release!: () => void;
  transport.sendSessionEvents.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  bus.emit({ t: Date.now(), k: "clk", d: { sel: "button.first" } });
  bus.flush();
  await vi.advanceTimersByTimeAsync(300000);
  const second = logger.getSessionId();
  bus.emit({ t: Date.now(), k: "clk", d: { sel: "button.second" } });
  bus.flush();
  expect(transport.sendSessionEvents).toHaveBeenCalledWith(second, expect.arrayContaining([expect.objectContaining({ d: { sel: "button.second" } })]));
  expect(transport.endSession).not.toHaveBeenCalledWith(first);
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(transport.endSession).toHaveBeenCalledWith(first);
  await logger.stop();
});
it("HTTP transport delivers explicit late evidence under its original session", async () => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response('{}'))));
  const transport = new HttpTransport("http://capture.example");
  await transport.startSession("old", {});
  await transport.endSession("old");
  await transport.startSession("new", {});
  await transport.sendSessionEvents("old", [{ t: 1, k: "net.res", d: { sessionId: "old", st: 200 } }]);
  const call = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith("/api/events"));
  expect(JSON.parse(call![1]!.body as string).sessionId).toBe("old");
});
