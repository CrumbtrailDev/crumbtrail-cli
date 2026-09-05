package crumbtrail

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
)

type SenderConfig struct {
	Endpoint, Key string
	HTTPClient    *http.Client
	// Logger receives one line per permanent refusal and per capture shed window. Nil uses the
	// standard logger. A refusal that is only recorded as a capture gap is invisible until
	// somebody opens the session, and a revoked key deserves to be visible at the process.
	Logger *log.Logger
}

type Sender struct {
	endpoint, key string
	client        *http.Client
	logger        *log.Logger
	queue         chan pendingBatch
	done          chan struct{}
	ctx           context.Context
	cancel        context.CancelFunc
	mu            sync.RWMutex
	closed        bool
	// Owned by the single delivery goroutine.
	shedUntil   time.Time
	shedReason  string
	shedSession string
	shedDropped int
}

type pendingBatch struct {
	session string
	payload []byte
	events  int
	gap     bool
}

const senderAttempts = 4
const maxShedSeconds = 300
const maxResponseBytes = 4096

// shedReasons are authored by the capture edge. An unrecognised reason is recorded as a plain
// delivery failure rather than passed through as an invented classification.
var shedReasons = map[string]bool{"kill_switch": true, "sessions_per_hour": true, "bytes_per_day": true,
	"rate_limited_ingest": true, "rate_limited_session_start": true, "trial_expired": true,
	"payment_failed": true, "upgrade_required": true}

