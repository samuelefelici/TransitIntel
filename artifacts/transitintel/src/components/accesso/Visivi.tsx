/**
 * Le piccole animazioni dei moduli nella pagina di accesso (tappa 7.34):
 * SVG e CSS (styles/landing.css), niente librerie. Con «riduci il movimento»
 * restano ferme: le animazioni in CSS si spengono, quelle SMIL non si
 * disegnano proprio.
 */
import type { Modulo } from "@/lib/accesso";

const PERCORSO = "M8 82 C 40 20, 78 104, 112 48 S 168 70, 192 26";

export default function VisivoModulo({ chiave, fermo, etichette }: {
  chiave: Modulo["chiave"]; fermo: boolean; etichette: { inLinea: string; tariffe: string };
}) {
  return (
    <svg viewBox="0 0 200 110" className={`landing-visivo landing-visivo-${chiave}`} aria-hidden focusable="false">
      {chiave === "rete" && <Rete fermo={fermo} />}
      {chiave === "turni" && <Turni />}
      {chiave === "roster" && <Roster />}
      {chiave === "esercizio" && <Esercizio fermo={fermo} inLinea={etichette.inLinea} />}
      {chiave === "consuntivo" && <Consuntivo />}
      {chiave === "tariffe" && <Tariffe />}
      {chiave === "dati" && <Dati tariffe={etichette.tariffe} />}
      {chiave === "pubblico" && <Pubblico />}
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

function Esercizio({ fermo, inLinea }: { fermo: boolean; inLinea: string }) {
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
      <text x={10} y={92} className="lv-etichetta">{inLinea}</text>
      <circle cx={16 + inLinea.length * 7.3} cy={89} r={3} className="lv-vivo" />
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

function Dati({ tariffe }: { tariffe: string }) {
  return (
    <>
      <rect x={60} y={74} width={80} height={26} rx={6} className="lv-scatola" />
      <path d="M60 80 L100 92 L140 80" className="lv-scatola-bordo" />
      {["GTFS", "NeTEx", tariffe].map((t, i) => (
        <g key={t} className="lv-file" style={{ animationDelay: `${i * 1.2}s` }}>
          <rect x={64 + i * 26 - 14} y={44} width={44} height={20} rx={4} className="lv-file-fondo" />
          <text x={64 + i * 26 + 8} y={58} textAnchor="middle" className="lv-file-testo">{t}</text>
        </g>
      ))}
    </>
  );
}

/** gli orari al pubblico: la palina con i prossimi passaggi e il codice da inquadrare */
const QR = [
  "111111101", "100000100", "101110111", "101110010", "101110101", "100000110", "111111101", "000000011", "110101111",
];
function Pubblico() {
  const righe: Array<[string, string]> = [["1", "07:42"], ["7", "07:49"], ["12", "07:55"], ["3", "08:02"]];
  return (
    <>
      <rect x={14} y={8} width={98} height={94} rx={6} className="lv-tabellone" />
      {righe.map(([linea, ora], i) => (
        <g key={linea} transform={`translate(22 ${18 + i * 21})`}>
          <rect x={0} y={0} width={22} height={14} rx={3} className={`lv-linea-badge lv-linea-badge-${i % 3}`} />
          <text x={11} y={10.5} textAnchor="middle" className="lv-linea-numero">{linea}</text>
          <text x={74} y={11} textAnchor="end" className="lv-orario" style={{ animationDelay: `${i * 0.5}s` }}>{ora}</text>
        </g>
      ))}
      <g transform="translate(128 18)">
        {QR.map((riga, r) => [...riga].map((b, c) => (b === "1"
          ? <rect key={`${r}-${c}`} x={c * 7.6} y={r * 7.6} width={6.8} height={6.8} rx={1} className="lv-qr" style={{ animationDelay: `${(r + c) * 0.07}s` }} />
          : null)))}
      </g>
    </>
  );
}
