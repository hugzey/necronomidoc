import { zodToJsonSchema } from "zod-to-json-schema";
import { DocModel, EnrichmentOverlay, Registry, SubsystemsManifest } from "./schema.js";

/**
 * Export the public schemas as JSON Schema so non-TS adapter authors (Python,
 * C#, …) have a language-neutral contract to emit against — decision 0006.
 */
export function exportJsonSchemas(): Record<string, unknown> {
  return {
    DocModel: zodToJsonSchema(DocModel, "DocModel"),
    EnrichmentOverlay: zodToJsonSchema(EnrichmentOverlay, "EnrichmentOverlay"),
    Registry: zodToJsonSchema(Registry, "Registry"),
    SubsystemsManifest: zodToJsonSchema(SubsystemsManifest, "SubsystemsManifest"),
  };
}
