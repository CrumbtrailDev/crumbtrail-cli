// Package crumbtrail captures correlated net/http requests for Crumbtrail.
package crumbtrail

import (
	"context"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/felixge/httpsnoop"
)

// Version of this SDK, reported on every event.
const Version = "0.1.0"

// SchemaVersion and Platform are required of every SDK that is not built on crumbtrail-core.
// Without them ingest defaults each event to platform "web", and no reader can tell a Go
// service's request apart from a browser's.
const SchemaVersion = 1
const Platform = "go"

// SDK names the producer of an event.
type SDK struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

var sdkDescriptor = SDK{Name: "crumbtrail-go", Version: Version}

type Event struct {
	T             int64          `json:"t"`
	K             string         `json:"k"`
	D             map[string]any `json:"d"`
	SchemaVersion int            `json:"schemaVersion"`
	Platform      string         `json:"platform"`
	SDK           SDK            `json:"sdk"`
	// Capabilities and Target complete the wire envelope. This SDK never populates them; they
	// exist so the wire contract fixtures can be exercised through the real serializer rather
	// than through a copy of it.
	Capabilities []string       `json:"capabilities,omitempty"`
	Target       map[string]any `json:"target,omitempty"`
}

func newEvent(t int64, kind string, data map[string]any) Event {
	return Event{T: t, K: kind, D: data, SchemaVersion: SchemaVersion, Platform: Platform, SDK: sdkDescriptor}
}

type Batch struct {
	SessionID string  `json:"sessionId"`
	Events    []Event `json:"events"`
}
type Sink interface{ Enqueue(Batch) bool }
type Options struct {
	Sink          Sink
	Service       string
	ShouldCapture func(*http.Request) bool
	// Route returns the matched route template for a request, such as "/api/orders/{id}".
	// Only net/http.ServeMux on Go 1.22 and later populates http.Request.Pattern, so under
	// chi, gin, echo or gorilla/mux this callback is the only way the route is known. Return
	// the empty string when there is no template. Never return a path holding real parameter
	// values: the raw path is deliberately never captured.
	Route func(*http.Request) string
}
type contextKey struct{}
type captureContext struct {
	mu               sync.Mutex
	session, request string
	events           []Event
	dropped, seq     int
}

var validID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
var validTemplate = regexp.MustCompile(`^/[a-zA-Z0-9_{}:.* /-]*$`)

const eventBudget = 200

func (c *captureContext) add(kind string, data map[string]any, t int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.events) >= eventBudget && kind != "backend.req.start" && kind != "backend.req.end" && kind != "backend.req.error" {
		c.dropped++
		return
	}
	data["requestId"] = c.request
	data["sessionId"] = c.session
	c.events = append(c.events, newEvent(t, kind, data))
}

// nextSequence and the statement timestamp are both taken when a statement is issued rather
// than when it completes, so a slow query keeps its place in the order the application ran it.
func (c *captureContext) nextSequence() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.seq++
	return c.seq
}

func (c *captureContext) gap(reason string, dropped int, surface, detail string) Event {
	data := map[string]any{"kind": "capture_gap", "surface": surface, "reason": reason,
		"requestId": c.request, "sessionId": c.session, "droppedEventCount": dropped}
	if detail != "" {
		data["detail"] = detail
	}
	return newEvent(time.Now().UnixMilli(), "capture_gap", data)
}

func (c *captureContext) flush(sink Sink) {
	defer func() { _ = recover() }()
	c.mu.Lock()
	events := c.events
	c.events = nil
	dropped := c.dropped
	c.mu.Unlock()
	if dropped > 0 {
		events = append(events, c.gap("scan_budget_exceeded", dropped, "backend_request", ""))
	}
	sort.SliceStable(events, func(i, j int) bool {
		if events[i].T == events[j].T {
			return events[i].K == "backend.req.start" && events[j].K != "backend.req.start"
		}
		return events[i].T < events[j].T
	})
	refused := 0
	for len(events) > 0 {
		n := min(20, len(events))
		if !sink.Enqueue(Batch{c.session, events[:n]}) {
			refused += n
		}
		events = events[n:]
	}
	// A batch the sink refused is a hole in the session. Declaring it costs one event; leaving
	// it implicit lets a burst drop backend.req.end and leaves a request that never terminated
	// looking exactly like a request that never happened.
	if refused > 0 {
		sink.Enqueue(Batch{c.session, []Event{c.gap("buffer_overflow", refused, "queue", "sink queue full")}})
	}
}

