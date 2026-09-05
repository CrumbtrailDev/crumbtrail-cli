// Kotlin/JVM, deliberately NOT the Android Gradle Plugin.
//
// This SDK is pure code: no resources, no manifest entries, nothing that needs
// an AAR. Building it as a plain JVM library and putting `android.jar` on the
// compile-only classpath buys two things AGP would cost us:
//
//   1. `./gradlew test` runs the whole suite on any JDK, with no Android SDK,
//      no emulator and no AGP/Gradle version dance. A test suite that only runs
//      in one specific Android toolchain is a test suite that stops running.
//   2. Consumers get a plain JAR, which an Android app depends on exactly like
//      an AAR for a code-only library.
//
// `compileOnly` is the important part: the Android classes are provided by the
// device at runtime, so they must not be packaged or they would collide.
plugins {
    kotlin("jvm") version "2.4.0"
    `java-library`
}

group = "ai.crumbtrail"
version = "0.1.0"

repositories { mavenCentral() }

/**
 * Locate `android.jar`. ANDROID_HOME wins; the Homebrew commandlinetools path
 * is the fallback so a checkout works without extra environment setup.
 */
val androidJar: File? = run {
    val roots = listOfNotNull(
        System.getenv("ANDROID_HOME"),
        System.getenv("ANDROID_SDK_ROOT"),
        "/opt/homebrew/share/android-commandlinetools",
        "${System.getProperty("user.home")}/Library/Android/sdk",
    ).map(::File).filter { it.isDirectory }

    roots.asSequence()
        .mapNotNull { root -> File(root, "platforms").listFiles()?.toList() }
        .flatten()
        .sortedByDescending { it.name }
        .map { File(it, "android.jar") }
        .firstOrNull { it.isFile }
}

dependencies {
    if (androidJar != null) {
        compileOnly(files(androidJar))
    } else {
        // Not fatal. The Android bindings simply do not compile, while the
        // contract, session, transport, queue and redaction layers still build
        // and test — which is most of the SDK and all of the shared behaviour.
        logger.warn("android.jar not found: Android bindings will be skipped")
    }
    // The host application supplies OkHttp. Packaging it would collide with
    // whatever version the app already pins, and pinning one here would force a
    // version on an app that never asked Crumbtrail for an HTTP client.
    compileOnly("com.squareup.okhttp3:okhttp:4.12.0")
    // Named explicitly rather than arriving transitively through mockwebserver:
    // a mockwebserver bump would otherwise silently move the version the
    // interceptor is compiled and tested against.
    testImplementation("com.squareup.okhttp3:okhttp:4.12.0")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation(kotlin("test"))
}

// The Android-specific source set is excluded when android.jar is absent, so a
// contributor without the Android SDK still gets a green build.
if (androidJar == null) {
    sourceSets["main"].kotlin.exclude("**/android/**")
}

kotlin { jvmToolchain(21) }

tasks.test { useJUnitPlatform() }
