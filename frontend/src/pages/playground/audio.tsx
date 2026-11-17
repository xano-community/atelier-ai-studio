// Audio: speech from words in a chosen voice, or a music clip from a prompt.
import { useId } from "react";
import { Input } from "@/components/ui/input";
import { Choice, Field, PromptBox } from "./fields";
import type { KindFieldsProps } from "./image";

/** A voice left unset takes the brand kit's default voice, or the model's own. */
const BRAND_VOICE = "default";

export function SpeechFields({ form, patch, setting, choices }: KindFieldsProps) {
  const style = useId();
  return (
    <>
      <PromptBox id="speech-text" label="Words to say" value={form.speechText} onChange={(speechText) => patch({ speechText })} useBrand={form.useBrand} onBrand={(useBrand) => patch({ useBrand })}
        placeholder="The words to say, exactly as they should be read." testId="speech-text" />
      <Choice label="Voice" value={form.settings.voice || BRAND_VOICE} options={[BRAND_VOICE, ...choices.voices]} onChange={(voice) => setting({ voice: voice === BRAND_VOICE ? "" : voice })}
        words={(v) => (v === BRAND_VOICE ? (form.useBrand ? "The brand kit's voice" : "The model's default") : v)} testId="speech-voice" />
      <Field label="How to say it" hint="Optional" htmlFor={style}>
        <Input id={style} value={form.style} onChange={(e) => patch({ style: e.target.value })} placeholder="Warm and unhurried" className="h-8 text-body" />
      </Field>
    </>
  );
}

export function MusicFields({ form, patch, choices }: KindFieldsProps) {
  const avoid = useId();
  return (
    <>
      <PromptBox id="music-prompt" value={form.prompt} onChange={(prompt) => patch({ prompt })} useBrand={form.useBrand} onBrand={(useBrand) => patch({ useBrand })}
        placeholder="Describe the music: the mood, the instruments, the tempo." />
      {choices.negativePrompt && (
        <Field label="Leave out" hint="Optional" htmlFor={avoid}>
          <Input id={avoid} value={form.negative} onChange={(e) => patch({ negative: e.target.value })} placeholder="vocals, drums" className="h-8 text-body" />
        </Field>
      )}
      <p className="text-caption text-muted-foreground">Each clip is the model's own length{choices.clipSeconds ? `: about ${Math.round(choices.clipSeconds)} s` : ""}.</p>
    </>
  );
}
