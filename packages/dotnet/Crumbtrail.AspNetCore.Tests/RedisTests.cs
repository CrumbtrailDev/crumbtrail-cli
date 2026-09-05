using System.Text.Json;
using StackExchange.Redis;
using Xunit;
namespace Crumbtrail.Tests;

public sealed class RedisFactAttribute : FactAttribute
{
    public RedisFactAttribute()
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("CRUMBTRAIL_DOTNET_REDIS")))
            Skip = "Set CRUMBTRAIL_DOTNET_REDIS to an isolated local Redis endpoint.";
    }
}
public sealed class RedisTests
{
    [RedisFact]
    public async Task Redis_commands_preserve_values_hits_misses_and_server_errors()
    {
        using var client = await ConnectionMultiplexer.ConnectAsync(Environment.GetEnvironmentVariable("CRUMBTRAIL_DOTNET_REDIS")!);
        var db = client.GetDatabase(); var key = "crumbtrail-proof-" + Guid.NewGuid();
        var capture = new CaptureContext(); capture.Start("ses_redis", "req_redis"); var cache = new CaptureCache(capture, "redis");
        try
        {
            var missing = await cache.Observe("get", key, () => db.StringGetAsync(key), value => value.HasValue);
            Assert.False(missing.HasValue);
            Assert.True(await cache.Observe("set", key, () => db.StringSetAsync(key, "private-value", TimeSpan.FromMinutes(1)), ttlMs: 60000));
            Assert.Equal("private-value", (string?)await cache.Observe("get", key, () => db.StringGetAsync(key), value => value.HasValue));
            await Assert.ThrowsAsync<RedisServerException>(() => cache.Observe("get", key, () => db.ListGetByIndexAsync(key, 0)));
            var events = capture.Events.Select(e => JsonSerializer.SerializeToElement(e.d)).ToArray();
            Assert.False(events[0].GetProperty("hit").GetBoolean()); Assert.True(events[2].GetProperty("hit").GetBoolean());
            Assert.Equal("failure", events[3].GetProperty("outcome").GetString());
            Assert.All(events, e => Assert.Equal("redis", e.GetProperty("driver").GetString()));
            var wire = JsonSerializer.Serialize(events); Assert.DoesNotContain(key, wire); Assert.DoesNotContain("private-value", wire); Assert.DoesNotContain("WRONGTYPE", wire);
        }
        finally { await db.KeyDeleteAsync(key); }
    }
}
