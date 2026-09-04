package crumbtrail

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
	"unicode"
)

type SenderConfig struct {
	Endpoint, Key string
	HTTPClient    *http.Client
}
type Sender struct {
	endpoint, key string
	client        *http.Client
	queue         chan []byte
	done          chan struct{}
	ctx           context.Context
	cancel        context.CancelFunc
	mu            sync.RWMutex
	closed        bool
}

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
	ctx, cancel := context.WithCancel(context.Background())
	s := &Sender{endpoint: u.String(), key: config.Key, client: &client, queue: make(chan []byte, 64), done: make(chan struct{}), ctx: ctx, cancel: cancel}
	go func() {
		defer close(s.done)
		for {
			select {
			case <-ctx.Done():
				return
			case payload, ok := <-s.queue:
				if !ok {
					return
				}
				s.deliver(payload)
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
	case s.queue <- payload:
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
func (s *Sender) deliver(payload []byte) {
	for attempt := 0; attempt < 4; attempt++ {
		req, err := http.NewRequestWithContext(s.ctx, http.MethodPost, s.endpoint, bytes.NewReader(payload))
		if err != nil {
			return
		}
		req.Header.Set("Authorization", "Bearer "+s.key)
		req.Header.Set("Content-Type", "application/json")
		response, err := s.client.Do(req)
		if err == nil {
			io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
			response.Body.Close()
			if response.StatusCode == 200 {
				return
			}
			if response.StatusCode != 404 && response.StatusCode != 429 && response.StatusCode < 500 {
				return
			}
		}
		if attempt < 3 {
			select {
			case <-s.ctx.Done():
				return
			case <-time.After(time.Duration(attempt+1) * 250 * time.Millisecond):
			}
		}
	}
}
