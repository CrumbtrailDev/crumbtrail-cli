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
        Logger: log.Default(),
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

The browser must register a session and send valid `x-crumbtrail-session-id` and `x-crumbtrail-request-id` headers. The default captures no routes. Upgrade requests bypass capture. Query strings, headers and exception messages are never captured. The matched `net/http` route pattern is used for route and URL metadata. Only `net/http.ServeMux` on Go 1.22 or later sets it, so applications on chi, gorilla or any other router supply the template through the optional `Route` callback:

```go
handler := crumbtrail.Middleware(crumbtrail.Options{
    Sink: sender, Service: "api", ShouldCapture: shouldCapture,
    Route: func(r *http.Request) string { return chi.RouteContext(r.Context()).RoutePattern() },
})(router)
```

`Route` takes precedence over the pattern. Return a template such as `/api/orders/{id}`, never a path containing actual parameter values: a returned value that is empty, oversized, panics, or contains characters a template cannot hold is recorded as `/`. Raw paths and parameter values are withheld. Duplicate correlation header values bypass capture.

JSON bodies are observed as application code reads or writes them. Unread requests have `missing` state. A nonempty request must exactly match a declared Content Length. When the length is unknown, EOF must prove completeness. Incomplete reads, interrupted response writes and bodies over 16 KiB have `truncated` state with no body. Sensitive names and free text are redacted, and a sensitive name redacts its whole subtree without walking it. A number is kept only when it stays inside the safe integer range, has at most six integer digits, and is not a valid card number. That cap is below the length of a phone number, a national identifier or an account number, so those are withheld even under an innocent field name. Strings are kept only as a short lowercase word, a three letter uppercase code, or at most six digits. Booleans and null remain. The Go, Ruby and ASP.NET Core packages all run `test-fixtures/backend-body/cases.json`, so the three agree on every case in it. Malformed, duplicate key or structurally excessive JSON is withheld. Application body bytes and optional ResponseWriter interfaces are preserved. Wrapping `ReadFrom` is what lets a response written with `io.Copy` be captured, and it costs that response the `sendfile` fast path, so a handler streaming large files pays a copy through user space. Panics propagate unchanged after recording a generic error.

A request holds up to 200 database events plus request boundary events, then records a capture gap. The HTTPS sender queues at most 64 batches and refuses new batches when full. A refused batch is a hole in the session, so the request records a `buffer_overflow` capture gap naming how many events were lost.

The sender retries network errors, 429 and server errors up to four attempts. Any other status is permanent: repeating it cannot help, so the sender records a `delivery_failed` capture gap and writes one line to `Logger`, which defaults to the standard logger. Without that line a revoked key looks exactly like a working SDK with an empty project.

The cloud can also answer 202 with `{"capture":"shed"}` and a retry window, which means it accepted the request and discarded the evidence. The sender pauses delivery for the window, counts what it drops, and sends one capture gap naming the shed reason once the window passes.

Redirects are never followed. Each request has a five second timeout. Delivery runs in a goroutine. A caller supplied `HTTPClient` supports custom trust roots, but cannot enable redirects or remove the timeout.

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

Run `pnpm test:go` from the repository root, or `go test -race ./...` here. The tests use a real loopback HTTP server, SQLite database and TLS ingest server. SQLite tests require a C compiler. Set `CRUMBTRAIL_CAPTURE_CONTRACT_OUTPUT=/tmp/go-capture.json` to export the actual middleware batch for cloud contract checks.
