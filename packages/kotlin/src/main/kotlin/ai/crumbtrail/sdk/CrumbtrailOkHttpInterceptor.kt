package ai.crumbtrail.sdk

import okhttp3.Interceptor
import okhttp3.Response
import java.io.IOException

/** Register once with OkHttpClient.Builder.addInterceptor. Bodies remain untouched. */
class CrumbtrailOkHttpInterceptor(private val crumbtrail: Crumbtrail) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        if (!crumbtrail.config.collectors.network) return chain.proceed(request)
        val started = System.nanoTime()
        fun record(status: Int?, error: String? = null) {
            try {
                crumbtrail.recordRequest(
                    url = request.url.toString(), method = request.method, status = status,
                    durationMs = (System.nanoTime() - started) / 1_000_000,
                    source = "okhttp", error = error,
                )
            } catch (_: Exception) {
                // A failed session store must not replace the HTTP result.
            }
        }
        val response = try {
            chain.proceed(request)
        } catch (error: IOException) {
            record(null, error.javaClass.simpleName)
            throw error
        }
        record(response.code)
        return response
    }
}
