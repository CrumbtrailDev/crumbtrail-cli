package ai.crumbtrail.sdk

/**
 * A JSON value with a deterministic serialisation.
 *
 * Hand-rolled rather than pulling in kotlinx.serialization or Gson. A telemetry
 * SDK is a dependency of someone else's app, and every transitive dependency it
 * drags in is a version conflict waiting to happen in a build the SDK author
 * will never see. This is a few hundred lines and depends on nothing.
 *
 * Object keys are emitted in sorted order so the same value always produces the
 * same bytes — which is what lets the conformance tests compare against the
 * shared fixtures at all.
 */
sealed class JsonValue {
    object Null : JsonValue()
    data class Bool(val value: Boolean) : JsonValue()
    data class Num(val value: Number) : JsonValue()
    data class Str(val value: String) : JsonValue()
    data class Arr(val values: List<JsonValue>) : JsonValue()
    data class Obj(val values: Map<String, JsonValue>) : JsonValue()

    fun toJson(): String = StringBuilder().also { write(it) }.toString()

    private fun write(out: StringBuilder) {
        when (this) {
            is Null -> out.append("null")
            is Bool -> out.append(if (value) "true" else "false")
            is Num -> out.append(formatNumber(value))
            is Str -> writeString(value, out)
            is Arr -> {
                out.append('[')
                values.forEachIndexed { index, value ->
                    if (index > 0) out.append(',')
                    value.write(out)
                }
                out.append(']')
            }
            is Obj -> {
                out.append('{')
                values.entries.sortedBy { it.key }.forEachIndexed { index, entry ->
                    if (index > 0) out.append(',')
                    writeString(entry.key, out)
                    out.append(':')
                    entry.value.write(out)
                }
                out.append('}')
            }
        }
    }

    companion object {
        /**
         * Build an object, dropping null-valued keys.
         *
         * The contract's rule: an absent field and a null one are different
         * claims, and "we did not observe this" is almost always the true one.
         */
        fun of(vararg pairs: Pair<String, JsonValue?>): Obj =
            Obj(pairs.mapNotNull { (key, value) ->
                if (value == null || value is Null) null else key to value
            }.toMap())

        fun str(value: String?): JsonValue? = value?.let(::Str)
        fun num(value: Number?): JsonValue? = value?.let(::Num)
        fun bool(value: Boolean?): JsonValue? = value?.let(::Bool)

        /**
         * Whole doubles are emitted without a trailing `.0`.
         *
         * Not cosmetic: `402.0` and `402` are different tokens, and a
         * conformance test comparing serialised bytes against a fixture written
         * by another language would fail on the difference alone.
         */
        private fun formatNumber(value: Number): String = when (value) {
            is Double ->
                if (value.isFinite() && value == Math.floor(value) && Math.abs(value) < 1e15)
                    value.toLong().toString()
                else value.toString()
            is Float -> formatNumber(value.toDouble())
            else -> value.toString()
        }

        private fun writeString(value: String, out: StringBuilder) {
            out.append('"')
            for (char in value) {
                when (char) {
                    '"' -> out.append("\\\"")
                    '\\' -> out.append("\\\\")
                    '\n' -> out.append("\\n")
                    '\r' -> out.append("\\r")
                    '\t' -> out.append("\\t")
                    '\b' -> out.append("\\b")
                    '\u000C' -> out.append("\\f")
                    else ->
                        // Control characters must be escaped or the payload is
                        // not valid JSON and ingest rejects the whole batch.
                        if (char < ' ') out.append("\\u%04x".format(char.code))
                        else out.append(char)
                }
            }
            out.append('"')
        }
    }
}
