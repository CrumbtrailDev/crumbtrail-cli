using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
namespace Crumbtrail;

public static class EntityFrameworkCaptureExtensions
{
    public static IServiceCollection AddCrumbtrailEntityFramework(this IServiceCollection services)
    {
        // CapturedChanges takes a logger and every interceptor takes the scoped
        // capture context, so an application that registers only EF capture must
        // still get a working DbContext.
        services.AddLogging();
        services.TryAddScoped<CaptureContext>();
        services.TryAddScoped<CapturedChanges>();
        services.TryAddScoped<CaptureSaveChanges>();
        services.TryAddScoped<CaptureTransactions>();
        services.TryAddScoped<CaptureCommands>();
        return services;
    }

    public static DbContextOptionsBuilder AddCrumbtrail(this DbContextOptionsBuilder builder, IServiceProvider services)
        => builder.AddInterceptors(services.GetRequiredService<CaptureSaveChanges>(),
            services.GetRequiredService<CaptureTransactions>(), services.GetRequiredService<CaptureCommands>());
}
