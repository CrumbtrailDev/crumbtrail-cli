# Capture net/http requests

Requires Go 1.23 or later. This nested module is source only until the repository publishes a `packages/go/v0.1.0` tag. For local verification, add a module replacement pointing at this directory. Once that release exists, install it with:

```sh
go get github.com/CrumbtrailDev/crumbtrail-cli/packages/go@v0.1.0
```

```go
package main

import (
    "context"
    "log"
    "net/http"
    "os"
    "strings"
    "time"
    crumbtrail "github.com/CrumbtrailDev/crumbtrail-cli/packages/go"
)

func main() {
    sender, err := crumbtrail.NewSender(crumbtrail.SenderConfig{
        Endpoint: os.Getenv("CRUMBTRAIL_ENDPOINT"),
        Key: os.Getenv("CRUMBTRAIL_INGEST_KEY"),
    })
    if err != nil { log.Fatal(err) }
    defer func() {
        ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
        defer cancel()
        _ = sender.Close(ctx)
    }()
    mux := http.NewServeMux()
    mux.HandleFunc("POST /api/quote", func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Content-Type", "application/json")
        _, _ = w.Write([]byte(`{"total":37.5}`))
    })
    handler := crumbtrail.Middleware(crumbtrail.Options{
        Sink: sender, Service: "api",
        ShouldCapture: func(r *http.Request) bool {
            return strings.HasPrefix(r.URL.Path, "/api/") && !strings.HasPrefix(r.URL.Path, "/api/auth")
        },
    })(mux)
    if err := http.ListenAndServe(":8080", handler); err != nil { log.Print(err) }
}
```

Register normal application shutdown handling to call `Server.Shutdown` and let `main` return. `Sender.Close(ctx)` drains the queue until the deadline and then cancels delivery. Abrupt termination can lose evidence.

The browser must register a session and send valid `x-crumbtrail-session-id` and `x-crumbtrail-request-id` headers. The default captures no routes. Upgrade requests bypass capture. Query strings, headers and exception messages are never captured. The matched `net/http` route pattern is used for route and URL metadata. When no pattern is available, `/` is recorded. Raw paths and parameter values are withheld. Duplicate correlation header values bypass capture.

JSON bodies are observed as application code reads or writes them. Unread requests have `missing` state. A nonempty request must exactly match a declared Content Length. When the length is unknown, EOF must prove completeness. Incomplete reads, interrupted response writes and bodies over 16 KiB have `truncated` state with no body. Sensitive names and free text are redacted. Safe numbers below one trillion, booleans, null, short enums and currency codes remain. Malformed, duplicate key or structurally excessive JSON is withheld. Application body bytes and optional ResponseWriter interfaces are preserved. Panics propagate unchanged after recording a generic error.

A request holds up to 200 database events plus request boundary events, then records a capture gap. The HTTPS sender queues at most 64 batches and drops new batches when full. It retries network errors, 404 registration races, 429 and server errors up to four attempts. Other failures and redirects are not retried. Each request has a five second timeout. Delivery runs in a goroutine. A caller supplied `HTTPClient` supports custom trust roots, but cannot enable redirects or remove the timeout.

## Capture database/sql commands

Wrap the application database once, then use the request context:

```go
observed, err := crumbtrail.WrapDB(db, "postgres") // db is an existing *sql.DB
if err != nil { return err }
result, err := observed.ExecContext(r.Context(), "UPDATE orders SET total = $1 WHERE id = $2", total, id)
```

`WrapDB` accepts `postgres`, `mysql` or `sqlite`. Owned `ExecContext`, `QueryContext`, `QueryRowContext`, `PrepareContext`, and `BeginTx` methods preserve database behavior while recording operation, duration, sequence, affected count and generic errors. Prepared statements and transactions have equivalent context methods. `QueryRowContext` returns a Crumbtrail `Row` with `Scan` and `Err` methods. Capture completes at `Scan`. Existing methods exposed by the embedded `*sql.DB`, `*sql.Tx` or `*sql.Stmt` that are not explicitly wrapped are ordinary unobserved methods. Use the context methods listed here for capture.

SQL text, bindings and rows are withheld. Query row counts are unknown. Errors during later `Rows.Next` iteration are not captured. This package does not provide before/after snapshots, transaction identity or read row evidence.

## Verify the package

Run `go test -race ./...` from this directory. The tests use a real loopback HTTP server, SQLite database and TLS ingest server. SQLite tests require a C compiler. Set `CRUMBTRAIL_CAPTURE_CONTRACT_OUTPUT=/tmp/go-capture.json` to export the actual middleware batch for cloud contract checks.
