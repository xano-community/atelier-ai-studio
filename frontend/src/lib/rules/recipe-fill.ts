// A recipe step's words, finished just before it runs: each `{{step.N}}` becomes what that earlier step said (or one
// field of its JSON reply), and each pick from Knowledge becomes the passages found for it. Every inserted value is cut
// to its cap, the length the estimate priced, so a step can't cost more than was held.
//
//   $var.fill_in = { fill: { templates, seq_of, caps, speech }, outputs: { "<seq>": { text, json } }, knowledge: { "<input>": "passages" } }
//   → { fields: { prompt?, system?, instructions?, negative_prompt? }, missing: ["step 2", …] }
export default function ({ $var }: { $var: Record<string, any> }) {
  const src = ($var.fill_in ?? {}) as Record<string, any>;
  const fill = (src.fill ?? {}) as Record<string, any>;
  const templates = (fill.templates ?? {}) as Record<string, string>;
  const seqOf = (fill.seq_of ?? {}) as Record<string, number>;
  const caps = (fill.caps ?? {}) as Record<string, number>;
  const outputs = (src.outputs ?? {}) as Record<string, { text?: unknown; json?: unknown }>;
  const knowledge = (src.knowledge ?? {}) as Record<string, string>;
  const REF = /\{\{\s*([^{}]*?)\s*\}\}/g;
  const missing: string[] = [];
  const cut = (text: string, cap: number) => (cap > 0 && text.length > cap ? text.slice(0, cap) : text);
  const asText = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? "" : JSON.stringify(v, null, 2));

  const fillOne = (template: string) => template.replace(REF, (whole: string, raw: string) => {
    let m = /^step\.(\d+)(?:\.([A-Za-z0-9_]+))?$/.exec(raw);
    if (m) {
      const out = outputs[String(seqOf[m[1]] ?? "")];
      if (!out) { missing.push(`step ${m[1]}`); return ""; }
      const json = out.json && typeof out.json === "object" ? (out.json as Record<string, unknown>) : null;
      const value = m[2] ? asText(json?.[m[2]]) : json ? asText(json) : asText(out.text);
      return cut(value, caps.step ?? 0);
    }
    m = /^input\.([A-Za-z0-9_]+)$/.exec(raw);
    if (m && m[1] in knowledge) return cut(asText(knowledge[m[1]]), caps.knowledge ?? 0);
    // Anything else was filled when the run started, or isn't a reference.
    return m ? "" : whole;
  });

  const fields: Record<string, string> = {};
  for (const [field, template] of Object.entries(templates)) fields[field] = fillOne(String(template ?? ""));
  if (fill.speech && fields.prompt !== undefined) fields.prompt = cut(fields.prompt, caps.speech ?? 0);
  return { fields, missing };
}
