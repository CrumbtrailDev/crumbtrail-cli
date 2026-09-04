import type { RedactionMetadata, TargetDescriptor } from "crumbtrail-core";
import {
  MOBILE_LABEL_MAX_LENGTH,
  MOBILE_REDACTION_POLICY,
  attachMobileRedaction,
  redactMobileText,
} from "./redaction-plane";
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
      const metadata: Array<RedactionMetadata | undefined> = [];
      const d: Record<string, unknown> = {
        kind: "component-tree",
        routePath: snapshot.routePath,
        root: sanitizeNode(snapshot.root, metadata, "root", 0),
      };
      attachMobileRedaction(d, ...metadata);
      emit("view-snapshot", d);
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

/**
 * How deep the view tree is walked.
 *
 * The tree is the host app's, so its depth is whatever that app renders, and a
 * deeply nested list view recurses as far as it goes. Native screens flatten
 * well before this; the bound exists so a pathological tree cannot take the
 * app's own JS thread down inside the crash path.
 */
export const VIEW_SNAPSHOT_MAX_DEPTH = 32;

/** How many children are kept per node. A screen has nothing like this many. */
export const VIEW_SNAPSHOT_MAX_CHILDREN = 200;

/**
 * Select the reportable fields of one node, and redact the one that carries
 * user data.
 *
 * `componentName`, `role`, `testID` and `accessibilityId` are written by the
 * developer and identify a widget. `label` is the accessibility label: it is
 * the text a screen reader speaks, so it is whatever is on screen — a name, a
 * balance, an address — and it goes through the engine like any other captured
 * text.
 */
function sanitizeNode(
  node: ReactNativeViewSnapshotNode,
  metadata: Array<RedactionMetadata | undefined>,
  path: string,
  depth: number,
): ReactNativeViewSnapshotNode {
  const label = redactMobileText(
    node.label,
    `${path}.label`,
    MOBILE_LABEL_MAX_LENGTH,
  );
  if (label?.metadata) metadata.push(label.metadata);

  const children = node.children ?? [];
  // The subtree past the bound is dropped rather than replaced by a stand-in:
  // a placeholder node in a list of real nodes is something every consumer of
  // the tree would then have to know about. The field below carries the count.
  const truncatedDepth = depth >= VIEW_SNAPSHOT_MAX_DEPTH && children.length > 0;
  const overWide = children.length > VIEW_SNAPSHOT_MAX_CHILDREN;
  if (truncatedDepth || overWide) {
    metadata.push({
      policy: MOBILE_REDACTION_POLICY,
      fields: [
        {
          path,
          reason: truncatedDepth
            ? "view_tree_depth_exceeded"
            : "view_tree_children_exceeded",
          action: "summarized",
        },
      ],
    });
  }

  return {
    id: node.id,
    componentName: node.componentName,
    role: node.role,
    ...(label ? { label: label.value } : {}),
    testID: node.testID,
    accessibilityId: node.accessibilityId,
    bounds: node.bounds,
    children: truncatedDepth
      ? []
      : children
          .slice(0, VIEW_SNAPSHOT_MAX_CHILDREN)
          .map((child, index) =>
            sanitizeNode(child, metadata, `${path}[${index}]`, depth + 1),
          ),
  };
}
