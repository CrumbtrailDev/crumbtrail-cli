import { invoke } from "@tauri-apps/api/core";
import type { BugEvent, CrumbtrailTransport, BugReport } from "crumbtrail-core";

export class TauriTransport implements CrumbtrailTransport {
  private sessionId = "";

  async startSession(
    sessionId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    this.sessionId = sessionId;
    await invoke("plugin:crumbtrail|start_session", { sessionId, metadata });
  }

  async endSession(sessionId: string): Promise<void> {
    await invoke("plugin:crumbtrail|end_session", { sessionId });
  }

  async sendEvents(events: BugEvent[]): Promise<void> {
    await invoke("plugin:crumbtrail|append_events", {
      sessionId: this.sessionId,
      events,
    });
  }

  async sendBlob(
    name: string,
    blob: Blob,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const buffer = await blob.arrayBuffer();
    await invoke("plugin:crumbtrail|write_blob", {
      sessionId: this.sessionId,
      name,
      data: Array.from(new Uint8Array(buffer)),
      metadata: metadata ?? {},
    });
  }

  async sendBugReport(
    report: BugReport,
    events: BugEvent[],
    voiceBlob?: Blob,
  ): Promise<void> {
    await invoke("plugin:crumbtrail|flag_bug", {
      report,
      events,
    });
    if (voiceBlob) {
      const buffer = await voiceBlob.arrayBuffer();
      await invoke("plugin:crumbtrail|write_bug_voice", {
        bugId: report.bugId,
        data: Array.from(new Uint8Array(buffer)),
      });
    }
  }
}
