import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
} from "react";
import type { ReactNode } from "react";
import {
  createReactNativeCrumbtrail,
  createReactNativeCrumbtrailAsync,
} from "./logger";
import { detectReactNativeCapabilities } from "./capabilities";
import type { Crumbtrail } from "crumbtrail-core";
import type { CrumbtrailConfig } from "crumbtrail-core";
import type { AsyncStorageLike } from "./session-store";
import type {
  OptionalModuleResolver,
  ReactNativeCapabilities,
} from "./capabilities";

export interface CrumbtrailReactNativeContextValue {
  logger: Crumbtrail;
  capabilities: ReactNativeCapabilities;
}

export interface CrumbtrailReactNativeProviderProps {
  children: ReactNode;
  logger?: Crumbtrail;
  config?: Partial<CrumbtrailConfig>;
  asyncStorage?: AsyncStorageLike | null;
  resolver?: OptionalModuleResolver;
  reportCapabilities?: boolean;
  fallback?: ReactNode;
}

const CrumbtrailReactNativeContext = createContext<
  CrumbtrailReactNativeContextValue | undefined
>(undefined);

export function CrumbtrailReactNativeProvider(
  props: CrumbtrailReactNativeProviderProps,
): ReactNode {
  const [value, setValue] = useState<
    CrumbtrailReactNativeContextValue | undefined
  >(() => {
    if (!props.logger && props.asyncStorage) return undefined;
    return props.logger
      ? {
          logger: props.logger,
          capabilities: detectReactNativeCapabilities({
            resolver: props.resolver,
          }),
        }
      : createReactNativeCrumbtrail({
          config: props.config,
          resolver: props.resolver,
          reportCapabilities: props.reportCapabilities,
        });
  });

  useEffect(() => {
    let active = true;

    if (props.logger) {
      setValue({
        logger: props.logger,
        capabilities: detectReactNativeCapabilities({
          resolver: props.resolver,
        }),
      });
      return;
    }

    if (!props.asyncStorage) return;

    let hydratedLogger: Crumbtrail | undefined;
    createReactNativeCrumbtrailAsync({
      config: props.config,
      asyncStorage: props.asyncStorage,
      resolver: props.resolver,
      reportCapabilities: props.reportCapabilities,
    })
      .then((result) => {
        if (!active) {
          void result.logger.stop();
          return;
        }
        hydratedLogger = result.logger;
        setValue(result);
      })
      .catch(() => {});

    return () => {
      active = false;
      if (hydratedLogger) void hydratedLogger.stop();
    };
  }, [
    props.asyncStorage,
    props.config,
    props.logger,
    props.reportCapabilities,
    props.resolver,
  ]);

  if (!value) return props.fallback ?? null;
  return createElement(
    CrumbtrailReactNativeContext.Provider,
    { value },
    props.children,
  );
}

export function useCrumbtrailReactNative(): CrumbtrailReactNativeContextValue {
  const value = useContext(CrumbtrailReactNativeContext);
  if (!value) {
    throw new Error(
      "useCrumbtrailReactNative must be used within CrumbtrailReactNativeProvider",
    );
  }
  return value;
}
