import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { redactReactNativeSnapshot } from "./use-bug-state";
import type { BugStateLogger } from "./use-bug-state";

export interface CrumbtrailReactNativeErrorBoundaryProps {
  logger: BugStateLogger & {
    addEvent(partial: { type: string; data: Record<string, unknown> }): void;
  };
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
}

export class CrumbtrailReactNativeErrorBoundary extends Component<
  CrumbtrailReactNativeErrorBoundaryProps,
  State
> {
  constructor(props: CrumbtrailReactNativeErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(_error: Error): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.props.logger.addEvent({
      type: "err",
      data: {
        msg: redactReactNativeSnapshot(error.message),
        stack: redactReactNativeSnapshot(error.stack),
        componentStack: redactReactNativeSnapshot(errorInfo.componentStack),
        source: "react-native-error-boundary",
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
