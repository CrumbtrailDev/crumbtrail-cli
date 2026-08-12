// Public API for the offline core of the Crumbtrail setup CLI.
//
// Detection, injection planning and the recipe registry used to live in a
// separate crumbtrail-detect-core package, published to npm purely so the
// hosted cloud — which lives in another repository — could import them. Nobody
// installed it on purpose. It is plain source here now, and the cloud reaches
// it through this entry, which it already depended on for materializePlan.
//
// memoryReader is deliberately test-only and is not re-exported here; it is
// reachable at the `crumbtrail/testing` subpath.
export * from "./detect";
export * from "./discover";
export * from "./recipe-registry";
export * from "./inject";
export * from "./otlp";
export * from "./readers/github";
