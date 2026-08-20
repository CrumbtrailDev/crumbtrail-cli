import { Component } from "react";
import type { ReactNode, ErrorInfo } from "react";
import { redactReactSnapshot } from "./use-bug-state";
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
    this.props.logger.addEvent({
      type: "err",
      data: {
        msg: redactReactSnapshot(error.message),
        stk: redactReactSnapshot(error.stack),
        componentStk: redactReactSnapshot(errorInfo.componentStack),
        source: "react-error-boundary",
      },
    });
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
