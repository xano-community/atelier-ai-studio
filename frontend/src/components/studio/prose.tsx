// A model's words, set for reading: paragraphs with air between them, "- " lines as a list, "#" lines as small headings,
// "**bold**" as bold and a Markdown table as a table. Models write a little Markdown even when asked not to, and a
// passage quoted from a Markdown source is Markdown too; showing the marks raw ("## Sizing", "| S | 155 cm |") reads as
// broken. Anything else stays exactly as written.
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type Block =
  | { type: "p"; lines: string[] }
  | { type: "h"; text: string }
  | { type: "ul" | "ol"; items: string[] }
  | { type: "table"; head: string[]; rows: string[][] };

const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const isRule = (line: string) => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line.trim());

/** Split text into blocks. Pure, so a list, a heading or a table reads the same wherever it's shown. */
export function proseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (!t) { i++; continue; }
    if (/^#{1,6}\s+/.test(t)) { blocks.push({ type: "h", text: t.replace(/^#{1,6}\s+/, "") }); i++; continue; }
    if (t.startsWith("|") && i + 1 < lines.length && isRule(lines[i + 1])) {
      const head = cells(t);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) { rows.push(cells(lines[i])); i++; }
      blocks.push({ type: "table", head, rows });
      continue;
    }
    if (/^[-*•]\s+/.test(t)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*•]\s+/.test(lines[i].trim())) { items.push(lines[i].trim().replace(/^[-*•]\s+/, "")); i++; }
      blocks.push({ type: "ul", items });
      continue;
    }
    if (/^\d+[.)]\s+/.test(t)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) { items.push(lines[i].trim().replace(/^\d+[.)]\s+/, "")); i++; }
      blocks.push({ type: "ol", items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|[-*•]\s|\d+[.)]\s|\|)/.test(lines[i].trim())) { para.push(lines[i].trim()); i++; }
    if (!para.length) { para.push(t); i++; }
    blocks.push({ type: "p", lines: para });
  }
  return blocks;
}

/** "**bold**" as bold; everything else as written. `inline` can turn the rest into more (citation chips). */
function strong(text: string, inline: (s: string, key: string) => ReactNode, key: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    /^\*\*[^*]+\*\*$/.test(part) ? <strong key={`${key}-${i}`} className="font-semibold">{inline(part.slice(2, -2), `${key}-${i}`)}</strong> : <span key={`${key}-${i}`}>{inline(part, `${key}-${i}`)}</span>);
}

export function Prose({ text, className, inline = (s) => s, compact = false, testId }: {
  text: string; className?: string; testId?: string;
  /** Turn a run of plain text into nodes (citation chips). */ inline?: (text: string, key: string) => ReactNode;
  /** Smaller, quieter type: a quoted passage rather than an answer. */ compact?: boolean;
}) {
  const blocks = proseBlocks(text);
  const gap = compact ? "space-y-1.5" : "space-y-3";
  return (
    <div className={cn("min-w-0 wrap-anywhere text-pretty", gap, className)} data-testid={testId}>
      {blocks.map((b, i) => {
        const k = String(i);
        if (b.type === "h") return <p key={k} className={cn("font-semibold text-foreground", compact ? "text-caption" : "text-body")}>{strong(b.text, inline, k)}</p>;
        if (b.type === "p") return <p key={k}>{b.lines.flatMap((l, j) => (j ? [<br key={`${k}-br-${j}`} />, ...strong(l, inline, `${k}-${j}`)] : strong(l, inline, `${k}-${j}`)))}</p>;
        if (b.type !== "table") {
          const List = b.type;
          return (
            <List key={k} className={cn("space-y-1 pl-5 marker:text-muted-foreground", b.type === "ul" ? "list-disc" : "list-decimal")}>
              {b.items.map((it, j) => <li key={j} className="pl-1">{strong(it, inline, `${k}-${j}`)}</li>)}
            </List>
          );
        }
        return (
          <div key={k} className="max-w-full overflow-x-auto rounded-md border">
            <table className="w-full text-left text-caption tabular-nums">
              <thead className="bg-muted/50 text-muted-foreground"><tr>{b.head.map((h, j) => <th key={j} scope="col" className="px-2.5 py-1.5 font-medium whitespace-nowrap">{h}</th>)}</tr></thead>
              <tbody className="divide-y">{b.rows.map((r, j) => <tr key={j}>{r.map((c, m) => <td key={m} className="px-2.5 py-1.5 whitespace-nowrap">{c}</td>)}</tr>)}</tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
