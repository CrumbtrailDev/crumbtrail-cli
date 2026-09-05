package ai.crumbtrail.sdk

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Conformance against `test-fixtures/redaction/urls.json`.
 *
 * The Dart SDK runs the equivalent of this file against the same corpus, so a
 * rule that drifts in one language fails in both. The class doc on
 * [CrumbtrailRedaction] claims the SDKs are held to the same fixtures; this is
 * the file that makes that true for URLs.
 *
 * The corpus is read from the repo root rather than copied in: a per-SDK copy
 * would hide exactly the cross-language drift it exists to catch.
 */
class RedactionFixturesTest {
    private val fixture: File = run {
        var dir = File(System.getProperty("user.dir"))
        while (!File(dir, "test-fixtures/redaction").isDirectory) {
            dir = dir.parentFile ?: error("repo root not found from ${System.getProperty("user.dir")}")
        }
        File(dir, "test-fixtures/redaction/urls.json")
    }

    private fun cases(): List<Triple<String, String, String>> {
        val root = MiniJson(fixture.readText()).parseValue() as JsonValue.Obj
        val list = root.values["cases"] as JsonValue.Arr
        return list.values.map { entry ->
            val case = entry as JsonValue.Obj
            fun field(name: String) = (case.values[name] as JsonValue.Str).value
            Triple(field("name"), field("input"), field("expected"))
        }
    }

    @Test
    fun `the corpus is reachable and not empty`() {
        // If the path arithmetic above is wrong every other assertion here would
        // pass vacuously against an empty list. Fail loudly instead.
        assertTrue(fixture.isFile, "expected ${fixture.absolutePath} to exist")
        assertTrue(cases().size >= 10, "expected a corpus, found ${cases().size} cases")
    }

    @Test
    fun `every fixture URL redacts to the shared expectation`() {
        val failures = cases().mapNotNull { (name, input, expected) ->
            val actual = CrumbtrailRedaction.redactUrl(input)
            if (actual == expected) null else "$name\n  input:    $input\n  expected: $expected\n  actual:   $actual"
        }
        assertTrue(
            failures.isEmpty(),
            "test-fixtures/redaction/urls.json disagrees with this SDK:\n" + failures.joinToString("\n"),
        )
    }

    @Test
    fun `the marker is emitted literally so ingest can match on it`() {
        // Re-encoding the marker is the failure mode that hides a redaction from
        // every downstream consumer while still looking redacted to a reader.
        val redacted = CrumbtrailRedaction.redactUrl("https://api.example.com/api?token=abc")
        assertEquals("https://api.example.com/api?token=[REDACTED]", redacted)
    }

    @Test
    fun `verified leaks from the reviewed adapters stay redacted`() {
        for (url in listOf(
            "https://api.example.com/v1/users/omar@shabana.dev/profile",
            "https://api.example.com/reset-password/eyJhbGciOiJIUzI1NiJ9.abc.def",
            "https://api.example.com/api?q=Bearer%20sk-live-1234567890",
            "https://api.example.com/api?next=https%3A%2F%2Fx.com%3Ftoken%3Dsecret",
        )) {
            val redacted = CrumbtrailRedaction.redactUrl(url)
            assertTrue(redacted.contains(CrumbtrailRedaction.PLACEHOLDER), "not redacted: $redacted")
            for (secret in listOf("omar@shabana.dev", "eyJhbGciOiJIUzI1NiJ9", "sk-live-1234567890", "token%3Dsecret")) {
                assertTrue(!redacted.contains(secret), "leaked $secret in $redacted")
            }
        }
    }
}
