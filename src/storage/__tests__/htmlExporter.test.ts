import { describe, expect, it } from "vitest";
import type { HexStack } from "../../core/schema.ts";
import { parseEmbeddedStack } from "../../player/embedded.ts";
import { HTML_MIME_TYPE, escapeHtml, escapeScriptText, htmlFileName, renderStandaloneHtml } from "../htmlExporter.ts";
import { checkStack } from "../stackLoader.ts";
import { makeStack } from "./fixtures.ts";

/** A fake player bundle: the exporter treats it as opaque text. */
const FAKE_PLAYER = `/*FAKE_PLAYER*/var s="</script><!-- x";var t="</SCRIPT >";`;

/** A stack whose text contains everything that could close or confuse a script element. */
function hostileStack(): HexStack {
  const stack = makeStack({ name: `<b>Tom & "Jerry's"</b>`, scriptSource: `on openStack\n  put "</script><!--<script>" into x\nend openStack` });
  const field = stack.cards[0].parts.find((part) => part.type === "field");
  if (field?.type === "field") field.content = "a < b </script> <!-- c --> <SCRIPT>";
  return stack;
}

/** The text of the embedded stack element: from its opening tag to the first `</script`. */
function embeddedJson(html: string): string {
  const open = `<script type="application/json" id="hexstack">`;
  const start = html.indexOf(open);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = html.indexOf("</script", start + open.length);
  return html.slice(start + open.length, end);
}

describe("standalone HTML export", () => {
  it("escapes every < of the stack JSON (Requirement 6.2)", () => {
    const html = renderStandaloneHtml(hostileStack(), FAKE_PLAYER);
    const json = embeddedJson(html);
    expect(json).not.toContain("<");
    expect(json).toContain("\\u003c/script>");
    expect(JSON.parse(json)).toEqual(hostileStack());
  });

  it("round-trips the embedded JSON through parseEmbeddedStack to an equal, valid stack (Requirement 6.3)", () => {
    const stack = hostileStack();
    const parsed = parseEmbeddedStack(embeddedJson(renderStandaloneHtml(stack, FAKE_PLAYER)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.stack).toEqual(stack);
    expect(checkStack(parsed.stack).ok).toBe(true);
  });

  it("HTML-escapes the stack name in the title", () => {
    const html = renderStandaloneHtml(hostileStack(), FAKE_PLAYER);
    expect(html).toContain("<title>&lt;b&gt;Tom &amp; &quot;Jerry&#39;s&quot;&lt;/b&gt;</title>");
    expect(escapeHtml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&#39;");
  });

  it("neutralises </script and <!-- inside the player source", () => {
    const html = renderStandaloneHtml(makeStack(), FAKE_PLAYER);
    // Only the two real closing tags remain, and no comment opener at all.
    expect(html.match(/<\/script/gi)).toHaveLength(2);
    expect(html).not.toContain("<!--");
    expect(html).toContain(`<script>${escapeScriptText(FAKE_PLAYER)}</script></body></html>`);
    expect(escapeScriptText(FAKE_PLAYER)).toBe(`/*FAKE_PLAYER*/var s="<\\/script><\\!-- x";var t="<\\/SCRIPT >";`);
  });

  it("writes one document: doctype, charset, the stack element, then the player", () => {
    const html = renderStandaloneHtml(makeStack({ name: "Demo" }), FAKE_PLAYER);
    expect(html.startsWith(`<!doctype html><html><head><meta charset="utf-8">`)).toBe(true);
    expect(html.indexOf(`id="hexstack"`)).toBeLessThan(html.indexOf("/*FAKE_PLAYER*/"));
    expect(html.trimEnd().endsWith("</body></html>")).toBe(true);
  });

  it("names the file <stack name>.html", () => {
    expect(htmlFileName({ name: "Demo" })).toBe("Demo.html");
    expect(HTML_MIME_TYPE).toBe("text/html");
  });

  it("a page without a valid embedded stack is rejected", () => {
    expect(parseEmbeddedStack(null).ok).toBe(false);
    expect(parseEmbeddedStack("{").ok).toBe(false);
    expect(parseEmbeddedStack(JSON.stringify({ ...makeStack(), schemaVersion: "1.0.0" })).ok).toBe(false);
  });
});
