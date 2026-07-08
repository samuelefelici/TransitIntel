/**
 * ArgosMarkdown — markdown "ricco" per le risposte di Argos nel pannello.
 * Oltre a GFM (tabelle/liste) rende:
 *  - formule LaTeX ($…$ / $$…$$) con KaTeX;
 *  - blocchi ```map  → mappa Mapbox reale (ArgosMap);
 *  - blocchi ```mermaid → diagramma (Mermaid, lazy);
 *  - blocchi ```chart → grafico Chart.js (ChartBlock, lazy).
 * Così le risposte con mappa/diagramma/formula si vedono come nella chat nativa
 * di Argos, non più come codice grezzo.
 */
import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import ArgosMap from "./ArgosMap";
import Mermaid from "./Mermaid";
import ChartBlock from "./ChartBlock";

function CodeBlock({ lang, raw }: { lang: string; raw: string }) {
  if (lang === "map") {
    try { return <ArgosMap spec={JSON.parse(raw)} />; } catch { /* fallback sotto */ }
  }
  if (lang === "mermaid") return <Mermaid code={raw} />;
  if (lang === "chart") {
    try { return <ChartBlock config={JSON.parse(raw)} />; } catch { /* fallback sotto */ }
  }
  return <pre className="text-[10.5px] overflow-x-auto bg-black/40 rounded-lg p-2 my-2"><code>{raw}</code></pre>;
}

export default function ArgosMarkdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          // Togliamo il <pre> di wrapping: i blocchi speciali si renderizzano da soli.
          pre: ({ children }: any) => <>{children}</>,
          code: ({ className: cls, children, ...props }: any) => {
            const lang = /language-(\w+)/.exec(cls || "")?.[1];
            if (!lang) return <code className={cls} {...props}>{children}</code>; // inline
            return <CodeBlock lang={lang} raw={String(children ?? "").replace(/\n$/, "")} />;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
