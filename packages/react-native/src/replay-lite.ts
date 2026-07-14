import type { TargetDescriptor } from "crumbtrail-core";
import {
  createReactNativeTargetDescriptor,
  type ReactNativeTargetInput,
} from "./target-descriptor";

export interface ReactNativeViewSnapshotNode {
  id?: string;
  componentName?: string;
  role?: string;
  label?: string;
  testID?: string;
  accessibilityId?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  children?: ReactNativeViewSnapshotNode[];
}

export interface ReactNativeViewSnapshot {
  routePath?: string;
  root: ReactNativeViewSnapshotNode;
}

export interface ReactNativeTouchOverlay {
  x: number;
  y: number;
  target?: TargetDescriptor | ReactNativeTargetInput;
  phase?: "start" | "move" | "end" | "cancel" | "press";
}

export interface ReactNativeViewShotModule {
  captureRef?: (
    target: unknown,
    options?: Record<string, unknown>,
  ) => Promise<string> | string;
  captureScreen?: (
    options?: Record<string, unknown>,
  ) => Promise<string> | string;
}

export interface ReplayLiteLogger {
  addEvent(partial: {
    type: string;
    data: Record<string, unknown>;
    platform?: "react-native";
    sdk?: { name: string; version?: string };
    capabilities?: string[];
    target?: TargetDescriptor;
  }): void;
}

export interface ReactNativeReplayLiteOptions {
  logger: ReplayLiteLogger;
  capabilities: string[];
  viewShot?: ReactNativeViewShotModule | null;
}

export interface ReactNativeReplayLiteController {
  recordViewSnapshot(snapshot: ReactNativeViewSnapshot): void;
  recordTouch(overlay: ReactNativeTouchOverlay): void;
  captureCrashScreenshot(target?: unknown): Promise<string | undefined>;
}

export function createReactNativeReplayLite(
  options: ReactNativeReplayLiteOptions,
): ReactNativeReplayLiteController {
  const emit = (
    type: string,
    data: Record<string, unknown>,
    target?: TargetDescriptor,
  ) => {
    options.logger.addEvent({
      type,
      data,
      platform: "react-native",
      sdk: { name: "crumbtrail-react-native" },
      capabilities: options.capabilities,
      ...(target ? { target } : {}),
    });
  };

  return {
    recordViewSnapshot(snapshot) {
      emit("view-snapshot", {
        kind: "component-tree",
        routePath: snapshot.routePath,
        root: sanitizeNode(snapshot.root),
      });
    },
    recordTouch(overlay) {
      const target = overlay.target
        ? createReactNativeTargetDescriptor(
            overlay.target as ReactNativeTargetInput,
          )
        : undefined;
      emit(
        "touch",
        {
          kind: "overlay",
          x: overlay.x,
          y: overlay.y,
          phase: overlay.phase ?? "press",
        },
        target,
      );
    },
    async captureCrashScreenshot(target) {
      const capture =
        target !== undefined && options.viewShot?.captureRef
          ? options.viewShot.captureRef(target, { format: "jpg", quality: 0.7 })
          : options.viewShot?.captureScreen?.({ format: "jpg", quality: 0.7 });
      if (!capture) return undefined;

      try {
        const uri = await capture;
        emit("view-snapshot", {
          kind: "crash-screenshot",
          uri,
          capture: "react-native-view-shot",
        });
        return uri;
      } catch {
        return undefined;
      }
    },
  };
}

function sanitizeNode(
  node: ReactNativeViewSnapshotNode,
): ReactNativeViewSnapshotNode {
  return {
    id: node.id,
    componentName: node.componentName,
    role: node.role,
    label: node.label,
    testID: node.testID,
    accessibilityId: node.accessibilityId,
    bounds: node.bounds,
    children: node.children?.map(sanitizeNode),
  };
}
