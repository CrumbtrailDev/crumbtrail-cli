package crumbtrail

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

type memorySink struct {
	mu      sync.Mutex
	batches []Batch
}

func (s *memorySink) Enqueue(b Batch) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.batches = append(s.batches, b)
	return true
}
func (s *memorySink) events() []Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []Event
	for _, b := range s.batches {
		out = append(out, b.Events...)
	}
	return out
}
func request(body string) *http.Request {
	r := httptest.NewRequest("POST", "https://example.com/api/quote?token=secret", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("x-crumbtrail-session-id", "go-contract-session")
	r.Header.Set("x-crumbtrail-request-id", "go-contract-request")
	return r
}
func find(t *testing.T, s *memorySink, kind string) map[string]any {
	t.Helper()
	for _, e := range s.events() {
		if e.K == kind {
			return e.D
		}
	}
	t.Fatalf("missing %s", kind)
	return nil
}
func TestLoopbackHTTPDatabase(t *testing.T) {
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	observed, err := WrapDB(db, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	sink := &memorySink{}
	handler := Middleware(Options{sink, "go-test", func(*http.Request) bool { return true }})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		input, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		if !strings.Contains(string(input), "never-send") {
			t.Error("request changed")
		}
		tx, err := observed.BeginTx(r.Context(), nil)
		if err != nil {
			t.Error(err)
			return
		}
		if _, err = tx.ExecContext(r.Context(), "CREATE TABLE items (value INTEGER)"); err != nil {
			t.Error(err)
		}
		stmt, err := tx.PrepareContext(r.Context(), "INSERT INTO items(value) VALUES (?)")
		if err != nil {
			t.Error(err)
			return
		}
		if _, err = stmt.ExecContext(r.Context(), 731); err != nil {
			t.Error(err)
		}
		stmt.Close()
		if err = tx.Commit(); err != nil {
			t.Error(err)
		}
		var operand int
		if err = observed.QueryRowContext(r.Context(), "SELECT value FROM items").Scan(&operand); err != nil || operand != 731 {
			t.Errorf("database result %v %d", err, operand)
		}
		if _, err = observed.ExecContext(r.Context(), "SELECT * FROM absent_secret_table"); err == nil {
			t.Error("expected error")
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"total":37.5,"currency":"CAD","password":"never-send"}`)
	}))
	server := httptest.NewServer(handler)
	defer server.Close()
	r := request(`{"amount":18.75,"entityId":731,"currency":"CAD","password":"never-send"}`)
	r.URL.Scheme = "http"
	r.URL.Host = strings.TrimPrefix(server.URL, "http://")
	r.RequestURI = ""
	response, err := server.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if !strings.Contains(string(body), "never-send") {
		t.Fatal("response changed")
	}
	start := find(t, sink, "backend.req.start")
	end := find(t, sink, "backend.req.end")
	if start["requestBodyState"] != "redacted" || end["responseBodyState"] != "redacted" {
		t.Fatal(start, end)
	}
	if !strings.Contains(start["body"].(string), "18.75") || !strings.Contains(end["responseBody"].(string), "37.5") {
		t.Fatal("safe operands lost")
	}
	find(t, sink, "db.statement")
	find(t, sink, "db.error")
	encoded, _ := json.Marshal(sink.batches)
	if strings.Contains(string(encoded), "never-send") || strings.Contains(string(encoded), "absent_secret_table") {
		t.Fatal("private evidence leaked")
	}
	if output := os.Getenv("CRUMBTRAIL_CAPTURE_CONTRACT_OUTPUT"); output != "" {
		if err := os.WriteFile(output, contractJSON(sink), 0600); err != nil {
			t.Fatal(err)
		}
	}
}
func TestBodyPolicy(t *testing.T) {
	for _, raw := range []string{`{"a":1,"a":2}`, `{"a":`, strings.Repeat("[", 10) + strings.Repeat("]", 10)} {
		if got := captureBody([]byte(raw), false); got.State != "invalid" {
			t.Fatal(raw, got)
		}
	}
	got := captureBody([]byte(`{"amount":18.75,"email":"x@example.com","routing_number":123,"id":4111111111111111}`), false)
	if got.State != "redacted" || strings.Contains(got.Body.(string), "4111111111111111") {
		t.Fatal(got)
	}
	if got := captureBody(make([]byte, bodyLimit+1), false); got.State != "truncated" {
		t.Fatal(got)
	}
}
func TestTruncationInterfacesAndFailureIsolation(t *testing.T) {
	sink := &memorySink{}
	large := `{"data":"` + strings.Repeat("a", 20000) + `"}`
	handler := Middleware(Options{sink, "test", func(*http.Request) bool { return true }})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := w.(http.Flusher); !ok {
			t.Error("flusher lost")
		}
		b, _ := io.ReadAll(r.Body)
		if string(b) != large {
			t.Error("request changed")
		}
		w.Header().Set("Content-Type", "application/json")
		io.Copy(w, strings.NewReader(large))
	}))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request(large))
	if recorder.Body.String() != large {
		t.Fatal("response changed")
	}
	if find(t, sink, "backend.req.start")["requestBodyState"] != "truncated" || find(t, sink, "backend.req.end")["responseBodyState"] != "truncated" {
		t.Fatal("missing truncation")
	}
	bad := Middleware(Options{panicSink{}, "test", func(*http.Request) bool { return true }})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "ok") }))
	bad.ServeHTTP(httptest.NewRecorder(), request(""))
}

type panicSink struct{}

func (panicSink) Enqueue(Batch) bool { panic("sink failed") }
func TestPanicPreserved(t *testing.T) {
	sink := &memorySink{}
	original := errors.New("private")
	handler := Middleware(Options{sink, "test", func(*http.Request) bool { return true }})(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic(original) }))
	func() {
		defer func() {
			if recover() != original {
				t.Error("panic changed")
			}
		}()
		handler.ServeHTTP(httptest.NewRecorder(), request(""))
	}()
	find(t, sink, "backend.req.error")
}
func TestDefaultAndInvalidCorrelation(t *testing.T) {
	sink := &memorySink{}
	for _, options := range []Options{{Sink: sink}, {Sink: sink, ShouldCapture: func(*http.Request) bool { return true }}} {
		r := request("")
		r.Header.Set("x-crumbtrail-request-id", "invalid\n")
		Middleware(options)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })).ServeHTTP(httptest.NewRecorder(), r)
	}
	if len(sink.events()) != 0 {
		t.Fatal("unexpected capture")
	}
}
func TestSenderTLSRetryAndClose(t *testing.T) {
	var mu sync.Mutex
	count := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		count++
		n := count
		mu.Unlock()
		if r.URL.Path != "/api/events" || r.Header.Get("Authorization") != "Bearer test-key" {
			t.Error("invalid delivery")
		}
		var batch Batch
		if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
			t.Error(err)
		}
		if n == 1 {
			w.WriteHeader(404)
		} else {
			w.WriteHeader(200)
		}
	}))
	defer server.Close()
	sender, err := NewSender(SenderConfig{server.URL, "test-key", server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	if !sender.Enqueue(Batch{"session", []Event{{1, "backend.req.end", map[string]any{"requestId": "request"}}}}) {
		t.Fatal("enqueue failed")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := sender.Close(ctx); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if count != 2 {
		t.Fatal(count)
	}
	if sender.Enqueue(Batch{}) {
		t.Fatal("enqueue after close")
	}
}
func TestSenderRejectsEndpoints(t *testing.T) {
	for _, endpoint := range []string{"http://localhost", "https://user:pass@example.com", "https://example.com/?key=x"} {
		if _, err := NewSender(SenderConfig{Endpoint: endpoint, Key: "key"}); err == nil {
			t.Fatal(endpoint)
		}
	}
}

func contractJSON(s *memorySink) []byte {
	b, _ := json.Marshal(Batch{s.batches[0].SessionID, s.events()})
	return b
}

func TestPanicAfterWriteKeepsStatus(t *testing.T) {
	sink := &memorySink{}
	handler := Middleware(Options{sink, "test", func(*http.Request) bool { return true }})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(202)
		io.WriteString(w, "partial")
		panic("private failure")
	}))
	func() { defer func() { recover() }(); handler.ServeHTTP(httptest.NewRecorder(), request("")) }()
	if find(t, sink, "backend.req.end")["statusCode"] != 202 {
		t.Fatal("recorded status differs from sent status")
	}
	find(t, sink, "backend.req.error")
}
func TestConcurrentContextsStaySeparate(t *testing.T) {
	sink := &memorySink{}
	handler := Middleware(Options{sink, "test", func(*http.Request) bool { return true }})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { time.Sleep(time.Millisecond); io.WriteString(w, "ok") }))
	var group sync.WaitGroup
	for _, id := range []string{"request-one", "request-two"} {
		group.Add(1)
		go func(id string) {
			defer group.Done()
			r := request("")
			r.Header.Set("x-crumbtrail-request-id", id)
			handler.ServeHTTP(httptest.NewRecorder(), r)
		}(id)
	}
	group.Wait()
	counts := map[string]int{}
	for _, e := range sink.events() {
		counts[e.D["requestId"].(string)]++
	}
	if counts["request-one"] != 2 || counts["request-two"] != 2 {
		t.Fatal(counts)
	}
}
func TestSenderDoesNotFollowRedirect(t *testing.T) {
	redirected := false
	destination := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { redirected = true }))
	defer destination.Close()
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, destination.URL, 307) }))
	defer server.Close()
	sender, err := NewSender(SenderConfig{server.URL, "key", server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	sender.Enqueue(Batch{})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := sender.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if redirected {
		t.Fatal("redirect leaked key")
	}
}

func TestEventLimitPreservesBoundaries(t *testing.T) {
	sink := &memorySink{}
	handler := Middleware(Options{sink, "test", func(*http.Request) bool { return true }})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for i := 0; i < 250; i++ {
			recordSQL(r.Context(), "sqlite", "SELECT 1", time.Now(), nil, nil)
		}
		io.WriteString(w, "ok")
	}))
	handler.ServeHTTP(httptest.NewRecorder(), request(""))
	find(t, sink, "backend.req.start")
	find(t, sink, "backend.req.end")
	gap := find(t, sink, "capture_gap")
	if gap["droppedEvents"] != 50 {
		t.Fatal(gap)
	}
	if len(sink.events()) != 203 {
		t.Fatal(len(sink.events()))
	}
}

type fromWriter struct{ *httptest.ResponseRecorder }

func (w fromWriter) ReadFrom(r io.Reader) (int64, error) { return io.Copy(w.ResponseRecorder, r) }

type readerOnly struct{ io.Reader }

func TestReaderFromPreservedAndCaptured(t *testing.T) {
	sink := &memorySink{}
	handler := Middleware(Options{sink, "test", func(*http.Request) bool { return true }})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := w.(io.ReaderFrom); !ok {
			t.Error("ReaderFrom lost")
		}
		w.Header().Set("Content-Type", "application/json")
		io.Copy(w, readerOnly{strings.NewReader(`{"total":37.5}`)})
	}))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(fromWriter{recorder}, request(""))
	if recorder.Body.String() != `{"total":37.5}` {
		t.Fatal(recorder.Body.String())
	}
	if find(t, sink, "backend.req.end")["responseBodyState"] != "captured" {
		t.Fatal("ReaderFrom bypassed capture")
	}
}

func TestPartialRequestDoesNotInventOperand(t *testing.T) {
	for _, length := range []int64{4, -1} {
		sink := &memorySink{}
		handler := Middleware(Options{sink, "test", func(*http.Request) bool { return true }})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			one := make([]byte, 1)
			r.Body.Read(one)
			io.WriteString(w, "ok")
		}))
		r := request("1234")
		r.ContentLength = length
		handler.ServeHTTP(httptest.NewRecorder(), r)
		body := find(t, sink, "backend.req.start")
		if body["requestBodyState"] != "truncated" || body["body"] != nil {
			t.Fatal(body)
		}
	}
}
func TestDuplicateCorrelationRejected(t *testing.T) {
	for _, header := range []string{"x-crumbtrail-session-id", "x-crumbtrail-request-id"} {
		sink := &memorySink{}
		r := request("")
		r.Header.Add(header, "second-valid-identity")
		Middleware(Options{sink, "test", func(*http.Request) bool { return true }})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })).ServeHTTP(httptest.NewRecorder(), r)
		if len(sink.events()) != 0 {
			t.Fatal("ambiguous request captured")
		}
	}
}
func TestOnlyMatchedRouteTemplateCaptured(t *testing.T) {
	sink := &memorySink{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/users/{email}", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "ok") })
	handler := Middleware(Options{sink, "test", func(*http.Request) bool { return true }})(mux)
	r := request("")
	r.URL.Path = "/api/users/private@example.com"
	handler.ServeHTTP(httptest.NewRecorder(), r)
	encoded, _ := json.Marshal(sink.events())
	if strings.Contains(string(encoded), "private@example.com") {
		t.Fatal("raw path leaked")
	}
	if find(t, sink, "backend.req.start")["route"] != "/api/users/{email}" {
		t.Fatal("matched template missing")
	}
	sink = &memorySink{}
	r = request("")
	r.URL.Path = "/token/secret-path-value"
	Middleware(Options{sink, "test", func(*http.Request) bool { return true }})(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})).ServeHTTP(httptest.NewRecorder(), r)
	if find(t, sink, "backend.req.start")["url"] != "/" {
		t.Fatal("unmatched raw path recorded")
	}
}

func TestShortDeclaredResponseWithheld(t *testing.T) {
	sink := &memorySink{}
	handler := Middleware(Options{sink, "test", func(*http.Request) bool { return true }})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Length", "4")
		io.WriteString(w, "1")
	}))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request(""))
	if recorder.Body.String() != "1" {
		t.Fatal("response changed")
	}
	end := find(t, sink, "backend.req.end")
	if end["responseBodyState"] != "truncated" || end["responseBody"] != nil {
		t.Fatal(end)
	}
}
func TestHeadDeclaredLengthDoesNotInventTruncation(t *testing.T) {
	sink := &memorySink{}
	handler := Middleware(Options{sink, "test", func(*http.Request) bool { return true }})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Length", "4")
	}))
	r := request("")
	r.Method = "HEAD"
	handler.ServeHTTP(httptest.NewRecorder(), r)
	end := find(t, sink, "backend.req.end")
	if end["responseBodyState"] != "missing" || end["responseBodyTruncated"] != false {
		t.Fatal(end)
	}
}

func TestRequestEOFDoesNotOverrideDeclaredLength(t *testing.T) {
	sink := &memorySink{}
	handler := Middleware(Options{sink, "test", func(*http.Request) bool { return true }})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.ReadAll(r.Body) }))
	r := request("1")
	r.ContentLength = 4
	handler.ServeHTTP(httptest.NewRecorder(), r)
	start := find(t, sink, "backend.req.start")
	if start["requestBodyState"] != "truncated" || start["body"] != nil {
		t.Fatal(start)
	}
}
