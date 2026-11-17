// A JSON reply as words a person reads: its strings in order, each under the field it came from, list items marked as
// such. It reads a cut-off excerpt too (a tile shows only the first few hundred characters), so it walks the text instead
// of parsing it: whatever is complete, and the last string up to where the text stops.

export type JsonLine = { field: string; text: string; item: boolean };

/** Fields that name the piece, shown first and on their own. */
const TITLE_FIELDS = /^(headline|title|name|subject|heading)$/i;

/** The strings of a JSON object or list, in order, or null when the text isn't JSON. */
export function readJson(src: string | null | undefined): JsonLine[] | null {
  const text = (src ?? "").trimStart();
  if (!text.startsWith("{") && !text.startsWith("[")) return null;
  const lines: JsonLine[] = [];
  const stack: ("object" | "list")[] = [];
  const fields: string[] = [];
  let wantKey = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let value = "";
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === "\\" && j + 1 < text.length) {
          const next = text[++j];
          value += next === "n" ? "\n" : next === "t" ? " " : next === "u" ? String.fromCharCode(parseInt(text.slice(j + 1, j + 5), 16) || 32) : next;
          if (next === "u") j += 4;
        } else value += text[j];
      }
      i = j;
      const top = stack[stack.length - 1];
      if (top === "object" && wantKey) fields[stack.length - 1] = value;
      else if (value.trim()) lines.push({ field: nearestField(fields, stack), text: value.trim(), item: top === "list" || stack.includes("list") });
    } else if (ch === "{") { stack.push("object"); wantKey = true; }
    else if (ch === "[") { stack.push("list"); wantKey = false; }
    else if (ch === "}" || ch === "]") { stack.pop(); fields.length = stack.length; wantKey = false; }
    else if (ch === ":") wantKey = false;
    else if (ch === ",") wantKey = stack[stack.length - 1] === "object";
  }
  return lines;
}

/** The innermost field name a value sits under. */
function nearestField(fields: string[], stack: ("object" | "list")[]) {
  for (let d = stack.length - 1; d >= 0; d--) if (fields[d]) return fields[d];
  return "";
}

/** "voiceover_script" → "Voiceover script". */
export const fieldLabel = (field: string) => {
  const words = field.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  if (/^(seo|url|cta|faq)$/.test(words)) return words.toUpperCase();
  return words ? words[0].toUpperCase() + words.slice(1) : "";
};

/** The line that names the piece (a headline or title), and the rest. */
export function splitTitle(lines: JsonLine[]): { title: string; rest: JsonLine[] } {
  const at = lines.findIndex((l) => !l.item && TITLE_FIELDS.test(l.field));
  if (at < 0) return { title: "", rest: lines };
  return { title: lines[at].text, rest: lines.filter((_, i) => i !== at) };
}

/** Consecutive lines under the same field, for a record that shows each field once. */
export function groupByField(lines: JsonLine[]): { field: string; lines: JsonLine[] }[] {
  const groups: { field: string; lines: JsonLine[] }[] = [];
  for (const line of lines) {
    const last = groups[groups.length - 1];
    if (last && last.field === line.field) last.lines.push(line);
    else groups.push({ field: line.field, lines: [line] });
  }
  return groups;
}
