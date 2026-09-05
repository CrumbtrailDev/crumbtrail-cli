package ai.crumbtrail.sdk

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Conformance against `test-fixtures/wire-contract/`.
 *
 * The Swift and Dart SDKs run the equivalent of this file against the same
 * files. Changing a fixture therefore fails all three at once, which is the only
 * mechanism that reliably catches one SDK quietly renaming a field.
 *
 * The fixtures are read from the repo root rather than copied in: a per-SDK copy
 * would hide exactly the cross-language drift these exist to catch.
 */
class WireContractTest {
    private val fixtureSdk = CrumbtrailSdkDescriptor("crumbtrail-fixture", "0.0.0-fixture")
    private val fixtureTimestamp = 1_754_000_000_000L
    private val fixtureCapabilities = listOf("app-lifecycle", "device-info")

    private val fixtureDir: File = run {
        var dir = File(System.getProperty("user.dir"))
        while (!File(dir, "test-fixtures/wire-contract").isDirectory) {
            dir = dir.parentFile ?: error("repo root not found from ${System.getProperty("user.dir")}")
        }
        File(dir, "test-fixtures/wire-contract")
    }

    private fun event(
        kind: CrumbtrailEventKind,
        data: JsonValue,
        target: CrumbtrailTarget? = null,
    ) = CrumbtrailEvent(
        timestamp = fixtureTimestamp,
        kind = kind,
        data = data,
        platform = CrumbtrailPlatform.IOS,
        sdk = fixtureSdk,
        capabilities = fixtureCapabilities,
        target = target,
    )

    /**
     * Compare by canonical JSON text.
     *
     * Both sides are re-serialised through this SDK's own writer, which sorts
     * keys and normalises number formatting — so the comparison is about
     * structure and values, not about how a fixture file happens to be indented.
     */
    private fun assertMatchesFixture(event: CrumbtrailEvent, name: String) {
        val fixture = File(fixtureDir, "events/$name.json").readText()
        assertEquals(
            canonicalise(fixture),
            event.toJson().toJson(),
            "event does not match test-fixtures/wire-contract/events/$name.json",
        )
    }

    @Test
    fun `fixtures are reachable`() {
        // If the path arithmetic above is wrong every other test would pass
        // vacuously against an empty string. Fail loudly here instead.
        val fixture = File(fixtureDir, "events/net.json")
        assertTrue(fixture.isFile, "expected ${fixture.absolutePath} to exist")
        assertTrue(fixture.readText().contains("\"k\""))
    }

    @Test
    fun `error event`() = assertMatchesFixture(
        event(
            CrumbtrailEventKind.ERROR,
            JsonValue.of(
                "msg" to JsonValue.Str("Unexpected nil while unwrapping an Optional value"),
                "stk" to JsonValue.Str(
                    "CrumbtrailDemo.CheckoutViewController.submit()\n" +
                        "CrumbtrailDemo.CheckoutViewController.tap()"
                ),
                "fatal" to JsonValue.Bool(true),
                "source" to JsonValue.Str("uncaught-exception"),
            ),
        ),
        "err",
    )

    @Test
    fun `rejection event`() = assertMatchesFixture(
        event(
            CrumbtrailEventKind.REJECTION,
            JsonValue.of(
                "msg" to JsonValue.Str("The request timed out."),
                "stk" to JsonValue.Str("CrumbtrailDemo.OrderService.load()"),
                "source" to JsonValue.Str("unhandled-async"),
            ),
        ),
        "rej",
    )

    @Test
    fun `console event`() = assertMatchesFixture(
        event(
            CrumbtrailEventKind.CONSOLE,
            JsonValue.of(
                "lv" to JsonValue.Str("err"),
                "args" to JsonValue.Arr(
                    listOf(
                        JsonValue.Str("checkout failed"),
                        JsonValue.Str("{\"orderId\":42}"),
                    )
                ),
            ),
        ),
        "con",
    )

