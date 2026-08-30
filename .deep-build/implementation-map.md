# Serverless runtime implementation map

## Goal

Make Crumbtrail first class for Node function handlers and standards based edge Fetch handlers. Preserve existing browser and long lived Node behavior.

## Required behavior

1. Add one request scoped invocation contract with bounded correlation, method, route, status, duration, and error metadata. It must not capture request or response bodies by default, leak state across warm or concurrent invocations, or replace host responses and errors when capture fails.
2. Add async Node wrappers for AWS Lambda HTTP events, Vercel Node Functions, and Netlify Functions.
3. Add a Node free Fetch wrapper for Cloudflare Workers, Vercel Edge, Netlify Edge, and Deno Deploy. It accepts an optional `waitUntil` compatible hook, otherwise it awaits flush.
4. Detect serverless and edge manifests before framework fallbacks. Automatically edit only deterministic entry and export shapes. Give exact nonmutating guidance for ambiguous shapes.
5. Verify cold, warm, concurrent, success, error, abort or timeout, flush failure, scheduled flush, and awaited flush behavior. Verify representative installer fixtures through packed artifacts.
6. Document exact APIs, defaults, lifecycle, setup mode, environment variables, limitations, and verification. Check package exports and tarball contents.

## Exclusions

- No package publication, deployment, production state change, or main product adoption.
- No callback style Lambda support or non HTTP Lambda triggers.
- No request or response body capture by default.
- No Electron, TanStack Start, Bun, Elysia, Socket.IO, Java, .NET, Go, PHP, Ruby, Rust, Elixir, Kotlin, or Swift work.
- No unrelated capture refactor.

## Decisions

- Put the portable contract and Fetch adapter in `crumbtrail-core/serverless` so edge runtimes never import Node builtins.
- Put AWS, Vercel Node, and Netlify Node adapters in `crumbtrail-node` and reuse the portable contract.
- Treat ambiguous installer shapes as guided setup, not automatic support.
- Treat local package, fixture, and lifecycle verification as implementation proof. Publication and hosted deployment proof remain release follow ups.