type bodyReader struct {
	io.ReadCloser
	bytes     []byte
	truncated bool
	complete  bool
}

func (b *bodyReader) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	b.keep(p[:n])
	if err == io.EOF {
		b.complete = true
	}
	return n, err
}
func (b *bodyReader) keep(p []byte) {
	remaining := bodyLimit - len(b.bytes)
	b.bytes = append(b.bytes, p[:min(remaining, len(p))]...)
	b.truncated = b.truncated || len(p) > remaining
}

// responseAccumulator collects the bytes written to the response. It is deliberately not a
// bodyReader: that type embeds an io.ReadCloser, and a write side accumulator built from one
// carries a nil reader that panics the first time anything calls Read on it.
type responseAccumulator struct {
	bytes     []byte
	truncated bool
}

func (a *responseAccumulator) keep(p []byte) {
	remaining := bodyLimit - len(a.bytes)
	a.bytes = append(a.bytes, p[:min(remaining, len(p))]...)
	a.truncated = a.truncated || len(p) > remaining
}

func eligible(options Options, r *http.Request) (result bool) {
	defer func() {
		if recover() != nil {
			result = false
		}
	}()
	return options.Sink != nil && options.ShouldCapture != nil && options.ShouldCapture(r) && r.Header.Get("Upgrade") == "" && singleIdentity(r.Header, "x-crumbtrail-session-id") && singleIdentity(r.Header, "x-crumbtrail-request-id")
}

func singleIdentity(headers http.Header, name string) bool {
	values := headers.Values(name)
	return len(values) == 1 && validID.MatchString(values[0])
}

// routeTemplate prefers the framework's own answer through Options.Route, because only
// net/http.ServeMux on Go 1.22 and later sets http.Request.Pattern. Under any third party
// router the pattern is empty and every request would otherwise report "/".
func routeTemplate(options Options, r *http.Request) (template string) {
	defer func() {
		if recover() != nil {
			template = "/"
		}
	}()
	if options.Route != nil {
		if value := options.Route(r); value != "" {
			return normalizeTemplate(value)
		}
	}
	return normalizeTemplate(r.Pattern)
}

func normalizeTemplate(pattern string) string {
	if len(pattern) > 512 {
		return "/"
	}
	if space := strings.IndexByte(pattern, ' '); space >= 0 {
		pattern = pattern[space+1:]
	}
	if slash := strings.IndexByte(pattern, '/'); slash >= 0 {
		pattern = pattern[slash:]
	}
	if !strings.HasPrefix(pattern, "/") || !validTemplate.MatchString(pattern) {
		return "/"
	}
	return pattern
}

