import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import type { BugStateLogger } from "./use-bug-state";
import {
  MOBILE_ERROR_MESSAGE_MAX_LENGTH,
  MOBILE_ERROR_STACK_MAX_LENGTH,
  attachMobileRedaction,
  redactMobileText,
} from "./redaction-plane";

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
    // Keys match the wire contract's `err` event and core's own error
    // collector: the analyzer indexes `d.stk`, so a boundary that emitted
    // `stack` delivered a crash with no stack trace and no code frame. See the
    // note on the web boundary in `crumbtrail-core/react`.
    const msg = redactMobileText(
      error.message,
      "msg",
      MOBILE_ERROR_MESSAGE_MAX_LENGTH,
    );
    const stk = redactMobileText(
      error.stack,
      "stk",
      MOBILE_ERROR_STACK_MAX_LENGTH,
    );
    const componentStk = redactMobileText(
      errorInfo.componentStack ?? undefined,
      "componentStk",
      MOBILE_ERROR_STACK_MAX_LENGTH,
    );
    const data: Record<string, unknown> = {
      msg: msg?.value ?? "",
      ...(stk ? { stk: stk.value } : {}),
      ...(componentStk ? { componentStk: componentStk.value } : {}),
      source: "react-native-error-boundary",
    };
    attachMobileRedaction(
      data,
      msg?.metadata,
      stk?.metadata,
      componentStk?.metadata,
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
