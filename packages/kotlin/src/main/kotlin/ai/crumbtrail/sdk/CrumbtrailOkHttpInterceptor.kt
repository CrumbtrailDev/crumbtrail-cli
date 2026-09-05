package ai.crumbtrail.sdk

import okhttp3.Interceptor
import okhttp3.Response

/**
 * Register once with `OkHttpClient.Builder.addInterceptor`. Bodies remain
 * untouched, and `dur` is time to response headers.
 */
class CrumbtrailOkHttpInterceptor(private val crumbtrail: Crumbtrail) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        if (!crumbtrail.capturesRequestTo(request.url.toString())) return chain.proceed(request)
        val started = System.nanoTime()
        fun record(status: Int?, error: String? = null) {
            try {
                crumbtrail.recordRequest(
                    url = request.url.toString(), method = request.method, status = status,
                    durationMs = (System.nanoTime() - started) / 1_000_000,
                    source = "okhttp", error = error, durTo = "headers",
                )
            } catch (_: Exception) {
                // A failed session store must not replace the HTTP result.
            }
        }
        val response = try {
            chain.proceed(request)
        } catch (error: Throwable) {
            // Not just IOException. A downstream interceptor that throws
            // IllegalStateException, or any other RuntimeException, ends the
            // call exactly as visibly to the user and used to record nothing at
            // all, leaving a session showing a request that started and never
            // finished. Recorded, then rethrown untouched.
            record(null, error.javaClass.simpleName)
            throw error
        }
        record(response.code)
        return response
    }
}
