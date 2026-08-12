declare module 'react' {
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useRef<T>(initialValue: T): { current: T };

  export type ReactNode =
    | string
    | number
    | boolean
    | null
    | undefined
    | ReactElement
    | ReactNode[];

  export interface ReactElement {
    type: unknown;
    props: unknown;
    key: string | null;
  }

  export interface ErrorInfo {
    componentStack: string | null;
  }

  export class Component<P = object, S = object> {
    constructor(props: P);
    props: Readonly<P>;
    state: Readonly<S>;
    setState(state: Partial<S> | ((prev: Readonly<S>) => Partial<S>)): void;
    render(): ReactNode;
    componentDidCatch?(error: Error, errorInfo: ErrorInfo): void;
    static getDerivedStateFromError(error: Error): object;
  }
}
