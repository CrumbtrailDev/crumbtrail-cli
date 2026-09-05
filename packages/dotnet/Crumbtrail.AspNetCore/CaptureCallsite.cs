using System.Diagnostics;
namespace Crumbtrail;

public static class CaptureCallsite
{
    public static Func<object?> Create(string sourceMarker, string repositoryPrefix)
    {
        if (string.IsNullOrWhiteSpace(sourceMarker) || string.IsNullOrWhiteSpace(repositoryPrefix))
            throw new ArgumentException("Source marker and repository prefix are required.");
        var marker = sourceMarker.Replace('\\', '/');
        var prefix = repositoryPrefix.Replace('\\', '/').TrimEnd('/') + "/";
        return () =>
        {
            foreach (var frame in new StackTrace(true).GetFrames())
            {
                var file = frame.GetFileName()?.Replace('\\', '/');
                if (file is null || frame.GetMethod()?.DeclaringType?.Assembly == typeof(CaptureCallsite).Assembly) continue;
                var index = file.IndexOf(marker, StringComparison.Ordinal);
                if (index < 0 || frame.GetFileLineNumber() <= 0) continue;
                return new { file = prefix + file[(index + marker.Length)..].TrimStart('/'), line = frame.GetFileLineNumber(), fn = frame.GetMethod()?.Name };
            }
            return null;
        };
    }
}
