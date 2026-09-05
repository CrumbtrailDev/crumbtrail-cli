using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Crumbtrail;
using Xunit;

namespace Crumbtrail.AspNetCore.Tests;

/// <summary>
/// Conformance against test-fixtures/backend-body/cases.json.
///
/// The Ruby and Go packages run the same file. Reading it from the repository root rather than
/// copying it in is the whole point: three hand written copies of this policy is how Ruby, Go
/// and .NET ended up redacting the same body three different ways.
/// </summary>
public class StructuredBodyContractTests
{
    private sealed record BodyCase(string name, string why, string input, string state, JsonElement body);
    private sealed record Limits(int bytes, int nesting, int keys, int items, int integerDigits, long safeInteger);
    private sealed record Corpus(string policy, Limits limits, BodyCase[] cases);

    private static readonly JsonSerializerOptions Options = new() { PropertyNameCaseInsensitive = true };

    private static string RepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !Directory.Exists(Path.Combine(directory.FullName, "test-fixtures")))
            directory = directory.Parent;
        Assert.NotNull(directory);
        return directory!.FullName;
    }

    private static Corpus Load()
    {
        var path = Path.Combine(RepositoryRoot(), "test-fixtures", "backend-body", "cases.json");
        var corpus = JsonSerializer.Deserialize<Corpus>(File.ReadAllText(path), Options);
        Assert.NotNull(corpus);
        // Without this every assertion below would pass vacuously.
        Assert.NotEmpty(corpus!.cases);
        return corpus;
    }

    public static TheoryData<string> CaseNames()
    {
        var data = new TheoryData<string>();
        foreach (var example in Load().cases) data.Add(example.name);
        return data;
    }

    [Fact]
    public void Limits_match_the_corpus()
    {
        var corpus = Load();
        Assert.Equal(StructuredBody.Policy, corpus.policy);
        Assert.Equal(StructuredBody.MaxBytes, corpus.limits.bytes);
        Assert.Equal(StructuredBody.MaxNesting, corpus.limits.nesting);
        Assert.Equal(StructuredBody.MaxKeys, corpus.limits.keys);
        Assert.Equal(StructuredBody.MaxItems, corpus.limits.items);
        Assert.Equal(StructuredBody.MaxIntegerDigits, corpus.limits.integerDigits);
        Assert.Equal(StructuredBody.SafeInteger, corpus.limits.safeInteger);
    }

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void Body_matches_the_corpus(string name)
    {
        var example = Load().cases.Single(entry => entry.name == name);
        var captured = StructuredBody.Capture(Encoding.UTF8.GetBytes(example.input));
        Assert.Equal(example.state, captured.State);
        if (example.body.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
        {
            Assert.Null(captured.Body);
            return;
        }
        Assert.NotNull(captured.Body);
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(captured.Body!), JsonNode.Parse(example.body.GetRawText())),
            $"{example.name}: {example.why}\nactual   {captured.Body}\nexpected {example.body.GetRawText()}");
    }
}
