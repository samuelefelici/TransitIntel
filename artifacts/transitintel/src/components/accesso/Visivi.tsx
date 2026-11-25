/**
 * Le piccole animazioni dei moduli nella pagina di accesso (tappa 7.34):
 * SVG e CSS (styles/landing.css), niente librerie. Con «riduci il movimento»
 * restano ferme: le animazioni in CSS si spengono, quelle SMIL non si
 * disegnano proprio.
 */
import type { Modulo } from "@/lib/accesso";

const PERCORSO = "M8 82 C 40 20, 78 104, 112 48 S 168 70, 192 26";

export default function VisivoModulo({ chiave, fermo }: { chiave: Modulo["chiave"]; fermo: boolean }) {
  return (
    <svg viewBox="0 0 200 110" className={`landing-visivo landing-visivo-${chiave}`} aria-hidden focusable="false">
      {chiave === "rete" && <Rete fermo={fermo} />}
      {chiave === "turni" && <Turni />}
      {chiave === "roster" && <Roster />}
      {chiave === "esercizio" && <Esercizio fermo={fermo} />}
      {chiave === "consuntivo" && <Consuntivo />}
      {chiave === "tariffe" && <Tariffe />}
      {chiave === "dati" && <Dati />}
      {chiave === "argos" && <Argos />}
    </svg>
  );
}

function Rete({ fermo }: { fermo: boolean }) {
  return (
    <>
      <path d={PERCORSO} className="lv-traccia" />
      <path d={PERCORSO} className="lv-disegno" pathLength={1} />
      {[[8, 82], [52, 56], [112, 48], [150, 62], [192, 26]].map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={3.6} className="lv-fermata" style={{ animationDelay: `${i * 0.35}s` }} />
      ))}
      <circle r={4.2} className="lv-mezzo">
        {!fermo && <animateMotion dur="5.5s" repeatCount="indefinite" path={PERCORSO} />}
      </circle>
    </>
  );
}

function Turni() {
  const righe = [
    [[6, 46], [60, 30], [100, 52], [160, 34]],
    [[14, 38], [62, 58], [130, 24], [162, 30]],
    [[4, 30], [44, 44], [96, 40], [146, 48]],
    [[20, 52], [80, 26], [116, 44], [168, 26]],
  ];
  return (
    <>
      {righe.map((r, i) => (
        <g key={i} transform={`translate(0 ${14 + i * 22})`}>
          <rect x={4} y={6} width={192} height={1} className="lv-asse" />
          {r.map(([x, w], k) => (
            <rect key={k} x={x} y={0} width={w} height={12} rx={3} className={`lv-barra lv-barra-${(i + k) % 3}`} style={{ animationDelay: `${(i * 4 + k) * 0.18}s` }} />
          ))}
        </g>
      ))}
      <rect x={0} y={8} width={2} height={92} className="lv-adesso" />
    </>
  );
}

function Roster() {
  const celle = [];
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 12; c++) {
      const i = r * 12 + c;
      celle.push(<rect key={i} x={6 + c * 16} y={8 + r * 19} width={13} height={15} rx={2.5} className={`lv-cella lv-cella-${(r * 7 + c * 3) % 4}`} style={{ animationDelay: `${((c + r * 2) % 12) * 0.16}s` }} />);
    }
  }
  return <>{celle}</>;
}

function Esercizio({ fermo }: { fermo: boolean }) {
  const fermate = [12, 48, 84, 120, 156, 188];
  return (
    <>
      <line x1={8} y1={58} x2={192} y2={58} className="lv-linea" />
      {fermate.map((x, i) => <circle key={i} cx={x} cy={58} r={4} className="lv-palina" />)}
      {[0, 1, 2].map((k) => (
        <g key={k}>
          <circle cy={58} r={5.5} className="lv-veicolo">
            {!fermo && <animate attributeName="cx" from="8" to="192" dur={`${6 + k * 2.4}s`} begin={`${-k * 2.1}s`} repeatCount="indefinite" />}
          </circle>
          <circle cy={58} r={5.5} className="lv-veicolo-onda">
            {!fermo && <animate attributeName="cx" from="8" to="192" dur={`${6 + k * 2.4}s`} begin={`${-k * 2.1}s`} repeatCount="indefinite" />}
          </circle>
        </g>
      ))}
      <text x={10} y={92} className="lv-etichetta">IN LINEA</text>
      <circle cx={64} cy={89} r={3} className="lv-vivo" />
    </>
  );
}

function Consuntivo() {
  const alte = [44, 62, 38, 70, 56, 80, 66];
  return (
    <>
      <line x1={8} y1={96} x2={192} y2={96} className="lv-asse-forte" />
      {alte.map((h, i) => (
        <rect key={i} x={14 + i * 22} y={96 - h} width={14} height={h} rx={2} className="lv-colonna" style={{ animationDelay: `${i * 0.14}s` }} />
      ))}
      <path d="M168 26 l8 8 l16 -18" className="lv-spunta" pathLength={1} />
    </>
  );
}

function Tariffe() {
  const celle = [];
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c <= r; c++) {
      celle.push(<rect key={`${r}-${c}`} x={52 + c * 17} y={6 + r * 16.5} width={14} height={13.5} rx={2} className="lv-polimetrica" style={{ animationDelay: `${(r + c) * 0.16}s` }} />);
    }
  }
  return <>{celle}</>;
}

function Dati() {
  return (
    <>
      <rect x={60} y={74} width={80} height={26} rx={6} className="lv-scatola" />
      <path d="M60 80 L100 92 L140 80" className="lv-scatola-bordo" />
      {["GTFS", "NeTEx", "Tariffe"].map((t, i) => (
        <g key={t} className="lv-file" style={{ animationDelay: `${i * 1.2}s` }}>
          <rect x={64 + i * 26 - 14} y={44} width={44} height={20} rx={4} className="lv-file-fondo" />
          <text x={64 + i * 26 + 8} y={58} textAnchor="middle" className="lv-file-testo">{t}</text>
        </g>
      ))}
    </>
  );
}

function Argos() {
  const nodi: Array<[number, number]> = [[30, 30], [30, 80], [84, 18], [84, 55], [84, 92], [140, 36], [140, 76], [182, 55]];
  const lati: Array<[number, number]> = [[0, 2], [0, 3], [1, 3], [1, 4], [2, 5], [3, 5], [3, 6], [4, 6], [5, 7], [6, 7]];
  return (
    <>
      {lati.map(([a, b], i) => (
        <line key={i} x1={nodi[a]![0]} y1={nodi[a]![1]} x2={nodi[b]![0]} y2={nodi[b]![1]} className="lv-sinapsi" style={{ animationDelay: `${i * 0.22}s` }} />
      ))}
      {nodi.map(([x, y], i) => <circle key={i} cx={x} cy={y} r={5} className="lv-neurone" style={{ animationDelay: `${i * 0.2}s` }} />)}
    </>
  );
}