// Middleware observes only explicitly eligible requests with valid browser correlation.
// It preserves ResponseWriter's optional interfaces through httpsnoop.
func Middleware(options Options) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !eligible(options, r) {
				next.ServeHTTP(w, r)
				return
			}
			started := time.Now()
			c := &captureContext{session: r.Header.Get("x-crumbtrail-session-id"), request: r.Header.Get("x-crumbtrail-request-id")}
			r = r.WithContext(context.WithValue(r.Context(), contextKey{}, c))
			var input *bodyReader
			if r.Body != nil && isJSON(r.Header.Get("Content-Type")) {
				input = &bodyReader{ReadCloser: r.Body}
				r.Body = input
			}
			output := &responseAccumulator{}
			status := 200
			wroteHeader := false
			base := func() map[string]any {
				route := routeTemplate(options, r)
				return map[string]any{"method": r.Method, "url": route, "pathname": route, "route": route, "service": options.Service, "correlation": map[string]any{"status": "linked", "sessionIdSource": "header", "requestIdSource": "header"}}
			}
			wrapped := httpsnoop.Wrap(w, httpsnoop.Hooks{
				WriteHeader: func(next httpsnoop.WriteHeaderFunc) httpsnoop.WriteHeaderFunc {
					return func(code int) {
						next(code)
						if !wroteHeader && code >= 200 {
							status = code
							wroteHeader = true
						}
					}
				},
				Write: func(next httpsnoop.WriteFunc) httpsnoop.WriteFunc {
					return func(p []byte) (int, error) {
						n, err := next(p)
						wroteHeader = true
						output.keep(p[:n])
						output.truncated = output.truncated || err != nil || n < len(p)
						return n, err
					}
				},
				// Hooking ReadFrom costs the sendfile fast path: os.File to TCP responses that
				// the kernel would have copied without entering user space are copied here in
				// 32 KiB chunks instead. That is the price of the response body being observed
				// at all on this path, and it is paid only for requests that are already
				// eligible for capture.
				ReadFrom: func(_ httpsnoop.ReadFromFunc) httpsnoop.ReadFromFunc {
					return func(reader io.Reader) (int64, error) {
						n, err := io.Copy(writerOnly{writer: captureWriter{w, output, &wroteHeader}}, reader)
						output.truncated = output.truncated || err != nil
						return n, err
					}
				},
				Flush: func(next httpsnoop.FlushFunc) httpsnoop.FlushFunc { return func() { next(); wroteHeader = true } },
			})
			defer func() {
				failure := recover()
				func() {
					defer func() { _ = recover() }()
					request := capturedBody{nil, "missing"}
					if input != nil && len(input.bytes) > 0 {
						complete := input.complete
						if r.ContentLength >= 0 {
							complete = int64(len(input.bytes)) == r.ContentLength
						}
						request = captureBody(input.bytes, input.truncated || !complete)
					}
					output.truncated = output.truncated || (failure != nil && len(output.bytes) > 0)
					response := capturedBody{nil, "missing"}
					bodyAllowed := r.Method != "HEAD" && status >= 200 && status != 204 && status != 304
					if bodyAllowed {
						if length, err := strconv.ParseInt(w.Header().Get("Content-Length"), 10, 64); err == nil && length >= 0 {
							output.truncated = output.truncated || int64(len(output.bytes)) != length
						}
					}
					if bodyAllowed && isJSON(w.Header().Get("Content-Type")) {
						response = captureBody(output.bytes, output.truncated)
					}
					data := base()
					data["body"] = request.Body
					data["requestBodyState"] = request.State
					data["redaction"] = redaction("body", request.State)
					c.add("backend.req.start", data, started.UnixMilli())
					if failure != nil {
						if !wroteHeader {
							status = 500
						}
						data = base()
						data["error"] = map[string]any{"name": "panic"}
						c.add("backend.req.error", data, time.Now().UnixMilli())
					}
					data = base()
					data["statusCode"] = status
					data["durationMs"] = float64(time.Since(started).Microseconds()) / 1000
					data["responseBody"] = response.Body
					data["responseBodyState"] = response.State
					data["responseBodyTruncated"] = output.truncated
					data["redaction"] = redaction("responseBody", response.State)
					c.add("backend.req.end", data, time.Now().UnixMilli())
					c.flush(options.Sink)
				}()
				if failure != nil {
					panic(failure)
				}
			}()
			next.ServeHTTP(wrapped, r)
		})
	}
}

// Hide ReaderFrom to ensure io.Copy observes every response byte.
type writerOnly struct{ writer io.Writer }

func (w writerOnly) Write(p []byte) (int, error) { return w.writer.Write(p) }

type captureWriter struct {
	w      http.ResponseWriter
	output *responseAccumulator
	wrote  *bool
}

func (w captureWriter) Write(p []byte) (int, error) {
	n, err := w.w.Write(p)
	*w.wrote = true
	w.output.keep(p[:n])
	w.output.truncated = w.output.truncated || err != nil || n < len(p)
	return n, err
}