func NewSender(config SenderConfig) (*Sender, error) {
	u, err := url.Parse(config.Endpoint)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || strings.TrimSpace(config.Key) == "" || strings.IndexFunc(config.Key, unicode.IsControl) >= 0 {
		return nil, errors.New("crumbtrail requires an HTTPS endpoint without credentials, query or fragment and a nonempty ingest key")
	}
	u.Path = "/api/events"
	u.RawPath = ""
	client := http.Client{Timeout: 5 * time.Second}
	if config.HTTPClient != nil {
		client = *config.HTTPClient
		client.Timeout = 5 * time.Second
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	logger := config.Logger
	if logger == nil {
		logger = log.Default()
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &Sender{endpoint: u.String(), key: config.Key, client: &client, logger: logger,
		queue: make(chan pendingBatch, 64), done: make(chan struct{}), ctx: ctx, cancel: cancel}
	go func() {
		defer close(s.done)
		for {
			select {
			case <-ctx.Done():
				return
			case batch, ok := <-s.queue:
				if !ok {
					return
				}
				s.deliver(batch)
			}
		}
	}()
	return s, nil
}

func (s *Sender) Enqueue(batch Batch) bool {
	payload, err := json.Marshal(batch)
	if err != nil {
		return false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.closed {
		return false
	}
	select {
	case s.queue <- pendingBatch{session: batch.SessionID, payload: payload, events: len(batch.Events)}:
		return true
	default:
		return false
	}
}

// Close drains pending batches until ctx expires, then cancels network work.
func (s *Sender) Close(ctx context.Context) error {
	s.mu.Lock()
	if !s.closed {
		s.closed = true
		close(s.queue)
	}
	s.mu.Unlock()
	select {
	case <-s.done:
		s.cancel()
		return nil
	case <-ctx.Done():
		s.cancel()
		return ctx.Err()
	}
}

func (s *Sender) deliver(batch pendingBatch) {
	if s.shedding() {
		if !batch.gap {
			s.shedDropped += batch.events
		}
		return
	}
	if !batch.gap {
		s.flushShedGap()
	}
	for attempt := 0; attempt < senderAttempts; attempt++ {
		req, err := http.NewRequestWithContext(s.ctx, http.MethodPost, s.endpoint, bytes.NewReader(batch.payload))
		if err != nil {
			return
		}
		req.Header.Set("Authorization", "Bearer "+s.key)
		req.Header.Set("Content-Type", "application/json")
		response, err := s.client.Do(req)
		if err == nil {
			body, _ := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes))
			response.Body.Close()
			if response.StatusCode == http.StatusAccepted {
				if reason, seconds, shed := shedDirective(response, body); shed {
					if !batch.gap {
						s.beginShed(batch, reason, seconds)
					}
					return
				}
			}
			if response.StatusCode/100 == 2 {
				return
			}
			// 429 and 5xx are the only answers worth repeating the identical batch into. A 404
			// names a session the cloud does not have, and every later batch for that id is
			// refused the same way, so retrying it only delays the gap that says the evidence
			// is gone.
			if response.StatusCode != http.StatusTooManyRequests && response.StatusCode < 500 {
				s.refuse(batch, response.StatusCode)
				return
			}
		}
		if attempt < senderAttempts-1 {
			select {
			case <-s.ctx.Done():
				return
			case <-time.After(time.Duration(attempt+1) * 250 * time.Millisecond):
			}
		}
	}
	s.refuse(batch, 0)
}

// A 202 passes any "is this a success" test while the cloud has already discarded the evidence.
// Reading the body is the only way to tell the two apart.
func shedDirective(response *http.Response, body []byte) (string, time.Duration, bool) {
	var directive struct {
		Capture           string  `json:"capture"`
		Reason            string  `json:"reason"`
		RetryAfterSeconds float64 `json:"retryAfterSeconds"`
	}
	if err := json.Unmarshal(body, &directive); err != nil || directive.Capture != "shed" {
		return "", 0, false
	}
	seconds := directive.RetryAfterSeconds
	if seconds <= 0 {
		if header, err := strconv.Atoi(strings.TrimSpace(response.Header.Get("Retry-After"))); err == nil {
			seconds = float64(header)
		}
	}
	if seconds < 0 {
		seconds = 0
	}
	if seconds > maxShedSeconds {
		seconds = maxShedSeconds
	}
	reason := directive.Reason
	if !shedReasons[reason] {
		reason = "delivery_failed"
	}
	return reason, time.Duration(seconds * float64(time.Second)), true
}

func (s *Sender) beginShed(batch pendingBatch, reason string, wait time.Duration) {
	s.shedUntil = time.Now().Add(wait)
	s.shedReason = reason
	s.shedSession = batch.session
	s.shedDropped = batch.events
	s.logger.Printf("crumbtrail: capture is shed at the endpoint (%s); pausing delivery for %s", reason, wait)
}

func (s *Sender) shedding() bool {
	return !s.shedUntil.IsZero() && time.Now().Before(s.shedUntil)
}

// The gap for a shed window cannot be delivered during the window. It is held and sent on the
// first batch after Retry-After has passed.
func (s *Sender) flushShedGap() {
	if s.shedUntil.IsZero() {
		return
	}
	session, reason, dropped := s.shedSession, s.shedReason, s.shedDropped
	s.shedUntil, s.shedReason, s.shedSession, s.shedDropped = time.Time{}, "", "", 0
	s.sendGap(session, reason, dropped, "capture shed by the endpoint")
}

func (s *Sender) refuse(batch pendingBatch, status int) {
	if batch.gap {
		return
	}
	detail := "retry budget exhausted"
	if status != 0 {
		detail = "HTTP " + strconv.Itoa(status)
	}
	s.logger.Printf("crumbtrail: refused %d captured event(s): %s", batch.events, detail)
	s.sendGap(batch.session, "delivery_failed", batch.events, detail)
}

func (s *Sender) sendGap(session, reason string, dropped int, detail string) {
	if session == "" || dropped <= 0 {
		return
	}
	event := newEvent(time.Now().UnixMilli(), "capture_gap", map[string]any{
		"kind": "capture_gap", "surface": "backend_request", "reason": reason,
		"sessionId": session, "droppedEventCount": dropped, "detail": detail})
	payload, err := json.Marshal(Batch{session, []Event{event}})
	if err != nil {
		return
	}
	s.deliver(pendingBatch{session: session, payload: payload, events: 1, gap: true})
}
