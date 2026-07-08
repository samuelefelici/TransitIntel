/**
 * Mermaid — rende un blocco ```mermaid come diagramma SVG.
 * mermaid è pesante: viene caricato in modo LAZY (dynamic import) solo quando
 * una risposta contiene davvero un diagramma. securityLevel 'strict' perché il
 * contenuto arriva dall'LLM.
 */
import React from "react";

let _mermaidReady: Promise<any> | null = null;
let _counter = 0;

function loadMermaid(): Promise<any> {
  if (!_mermaidReady) {
    _mermaidReady = import("mermaid").then((mod) => {
      const mermaid = mod.default;
      mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
      return mermaid;
    });
  }
  return _mermaidReady;
}

export default function Mermaid({ code }: { code: string }) {
  const [svg, setSvg] = React.useState<string>("");
  const [err, setErr] = React.useState(false);
  const idRef = React.useRef(`argos-mmd-${++_counter}`);

  React.useEffect(() => {
    let cancelled = false;
    setErr(false);
    loadMermaid()
      .then((mermaid) => mermaid.render(idRef.current, code.trim()))
      .then(({ svg }: { svg: string }) => { if (!cancelled) setSvg(svg); })
      .catch(() => { if (!cancelled) setErr(true); });
    return () => { cancelled = true; };
  }, [code]);

  if (err) {
    // Diagramma non valido: mostro il sorgente come fallback leggibile.
    return <pre className="text-[10px] overflow-x-auto bg-black/40 rounded p-2 my-2">{code}</pre>;
  }
  if (!svg) {
    return <div className="my-2 text-[11px] text-zinc-400">rendo il diagramma…</div>;
  }
  return <div className="my-2 rounded-xl border border-violet-400/20 bg-white/5 p-2 overflow-x-auto [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />;
}
