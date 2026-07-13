# sample-dotnet-mref

Pre-generated `docfx metadata` output (ManagedReference YAML) for
[`fixtures/sample-dotnet`](../sample-dotnet), so the csharp adapter's mapping
tests run without a .NET toolchain. `source.path` entries are rewritten to be
relative to a pretend docfx dir at `fixtures/sample-dotnet/.docfx`, and git
`remote:` blocks are stripped.

Regenerate (requires dotnet + docfx) by running `docfx metadata` with
`src: ../sample-dotnet`, then re-applying the path rewrite.
