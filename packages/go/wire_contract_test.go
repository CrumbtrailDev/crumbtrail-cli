package crumbtrail

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// Conformance against test-fixtures/wire-contract/.
//
// The Swift, Kotlin, Dart and Ruby SDKs run the equivalent of this file against the same
// files. Changing a fixture therefore fails all of them at once, which is the only mechanism
// that reliably catches one SDK quietly renaming an envelope field.
//
// The fixtures are read from the repository root rather than copied in: a per SDK copy would
// hide exactly the cross language drift they exist to catch.
func fixturePath(t *testing.T, parts ...string) string {
	t.Helper()
	return filepath.Join(append([]string{repositoryRoot(t), "test-fixtures", "wire-contract"}, parts...)...)
}

func decodeFixture(t *testing.T, path string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value map[string]any
	if err := decoder.Decode(&value); err != nil {
		t.Fatal(err)
	}
	return value
}

func TestWireContractFixturesAreReachable(t *testing.T) {
	// If the path arithmetic is wrong, every other test here would pass vacuously.
	fixture := decodeFixture(t, fixturePath(t, "events", "net.json"))
	if fixture["k"] != "net" {
		t.Fatalf("unexpected fixture %v", fixture)
	}
}

// Every shared event kind, serialized through this SDK's own envelope type. The payload and
// the sdk descriptor come from the fixture, because a backend SDK does not emit these kinds;
// the envelope field names, their presence and their encoding are this SDK's own.
func TestWireContractEnvelope(t *testing.T) {
	entries, err := os.ReadDir(fixturePath(t, "events"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) == 0 {
		t.Fatal("no wire contract event fixtures")
	}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		t.Run(entry.Name(), func(t *testing.T) {
			fixture := decodeFixture(t, fixturePath(t, "events", entry.Name()))
			timestamp, err := fixture["t"].(json.Number).Int64()
			if err != nil {
				t.Fatal(err)
			}
			schema, err := fixture["schemaVersion"].(json.Number).Int64()
			if err != nil {
				t.Fatal(err)
			}
			if schema != SchemaVersion {
				t.Fatalf("fixture schemaVersion %d, SDK sends %d", schema, SchemaVersion)
			}
			descriptor := fixture["sdk"].(map[string]any)
			event := Event{
				T:             timestamp,
				K:             fixture["k"].(string),
				D:             fixture["d"].(map[string]any),
				SchemaVersion: SchemaVersion,
				Platform:      fixture["platform"].(string),
				SDK:           SDK{Name: descriptor["name"].(string), Version: descriptor["version"].(string)},
			}
			if capabilities, ok := fixture["capabilities"].([]any); ok {
				for _, capability := range capabilities {
					event.Capabilities = append(event.Capabilities, capability.(string))
				}
			}
			if target, ok := fixture["target"].(map[string]any); ok {
				event.Target = target
			}
			encoded, err := json.Marshal(event)
			if err != nil {
				t.Fatal(err)
			}
			decoder := json.NewDecoder(bytes.NewReader(encoded))
			decoder.UseNumber()
			var actual map[string]any
			if err := decoder.Decode(&actual); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(actual, fixture) {
				t.Fatalf("does not match test-fixtures/wire-contract/events/%s\nactual   %s", entry.Name(), encoded)
			}
		})
	}
}

func TestWireContractTransportPath(t *testing.T) {
	var transport struct {
		Endpoints struct {
			Events struct {
				Path string `json:"path"`
			} `json:"events"`
		} `json:"endpoints"`
	}
	raw, err := os.ReadFile(fixturePath(t, "transport.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &transport); err != nil {
		t.Fatal(err)
	}
	sender, err := NewSender(SenderConfig{Endpoint: "https://ingest.example.com/prefix", Key: "key"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(sender.endpoint, transport.Endpoints.Events.Path) {
		t.Fatalf("sender posts to %q, contract says %q", sender.endpoint, transport.Endpoints.Events.Path)
	}
}

// The envelope this SDK actually produces, from a real middleware run rather than a fixture.
func TestProductionEventsCarryTheEnvelope(t *testing.T) {
	sink := &memorySink{}
	handler := Middleware(Options{Sink: sink, Service: "test", ShouldCapture: captureAll})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	handler.ServeHTTP(httptest.NewRecorder(), request(""))
	events := sink.events()
	if len(events) == 0 {
		t.Fatal("no events")
	}
	for _, event := range events {
		if event.SchemaVersion != SchemaVersion || event.Platform != Platform {
			t.Fatalf("%s carries schemaVersion %d platform %q", event.K, event.SchemaVersion, event.Platform)
		}
		if event.SDK.Name == "" || event.SDK.Version == "" {
			t.Fatalf("%s carries sdk %+v", event.K, event.SDK)
		}
		// An absent field and an empty array are different claims on the ingest side.
		encoded, _ := json.Marshal(event)
		if bytes.Contains(encoded, []byte(`"capabilities"`)) || bytes.Contains(encoded, []byte(`"target"`)) {
			t.Fatalf("%s sends an empty envelope field: %s", event.K, encoded)
		}
	}
}
