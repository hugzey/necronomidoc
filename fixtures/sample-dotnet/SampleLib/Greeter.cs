namespace SampleLib;

/// <summary>How enthusiastic a greeting should sound.</summary>
public enum Tone
{
    /// <summary>A measured greeting.</summary>
    Calm,

    /// <summary>An emphatic greeting.</summary>
    Excited,
}

/// <summary>Produces greetings with a configurable tone.</summary>
/// <remarks>The C# twin of the Python fixture's <c>Greeter</c>.</remarks>
public class Greeter
{
    /// <summary>Fallback greeting target when none is given.</summary>
    public const string DefaultTarget = "world";

    /// <summary>Name the greeter signs greetings with.</summary>
    public string Name { get; }

    /// <summary>Create a greeter.</summary>
    /// <param name="name">Name to sign greetings with.</param>
    /// <param name="tone">Default tone for greetings.</param>
    public Greeter(string name, Tone tone = Tone.Calm)
    {
        Name = name;
        _tone = tone;
    }

    /// <summary>Greet a single target.</summary>
    /// <param name="target">Who to greet.</param>
    /// <returns>The rendered greeting line.</returns>
    /// <exception cref="ArgumentException">If <paramref name="target"/> is empty.</exception>
    public string Greet(string target = DefaultTarget)
    {
        if (string.IsNullOrEmpty(target))
        {
            throw new ArgumentException("target must not be empty", nameof(target));
        }

        var suffix = _tone == Tone.Excited ? "!" : ".";
        return $"Hello {target}{suffix} — {Name}";
    }

    private readonly Tone _tone;

    private string RenderSignature() => $"— {Name}";
}