    @Test
    fun `network event`() = assertMatchesFixture(
        event(
            CrumbtrailEventKind.NETWORK,
            JsonValue.of(
                "url" to JsonValue.Str("https://api.example.com/v1/orders"),
                "method" to JsonValue.Str("POST"),
                "status" to JsonValue.Num(402),
                "ok" to JsonValue.Bool(false),
                "dur" to JsonValue.Num(318),
                "source" to JsonValue.Str("urlsession"),
            ),
        ),
        "net",
    )

    @Test
    fun `network status event`() = assertMatchesFixture(
        event(
            CrumbtrailEventKind.NETWORK_STATUS,
            JsonValue.of(
                "connected" to JsonValue.Bool(false),
                "type" to JsonValue.Str("none"),
                "kind" to JsonValue.Str("change"),
            ),
        ),
        "net-status",
    )

    @Test
    fun `environment event`() = assertMatchesFixture(
        event(
            CrumbtrailEventKind.ENVIRONMENT,
            JsonValue.of(
                "kind" to JsonValue.Str("snapshot"),
                "device" to JsonValue.of(
                    "model" to JsonValue.Str("iPhone15,2"),
                    "manufacturer" to JsonValue.Str("Apple"),
                    "os" to JsonValue.Str("iOS"),
                    "osVersion" to JsonValue.Str("18.2"),
                ),
                "app" to JsonValue.of(
                    "id" to JsonValue.Str("ai.crumbtrail.demo"),
                    "version" to JsonValue.Str("1.4.0"),
                    "build" to JsonValue.Str("204"),
                ),
                "battery" to JsonValue.of(
                    "level" to JsonValue.Num(0.42),
                    "charging" to JsonValue.Bool(false),
                ),
                "locale" to JsonValue.Str("en-GB"),
            ),
        ),
        "env",
    )

    @Test
    fun `navigation event`() = assertMatchesFixture(
        event(
            CrumbtrailEventKind.NAVIGATION,
            JsonValue.of(
                "name" to JsonValue.Str("CheckoutViewController"),
                "path" to JsonValue.Str("/checkout"),
                "source" to JsonValue.Str("navigation-controller"),
            ),
        ),
        "navigation",
    )

    @Test
    fun `navigation intent event`() = assertMatchesFixture(
        event(
            CrumbtrailEventKind.NAVIGATION_INTENT,
            JsonValue.of(
                "action" to JsonValue.Str("back"),
                "source" to JsonValue.Str("hardware-back"),
            ),
        ),
        "nav-intent",
    )

    @Test
    fun `app lifecycle event`() = assertMatchesFixture(
        event(
            CrumbtrailEventKind.APP_LIFECYCLE,
            JsonValue.of(
                "state" to JsonValue.Str("background"),
                "source" to JsonValue.Str("app-lifecycle"),
            ),
        ),
        "app-lifecycle",
    )

    @Test
    fun `native crash event`() = assertMatchesFixture(
        event(
            CrumbtrailEventKind.NATIVE_CRASH,
            JsonValue.of(
                "msg" to JsonValue.Str("Fatal error: index out of range"),
                "stk" to JsonValue.Str("CrumbtrailDemo.CartView.item(at:)"),
                "signal" to JsonValue.Str("SIGABRT"),
                "source" to JsonValue.Str("previous-launch"),
            ),
        ),
        "native-crash",
    )

    @Test
    fun `native hang event`() = assertMatchesFixture(
        event(
            CrumbtrailEventKind.NATIVE_HANG,
            JsonValue.of(
                "source" to JsonValue.Str("main-thread"),
                "thresholdMs" to JsonValue.Num(5000),
                "observedDurationMs" to JsonValue.Num(7420),
                "recovered" to JsonValue.Bool(false),
                "previousLaunch" to JsonValue.Bool(true),
                "stk" to JsonValue.Str(
                    "CrumbtrailDemo.CheckoutViewController.submit()\n" +
                        "CrumbtrailDemo.CheckoutViewController.tap()"
                ),
            ),
        ),
        "native-hang",
    )

