package ai.crumbtrail.sdk

/** Source runtime an event came from. See the shared wire contract. */
enum class CrumbtrailPlatform(val wireValue: String) {
    WEB("web"),
    REACT_NATIVE("react-native"),
    IOS("ios"),
    ANDROID("android"),
    FLUTTER("flutter"),
    WEBVIEW("webview"),
    NODE("node"),
}

/** Identity of the SDK that produced an event. */
data class CrumbtrailSdkDescriptor(val name: String, val version: String) {
    fun toJson(): JsonValue = JsonValue.of("name" to JsonValue.Str(name), "version" to JsonValue.Str(version))
}

/** Bounding box of a UI element, in device-independent pixels. */
data class CrumbtrailBounds(
    val x: Double,
    val y: Double,
    val width: Double,
    val height: Double,
) {
    fun toJson(): JsonValue = JsonValue.of(
        "x" to JsonValue.Num(x),
        "y" to JsonValue.Num(y),
        "width" to JsonValue.Num(width),
        "height" to JsonValue.Num(height),
    )
}

/**
 * A normalised reference to a UI element.
 *
 * At least one identifying key must be present, or the descriptor is dropped —
 * a target made only of bounds names nothing and costs payload on every event.
 */
data class CrumbtrailTarget(
    val role: String? = null,
    val label: String? = null,
    val testID: String? = null,
    val accessibilityId: String? = null,
    val componentName: String? = null,
    val routePath: String? = null,
    val ancestryHash: String? = null,
    val bounds: CrumbtrailBounds? = null,
) {
    val identifiesSomething: Boolean
        get() = listOfNotNull(
            role, label, testID, accessibilityId, componentName, routePath, ancestryHash
        ).isNotEmpty()

    fun toJson(): JsonValue = JsonValue.of(
        "role" to JsonValue.str(role),
        "label" to JsonValue.str(label),
        "testID" to JsonValue.str(testID),
        "accessibilityId" to JsonValue.str(accessibilityId),
        "componentName" to JsonValue.str(componentName),
        "routePath" to JsonValue.str(routePath),
        "ancestryHash" to JsonValue.str(ancestryHash),
        "bounds" to bounds?.toJson(),
    )
}

/** The shared event kinds. */
enum class CrumbtrailEventKind(val wireValue: String) {
    ERROR("err"),
    REJECTION("rej"),
    CONSOLE("con"),
    NETWORK("net"),
    NETWORK_STATUS("net-status"),
    ENVIRONMENT("env"),
    NAVIGATION("navigation"),
    NAVIGATION_INTENT("nav-intent"),
    APP_LIFECYCLE("app-lifecycle"),
    NATIVE_CRASH("native-crash"),
    NATIVE_HANG("native-hang"),
    VIEW_SNAPSHOT("view-snapshot"),
}

const val CRUMBTRAIL_SCHEMA_VERSION = 1

/**
 * One captured event, in the shape ingest expects.
 *
 * `kindOverride` exists so a caller can emit a kind outside the enum without
 * losing type safety for the common ones.
 */
data class CrumbtrailEvent(
    /**
     * Unix timestamp in MILLISECONDS. Seconds here would place every event in
     * 1970 and break every correlation the product depends on.
     */
    val timestamp: Long,
    val kind: String,
    val data: JsonValue,
    val platform: CrumbtrailPlatform = CrumbtrailPlatform.ANDROID,
    val sdk: CrumbtrailSdkDescriptor,
    val capabilities: List<String> = emptyList(),
    val target: CrumbtrailTarget? = null,
) {
    constructor(
        timestamp: Long,
        kind: CrumbtrailEventKind,
        data: JsonValue,
        platform: CrumbtrailPlatform = CrumbtrailPlatform.ANDROID,
        sdk: CrumbtrailSdkDescriptor,
        capabilities: List<String> = emptyList(),
        target: CrumbtrailTarget? = null,
    ) : this(timestamp, kind.wireValue, data, platform, sdk, capabilities, target)

    fun toJson(): JsonValue = JsonValue.of(
        "t" to JsonValue.Num(timestamp),
        "k" to JsonValue.Str(kind),
        "d" to data,
        "schemaVersion" to JsonValue.Num(CRUMBTRAIL_SCHEMA_VERSION),
        "platform" to JsonValue.Str(platform.wireValue),
        "sdk" to sdk.toJson(),
        // Omitted rather than sent empty: an absent field and an empty array are
        // different claims on the ingest side.
        "capabilities" to if (capabilities.isEmpty()) null
            else JsonValue.Arr(capabilities.map(JsonValue::Str)),
        // A target that identifies nothing adds bytes and names no element.
        "target" to target?.takeIf { it.identifiesSomething }?.toJson(),
    )
}
