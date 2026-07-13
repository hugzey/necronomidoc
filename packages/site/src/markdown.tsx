import { isValidElement, useEffect, useId, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { Link } from "react-router-dom";
import type { DocFile } from "./api.js";
import { resolveDocLink, slugifyAnchor } from "./resolve.js";

/** Plain text of a rendered heading's children (for anchor slugs). */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

/**
 * Render a ```mermaid code block as an inline SVG diagram (core docs carry
 * architecture diagrams — slice 7). The mermaid library is loaded lazily so
 * pages without diagrams never pay for it; on a render error the raw source
 * is shown instead so a bad diagram never blanks the page.
 */
function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string>();
  const [error, setError] = useState<string>();
  const reactId = useId();
  useEffect(() => {
    let live = true;
    import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
        // mermaid.render needs a DOM-safe unique element id.
        const id = `mermaid-${reactId.replace(/[^a-zA-Z0-9]/g, "")}`;
        const rendered = await mermaid.render(id, code);
        if (live) setSvg(rendered.svg);
      })
      .catch((err: unknown) => {
        if (live) setError(String(err));
      });
    return () => {
      live = false;
    };
  }, [code, reactId]);

  if (error) {
    return (
      <pre title={error}>
        <code>{code}</code>
      </pre>
    );
  }
  if (!svg) {
    return (
      <div className="flex justify-center p-4">
        <span className="loading loading-dots loading-sm" aria-label="Rendering diagram" />
      </div>
    );
  }
  // Mermaid output is library-generated SVG (securityLevel: strict), not
  // arbitrary document HTML.
  return <div className="not-prose overflow-x-auto" dangerouslySetInnerHTML={{ __html: svg }} />;
}

/**
 * Render a markdown document from the doc model. Headings get the same anchor
 * ids the adapter gave their section symbols (so tree/search/MCP links land),
 * and relative links to other documented files become router links.
 */
export function MarkdownDoc({
  content,
  slug,
  path,
  files,
}: {
  content: string;
  slug: string;
  path: string;
  files: Pick<DocFile, "path">[];
}) {
  const heading =
    (Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") =>
    ({ children }: { children?: ReactNode }) => {
      const id = slugifyAnchor(textOf(children));
      return (
        <Tag id={id || undefined} className="scroll-mt-4">
          {children}
        </Tag>
      );
    };

  const components: Components = {
    h1: heading("h1"),
    h2: heading("h2"),
    h3: heading("h3"),
    h4: heading("h4"),
    h5: heading("h5"),
    h6: heading("h6"),
    a: ({ href, children }) => {
      const internal = href ? resolveDocLink(slug, path, href, files) : undefined;
      if (internal) return <Link to={internal}>{children}</Link>;
      if (href?.startsWith("#")) return <a href={href}>{children}</a>;
      return (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    },
    pre: ({ children }) => {
      const child = Array.isArray(children) ? children[0] : children;
      if (
        isValidElement<{ className?: string; children?: ReactNode }>(child) &&
        /language-mermaid/.test(child.props.className ?? "")
      ) {
        return <MermaidBlock code={textOf(child.props.children).trim()} />;
      }
      return <pre>{children}</pre>;
    },
    img: ({ src, alt }) => {
      // Repo-relative images aren't served by the doc site; show a placeholder.
      if (typeof src === "string" && /^[a-z][a-z0-9+.-]*:/i.test(src)) {
        return <img src={src} alt={alt ?? ""} className="max-w-full" />;
      }
      return <span className="badge badge-ghost badge-sm">image: {alt || src || "?"}</span>;
    },
  };

  return (
    <article className="prose prose-sm max-w-none sm:prose-base">
      <ReactMarkdown components={components}>{content}</ReactMarkdown>
    </article>
  );
}
