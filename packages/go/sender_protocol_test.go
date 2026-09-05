package crumbtrail

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// The delivery contract: what the sender decides once it has an answer.
//
// TestSenderTLSRetryAndClose proves the HTTPS path works. This is the part where the damage
// was: a 202 shed and a 401 both read as success, so a revoked key produced a working looking
// SDK and a permanently empty project.

type deliveryLog struct {
	mu       sync.Mutex
	requests []Batch
}

func (d *deliveryLog) record(r *http.Request) {
	var batch Batch
	body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	_ = json.Unmarshal(body, &batch)
	d.mu.Lock()
	defer d.mu.Unlock()
	d.requests = append(d.requests, batch)
}

func (d *deliveryLog) count() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.requests)
}

func (d *deliveryLog) gaps() []map[string]any {
	d.mu.Lock()
	defer d.mu.Unlock()
	var out []map[string]any
	for _, batch := range d.requests {
		for _, event := range batch.Events {
			if event.K == "capture_gap" {
				out = append(out, event.D)
			}
		}
	}
	return out
}

// answers replies with each status in turn, then 200 for anything after.
func newDelivery(t *testing.T, answer func(int, http.ResponseWriter)) (*Sender, *deliveryLog, *strings.Builder) {
	t.Helper()
	delivery := &deliveryLog{}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		delivery.record(r)
		answer(delivery.count(), w)
	}))
	t.Cleanup(server.Close)
	messages := &strings.Builder{}
	sender, err := NewSender(SenderConfig{Endpoint: server.URL, Key: "test-key", HTTPClient: server.Client(),
		Logger: log.New(messages, "", 0)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = sender.Close(ctx)
	})
	return sender, delivery, messages
}

func batchOf(session string, count int) pendingBatch {
	events := make([]Event, count)
	for i := range events {
		events[i] = newEvent(int64(i), "backend.req.end", map[string]any{})
	}
	payload, _ := json.Marshal(Batch{session, events})
	return pendingBatch{session: session, payload: payload, events: count}
}

