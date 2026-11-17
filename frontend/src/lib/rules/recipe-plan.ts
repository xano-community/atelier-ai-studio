// A recipe's references, read once and used everywhere: the editor shows its errors inline, saving refuses a recipe
// with any, and starting a run turns the recipe into the run's steps. A step names what it uses with `{{input.name}}`
// and `{{step.N}}` (or `{{step.N.key}}` for one field of an earlier step's JSON reply). What a step depends on is the
// steps it refers to, never a list someone keeps by hand.
//
// Two modes, one body (a lambda module can hold only its default export):
//   - `$var.plan_in = { inputs, steps }` → `{ ok, errors, steps: [{ depends_on, inputs, knowledge, files }] }`
//   - `$var.plan_in = { inputs, steps, values, mode: "build" }` → also `run_steps`: the steps a run is started with,
//     inputs filled in and every unknown length priced at its cap (`values` empty prices an estimate).
export default function ({ $var }: { $var: Record<string, any> }) {
  const KINDS = ["text", "image", "video", "music", "speech", "transcribe"];
  const INPUT_TYPES = ["text", "long_text", "image", "audio", "file", "knowledge"];
  const FILE_TYPES = ["image", "audio", "file"];
  /** What each kind's file slot takes: input types, and the kinds of earlier step whose file it can use. */
  const FILE_SLOT: Record<string, { inputs: string[]; steps: string[]; what: string }> = {
    image: { inputs: ["image"], steps: ["image"], what: "an image to edit" },
    video: { inputs: ["image"], steps: ["image"], what: "an image to start from" },
    text: { inputs: ["image", "audio", "file"], steps: ["image", "speech", "music"], what: "a file to read" },
    transcribe: { inputs: ["audio"], steps: ["speech", "music"], what: "a recording" },
  };
  /** Kinds whose output is words a later step can put in its prompt. */
  const WORDS = ["text", "transcribe"];
  const MOST_STEPS = 10;
  const MOST_INPUTS = 10;
  const MOST_FILE_INPUTS = 3;
  const MOST_KNOWLEDGE = 3;
  /** The longest an inserted value can be, in characters (about 4 to a token). Longer values are cut to it. */
  const CAP = { step: 8000, knowledge: 8400, text: 2000, long_text: 12000, speech: 3000 } as const;
  const TEXT_FIELDS = ["prompt", "system", "instructions", "negative_prompt"];
  const REF = /\{\{\s*([^{}]*?)\s*\}\}/g;
  const KIND_WORDS: Record<string, string> = { text: "text", image: "an image", video: "a video", music: "music", speech: "speech", transcribe: "a transcript" };

  const src = ($var.plan_in ?? {}) as Record<string, any>;
  const inputs: any[] = Array.isArray(src.inputs) ? src.inputs : [];
  const steps: any[] = Array.isArray(src.steps) ? src.steps : [];
  const errors: { step: number; field: string; ref?: string; message: string }[] = [];
  const fail = (step: number, field: string, message: string, ref?: string) => errors.push(ref ? { step, field, ref, message } : { step, field, message });
  const str = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
  const fieldOf = (s: any, f: string) => str(f === "prompt" ? s?.prompt : s?.settings?.[f]);

  // Inputs: a name to refer to, unique, a known type.
  const byName: Record<string, any> = {};
  if (inputs.length > MOST_INPUTS) fail(0, "inputs", `A recipe can ask for up to ${MOST_INPUTS} inputs.`);
  inputs.forEach((inp, i) => {
    const name = str(inp?.name);
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(name)) fail(0, `inputs.${i}`, `Input ${i + 1}'s name must start with a letter and use only lower-case letters, digits and _ (like product_name).`);
    else if (byName[name]) fail(0, `inputs.${i}`, `Two inputs are called ${name}. Give each its own name.`);
    else byName[name] = inp;
    if (!INPUT_TYPES.includes(str(inp?.type))) fail(0, `inputs.${i}`, `Input ${name || i + 1} needs a type: text, long text, image, audio, file or a pick from Knowledge.`);
  });
  if (inputs.filter((x) => FILE_TYPES.includes(str(x?.type))).length > MOST_FILE_INPUTS) fail(0, "inputs", `A recipe can ask for up to ${MOST_FILE_INPUTS} files.`);
  if (inputs.filter((x) => str(x?.type) === "knowledge").length > MOST_KNOWLEDGE) fail(0, "inputs", `A recipe can pick from Knowledge up to ${MOST_KNOWLEDGE} times.`);
  if (!steps.length) fail(0, "steps", "Add a step: what the recipe makes.");
  if (steps.length > MOST_STEPS) fail(0, "steps", `A recipe has up to ${MOST_STEPS} steps.`);

  type Ref = { raw: string; kind: "input"; name: string } | { raw: string; kind: "step"; n: number; key: string } | { raw: string; kind: "bad" };
  const parse = (raw: string): Ref => {
    let m = /^input\.([A-Za-z0-9_]+)$/.exec(raw);
    if (m) return { raw, kind: "input", name: m[1] };
    m = /^step\.(\d+)(?:\.([A-Za-z0-9_]+))?$/.exec(raw);
    if (m) return { raw, kind: "step", n: Number(m[1]), key: m[2] ?? "" };
    return { raw, kind: "bad" };
  };
  const refsIn = (text: string): Ref[] => [...text.matchAll(REF)].map((m) => parse(m[1]));

  const planned = steps.map((step, i) => {
    const seq = i + 1;
    const kind = str(step?.kind);
    const deps = new Set<number>();
    const usedInputs = new Set<string>();
    const knowledge = new Set<string>();
    let stepRefs = 0;
    if (!str(step?.name).trim()) fail(seq, "name", `Step ${seq} needs a name.`);
    if (!KINDS.includes(kind)) fail(seq, "kind", `Step ${seq} needs a kind: text, image, video, music, speech or transcribe.`);
    if (!str(step?.model).trim()) fail(seq, "model", `Step ${seq} needs a model.`);

    // A reference names an input that exists, or a step that runs before this one.
    const checkStep = (r: Extract<Ref, { kind: "step" }>, field: string) => {
      if (r.n === seq) { fail(seq, field, `{{${r.raw}}} is this step. A step can use only the steps before it.`, r.raw); return null; }
      if (r.n > seq && r.n <= steps.length) { fail(seq, field, `{{${r.raw}}} runs after this one. Move this step below step ${r.n}, or use an earlier step.`, r.raw); return null; }
      if (r.n < 1 || r.n > steps.length) { fail(seq, field, `There's no step ${r.n}.`, r.raw); return null; }
      return steps[r.n - 1];
    };

    for (const field of TEXT_FIELDS) {
      for (const r of refsIn(fieldOf(step, field))) {
        if (r.kind === "bad") { fail(seq, field, `{{${r.raw}}} isn't something a step can use. Use Insert to add an input or an earlier step.`, r.raw); continue; }
        if (r.kind === "input") {
          const def = byName[r.name];
          if (!def) { fail(seq, field, `There's no input called ${r.name}.`, r.raw); continue; }
          if (FILE_TYPES.includes(str(def.type))) { fail(seq, field, `${r.name} is a file, so it can't go into words. Pick it as this step's file instead.`, r.raw); continue; }
          usedInputs.add(r.name);
          if (str(def.type) === "knowledge") knowledge.add(r.name);
          continue;
        }
        const earlier = checkStep(r, field);
        if (!earlier) continue;
        if (!WORDS.includes(str(earlier.kind))) { fail(seq, field, `Step ${r.n} makes ${KIND_WORDS[str(earlier.kind)] ?? "a file"}, which can't go into words. Use it as this step's file instead.`, r.raw); continue; }
        if (r.key && !(str(earlier.kind) === "text" && str(earlier.settings?.response_format) === "json")) {
          fail(seq, field, `{{${r.raw}}} reads a field of step ${r.n}'s reply, but step ${r.n} doesn't return JSON. Use {{step.${r.n}}}.`, r.raw); continue;
        }
        deps.add(r.n);
        stepRefs += 1;
      }
    }

    // The file slot: one reference, of a type this kind can use.
    const fileText = str(step?.file).trim();
    let file: { input: string } | { step: number } | null = null;
    const slot = FILE_SLOT[kind];
    if (fileText) {
      const all = refsIn(fileText);
      if (!slot) fail(seq, "file", `A ${kind} step doesn't take a file. Remove it.`);
      else if (all.length !== 1 || fileText.replace(REF, "").trim()) fail(seq, "file", "Pick one input or one earlier step as the file.");
      else {
        const r = all[0];
        if (r.kind === "input") {
          const def = byName[r.name];
          if (!def) fail(seq, "file", `There's no input called ${r.name}.`, r.raw);
          else if (!slot.inputs.includes(str(def.type))) fail(seq, "file", `This step needs ${slot.what}, and ${r.name} isn't one.`, r.raw);
          else { file = { input: r.name }; usedInputs.add(r.name); }
        } else if (r.kind === "step") {
          const earlier = checkStep(r, "file");
          if (earlier && !slot.steps.includes(str(earlier.kind))) fail(seq, "file", `This step needs ${slot.what}, and step ${r.n} makes ${KIND_WORDS[str(earlier.kind)] ?? "something else"}.`, r.raw);
          else if (earlier) { file = { step: r.n }; deps.add(r.n); }
        } else fail(seq, "file", `{{${r.raw}}} isn't something a step can use.`, r.raw);
      }
    }
    if (kind === "transcribe" && !fileText) fail(seq, "file", "A transcribe step needs a recording: pick an audio input or an earlier speech or music step.");
    if (["text", "image", "video", "music"].includes(kind) && !str(step?.prompt).trim()) fail(seq, "prompt", `Step ${seq} needs a prompt.`);
    if (kind === "speech" && !str(step?.prompt).trim()) fail(seq, "prompt", `Step ${seq} needs the words to say.`);
    return { seq, depends_on: [...deps].sort((a, b) => a - b), inputs: [...usedInputs], knowledge: [...knowledge], file, step_refs: stepRefs };
  });

  const out: Record<string, any> = { ok: errors.length === 0, errors, steps: planned };
  if (src.mode !== "build" || errors.length) return out;

  // The run's steps. A pick from Knowledge that a step uses becomes one embedding step first, so its passages can be
  // found before the steps that need them; every recipe step moves down by that many.
  const values: Record<string, any> = src.values && typeof src.values === "object" && !Array.isArray(src.values) ? src.values : {};
  const estimating = src.values === undefined || src.values === null;
  const kbModel = str(src.kb_model);
  const kbDims = Number(src.kb_dimensions) || 768;
  const valueOf = (name: string) => str(values[name]).trim();

  // What the person filled in: every required input, and nothing longer than its type allows.
  if (!estimating) {
    const given: string[] = Array.isArray(src.files_given) ? src.files_given.map(str) : [];
    for (const def of inputs) {
      const name = str(def?.name);
      const type = str(def?.type);
      const label = str(def?.label) || name;
      if (FILE_TYPES.includes(type)) {
        if (def?.required && !given.includes(name)) fail(0, `values.${name}`, `${label} is required: attach ${type === "image" ? "an image" : type === "audio" ? "a recording" : "a file"}.`);
        continue;
      }
      const v = valueOf(name);
      if (def?.required && !v) fail(0, `values.${name}`, `${label} is required.`);
      const most = type === "long_text" ? CAP.long_text : type === "knowledge" ? 200 : CAP.text;
      if (v.length > most) fail(0, `values.${name}`, `${label} is too long: keep it under ${most.toLocaleString("en-US")} characters.`);
    }
    if (errors.length) { out.ok = false; return out; }
  }
  const usedKnowledge: string[] = [];
  for (const p of planned) for (const k of p.knowledge) if (!usedKnowledge.includes(k)) usedKnowledge.push(k);
  const kbSteps: any[] = [];
  const kbSeq: Record<string, number> = {};
  for (const name of usedKnowledge) {
    const asked = estimating ? "x".repeat(200) : valueOf(name);
    if (!asked) continue;
    kbSeq[name] = kbSteps.length + 1;
    kbSteps.push({
      kind: "embedding", model: kbModel, label: estimating ? `Find ${byName[name]?.label || name} in Knowledge` : `Find “${asked.slice(0, 60)}” in Knowledge`,
      input: { input: [asked], task_type: "RETRIEVAL_QUERY", dimensions: kbDims, kb_input: name },
      options: { input_tokens: Math.ceil(asked.length / 4) + 8, input_type: "text" }, depends_on: [],
    });
  }
  const shift = kbSteps.length;
  const seqOf: Record<string, number> = {};
  steps.forEach((_, i) => { seqOf[String(i + 1)] = i + 1 + shift; });

  // How long a field will be once filled: what's written, plus each inserted value at its length or its cap.
  const filledLength = (text: string) => {
    let n = text.replace(REF, "").length;
    for (const r of refsIn(text)) {
      if (r.kind === "step") n += CAP.step;
      else if (r.kind === "input") {
        const def = byName[r.name];
        const type = str(def?.type);
        if (type === "knowledge") n += CAP.knowledge;
        else if (estimating) n += type === "long_text" ? CAP.long_text : CAP.text;
        else n += Math.min(valueOf(r.name).length, type === "long_text" ? CAP.long_text : CAP.text);
      }
    }
    return n;
  };
  // Text inputs are filled in now; steps and Knowledge when the step runs.
  const fillInputs = (text: string) => text.replace(REF, (whole, raw) => {
    const r = parse(raw);
    if (r.kind !== "input") return whole;
    const type = str(byName[r.name]?.type);
    // A pick from Knowledge is found when the step runs; one left empty adds nothing.
    if (type === "knowledge") return kbSeq[r.name] ? whole : "";
    return valueOf(r.name).slice(0, type === "long_text" ? CAP.long_text : CAP.text);
  });

  const runSteps = steps.map((step, i) => {
    const p = planned[i];
    const kind = str(step.kind);
    const settings = step.settings && typeof step.settings === "object" ? step.settings : {};
    const options = { ...(step.options && typeof step.options === "object" ? step.options : {}) };
    const templates: Record<string, string> = {};
    for (const f of TEXT_FIELDS) {
      const v = fieldOf(step, f);
      if (v) templates[f] = estimating ? v : fillInputs(v);
    }
    const waits = p.step_refs > 0 || p.knowledge.some((k) => kbSeq[k]);
    const input: Record<string, any> = {};
    for (const [k, v] of Object.entries(settings)) if (!TEXT_FIELDS.includes(k) && v !== "" && v !== null && v !== undefined) input[k] = v;
    // Fields filled later start empty; the step's `fill` says how to finish them when it runs.
    if (kind === "speech") input.text = waits ? "" : templates.prompt ?? "";
    else if (templates.prompt !== undefined) input.prompt = waits ? "" : templates.prompt;
    for (const f of ["system", "instructions", "negative_prompt"]) if (templates[f] !== undefined) input[f] = waits ? "" : templates[f];
    if (waits || (p.file && "step" in p.file)) {
      input.fill = {
        templates, seq_of: seqOf, speech: kind === "speech",
        kb: p.knowledge.filter((k) => kbSeq[k]).map((k) => ({ name: k, seq: kbSeq[k] })),
        file_from: p.file && "step" in p.file ? seqOf[String(p.file.step)] : 0,
        caps: { step: CAP.step, knowledge: CAP.knowledge, speech: CAP.speech },
      };
    }
    if (p.file && "input" in p.file) input.file_input = p.file.input;
    // Unknown lengths are priced at their caps, so a step can't cost more than was held.
    const promptChars = filledLength(kind === "speech" ? fieldOf(step, "prompt") : TEXT_FIELDS.map((f) => fieldOf(step, f)).join("\n"));
    if (kind === "text") options.input_tokens = Math.ceil(promptChars / 4) + 50 + (input.use_brand === false ? 0 : 400);
    if (kind === "speech") {
      const chars = Math.min(filledLength(fieldOf(step, "prompt")), CAP.speech);
      options.input_tokens = Math.ceil((chars + fieldOf(step, "instructions").length) / 4) + 20;
      options.output_tokens = Math.max(200, Math.ceil((chars / 6 / 150) * 1500));
    }
    if (kind === "transcribe") { options.input_tokens = options.input_tokens ?? 15600; options.output_tokens = options.output_tokens ?? 2400; }
    const depends = p.depends_on.map((n) => seqOf[String(n)]);
    for (const k of p.knowledge) if (kbSeq[k]) depends.push(kbSeq[k]);
    return {
      kind, model: str(step.model), label: str(step.name).trim() || `Step ${i + 1}`, recipe_seq: i + 1,
      input, options, depends_on: [...new Set(depends)].sort((a, b) => a - b),
    };
  });
  out.run_steps = [...kbSteps, ...runSteps];
  out.kb_steps = shift;
  return out;
}
