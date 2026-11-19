import { zodToJsonSchema } from "zod-to-json-schema";
import {
  DocModel,
  EnrichmentOverlay,
  Registry,
  SourcesManifest,
  SubsystemsManifest,
  VersionsManifest,
} from "./schema.js";
import { PRODUCT_FRONTMATTER_SCHEMAS, ProductManifest } from "./product.js";

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
    SourcesManifest: zodToJsonSchema(SourcesManifest, "SourcesManifest"),
    VersionsManifest: zodToJsonSchema(VersionsManifest, "VersionsManifest"),
    ProductManifest: zodToJsonSchema(ProductManifest, "ProductManifest"),
    ProductFrontmatter: productFrontmatterJsonSchema(),
  };
}

/**
 * One JSON Schema for every product-doc frontmatter type (decision 0023):
 * `oneOf` the six document schemas, each pinned by its id prefix. Shipped into
 * repos by `necronomidoc product init` (`docs/product/schema.json`) so coding
 * agents can validate the frontmatter they write without the server.
 */
export function productFrontmatterJsonSchema(): Record<string, unknown> {
  const prefixes: Record<string, string> = {
    persona: "PER",
    job: "JOB",
    epic: "EPIC",
    story: "STORY",
    journey: "JRN",
    session: "SES",
  };
  const variants = Object.entries(PRODUCT_FRONTMATTER_SCHEMAS).map(([type, schema]) => {
    const json = zodToJsonSchema(schema, { $refStrategy: "none" }) as Record<string, unknown>;
    delete json.$schema;
    const props = (json.properties ?? {}) as Record<string, Record<string, unknown>>;
    props.id = { type: "string", pattern: `^${prefixes[type]}-\\d+$` };
    return { title: type, ...json };
  });
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://github.com/hugzey/necronomidoc/product-frontmatter.schema.json",
    title: "necronomidoc product document frontmatter",
    description:
      "YAML frontmatter of a docs/product/ document. The id prefix selects the type: PER persona, JOB job (intent), EPIC epic, STORY user story, JRN journey map, SES intent interaction session.",
    oneOf: variants,
  };
}
