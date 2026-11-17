// Text: one prompt, an optional system instruction, and a switch for a JSON reply shaped by a schema.
import { useId } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Field, PromptBox, Toggle } from "./fields";
import type { KindFieldsProps } from "./image";

export function TextFields({ form, patch }: KindFieldsProps) {
  const system = useId(), schema = useId();
  return (
    <>
      <PromptBox id="text-prompt" value={form.prompt} onChange={(prompt) => patch({ prompt })} rows={5} useBrand={form.useBrand} onBrand={(useBrand) => patch({ useBrand })}
        placeholder="What should the model write?" />
      <Field label="Instructions" hint="Optional" htmlFor={system}>
        <Textarea id={system} value={form.system} onChange={(e) => patch({ system: e.target.value })} rows={2} className="min-h-14 resize-y text-body" placeholder="How the model should behave, for example: you write for Marlow's product pages." />
      </Field>
      <div className="flex min-h-8 items-center justify-between gap-2">
        <span className="text-caption font-medium text-muted-foreground" id={`${schema}-label`}>Reply as JSON</span>
        <Toggle label="Return JSON" on={form.json} onChange={(json) => patch({ json })} testId="json-toggle" bare />
      </div>
      {form.json && (
        <Field label="JSON schema" hint="Optional" htmlFor={schema}>
          <Textarea id={schema} value={form.schema} onChange={(e) => patch({ schema: e.target.value })} rows={5} spellCheck={false} data-testid="json-schema"
            className="min-h-24 resize-y font-mono text-caption" placeholder={'Leave empty to let the model choose the shape, or:\n{\n  "type": "object",\n  "properties": { "intro": { "type": "string" } }\n}'} />
        </Field>
      )}
    </>
  );
}
