import { describe, expect, it } from "vitest";
import * as publicApi from "../index";
import { sendBackendEvent } from "../backend-intake";

// A host that hands `instrumentPgClient` its own `emit` needs the same poster
// the package's correlated lanes use, because only that poster retries the
// browser session start race. Before this export the README pointed at a name
// the package did not export, and the reference integration posted with a bare
// fetch that lost most database evidence on a real network.
describe("public backend intake export", () => {
  it("exports postBackendEvent as the intake poster", () => {
    expect(publicApi.postBackendEvent).toBe(sendBackendEvent);
    expect(typeof publicApi.flushBackendEvents).toBe("function");
  });
});
