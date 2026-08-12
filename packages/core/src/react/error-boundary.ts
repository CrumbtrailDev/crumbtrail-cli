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
    this.props.logger.addEvent({
      type: "err",
      data: {
        msg: redactReactSnapshot(error.message),
        stack: redactReactSnapshot(error.stack),
        componentStack: redactReactSnapshot(errorInfo.componentStack),
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
