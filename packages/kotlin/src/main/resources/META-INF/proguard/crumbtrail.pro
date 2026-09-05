# Shipped inside the JAR. R8 and ProGuard read META-INF/proguard/* from every
# dependency, so a consuming Android app picks these up with no configuration.
#
# CrumbtrailOkHttpInterceptor compiles against OkHttp with `compileOnly`, which
# leaves okhttp3 references in a shipped class while packaging none of OkHttp.
# An app that does not use OkHttp therefore builds fine and shrinks with a wall
# of "can't find referenced class okhttp3.*" warnings, which is noise on a real
# build and an error under -Werror style configurations.
-dontwarn okhttp3.**

# The interceptor is instantiated by the host application by name in most
# integrations, and its only entry point is called through the OkHttp interface.
-keep class ai.crumbtrail.sdk.CrumbtrailOkHttpInterceptor { *; }
