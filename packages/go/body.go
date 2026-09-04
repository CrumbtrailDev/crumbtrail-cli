package crumbtrail

import (
	"bytes"
	"encoding/json"
	"io"
	"math"
	"mime"
	"regexp"
	"strings"
	"unicode/utf8"
)

const bodyLimit = 16384
const policy = "crumbtrail.backend-redaction.v1"

var denied = regexp.MustCompile(`(?i)password|passwd|passphrase|passcode|secret|token|auth|card|cvv|cvc|ssn|email|phone|address|iban|account|birth|credential|creds|cookie|session|privatekey|apikey|accesskey|securitycode|verificationcode|connection|routingnumber|taxid|nationalid|sortcode|name|postal|payload|beforejson|afterjson`)
var deniedWord = regexp.MustCompile(`(?i)^(pwd|pin|pan|otp|pass|sid|dob|zip|jwt|mfa|csrf|xsrf)[0-9]*$`)
var camel = regexp.MustCompile(`([a-z0-9])([A-Z])`)
var nonWord = regexp.MustCompile(`[^a-zA-Z0-9]+`)
var fieldName = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)
var safeString = regexp.MustCompile(`^([a-z][a-z_]{0,22}|[A-Z]{3}|[0-9]{1,12})$`)
var tokenString = regexp.MustCompile(`(?i)(sk|pk|rk|ghp|gho|ghu|ghs|glpat|xox[baprs])[-_][a-zA-Z0-9_.=-]{12,}`)

type capturedBody struct {
	Body  any
	State string
}

func captureBody(raw []byte, truncated bool) capturedBody {
	if truncated || len(raw) > bodyLimit {
		return capturedBody{nil, "truncated"}
	}
	if len(raw) == 0 {
		return capturedBody{nil, "missing"}
	}
	if !utf8.Valid(raw) {
		return capturedBody{nil, "invalid"}
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	removed := false
	value, ok := parseValue(decoder, "", 0, &removed)
	if !ok {
		return capturedBody{nil, "invalid"}
	}
	if _, err := decoder.Token(); err != io.EOF {
		return capturedBody{nil, "invalid"}
	}
	result, err := json.Marshal(value)
	if err != nil {
		return capturedBody{nil, "invalid"}
	}
	if len(result) > bodyLimit {
		return capturedBody{nil, "truncated"}
	}
	state := "captured"
	if removed {
		state = "redacted"
	}
	return capturedBody{string(result), state}
}
func parseValue(d *json.Decoder, key string, depth int, removed *bool) (any, bool) {
	if depth > 8 {
		return nil, false
	}
	token, err := d.Token()
	if err != nil {
		return nil, false
	}
	sensitive := denied.MatchString(nonWord.ReplaceAllString(key, ""))
	for _, word := range nonWord.Split(camel.ReplaceAllString(key, "${1} ${2}"), -1) {
		sensitive = sensitive || deniedWord.MatchString(word)
	}
	var value any
	switch token := token.(type) {
	case json.Delim:
		switch token {
		case '{':
			object := map[string]any{}
			for d.More() {
				t, err := d.Token()
				k, valid := t.(string)
				if err != nil || !valid || len(k) > 64 || !fieldName.MatchString(k) || len(object) >= 64 {
					return nil, false
				}
				if _, exists := object[k]; exists {
					return nil, false
				}
				v, ok := parseValue(d, k, depth+1, removed)
				if !ok {
					return nil, false
				}
				object[k] = v
			}
			if t, err := d.Token(); err != nil || t != json.Delim('}') {
				return nil, false
			}
			value = object
		case '[':
			list := []any{}
			for d.More() {
				if len(list) >= 40 {
					return nil, false
				}
				v, ok := parseValue(d, key, depth+1, removed)
				if !ok {
					return nil, false
				}
				list = append(list, v)
			}
			if t, err := d.Token(); err != nil || t != json.Delim(']') {
				return nil, false
			}
			value = list
		default:
			return nil, false
		}
	case json.Number:
		number, err := token.Float64()
		if err != nil || math.Abs(number) >= 1e12 {
			sensitive = true
		}
		value = token
	case string:
		if !safeString.MatchString(token) || tokenString.MatchString(token) {
			sensitive = true
		}
		value = token
	case nil, bool:
		value = token
	default:
		return nil, false
	}
	if sensitive {
		*removed = true
		return "[REDACTED]", true
	}
	return value, true
}
func isJSON(contentType string) bool {
	media, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		return false
	}
	return media == "application/json" || (strings.HasPrefix(media, "application/") && strings.HasSuffix(media, "+json"))
}

func redaction(field, state string) map[string]any {
	fields := []any{}
	if state == "redacted" {
		fields = append(fields, map[string]any{"path": field, "reason": "backend_structured_profile", "action": "redacted"})
	}
	return map[string]any{"policy": policy, "fields": fields}
}
