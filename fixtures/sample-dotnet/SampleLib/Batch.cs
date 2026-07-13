namespace SampleLib;

/// <summary>Batch helpers over <see cref="Greeter"/>.</summary>
public static class Batch
{
    /// <summary>Greet several targets at once.</summary>
    /// <param name="targets">The names to greet.</param>
    /// <param name="tone">Tone applied to every greeting.</param>
    /// <returns>One greeting line per target.</returns>
    /// <example>
    /// <code>
    /// var lines = Batch.GreetMany(new[] { "ada", "linus" });
    /// </code>
    /// </example>
    public static IReadOnlyList<string> GreetMany(IEnumerable<string> targets, Tone tone = Tone.Calm)
    {
        var greeter = new Greeter("greeter", tone);
        return targets.Select(greeter.Greet).ToList();
    }
}
