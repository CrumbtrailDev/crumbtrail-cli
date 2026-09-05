"""Bounded conservative backend structured profile; never captures free text."""
import functools
import json
import logging
import math
import re

log = logging.getLogger("crumbtrail")

MAX_BYTES = 16384
POLICY = "crumbtrail.backend-redaction.v1"
REDACTED = "[REDACTED]"
MAX_KEYS = 64
MAX_ARRAY = 40
MAX_DEPTH = 8
# Substring match against the key with separators stripped, so only terms that cannot
# appear inside an unrelated word belong here. Short location terms are matched as whole
# words by _WORD instead, otherwise "lat" would redact "latency" and "platform".
_DENIED = re.compile(r"password|passwd|passphrase|passcode|secret|token|auth|card|cvv|cvc|ssn|email|phone|address|iban|account|birth|credential|creds|cookie|session|privatekey|apikey|accesskey|securitycode|verificationcode|connection|routingnumber|taxid|nationalid|sortcode|name|postal|payload|beforejson|afterjson|latitude|longitude|geolocation|coordinate", re.I)
_WORD = re.compile(r"^(pwd|pin|pan|otp|pass|sid|dob|zip|jwt|mfa|csrf|xsrf|lat|lon|lng|geo|coord|coords)[0-9]*$", re.I)
_KEY = re.compile(r"[a-zA-Z_][a-zA-Z0-9_.-]{0,63}")
_CAMEL = re.compile(r"([a-z0-9])([A-Z])")
_STRIP = re.compile(r"[^a-zA-Z0-9]")
_SPLIT = re.compile(r"[^a-zA-Z0-9]+")
_ENUM = re.compile(r"(?:[a-z][a-z_]{0,22}|[A-Z]{3}|[0-9]{1,12})")
_DIGITS = re.compile(r"[0-9]{13,19}")


class _Unsupported(ValueError):
    """Well formed JSON whose shape the conservative profile will not export."""


@functools.lru_cache(maxsize=4096)
def _sensitive(key):
    words = _CAMEL.sub(r"\1 \2", key)
    return bool(_DENIED.search(_STRIP.sub("", key))) or any(_WORD.fullmatch(w) for w in _SPLIT.split(words))


def _card(number):
    digits = str(int(number)) if isinstance(number, float) and number.is_integer() else str(number)
    if not _DIGITS.fullmatch(digits):
        return False
    total = 0
    for i, ch in enumerate(reversed(digits)):
        n = int(ch) * (2 if i % 2 else 1)
        total += n - 9 if n > 9 else n
    return total % 10 == 0


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result or len(result) >= MAX_KEYS or not _KEY.fullmatch(key):
            raise _Unsupported("ambiguous or unsupported object")
        result[key] = value
    return result


def capture_body(raw, truncated=False):
    if truncated or len(raw) > MAX_BYTES:
        return None, "truncated"
    if not raw:
        return None, "missing"
    removed = False

    def walk(value, key="", depth=0, check_key=True):
        nonlocal removed
        if depth > MAX_DEPTH:
            raise _Unsupported("depth")
        if check_key and _sensitive(key):
            removed = True
            return REDACTED
        if isinstance(value, dict):
            return {k: walk(v, k, depth + 1) for k, v in value.items()}
        if isinstance(value, list):
            if len(value) > MAX_ARRAY:
                raise _Unsupported("array size")
            # The key is constant across elements and was cleared above, so skip it.
            return [walk(v, key, depth + 1, False) for v in value]
        if value is None or isinstance(value, bool):
            return value
        if isinstance(value, (float, int)):
            if math.isfinite(value) and abs(value) <= 9007199254740991 and not _card(value):
                return value
        elif isinstance(value, str) and _ENUM.fullmatch(value):
            return value
        removed = True
        return REDACTED

    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_object, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("number")))
        body = json.dumps(walk(value), separators=(",", ":"), ensure_ascii=True, allow_nan=False)
        if len(body.encode()) > MAX_BYTES:
            return None, "truncated"
        return body, "redacted" if removed else "captured"
    except _Unsupported as reason:
        # The bundle consumer accepts only captured, redacted, missing, invalid and
        # truncated, so an unsupported shape has to report "invalid". The log carries
        # the distinction a new state value would have carried.
        log.debug("Crumbtrail: body not exported, unsupported shape (%s)", reason)
        return None, "invalid"
    except (ValueError, RecursionError, OverflowError) as reason:
        log.debug("Crumbtrail: body not exported, invalid JSON (%s)", reason)
        return None, "invalid"


def redaction(field, state):
    return {"policy": POLICY, "fields": [{"path": field, "reason": "backend_structured_profile", "action": "redacted"}] if state == "redacted" else []}


def is_json(content_type):
    media = content_type.split(";", 1)[0].strip().lower()
    return media == "application/json" or (media.startswith("application/") and media.endswith("+json"))
