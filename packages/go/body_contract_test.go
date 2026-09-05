package crumbtrail

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// Conformance against test-fixtures/backend-body/cases.json.
//
// The Ruby and ASP.NET Core packages run the same file. Reading it from the repository root
// rather than copying it in is the whole point: three hand written copies of this policy is
// how Ruby, Go and .NET ended up redacting the same body three different ways.
type bodyCase struct {
	Name  string          `json:"name"`
	Why   string          `json:"why"`
	Input string          `json:"input"`
	State string          `json:"state"`
	Body  json.RawMessage `json:"body"`
}

type bodyCorpus struct {
	Policy string `json:"policy"`
	Limits struct {
		Bytes         int   `json:"bytes"`
		Nesting       int   `json:"nesting"`
		Keys          int   `json:"keys"`
		Items         int   `json:"items"`
		IntegerDigits int   `json:"integerDigits"`
		SafeInteger   int64 `json:"safeInteger"`
	} `json:"limits"`
	Cases []bodyCase `json:"cases"`
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "test-fixtures")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("repository root not found")
		}
		dir = parent
	}
}

func loadBodyCorpus(t *testing.T) bodyCorpus {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(repositoryRoot(t), "test-fixtures", "backend-body", "cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var corpus bodyCorpus
	if err := json.Unmarshal(raw, &corpus); err != nil {
		t.Fatal(err)
	}
	if len(corpus.Cases) == 0 {
		// Without this every assertion below would pass vacuously.
		t.Fatal("backend body corpus is empty")
	}
	return corpus
}

func decode(t *testing.T, raw []byte) any {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		t.Fatalf("cannot decode %s: %v", raw, err)
	}
	return value
}

func TestBodyCorpusLimits(t *testing.T) {
	corpus := loadBodyCorpus(t)
	if corpus.Policy != policy {
		t.Fatalf("policy %q, corpus says %q", policy, corpus.Policy)
	}
	for _, check := range []struct {
		name           string
		actual, corpus int64
	}{
		{"bytes", bodyLimit, int64(corpus.Limits.Bytes)},
		{"nesting", maxNesting, int64(corpus.Limits.Nesting)},
		{"keys", maxKeys, int64(corpus.Limits.Keys)},
		{"items", maxItems, int64(corpus.Limits.Items)},
		{"integerDigits", maxIntegerDigits, int64(corpus.Limits.IntegerDigits)},
		{"safeInteger", safeInteger, corpus.Limits.SafeInteger},
	} {
		if check.actual != check.corpus {
			t.Errorf("%s limit is %d, corpus says %d", check.name, check.actual, check.corpus)
		}
	}
}

func TestBodyCorpus(t *testing.T) {
	for _, example := range loadBodyCorpus(t).Cases {
		t.Run(example.Name, func(t *testing.T) {
			got := captureBody([]byte(example.Input), false)
			if got.State != example.State {
				t.Fatalf("state %q, want %q: %s", got.State, example.State, example.Why)
			}
			if len(example.Body) == 0 || string(example.Body) == "null" {
				if got.Body != nil {
					t.Fatalf("body %v should have been withheld entirely", got.Body)
				}
				return
			}
			body, ok := got.Body.(string)
			if !ok {
				t.Fatalf("body %v is not serialized JSON", got.Body)
			}
			if want, actual := decode(t, example.Body), decode(t, []byte(body)); !reflect.DeepEqual(want, actual) {
				t.Fatalf("body %s, want %s: %s", body, example.Body, example.Why)
			}
		})
	}
}
