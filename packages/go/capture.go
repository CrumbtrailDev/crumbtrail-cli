// Package crumbtrail captures correlated net/http requests for Crumbtrail.
package crumbtrail

import (
	"context"
	"io"
	"net/http"
	"regexp"
	"sort"
	"sync"
	"time"

	"github.com/felixge/httpsnoop"
)

type Event struct {
	T int64          `json:"t"`
	K string         `json:"k"`
	D map[string]any `json:"d"`
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
}
type contextKey struct{}
type captureContext struct {
	mu               sync.Mutex
	session, request string
	events           []Event
	dropped, seq     int
}

var validID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

func (c *captureContext) add(kind string, data map[string]any, t int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.events) >= 200 && kind != "backend.req.start" && kind != "backend.req.end" && kind != "backend.req.error" {
		c.dropped++
		return
	}
	data["requestId"] = c.request
	data["sessionId"] = c.session
	c.events = append(c.events, Event{t, kind, data})
}
func (c *captureContext) flush(sink Sink) {
	defer func() { _ = recover() }()
	c.mu.Lock()
	events := c.events
	c.events = nil
	dropped := c.dropped
	c.mu.Unlock()
	if dropped > 0 {
		events = append(events, Event{time.Now().UnixMilli(), "capture_gap", map[string]any{"kind": "capture_gap", "surface": "backend_request", "reason": "scan_budget_exceeded", "requestId": c.request, "droppedEvents": dropped}})
	}
	sort.SliceStable(events, func(i, j int) bool {
		if events[i].T == events[j].T {
			return events[i].K == "backend.req.start" && events[j].K != "backend.req.start"
		}
		return events[i].T < events[j].T
	})
	for len(events) > 0 {
		n := min(20, len(events))
		sink.Enqueue(Batch{c.session, events[:n]})
		events = events[n:]
	}
}

type bodyReader struct {
	io.ReadCloser
	bytes     []byte
	truncated bool
}

func (b *bodyReader) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	b.keep(p[:n])
	return n, err
}
func (b *bodyReader) keep(p []byte) {
	remaining := bodyLimit - len(b.bytes)
	b.bytes = append(b.bytes, p[:min(remaining, len(p))]...)
	b.truncated = b.truncated || len(p) > remaining
}
func eligible(options Options, r *http.Request) (result bool) {
	defer func() {
		if recover() != nil {
			result = false
		}
	}()
	return options.Sink != nil && options.ShouldCapture != nil && options.ShouldCapture(r) && r.Header.Get("Upgrade") == "" && validID.MatchString(r.Header.Get("x-crumbtrail-session-id")) && validID.MatchString(r.Header.Get("x-crumbtrail-request-id"))
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
			output := &bodyReader{}
			status := 200
			wroteHeader := false
			base := func() map[string]any {
				return map[string]any{"method": r.Method, "url": r.URL.Path, "pathname": r.URL.Path, "route": r.URL.Path, "service": options.Service, "correlation": map[string]any{"status": "linked", "sessionIdSource": "header", "requestIdSource": "header"}}
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
					return func(p []byte) (int, error) { n, err := next(p); wroteHeader = true; output.keep(p[:n]); return n, err }
				},
				ReadFrom: func(_ httpsnoop.ReadFromFunc) httpsnoop.ReadFromFunc {
					return func(reader io.Reader) (int64, error) {
						return io.Copy(writerOnly{writer: captureWriter{w, output, &wroteHeader}}, reader)
					}
				},
				Flush: func(next httpsnoop.FlushFunc) httpsnoop.FlushFunc { return func() { next(); wroteHeader = true } },
			})
			defer func() {
				failure := recover()
				func() {
					defer func() { _ = recover() }()
					request := capturedBody{nil, "missing"}
					if input != nil {
						request = captureBody(input.bytes, input.truncated)
					}
					response := capturedBody{nil, "missing"}
					if isJSON(w.Header().Get("Content-Type")) {
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
	output *bodyReader
	wrote  *bool
}

func (w captureWriter) Write(p []byte) (int, error) {
	n, err := w.w.Write(p)
	*w.wrote = true
	w.output.keep(p[:n])
	return n, err
}