    @Test
    fun `view snapshot event`() = assertMatchesFixture(
        event(
            CrumbtrailEventKind.VIEW_SNAPSHOT,
            JsonValue.of(
                "w" to JsonValue.Num(393),
                "h" to JsonValue.Num(852),
                "nodes" to JsonValue.Arr(
                    listOf(
                        JsonValue.of(
                            "role" to JsonValue.Str("screen"),
                            "componentName" to JsonValue.Str("CheckoutViewController"),
                            "bounds" to JsonValue.of(
                                "x" to JsonValue.Num(0),
                                "y" to JsonValue.Num(0),
                                "width" to JsonValue.Num(393),
                                "height" to JsonValue.Num(852),
                            ),
                        ),
                        JsonValue.of(
                            "role" to JsonValue.Str("button"),
                            "label" to JsonValue.Str("Pay now"),
                            "testID" to JsonValue.Str("checkout-pay"),
                            "bounds" to JsonValue.of(
                                "x" to JsonValue.Num(16),
                                "y" to JsonValue.Num(720),
                                "width" to JsonValue.Num(361),
                                "height" to JsonValue.Num(48),
                            ),
                        ),
                    )
                ),
            ),
        ),
        "view-snapshot",
    )

    @Test
    fun `target descriptor`() = assertMatchesFixture(
        event(
            CrumbtrailEventKind.ERROR,
            JsonValue.of(
                "msg" to JsonValue.Str("tap handler threw"),
                "fatal" to JsonValue.Bool(false),
                "source" to JsonValue.Str("caught"),
            ),
            target = CrumbtrailTarget(
                role = "button",
                label = "Pay now",
                testID = "checkout-pay",
                componentName = "CheckoutButton",
                routePath = "/checkout",
                bounds = CrumbtrailBounds(16.0, 720.0, 361.0, 48.0),
            ),
        ),
        "target",
    )

    // MARK: envelope invariants

    @Test
    fun `schema version and platform are always sent`() {
        val json = event(CrumbtrailEventKind.ERROR, JsonValue.of()).toJson().toJson()
        assertTrue(json.contains("\"schemaVersion\":1"))
        assertTrue(json.contains("\"platform\":\"ios\""))
    }

    @Test
    fun `empty capabilities are omitted not sent empty`() {
        val bare = CrumbtrailEvent(
            timestamp = fixtureTimestamp,
            kind = CrumbtrailEventKind.ERROR,
            data = JsonValue.of(),
            sdk = fixtureSdk,
        )
        // An absent field and an empty array are different claims on the ingest
        // side, and only one of them is what we mean.
        assertFalse(bare.toJson().toJson().contains("capabilities"))
    }

    @Test
    fun `target that identifies nothing is dropped`() {
        val event = CrumbtrailEvent(
            timestamp = fixtureTimestamp,
            kind = CrumbtrailEventKind.ERROR,
            data = JsonValue.of(),
            sdk = fixtureSdk,
            // Bounds only: names no element, costs bytes on every event.
            target = CrumbtrailTarget(bounds = CrumbtrailBounds(0.0, 0.0, 1.0, 1.0)),
        )
        assertFalse(event.toJson().toJson().contains("target"))
    }

    @Test
    fun `whole doubles serialise without a trailing decimal`() {
        // 402.0 and 402 are different JSON tokens, and a fixture written by
        // another language would fail on the difference alone.
        assertEquals("402", JsonValue.Num(402.0).toJson())
        assertEquals("0.42", JsonValue.Num(0.42).toJson())
    }

    @Test
    fun `control characters are escaped so the batch stays valid JSON`() {
        val json = JsonValue.Str("line\u0001break\n").toJson()
        assertTrue(json.contains("\\u0001"))
        assertTrue(json.contains("\\n"))
    }

    @Test
    fun `object keys serialise in sorted order`() {
        val json = JsonValue.of(
            "zebra" to JsonValue.Num(1),
            "alpha" to JsonValue.Num(2),
        ).toJson()
        assertEquals("{\"alpha\":2,\"zebra\":1}", json)
    }

    /**
     * Re-serialise a fixture file through this SDK's writer so the comparison
     * ignores formatting. Uses a tiny recursive-descent parser rather than
     * org.json, which is an Android class and absent from a plain JVM test run.
     */
    private fun canonicalise(text: String): String = MiniJson(text).parseValue().toJson()
}
