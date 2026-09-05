package ai.crumbtrail.sdk

/**
 * A tiny recursive-descent JSON reader for the shared fixture files.
 *
 * org.json is an Android class and absent from a plain JVM test run, and a test
 * only dependency that parses JSON would be one more thing to keep aligned with
 * the Dart and Swift suites. Shared between the wire contract conformance test
 * and the redaction fixture test.
 */
internal class MiniJson(private val src: String) {
    private var i = 0

    fun parseValue(): JsonValue {
        skipWhitespace()
        return when (val c = src[i]) {
            '{' -> parseObject()
            '[' -> parseArray()
            '"' -> JsonValue.Str(parseString())
            't' -> { expect("true"); JsonValue.Bool(true) }
            'f' -> { expect("false"); JsonValue.Bool(false) }
            'n' -> { expect("null"); JsonValue.Null }
            else -> if (c == '-' || c.isDigit()) parseNumber()
                    else error("unexpected '$c' at $i")
        }
    }

    private fun parseObject(): JsonValue {
        expect("{")
        val out = LinkedHashMap<String, JsonValue>()
        skipWhitespace()
        if (src[i] == '}') { i++; return JsonValue.Obj(out) }
        while (true) {
            skipWhitespace()
            val key = parseString()
            skipWhitespace()
            expect(":")
            out[key] = parseValue()
            skipWhitespace()
            when (src[i]) {
                ',' -> i++
                '}' -> { i++; return JsonValue.Obj(out) }
                else -> error("expected , or } at $i")
            }
        }
    }

    private fun parseArray(): JsonValue {
        expect("[")
        val out = mutableListOf<JsonValue>()
        skipWhitespace()
        if (src[i] == ']') { i++; return JsonValue.Arr(out) }
        while (true) {
            out.add(parseValue())
            skipWhitespace()
            when (src[i]) {
                ',' -> i++
                ']' -> { i++; return JsonValue.Arr(out) }
                else -> error("expected , or ] at $i")
            }
        }
    }

    private fun parseString(): String {
        expect("\"")
        val out = StringBuilder()
        while (src[i] != '"') {
            if (src[i] == '\\') {
                i++
                when (val esc = src[i]) {
                    'n' -> out.append('\n')
                    't' -> out.append('\t')
                    'r' -> out.append('\r')
                    'b' -> out.append('\b')
                    'f' -> out.append('\u000C')
                    'u' -> {
                        out.append(src.substring(i + 1, i + 5).toInt(16).toChar())
                        i += 4
                    }
                    else -> out.append(esc)
                }
            } else {
                out.append(src[i])
            }
            i++
        }
        i++
        return out.toString()
    }

    private fun parseNumber(): JsonValue {
        val start = i
        while (i < src.length && (src[i].isDigit() || src[i] in "-+.eE")) i++
        val text = src.substring(start, i)
        return if (text.contains('.') || text.contains('e') || text.contains('E'))
            JsonValue.Num(text.toDouble())
        else JsonValue.Num(text.toLong())
    }

    private fun skipWhitespace() {
        while (i < src.length && src[i].isWhitespace()) i++
    }

    private fun expect(token: String) {
        require(src.startsWith(token, i)) { "expected '$token' at $i" }
        i += token.length
    }
}
