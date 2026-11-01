import { fromMarkdown } from "mdast-util-from-markdown";
/** Source offsets refer to the original string; the original Markdown is never serialized. */
export function subjectNoteIndex(text: string) {
  const masked = text.replace(
    /^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,
    (s) => s.replace(/[^\r\n]/g, " "),
  );
  const tree = fromMarkdown(masked),
    headings: Array<{ title: string; offset: number }> = [],
    anchors: string[] = [];
  const inline = (node: any): string =>
    typeof node.value === "string"
      ? node.value
      : (node.children || []).map(inline).join("");
  const visit = (node: any) => {
    if (node.type === "code" || node.type === "html") return;
    if (node.type === "heading") {
      const title = inline(node);
      headings.push({ title, offset: node.position?.start?.offset || 0 });
      anchors.push(
        title.toLowerCase(),
        title.toLowerCase().replace(/\s+/g, "-"),
      );
    }
    if (node.type === "paragraph")
      for (const match of inline(node).matchAll(/(?:^|\s)\^([\w-]+)(?:\s|$)/g))
        anchors.push("^" + match[1]);
    for (const child of node.children || []) visit(child);
  };
  visit(tree);
  const frontmatter =
    text
      .replace(/^\uFEFF/, "")
      .match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || "";
  const aliases: string[] = [];
  const alias = frontmatter.match(/^aliases:\s*(.*)$/m);
  if (alias) {
    const value = alias[1]!.trim();
    if (value)
      aliases.push(
        ...value
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map((s) => s.trim().replace(/^['"]|['"]$/g, "")),
      );
    else {
      const rest = frontmatter.slice(alias.index! + alias[0].length);
      for (const line of rest.split(/\r?\n/).slice(1)) {
        const item = line.match(/^\s+-\s+(.+)$/);
        if (!item) break;
        aliases.push(item[1]!.trim().replace(/^['"]|['"]$/g, ""));
      }
    }
  }
  return { headings, anchors, aliases: aliases.filter(Boolean) };
}
