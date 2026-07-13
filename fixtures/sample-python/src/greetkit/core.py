"""Core greeting machinery.

Builds greetings for one or many targets, with pluggable tone.
"""

from enum import Enum

DEFAULT_TARGET: str = "world"
"""Fallback greeting target when none is given."""


class Tone(Enum):
    """How enthusiastic a greeting should sound."""

    CALM = 1
    EXCITED = 2


class Greeter:
    """Produces greetings with a configurable tone.

    Attributes:
        name: Name the greeter signs greetings with.
    """

    def __init__(self, name: str, tone: Tone = Tone.CALM) -> None:
        """Create a greeter.

        Args:
            name: Name to sign greetings with.
            tone: Default tone for greetings.
        """
        self.name = name
        self.tone = tone

    def greet(self, target: str = DEFAULT_TARGET) -> str:
        """Greet a single target.

        Args:
            target: Who to greet.

        Returns:
            The rendered greeting line.

        Raises:
            ValueError: If target is empty.
        """
        if not target:
            raise ValueError("target must not be empty")
        suffix = "!" if self.tone is Tone.EXCITED else "."
        return f"Hello {target}{suffix} — {self.name}"

    def _render_signature(self) -> str:
        """Internal signature formatting helper."""
        return f"— {self.name}"


def greet_many(targets: list[str], *, tone: Tone = Tone.CALM) -> list[str]:
    """Greet several targets at once.

    Args:
        targets: The names to greet.
        tone: Tone applied to every greeting.

    Returns:
        One greeting line per target.

    Examples:
        >>> greet_many(["ada", "linus"])
        ['Hello ada. — greeter', 'Hello linus. — greeter']
    """
    greeter = Greeter("greeter", tone)
    return [greeter.greet(target) for target in targets]


def _slugify(value: str) -> str:
    """Private helper the docs should still cover (non-exported)."""
    return value.strip().lower().replace(" ", "-")
