// Time so far against how long this model usually takes: the usual range is a shaded band on a time scale, and a marker
// shows where the run is now. It's never a filling bar, because nothing reports progress: only the clock is real.
import { rangeLayout, secondsWords } from "@/lib/catalog";

export function ElapsedRange({ elapsed, usual }: { elapsed: number; usual: [number, number] }) {
  const l = rangeLayout(elapsed, usual);
  return (
    <div className="grid gap-1.5" data-testid="elapsed-range">
      <div className="flex items-baseline justify-between gap-3 text-caption">
        <span className="font-medium tabular-nums text-foreground">{secondsWords(elapsed)} so far</span>
        <span className="text-muted-foreground">Usually {secondsWords(usual[0])} to {secondsWords(usual[1])}</span>
      </div>
      <div className="relative h-2 rounded-full border bg-background" role="img"
        aria-label={`${secondsWords(elapsed)} so far. This model usually takes ${secondsWords(usual[0])} to ${secondsWords(usual[1])}.`}>
        <span aria-hidden className="absolute inset-y-0 rounded-full bg-muted-foreground/25" style={{ left: `${l.from}%`, width: `${l.to - l.from}%` }} />
        <span aria-hidden className="absolute -top-1 -bottom-1 w-0.5 -translate-x-1/2 rounded-full bg-foreground transition-[left] duration-700 ease-linear" style={{ left: `${l.marker}%` }} />
      </div>
      <p className="text-caption text-muted-foreground">
        {l.late ? "Taking longer than usual. It keeps going until the model answers or its time limit passes." : "It runs in the background: you can leave this page and find it in your history when it ends."}
      </p>
    </div>
  );
}