func TestPermanentStatusRecordsAGapAndLogs(t *testing.T) {
	sender, delivery, messages := newDelivery(t, func(n int, w http.ResponseWriter) {
		if n == 1 {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	// deliver is driven directly so the assertions do not race the delivery goroutine.
	sender.deliver(batchOf("session", 4))
	if delivery.count() != 2 {
		t.Fatalf("a 401 was attempted %d times; the key is revoked, repeating cannot help", delivery.count()-1)
	}
	gaps := delivery.gaps()
	if len(gaps) != 1 {
		t.Fatal("a permanent refusal left no record that the evidence is gone")
	}
	if gaps[0]["reason"] != "delivery_failed" || gaps[0]["droppedEventCount"] != float64(4) || gaps[0]["detail"] != "HTTP 401" {
		t.Fatalf("gap %v", gaps[0])
	}
	if !strings.Contains(messages.String(), "HTTP 401") {
		t.Fatalf("nothing was logged: %q", messages.String())
	}
}

func TestNotFoundIsAttemptedOnce(t *testing.T) {
	sender, delivery, _ := newDelivery(t, func(n int, w http.ResponseWriter) {
		if n == 1 {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	sender.deliver(batchOf("session", 1))
	if delivery.count() != 2 {
		t.Fatalf("%d requests; want the batch once plus its gap", delivery.count())
	}
}

func TestRetryableStatusIsRepeatedThenAccepted(t *testing.T) {
	sender, delivery, _ := newDelivery(t, func(n int, w http.ResponseWriter) {
		switch n {
		case 1:
			w.WriteHeader(http.StatusTooManyRequests)
		case 2:
			w.WriteHeader(http.StatusServiceUnavailable)
		default:
			w.WriteHeader(http.StatusOK)
		}
	})
	sender.deliver(batchOf("session", 2))
	if delivery.count() != 3 {
		t.Fatalf("%d attempts, want 3", delivery.count())
	}
	if gaps := delivery.gaps(); len(gaps) != 0 {
		t.Fatalf("a batch that was eventually accepted reported a hole: %v", gaps)
	}
}

// A 202 passes every "is this a success" test while the cloud has already discarded the batch.
func TestShedPausesDeliveryAndReportsTheWholeHole(t *testing.T) {
	sender, delivery, messages := newDelivery(t, func(n int, w http.ResponseWriter) {
		if n == 1 {
			w.WriteHeader(http.StatusAccepted)
			io.WriteString(w, `{"capture":"shed","reason":"rate_limited_ingest","retryAfterSeconds":0.05}`)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	sender.deliver(batchOf("session", 3))
	if delivery.count() != 1 {
		t.Fatal(delivery.count())
	}
	if !strings.Contains(messages.String(), "rate_limited_ingest") {
		t.Fatalf("the shed window was not logged: %q", messages.String())
	}
	sender.deliver(batchOf("session", 5))
	if delivery.count() != 1 {
		t.Fatal("delivery continued inside the Retry-After window")
	}
	time.Sleep(80 * time.Millisecond)
	sender.deliver(batchOf("session", 1))
	if delivery.count() != 3 {
		t.Fatalf("%d requests; delivery did not resume with its held gap after the window", delivery.count())
	}
	gaps := delivery.gaps()
	if len(gaps) != 1 || gaps[0]["reason"] != "rate_limited_ingest" {
		t.Fatalf("gaps %v", gaps)
	}
	if gaps[0]["droppedEventCount"] != float64(8) {
		t.Fatalf("dropped %v; the shed batch and the suppressed batch are both lost", gaps[0]["droppedEventCount"])
	}
}

func TestRetryAfterHeaderIsHonouredWithoutABodyField(t *testing.T) {
	sender, delivery, _ := newDelivery(t, func(n int, w http.ResponseWriter) {
		if n == 1 {
			w.Header().Set("Retry-After", "120")
			w.WriteHeader(http.StatusAccepted)
			io.WriteString(w, `{"capture":"shed","reason":"kill_switch"}`)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	sender.deliver(batchOf("session", 1))
	sender.deliver(batchOf("session", 1))
	if delivery.count() != 1 {
		t.Fatal("the Retry-After header was ignored")
	}
}

// An unrecognised reason is a classification this SDK cannot vouch for.
func TestUnknownShedReasonIsRecordedAsAPlainDeliveryFailure(t *testing.T) {
	sender, delivery, _ := newDelivery(t, func(n int, w http.ResponseWriter) {
		if n == 1 {
			w.WriteHeader(http.StatusAccepted)
			io.WriteString(w, `{"capture":"shed","reason":"something_new","retryAfterSeconds":0}`)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	sender.deliver(batchOf("session", 2))
	sender.deliver(batchOf("session", 1))
	gaps := delivery.gaps()
	if len(gaps) != 1 || gaps[0]["reason"] != "delivery_failed" {
		t.Fatalf("gaps %v", gaps)
	}
}

// Without this the first refusal posts a gap, the gap is refused, and that posts a gap.
func TestARefusedGapDoesNotRecurse(t *testing.T) {
	sender, delivery, _ := newDelivery(t, func(_ int, w http.ResponseWriter) { w.WriteHeader(http.StatusUnauthorized) })
	sender.deliver(batchOf("session", 1))
	if delivery.count() != 2 {
		t.Fatalf("%d requests, want the batch and one gap", delivery.count())
	}
}

func TestCloseDoesNotWaitOutTheRetryBudget(t *testing.T) {
	sender, _, _ := newDelivery(t, func(_ int, w http.ResponseWriter) { w.WriteHeader(http.StatusServiceUnavailable) })
	sender.Enqueue(Batch{"session", []Event{newEvent(1, "backend.req.end", map[string]any{})}})
	started := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_ = sender.Close(ctx)
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("close waited %s for the retry backoff", elapsed)
	}
}
