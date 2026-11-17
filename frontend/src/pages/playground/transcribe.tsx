// Transcribe: a recording in, its words out. Names and terms in the hint help the model spell them.
import { useId } from "react";
import { Input } from "@/components/ui/input";
import { Field, FilePick } from "./fields";
import type { KindFieldsProps } from "./image";

export function TranscribeFields({ form, patch, file, setFile }: KindFieldsProps) {
  const language = useId(), hint = useId();
  return (
    <>
      <FilePick label="Recording" hint="Audio: MP3, WAV, M4A…" accept="audio/*" file={file} onChange={setFile} testId="transcribe-file" />
      <Field label="Names and terms" hint="Optional" htmlFor={hint}>
        <Input id={hint} value={form.hint} onChange={(e) => patch({ hint: e.target.value })} placeholder="Marlow, Trail 2, Riley Okafor" className="h-8 text-body" />
      </Field>
      <Field label="Language" hint="Optional: it hears most languages" htmlFor={language}>
        <Input id={language} value={form.language} onChange={(e) => patch({ language: e.target.value })} placeholder="en" className="h-8 text-body" />
      </Field>
    </>
  );
}
