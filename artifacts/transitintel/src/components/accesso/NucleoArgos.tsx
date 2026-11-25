/**
 * Argos, il nucleo di Cerbero, disegnato per la pagina di accesso (tappa
 * 7.35): al centro Argos, attorno l'anello degli agenti, fuori le fonti da cui
 * recupera (la biblioteca e i dati di Cerbero). Gli impulsi corrono dalle
 * fonti agli agenti e al nucleo, e le risposte tornano fuori.
 *
 * SVG e CSS (styles/landing.css, classi «na-»), niente librerie. Con «riduci
 * il movimento» resta fermo.
 */

const C = { x: 300, y: 280 };
const R_FONTI = 205;
const R_AGENTI = 118;
const R_NUCLEO = 56;

function punto(raggio: number, gradi: number): { x: number; y: number } {
  const a = (gradi * Math.PI) / 180;
  return { x: C.x + raggio * Math.cos(a), y: C.y + raggio * Math.sin(a) };
}

/** un punto sulla corda fra due cerchi, fuori dai bordi dei nodi */
function bordo(da: { x: number; y: number }, a: { x: number; y: number }, rDa: number, rA: number) {
  const dx = a.x - da.x, dy = a.y - da.y, l = Math.hypot(dx, dy) || 1;
  return {
    x1: da.x + (dx / l) * rDa, y1: da.y + (dy / l) * rDa,
    x2: a.x - (dx / l) * rA, y2: a.y - (dy / l) * rA,
  };
}

export default function NucleoArgos({ fonti, nucleo, agenti }: { fonti: readonly string[]; nucleo: string; agenti: string }) {
  const angoliFonti = fonti.map((_, i) => -90 + i * 60);
  const angoliAgenti = fonti.map((_, i) => -60 + i * 60);
  const pFonti = angoliFonti.map((g) => punto(R_FONTI, g));
  const pAgenti = angoliAgenti.map((g) => punto(R_AGENTI, g));

  /* ogni fonte parla con i due agenti accanto */
  const versoAgenti = pFonti.flatMap((f, i) => [i, (i + fonti.length - 1) % fonti.length].map((k) => ({ ...bordo(f, pAgenti[k]!, 24, 17), chiave: `f${i}a${k}` })));
  const versoNucleo = pAgenti.map((a, i) => ({ ...bordo(a, C, 17, R_NUCLEO + 4), chiave: `a${i}` }));
  const versoFuori = pAgenti.map((a, i) => ({ ...bordo(C, a, R_NUCLEO + 4, 17), chiave: `n${i}` }));

  return (
    <svg viewBox="-40 0 680 560" className="landing-nucleo" role="img" aria-label={`Argos · ${nucleo}: ${fonti.join(", ")}`}>
      <defs>
        <radialGradient id="na-cuore" cx="50%" cy="45%" r="60%">
          <stop offset="0%" stopColor="var(--l-ciano-2)" stopOpacity="0.95" />
          <stop offset="55%" stopColor="var(--l-indaco)" stopOpacity="0.9" />
          <stop offset="100%" stopColor="var(--l-viola)" stopOpacity="0.85" />
        </radialGradient>
        <radialGradient id="na-alone" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--l-indaco)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--l-indaco)" stopOpacity="0" />
        </radialGradient>
      </defs>

      <circle cx={C.x} cy={C.y} r={180} fill="url(#na-alone)" className="na-alone" />
      <circle cx={C.x} cy={C.y} r={R_AGENTI} className="na-anello-agenti" />
      <circle cx={C.x} cy={C.y} r={R_FONTI} className="na-anello-fonti" />

      {/* i fili e gli impulsi */}
      {versoAgenti.map((l, i) => (
        <g key={l.chiave}>
          <line {...l} className="na-filo" />
          <line {...l} pathLength={100} className="na-impulso" style={{ animationDelay: `${(i * 0.37) % 3}s` }} />
        </g>
      ))}
      {versoNucleo.map((l, i) => (
        <g key={l.chiave}>
          <line {...l} className="na-filo na-filo-forte" />
          <line {...l} pathLength={100} className="na-impulso na-impulso-dentro" style={{ animationDelay: `${0.6 + i * 0.45}s` }} />
        </g>
      ))}
      {versoFuori.map((l, i) => (
        <line key={l.chiave} {...l} pathLength={100} className="na-impulso na-impulso-fuori" style={{ animationDelay: `${1.4 + i * 0.5}s` }} />
      ))}

      {/* le fonti */}
      {pFonti.map((p, i) => {
        const g = angoliFonti[i]!;
        const coseno = Math.cos((g * Math.PI) / 180);
        const ancora = coseno > 0.3 ? "start" : coseno < -0.3 ? "end" : "middle";
        const e = punto(R_FONTI + 36, g);
        const dy = g === -90 ? -4 : g === 90 ? 14 : 5;
        return (
          <g key={`fonte-${i}`}>
            <circle cx={p.x} cy={p.y} r={22} className="na-fonte" />
            <circle cx={p.x} cy={p.y} r={6} className="na-fonte-cuore" style={{ animationDelay: `${i * 0.4}s` }} />
            <text x={e.x} y={e.y + dy} textAnchor={ancora} className="na-etichetta">{fonti[i]}</text>
          </g>
        );
      })}

      {/* gli agenti */}
      {pAgenti.map((p, i) => (
        <g key={`agente-${i}`}>
          <circle cx={p.x} cy={p.y} r={15} className="na-agente" style={{ animationDelay: `${i * 0.3}s` }} />
          <rect x={p.x - 6} y={p.y - 4} width={12} height={8} rx={2.5} className="na-agente-volto" />
          <circle cx={p.x - 2.6} cy={p.y} r={1.3} className="na-agente-occhio" />
          <circle cx={p.x + 2.6} cy={p.y} r={1.3} className="na-agente-occhio" />
        </g>
      ))}
      <text x={C.x} y={C.y - R_AGENTI - 26} textAnchor="middle" className="na-didascalia">{agenti}</text>

      {/* il nucleo */}
      <circle cx={C.x} cy={C.y} r={R_NUCLEO + 22} className="na-orbita" />
      <circle cx={C.x} cy={C.y} r={R_NUCLEO + 36} className="na-orbita na-orbita-2" />
      <circle cx={C.x} cy={C.y} r={R_NUCLEO} fill="url(#na-cuore)" className="na-nucleo" />
      <text x={C.x} y={C.y + 2} textAnchor="middle" className="na-nome">ARGOS</text>
      <text x={C.x} y={C.y + 22} textAnchor="middle" className="na-nome-sotto">{nucleo}</text>
    </svg>
  );
}
