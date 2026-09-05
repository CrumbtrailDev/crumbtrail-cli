using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;

namespace Crumbtrail;

public static class CaptureExtensions
{
    public static IServiceCollection AddCrumbtrail(this IServiceCollection services, CaptureOptions options)
    {
        services.AddSingleton(options);
        services.TryAddScoped<CaptureContext>();
        services.TryAddScoped<CaptureCache>();
        services.AddSingleton(sp => new CaptureSender(options,
            new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(5) },
            sp.GetRequiredService<ILogger<CaptureSender>>()));
        services.AddSingleton<ICaptureSink>(sp => sp.GetRequiredService<CaptureSender>());
        services.AddHostedService(sp => sp.GetRequiredService<CaptureSender>());
        return services;
    }

    public static IApplicationBuilder UseCrumbtrail(this IApplicationBuilder app)
        => app.UseMiddleware<CaptureMiddleware>();
}
