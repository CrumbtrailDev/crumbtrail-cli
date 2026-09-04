"""Bounded conservative backend structured profile; never captures free text."""
import json
import math
import re

MAX_BYTES = 16384
POLICY = "crumbtrail.backend-redaction.v1"
REDACTED = "[REDACTED]"
_DENIED = re.compile(r"password|passwd|passphrase|passcode|secret|token|auth|card|cvv|cvc|ssn|email|phone|address|iban|account|birth|credential|creds|cookie|session|privatekey|apikey|accesskey|securitycode|verificationcode|connection|routingnumber|taxid|nationalid|sortcode|name|postal|payload|beforejson|afterjson", re.I)
_WORD = re.compile(r"^(pwd|pin|pan|otp|pass|sid|dob|zip|jwt|mfa|csrf|xsrf)[0-9]*$", re.I)


def _sensitive(key):
    words = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", key)
    return _DENIED.search(re.sub(r"[^a-zA-Z0-9]", "", key)) or any(_WORD.fullmatch(w) for w in re.split(r"[^a-zA-Z0-9]+", words))


def _card(number):
    digits = str(number)
    if not re.fullmatch(r"[0-9]{13,19}", digits):
        return False
    total = 0
    for i, ch in enumerate(reversed(digits)):
        n = int(ch) * (2 if i % 2 else 1)
        total += n - 9 if n > 9 else n
    return total % 10 == 0


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result or len(result) >= 64 or not re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_]{0,63}", key):
            raise ValueError("ambiguous or unsupported object")
        result[key] = value
    return result


def capture_body(raw, truncated=False):
    if truncated or len(raw) > MAX_BYTES:
        return None, "truncated"
    if not raw:
        return None, "missing"
    removed = False

    def walk(value, key="", depth=0):
        nonlocal removed
        if depth > 8:
            raise ValueError("depth")
        if _sensitive(key):
            removed = True
            return REDACTED
        if isinstance(value, dict):
            return {k: walk(v, k, depth + 1) for k, v in value.items()}
        if isinstance(value, list):
            if len(value) > 40:
                raise ValueError("array size")
            return [walk(v, key, depth + 1) for v in value]
        if value is None or isinstance(value, bool):
            return value
        if isinstance(value, (float, int)):
            if math.isfinite(value) and abs(value) <= 9007199254740991 and not _card(value):
                return value
        elif isinstance(value, str) and re.fullmatch(r"(?:[a-z][a-z_]{0,22}|[A-Z]{3}|[0-9]{1,12})", value):
            return value
        removed = True
        return REDACTED

    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_object, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("number")))
        body = json.dumps(walk(value), separators=(",", ":"), ensure_ascii=True, allow_nan=False)
        if len(body.encode()) > MAX_BYTES:
            return None, "truncated"
        return body, "redacted" if removed else "captured"
    except (ValueError, RecursionError, OverflowError):
        return None, "invalid"


def redaction(field, state):
    return {"policy": POLICY, "fields": [{"path": field, "reason": "backend_structured_profile", "action": "redacted"}] if state == "redacted" else []}


def is_json(content_type):
    media = content_type.split(";", 1)[0].strip().lower()
    return media == "application/json" or (media.startswith("application/") and media.endswith("+json"))
