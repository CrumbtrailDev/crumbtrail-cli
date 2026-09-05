package crumbtrail

import (
	"bytes"
	"encoding/json"
	"io"
	"math"
	"mime"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Structured body policy. Go, Ruby and the ASP.NET Core package implement the same rules and
// are driven by the same corpus in test-fixtures/backend-body/cases.json, so a divergence
// between them fails a test instead of quietly producing three different bodies.
const bodyLimit = 16384
const policy = "crumbtrail.backend-redaction.v1"
const maxNesting = 8
const maxKeys = 64
const maxItems = 40

// Well below a phone number (10), a national insurance number (9) and a card (13 to 19).
const maxIntegerDigits = 6
const safeInteger = 9007199254740991

var denied = regexp.MustCompile(`(?i)password|passwd|passphrase|passcode|secret|token|auth|card|cvv|cvc|ssn|email|phone|address|iban|account|birth|credential|creds|cookie|session|privatekey|apikey|accesskey|securitycode|verificationcode|connection|routingnumber|taxid|nationalid|sortcode|name|postal|payload|beforejson|afterjson|mobile|contact|diagnosis|medical|patient|prescription|gender|ethnic|religion|salary|income|identifier|username|passport|insurance|beneficiary|guardian|occupation|citizen|latitude|longitude|coordinate|geolocation|province|country|street`)

// Short words that appear inside innocent identifiers ("capacity" contains "city"), so they are
// matched as whole words rather than as substrings.
var deniedWord = regexp.MustCompile(`(?i)^(pwd|pin|pan|otp|pass|sid|dob|zip|jwt|mfa|csrf|xsrf|city|town|geo|cell|race|sex|age|location|lat|lng|lon|gps)s?[0-9]*$`)
var camel = regexp.MustCompile(`([a-z0-9])([A-Z])`)
var nonWord = regexp.MustCompile(`[^a-zA-Z0-9]+`)
var fieldName = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)
var safeString = regexp.MustCompile(`^([a-z][a-z_]{0,22}|[A-Z]{3}|[0-9]{1,6})$`)
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

func sensitiveKey(key string) bool {
	if denied.MatchString(nonWord.ReplaceAllString(key, "")) {
		return true
	}
	for _, word := range nonWord.Split(camel.ReplaceAllString(key, "${1} ${2}"), -1) {
		if deniedWord.MatchString(word) {
			return true
		}
	}
	return false
}

func parseValue(d *json.Decoder, key string, depth int, removed *bool) (any, bool) {
	// A sensitive key is redacted whole. The subtree under it is consumed but never inspected,
	// so an oversized or oddly named field inside a secret cannot turn the whole body into
	// `invalid`, and its shape is not reported either. Ruby and .NET behave the same way.
	if sensitiveKey(key) {
		if !skipValue(d, depth) {
			return nil, false
		}
		*removed = true
		return "[REDACTED]", true
	}
	token, err := d.Token()
	if err != nil {
		return nil, false
	}
	var value any
	switch token := token.(type) {
	case json.Delim:
		if depth >= maxNesting {
			return nil, false
		}
		switch token {
		case '{':
			object := map[string]any{}
			for d.More() {
				t, err := d.Token()
				k, valid := t.(string)
				if err != nil || !valid || len(k) > 64 || !fieldName.MatchString(k) || len(object) >= maxKeys {
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
				if len(list) >= maxItems {
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
		if !safeNumber(token) {
			*removed = true
			return "[REDACTED]", true
		}
		value = token
	case string:
		if !safeString.MatchString(token) || tokenString.MatchString(token) {
			*removed = true
			return "[REDACTED]", true
		}
		value = token
	case nil, bool:
		value = token
	default:
		return nil, false
	}
	return value, true
}

// skipValue consumes one value without applying any shape rule to it. Well formedness,
// nesting depth and duplicate keys still hold, because those are properties of the document
// rather than of the redacted value.
func skipValue(d *json.Decoder, depth int) bool {
	token, err := d.Token()
	if err != nil {
		return false
	}
	delim, isDelim := token.(json.Delim)
	if !isDelim {
		return true
	}
	if depth >= maxNesting {
		return false
	}
	switch delim {
	case '{':
		seen := map[string]struct{}{}
		for d.More() {
			t, err := d.Token()
			k, valid := t.(string)
			if err != nil || !valid {
				return false
			}
			if _, exists := seen[k]; exists {
				return false
			}
			seen[k] = struct{}{}
			if !skipValue(d, depth+1) {
				return false
			}
		}
	case '[':
		for d.More() {
			if !skipValue(d, depth+1) {
				return false
			}
		}
	default:
		return false
	}
	if _, err := d.Token(); err != nil {
		return false
	}
	return true
}

// The integer digit cap already excludes every card length. Luhn stays because it also catches
// a card smuggled across a decimal point, where the integer part is short.
func safeNumber(token json.Number) bool {
	f, err := token.Float64()
	if err != nil || math.IsInf(f, 0) || math.IsNaN(f) || math.Abs(f) > safeInteger {
		return false
	}
	text := strconv.FormatFloat(math.Abs(f), 'f', -1, 64)
	integer := text
	if dot := strings.IndexByte(text, '.'); dot >= 0 {
		integer = text[:dot]
	}
	if len(integer) > maxIntegerDigits {
		return false
	}
	return !luhn(strings.Replace(text, ".", "", 1))
}

func luhn(digits string) bool {
	if len(digits) < 13 || len(digits) > 19 {
		return false
	}
	sum, twice := 0, false
	for i := len(digits) - 1; i >= 0; i-- {
		if digits[i] < '0' || digits[i] > '9' {
			return false
		}
		n := int(digits[i] - '0')
		if twice {
			n *= 2
			if n > 9 {
				n -= 9
			}
		}
		sum += n
		twice = !twice
	}
	return sum%10 == 0
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
