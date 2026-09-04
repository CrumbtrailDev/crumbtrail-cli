import { Component } from "react";
import type { ReactNode, ErrorInfo } from "react";
import { attachRedactionMetadata } from "../redaction";
import { redactReactErrorText } from "./redact-snapshot";
import type { BugStateLogger } from "./use-bug-state";

export interface CrumbtrailErrorBoundaryProps {
  logger: BugStateLogger & {
    addEvent(partial: { type: string; data: Record<string, unknown> }): void;
  };
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
}

// Same bounds the recorded-error path in `collectors/error.ts` applies, so a
// boundary event and a window error event of the same size are stored alike.
const BOUNDARY_MESSAGE_MAX_LENGTH = 2_000;
const BOUNDARY_STACK_MAX_LENGTH = 8_000;

export class CrumbtrailErrorBoundary extends Component<
  CrumbtrailErrorBoundaryProps,
  State
> {
  constructor(props: CrumbtrailErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(_error: Error): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Error boundary events are privacy-safe by default; raw error capture belongs in
    // caller-owned custom events, not in this automatic boundary path.
    //
    // `stk` and `componentStk`, not `stack`/`componentStack`. `err` events are
    // read by key, not by shape: the analyzer indexes `d.stk` and nothing else
    // (post-process.ts), and the code frame, the LLM bundle and the cloud brief
    // are all built from that index entry. A boundary crash that emits `stack`
    // still reaches the raw event log, but arrives at the agent as a bare
    // message with no stack and no file — which is the one thing a boundary was
    // installed to provide.
    //
    // These three fields are free text, so they take the engine's free-text
    // route, the same one `collectors/error.ts` uses for `msg` and `stk`: every
    // frame survives and only the embedded URLs, `key=value` secrets and
    // token-shaped substrings are scrubbed. The React plane previously ran them
    // through a snapshot walker that returned a bare `[REDACTED]` for the whole
    // string whenever it contained a bracket and any key-like token reading as
    // sensitive — which deleted exactly the stack the boundary exists to supply.
    const msg = redactReactErrorText(
      error.message,
      "msg",
      BOUNDARY_MESSAGE_MAX_LENGTH,
    );
    const stk = redactReactErrorText(
      error.stack,
      "stk",
      BOUNDARY_STACK_MAX_LENGTH,
    );
    const componentStk = redactReactErrorText(
      errorInfo.componentStack ?? undefined,
      "componentStk",
      BOUNDARY_STACK_MAX_LENGTH,
    );

    const data: Record<string, unknown> = {
      msg: msg.value,
      stk: stk.value,
      componentStk: componentStk.value,
      source: "react-error-boundary",
    };
    // The plane declares its policy and its evidence, so a boundary capture is
    // as auditable in the agent bundle as a network body is.
    attachRedactionMetadata(
      data,
      msg.metadata,
      stk.metadata,
      componentStk.metadata,
    );

    this.props.logger.addEvent({ type: "err", data });
  }

  resetError(): void {
    this.setState({ hasError: false });
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return this.props.fallback ?? null;
    }
    return this.props.children;
  }
}
