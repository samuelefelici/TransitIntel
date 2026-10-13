/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RITRATTI DEI CONDUCENTI FITTIZI — un'illustrazione per ciascuno
 * ───────────────────────────────────────────────────────────────────────────
 * I conducenti di prova hanno bisogno di una faccia, perché il tabellone e
 * la scheda la mostrano: una foto vera non si può usare, e un'immagine presa
 * da fuori è una persona vera. Qui si disegna un busto in SVG, diverso per
 * ciascuno (carnagione, capelli, barba, occhiali) e uguale per tutti nella
 * divisa: camicia azzurra di servizio e giacca blu.
 *
 * È deterministico: lo stesso seme dà lo stesso ritratto, così i test e le
 * schermate non cambiano a ogni giro.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Generatore pseudo-casuale con seme (mulberry32). */
function casuale(seme: number): () => number {
  let a = seme >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PELLE = ["#f6d2b5", "#eebf9b", "#e0a982", "#c98d63", "#a8704a", "#7b4b30", "#f1c9a5", "#dcae8a"];
const CAPELLI = ["#1f1a17", "#2f241d", "#4a3426", "#6b4a2f", "#8a6a45", "#b88c5a", "#d6b47a", "#9b9b9b", "#cfcfcf", "#7a3b22"];
const SFONDI = ["#dbe7f3", "#e3ecdf", "#efe5d8", "#e6e0ef", "#dfeaec", "#efe0e0"];
const GIACCA = "#1e3a6b";
const CAMICIA = "#cfe0f5";

export interface OpzioniRitratto {
  seme: number;
  donna: boolean;
  /** anni: i capelli grigi arrivano dopo i 50 */
  eta?: number;
}

/** Il ritratto come testo SVG (128×128). */
export function ritrattoSvg({ seme, donna, eta = 40 }: OpzioniRitratto): string {
  const r = casuale(seme * 7919 + (donna ? 1 : 0));
  const scegli = <T,>(a: T[]): T => a[Math.floor(r() * a.length)];
  const pelle = scegli(PELLE);
  const grigi = eta >= 52 && r() < 0.6;
  const capelli = grigi ? scegli(["#9b9b9b", "#b5b5b5", "#cfcfcf"]) : scegli(CAPELLI.slice(0, 7).concat(["#7a3b22"]));
  const sfondo = scegli(SFONDI);
  const occhiali = r() < 0.3;
  const barba = !donna && r() < 0.35;
  const baffi = !donna && !barba && r() < 0.2;
  const calvo = !donna && eta >= 45 && r() < 0.3;
  const stile = donna ? scegli(["lunghi", "caschetto", "raccolti"]) : scegli(["corti", "riga", "rasati"]);
  const ombra = "rgba(0,0,0,0.12)";

  const parti: string[] = [];
  parti.push(`<rect width="128" height="128" rx="20" fill="${sfondo}"/>`);
  /* capelli lunghi: dietro la testa */
  if (donna && stile === "lunghi") {
    parti.push(`<path d="M34 58 Q32 30 64 26 Q96 30 94 58 L98 104 Q64 112 30 104 Z" fill="${capelli}"/>`);
  }
  /* busto: giacca, camicia, colletto */
  parti.push(`<path d="M14 128 Q16 98 46 92 L64 100 L82 92 Q112 98 114 128 Z" fill="${GIACCA}"/>`);
  parti.push(`<path d="M50 92 L64 116 L78 92 L72 90 L64 102 L56 90 Z" fill="${CAMICIA}"/>`);
  parti.push(`<path d="M61 102 L64 122 L67 102 L64 99 Z" fill="#1b2f55"/>`);
  parti.push(`<rect x="86" y="104" width="12" height="7" rx="1.5" fill="#d9b44a"/>`);
  /* collo e testa */
  parti.push(`<path d="M54 76 L54 94 Q64 100 74 94 L74 76 Z" fill="${pelle}"/>`);
  parti.push(`<path d="M54 88 Q64 94 74 88 L74 92 Q64 98 54 92 Z" fill="${ombra}"/>`);
  parti.push(`<ellipse cx="41" cy="58" rx="5" ry="7" fill="${pelle}"/><ellipse cx="87" cy="58" rx="5" ry="7" fill="${pelle}"/>`);
  parti.push(`<ellipse cx="64" cy="56" rx="23" ry="27" fill="${pelle}"/>`);
  /* capelli sopra */
  if (donna) {
    if (stile === "caschetto") parti.push(`<path d="M39 60 Q36 28 64 27 Q92 28 89 60 L90 74 Q86 64 84 46 Q64 40 44 46 Q42 64 38 74 Z" fill="${capelli}"/>`);
    else if (stile === "raccolti") {
      parti.push(`<path d="M41 52 Q42 28 64 28 Q86 28 87 52 Q80 38 64 37 Q48 38 41 52 Z" fill="${capelli}"/>`);
      parti.push(`<circle cx="64" cy="24" r="9" fill="${capelli}"/>`);
    } else parti.push(`<path d="M40 56 Q40 28 64 28 Q88 28 88 56 Q84 40 64 38 Q50 40 44 50 Z" fill="${capelli}"/>`);
  } else if (calvo) {
    parti.push(`<path d="M41 54 Q42 44 46 42 L46 56 Z M87 54 Q86 44 82 42 L82 56 Z" fill="${capelli}"/>`);
  } else if (stile === "riga") {
    parti.push(`<path d="M41 52 Q40 30 62 29 Q88 28 88 52 Q86 40 72 37 L58 40 Q46 42 41 52 Z" fill="${capelli}"/>`);
  } else if (stile === "rasati") {
    parti.push(`<path d="M42 50 Q44 31 64 30 Q84 31 86 50 Q80 39 64 38 Q48 39 42 50 Z" fill="${capelli}" opacity="0.85"/>`);
  } else {
    parti.push(`<path d="M41 52 Q41 29 64 29 Q87 29 87 52 Q84 41 76 39 Q66 34 56 38 Q46 40 41 52 Z" fill="${capelli}"/>`);
  }
  /* sopracciglia, occhi, naso, bocca */
  parti.push(`<path d="M50 49 Q55 46 59 49 M69 49 Q73 46 78 49" stroke="${grigi ? "#7d7d7d" : capelli}" stroke-width="2.4" fill="none" stroke-linecap="round"/>`);
  parti.push(`<ellipse cx="55" cy="56" rx="2.6" ry="3" fill="#2b2b2b"/><ellipse cx="73" cy="56" rx="2.6" ry="3" fill="#2b2b2b"/>`);
  parti.push(`<path d="M64 58 Q61 66 64 67" stroke="${ombra}" stroke-width="2" fill="none" stroke-linecap="round"/>`);
  if (barba) {
    parti.push(`<path d="M42 60 Q44 84 64 86 Q84 84 86 60 Q82 74 74 74 Q64 70 54 74 Q46 74 42 60 Z" fill="${capelli}" opacity="0.92"/>`);
  }
  if (baffi) parti.push(`<path d="M55 71 Q64 66 73 71 Q64 70 55 71 Z" fill="${capelli}"/>`);
  parti.push(`<path d="M57 74 Q64 ${barba ? 77 : 79} 71 74" stroke="#8a4b3b" stroke-width="2.2" fill="none" stroke-linecap="round"/>`);
  if (occhiali) {
    parti.push(`<g fill="none" stroke="#2a2f3a" stroke-width="2"><rect x="46" y="50" width="16" height="12" rx="4"/><rect x="66" y="50" width="16" height="12" rx="4"/><path d="M62 55 L66 55 M46 55 L41 53 M82 55 L87 53"/></g>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">${parti.join("")}</svg>`;
}

/** Il ritratto come data-URI, pronto per photo_url. */
export function ritrattoDataUri(o: OpzioniRitratto): string {
  return `data:image/svg+xml;base64,${Buffer.from(ritrattoSvg(o), "utf8").toString("base64")}`;
}
