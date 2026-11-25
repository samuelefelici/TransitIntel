/**
 * La vista 3D della rete di Argos: un cervello-nebulosa in cui la telecamera
 * vola mentre la rete lavora.
 *
 * Non ha una regia sua: legge a ogni fotogramma lo stato della scena dal
 * motore 2D (Sciame.vista3d(), che intanto non disegna) e lo porta in tre
 * dimensioni:
 *   - le particelle del campo diventano un cervello (due emisferi, la
 *     scissura in mezzo, le circonvoluzioni): le categorie della biblioteca
 *     sono zone del cervello, i documenti ammassi di luce;
 *   - gli strumenti («dati reali · cerbero») sono il tronco encefalico;
 *   - la rete è un corpo luminoso con le sue fibre, che si sposta dove sta
 *     leggendo; i fasci verso i passaggi hanno impulsi che li percorrono, i
 *     ponti attraversano il cervello, i concetti brillano attorno;
 *   - in sovrimpressione (canvas 2D) i nomi delle zone, le pillole dei
 *     passaggi e le parole che volano verso la chat.
 * Quando la rete lavora la telecamera entra nella nebulosa e segue la zona
 * attiva; a riposo gira piano attorno al cervello. Col mouse si gira a mano
 * (per qualche secondo la telecamera automatica si ferma).
 *
 * three.js è già una dipendenza dell'app (Planning Studio, SpaceTimeCube) e
 * questo modulo si carica solo quando si sceglie la vista 3D.
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Id, Sciame, StilePillola, Vista3D } from "./argos-sciame";

type V3 = [number, number, number];
type RGBA = [number, number, number, number];

const TAU = Math.PI * 2;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const ease = (t: number) => { t = clamp(t, 0, 1); return 1 - Math.pow(1 - t, 3); };
/** un numero fra 0 e 1 stabile per ogni indice (niente Math.random: la forma non deve cambiare a ogni ricostruzione) */
export function caso(i: number, sale: number): number {
  let h = (Math.imul(i + 1, 2654435761) ^ Math.imul(sale + 7, 1597334677)) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0; h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}
/** "#rrggbb", "rgb(...)" o "rgba(...)" → [r, g, b, a] in 0..1 */
const CACHE_COLORI = new Map<string, RGBA>();
export function rgba(c: string): RGBA {
  const k = CACHE_COLORI.get(c);
  if (k) return k;
  let out: RGBA = [1, 1, 1, 1];
  const s = c.trim();
  if (s.startsWith("#")) {
    const h = s.slice(1);
    const full = h.length === 3 ? h.split("").map(x => x + x).join("") : h;
    out = [parseInt(full.slice(0, 2), 16) / 255, parseInt(full.slice(2, 4), 16) / 255, parseInt(full.slice(4, 6), 16) / 255, 1];
  } else {
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const p = m[1]!.split(",").map(x => parseFloat(x));
      out = [(p[0] ?? 255) / 255, (p[1] ?? 255) / 255, (p[2] ?? 255) / 255, p[3] ?? 1];
    }
  }
  if (CACHE_COLORI.size > 400) CACHE_COLORI.clear();
  CACHE_COLORI.set(c, out);
  return out;
}

/**
 * La sagoma: due emisferi (ellissoidi più lunghi che larghi, il davanti verso
 * +Z), la scissura in mezzo, la base schiacciata; sotto, dietro, il cervelletto
 * e il tronco.
 */
const EMISFERO = { cx: 0.62, rx: 0.6, ry: 0.92, rz: 1.45 };

/** dove sta, sul cervello, un punto del campo 2D (u, v in circa -1..1; a, b fra 0 e 1, per la profondità) */
export function suCervello(u: number, v: number, a: number, b: number): V3 {
  const x0 = clamp(u * 0.95, -0.98, 0.98), y0 = clamp(-v * 0.95, -0.98, 0.98), lato = x0 >= 0 ? 1 : -1;
  // la metà sinistra del campo è l'emisfero sinistro: dal bordo del campo (laterale) al centro (la scissura)
  let lx = 2 * Math.abs(x0) - 1, ly = y0;
  const r = Math.hypot(lx, ly);
  if (r > 0.97) { lx *= 0.97 / r; ly *= 0.97 / r; }
  // un po' di profondità anche sul bordo: le zone vicine alla scissura non si schiacciano in un foglio
  const zmax = Math.sqrt(Math.max(0.12, 1 - lx * lx - ly * ly)), s = 2 * a - 1;
  // in profondità: più fitto verso la corteccia, ma pieno anche dentro (una nebulosa, non un guscio)
  const lz = Math.sign(s) * Math.pow(Math.abs(s), 0.6) * zmax * (0.92 + 0.08 * b);
  const E = EMISFERO;
  const X = lato * (E.cx + lx * E.rx * 0.95);
  let Y = ly * E.ry;
  const Z = lz * E.rz;
  if (Y < -0.55) Y = -0.55 + (Y + 0.55) * 0.55;
  return [X, Y, Z];
}
/** il tronco encefalico, dove stanno gli strumenti (i dati veri di Cerbero) */
export function suTronco(a: number, b: number, c: number): V3 {
  const t = a;
  return [(b - 0.5) * 0.28 * (1 - t * 0.4), -0.72 - t * 0.75, -0.25 + (c - 0.5) * 0.26];
}

/**
 * La corteccia: punti sulla superficie dei due emisferi e del cervelletto, più
 * accesi sulle circonvoluzioni e più spenti (e un po' più dentro) nei solchi.
 * Restituisce posizioni e luminosità (0..1), sempre le stesse.
 */
export function corteccia(n: number): { pos: Float32Array; luce: Float32Array } {
  const pos = new Float32Array(n * 3), luce = new Float32Array(n);
  const nCer = Math.round(n * 0.14), E = EMISFERO;
  for (let i = 0; i < n; i++) {
    // una direzione a caso, uniforme sulla sfera
    const zz = 2 * caso(i, 11) - 1, th = TAU * caso(i, 12), rr = Math.sqrt(1 - zz * zz);
    let dx = rr * Math.cos(th), dy = rr * Math.sin(th), dz = zz;
    let X: number, Y: number, Z: number, piega: number;
    if (i < nCer) {
      // il cervelletto: dietro e sotto, a lamelle orizzontali fitte
      X = dx * 0.78; Y = -0.62 + dy * 0.3; Z = -0.95 + dz * 0.42;
      piega = Math.abs(Math.sin(Y * 46 + 1.3 * Math.sin(X * 4)));
    } else {
      const lato = caso(i, 13) < 0.5 ? -1 : 1;
      // la parete di dentro è piatta: è la scissura fra i due emisferi
      if (dx * lato < 0) dx *= 0.18;
      if (dy < -0.6) dy = -0.6 + (dy + 0.6) * 0.5;
      // il lobo frontale più alto, l'occipitale più basso
      dy += 0.08 * dz;
      X = lato * E.cx + dx * E.rx; Y = dy * E.ry; Z = dz * E.rz;
      const w = Math.sin(7.5 * Z + 2.6 * Math.sin(5.2 * Y + lato) + 1.8 * Math.sin(4 * X)) + 0.7 * Math.sin(9.5 * Y - 2.2 * Z + 3 * X);
      piega = 1 - Math.min(1, Math.abs(w) / 1.2);
    }
    // nei solchi la superficie rientra un poco
    const dentro = 1 - 0.05 * (1 - piega);
    const cxs = i < nCer ? 0 : X > 0 ? E.cx : -E.cx, cys = i < nCer ? -0.62 : 0, czs = i < nCer ? -0.95 : 0;
    X = cxs + (X - cxs) * dentro; Y = cys + (Y - cys) * dentro; Z = czs + (Z - czs) * dentro;
    pos[i * 3] = X; pos[i * 3 + 1] = Y; pos[i * 3 + 2] = Z;
    luce[i] = Math.pow(piega, 2.2);
  }
  return { pos, luce };
}

const VERT = `
attribute float size;
attribute float alpha;
attribute float phase;
attribute vec3 tinta;
uniform float time;
uniform float scale;
uniform float near;
uniform float far;
uniform float twinkle;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = -mv.z;
  vColor = tinta;
  float tw = mix(1.0, 0.55 + 0.45 * sin(time * (0.6 + fract(phase * 7.13) * 1.8) + phase * 6.2831), twinkle);
  float fog = clamp(1.0 - (d - near) / (far - near), 0.0, 1.0);
  vAlpha = alpha * tw * (0.22 + 0.78 * fog);
  gl_PointSize = size * scale / max(d, 0.08);
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c);
  if (r > 0.5) discard;
  float a = smoothstep(0.5, 0.0, r);
  gl_FragColor = vec4(vColor, vAlpha * a * a);
}`;

/** un insieme di punti con colore, misura e trasparenza per punto */
class Punti {
  readonly geo = new THREE.BufferGeometry();
  readonly mat: THREE.ShaderMaterial;
  readonly obj: THREE.Points;
  pos: Float32Array; col: Float32Array; size: Float32Array; alpha: Float32Array; phase: Float32Array;
  constructor(readonly cap: number, twinkle: number) {
    this.pos = new Float32Array(cap * 3); this.col = new Float32Array(cap * 3);
    this.size = new Float32Array(cap); this.alpha = new Float32Array(cap); this.phase = new Float32Array(cap);
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute("tinta", new THREE.BufferAttribute(this.col, 3));
    this.geo.setAttribute("size", new THREE.BufferAttribute(this.size, 1));
    this.geo.setAttribute("alpha", new THREE.BufferAttribute(this.alpha, 1));
    this.geo.setAttribute("phase", new THREE.BufferAttribute(this.phase, 1));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false,
      uniforms: { time: { value: 0 }, scale: { value: 300 }, near: { value: 0.5 }, far: { value: 7 }, twinkle: { value: twinkle } },
    });
    this.obj = new THREE.Points(this.geo, this.mat);
    this.obj.frustumCulled = false;
  }
  usa(n: number): void {
    this.geo.setDrawRange(0, n);
    for (const k of ["position", "tinta", "size", "alpha", "phase"]) (this.geo.getAttribute(k) as THREE.BufferAttribute).needsUpdate = true;
  }
  metti(i: number, p: V3, c: RGBA, size: number, alpha: number, phase = 0): void {
    this.pos[i * 3] = p[0]; this.pos[i * 3 + 1] = p[1]; this.pos[i * 3 + 2] = p[2];
    this.col[i * 3] = c[0]; this.col[i * 3 + 1] = c[1]; this.col[i * 3 + 2] = c[2];
    this.size[i] = size; this.alpha[i] = alpha * c[3]; this.phase[i] = phase;
  }
  dispose(): void { this.geo.dispose(); this.mat.dispose(); }
}

/** segmenti di linea con colore e trasparenza per vertice, riscritti a ogni fotogramma */
class Linee {
  readonly geo = new THREE.BufferGeometry();
  readonly mat: THREE.LineBasicMaterial;
  readonly obj: THREE.LineSegments;
  pos: Float32Array; col: Float32Array; n = 0;
  constructor(readonly cap: number) {
    this.pos = new Float32Array(cap * 6); this.col = new Float32Array(cap * 8);
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute("color", new THREE.BufferAttribute(this.col, 4));
    this.mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false });
    this.obj = new THREE.LineSegments(this.geo, this.mat);
    this.obj.frustumCulled = false;
  }
  inizio(): void { this.n = 0; }
  seg(a: V3, b: V3, c: RGBA, alfaA: number, alfaB = alfaA): void {
    if (this.n >= this.cap) return;
    const i = this.n++, p = this.pos, q = this.col;
    p[i * 6] = a[0]; p[i * 6 + 1] = a[1]; p[i * 6 + 2] = a[2]; p[i * 6 + 3] = b[0]; p[i * 6 + 4] = b[1]; p[i * 6 + 5] = b[2];
    q[i * 8] = c[0]; q[i * 8 + 1] = c[1]; q[i * 8 + 2] = c[2]; q[i * 8 + 3] = c[3] * alfaA;
    q[i * 8 + 4] = c[0]; q[i * 8 + 5] = c[1]; q[i * 8 + 6] = c[2]; q[i * 8 + 7] = c[3] * alfaB;
  }
  fine(): void {
    this.geo.setDrawRange(0, this.n * 2);
    (this.geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
  }
  dispose(): void { this.geo.dispose(); this.mat.dispose(); }
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const quad = (p0: V3, c: V3, p1: V3, t: number): V3 => {
  const u = 1 - t;
  return [u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1], u * u * p0[2] + 2 * u * t * c[2] + t * t * p1[2]];
};

/**
 * Lo sguardo di chi guarda (tappa 7.37, la pagina di accesso): la telecamera
 * gira attorno al suo bersaglio di sx (−1…1, verso destra) in orizzontale e
 * sale o scende di sy (−1…1, verso il basso). A sguardo fermo (0, 0) la
 * posizione non cambia: la console non se ne accorge.
 */
export function ruotaSguardo(pos: V3, tgt: V3, sx: number, sy: number): V3 {
  const d = sub(pos, tgt), l = len(d);
  if (l < 1e-6 || (sx === 0 && sy === 0)) return pos;
  const a = clamp(sx, -1, 1) * 0.55, c = Math.cos(a), s = Math.sin(a);
  const r: V3 = [d[0] * c + d[2] * s, d[1], -d[0] * s + d[2] * c];
  r[1] += clamp(sy, -1, 1) * -0.35 * l;
  return add(tgt, mul(norm(r), l));
}

export interface OpzioniCervello {
  chiaro: boolean;
  /** la vista 3D si è fermata da sola: un errore nel disegno, o troppo lenta su questa macchina. Si torna al 2D. */
  onGuasto?: (perche: "errore" | "lento") => void;
}

export class Cervello3D {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(58, 1, 0.02, 40);
  private readonly controls: OrbitControls;
  private readonly sopra: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly ridotto: boolean;
  private chiaro: boolean;
  // il cervello
  private campo: Punti | null = null;
  private maglia: THREE.LineSegments | null = null;
  private corteccia: Punti | null = null;
  private nubi: Punti | null = null;
  private stelle: Punti | null = null;
  private pos3: Float32Array = new Float32Array(0);
  private centri: Array<{ name: string; col: string; p: V3 }> = [];
  private versione = -1;
  // le cose che si muovono
  private readonly accesi = new Punti(400, 0);
  private readonly impulsi = new Punti(700, 0);
  private readonly linee = new Linee(9000);
  // la rete
  private A: V3 = [0, 0.05, 0];
  private camPos: V3 = [0, 0.6, 3.05];
  private camTarget: V3 = [0, 0, 0];
  private giro = 0;
  private manoFinoA = 0;
  private raf = 0;
  private last = performance.now();
  private morto = false;
  private W = 1; private H = 1; private DPR = 1;
  /**
   * La qualità si adatta alla macchina: se i fotogrammi calano si disegna a
   * risoluzione più bassa (1 → 0,75 → 0,5); se resta troppo lento anche così
   * (senza scheda video, WebGL fatto dal processore) si torna al 2D.
   */
  private qualita = 1;
  private nFoto = 0; private sFoto = 0; private lenti = 0;
  /** lo sguardo voluto (dal puntatore) e quello di adesso, che lo segue piano */
  private sguardo = { x: 0, y: 0 };
  private sguardoOra = { x: 0, y: 0 };

  private readonly onGuasto: OpzioniCervello["onGuasto"];

  constructor(private readonly box: HTMLElement, private readonly sciame: Sciame, o: OpzioniCervello) {
    this.chiaro = o.chiaro;
    this.onGuasto = o.onGuasto;
    this.ridotto = !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    const gl = this.renderer.domElement;
    gl.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;";
    gl.setAttribute("aria-hidden", "true");
    box.appendChild(gl);
    this.sopra = document.createElement("canvas");
    this.sopra.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;";
    this.sopra.setAttribute("aria-hidden", "true");
    box.appendChild(this.sopra);
    const ctx = this.sopra.getContext("2d");
    if (!ctx) throw new Error("canvas 2D non disponibile");
    this.ctx = ctx;
    this.controls = new OrbitControls(this.camera, gl);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.4;
    this.controls.maxDistance = 7;
    this.controls.enablePan = false;
    // chi gira il cervello a mano lo guida per qualche secondo
    this.controls.addEventListener("start", () => { this.manoFinoA = performance.now() + 7000; });
    this.controls.addEventListener("change", () => { if (performance.now() < this.manoFinoA) this.manoFinoA = Math.max(this.manoFinoA, performance.now() + 4000); });
    for (const x of [this.accesi, this.impulsi]) this.scene.add(x.obj);
    this.scene.add(this.linee.obj);
    this.impostaTema(o.chiaro, true);
    this.ridimensiona();
    this.raf = requestAnimationFrame(this.frame);
  }

  /** La telecamera segue di poco il puntatore: x e y fra −1 e 1 (0, 0 = ferma). */
  impostaSguardo(x: number, y: number): void {
    this.sguardo = { x: clamp(x, -1, 1), y: clamp(y, -1, 1) };
  }

  impostaTema(chiaro: boolean, forza = false): void {
    if (chiaro === this.chiaro && !forza) return;
    this.chiaro = chiaro;
    const v = this.sciame.vista3d();
    this.renderer.setClearColor(new THREE.Color(v.tavolozza.fondo), 1);
    const blend = chiaro ? THREE.NormalBlending : THREE.AdditiveBlending;
    for (const m of [this.accesi.mat, this.impulsi.mat, this.linee.mat]) { m.blending = blend; m.needsUpdate = true; }
    this.versione = -1; // i colori del campo vengono dalla tavolozza: si ricostruisce
  }

  ridimensiona(): void {
    const r = this.box.getBoundingClientRect();
    this.W = Math.max(1, Math.round(r.width)); this.H = Math.max(1, Math.round(r.height));
    this.DPR = Math.min(window.devicePixelRatio || 1, 2);
    const pr = this.DPR * this.qualita;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(this.W, this.H, false);
    this.sopra.width = Math.round(this.W * this.DPR); this.sopra.height = Math.round(this.H * this.DPR);
    this.camera.aspect = this.W / this.H;
    this.camera.updateProjectionMatrix();
    const scala = this.H * pr * 0.5 / Math.tan((this.camera.fov * Math.PI) / 360);
    for (const p of this.strati()) p.mat.uniforms.scale!.value = scala * 0.0045;
  }

  distruggi(): void {
    if (this.morto) return;
    this.morto = true;
    cancelAnimationFrame(this.raf);
    this.controls.dispose();
    for (const p of [this.campo, this.corteccia, this.nubi, this.stelle]) p?.dispose();
    if (this.maglia) { this.maglia.geometry.dispose(); (this.maglia.material as THREE.Material).dispose(); }
    this.accesi.dispose(); this.impulsi.dispose(); this.linee.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.sopra.remove();
  }

  private strati(): Punti[] {
    return [this.stelle, this.corteccia, this.nubi, this.campo, this.accesi, this.impulsi].filter((p): p is Punti => !!p);
  }
  private togli(p: Punti | null): void { if (p) { this.scene.remove(p.obj); p.dispose(); } }

  // ─── il cervello, dal campo 2D ───────────────────────────────────────────
  private costruisci(v: Vista3D): void {
    this.versione = v.versione;
    const fondo = this.chiaro ? THREE.NormalBlending : THREE.AdditiveBlending;
    for (const p of [this.campo, this.corteccia, this.nubi, this.stelle]) this.togli(p);
    this.campo = this.corteccia = this.nubi = this.stelle = null;
    // la corteccia: la sagoma del cervello, con le sue pieghe
    const nc = this.ridotto ? 4200 : 6500, C = corteccia(nc), cort = new Punti(nc, 0.35);
    const cc1 = rgba(this.chiaro ? "#475569" : "#a5b4fc"), cc2 = rgba(this.chiaro ? "#7c3aed" : "#c4b5fd");
    for (let i = 0; i < nc; i++) {
      const l = C.luce[i]!, p: V3 = [C.pos[i * 3]!, C.pos[i * 3 + 1]!, C.pos[i * 3 + 2]!];
      cort.metti(i, p, caso(i, 21) < 0.8 ? cc1 : cc2, 1.8 + l * 2.2, (this.chiaro ? 0.1 : 0.1) + l * (this.chiaro ? 0.4 : 0.6), caso(i, 22));
    }
    cort.usa(nc); cort.mat.blending = fondo;
    this.corteccia = cort; this.scene.add(cort.obj);
    // le stelle di fondo, solo al buio
    if (v.tavolozza.stelle) {
      const ns = 900, st = new Punti(ns, 1), sc = rgba(v.tavolozza.stelle);
      for (let i = 0; i < ns; i++) {
        const zz = 2 * caso(i, 31) - 1, th = TAU * caso(i, 32), rr = Math.sqrt(1 - zz * zz), R = 9 + 6 * caso(i, 33);
        st.metti(i, [rr * Math.cos(th) * R, zz * R, rr * Math.sin(th) * R], sc, 6 + 10 * caso(i, 34), 0.25 + 0.6 * caso(i, 35), caso(i, 36));
      }
      st.usa(ns); st.mat.blending = THREE.AdditiveBlending;
      this.stelle = st; this.scene.add(st.obj);
    }
    if (this.maglia) { this.scene.remove(this.maglia); this.maglia.geometry.dispose(); (this.maglia.material as THREE.Material).dispose(); }
    const n = v.n, P = v.tavolozza, hw = Math.max(1, v.palco.w / 2), hh = Math.max(1, v.palco.h / 2);
    const gruppo = new Int32Array(n);
    v.gruppi.forEach((idx, g) => { for (let k = 0; k < idx.length; k++) gruppo[idx[k]!] = g; });
    this.pos3 = new Float32Array(n * 3);
    const campo = new Punti(Math.max(1, n), 1);
    const colori = v.colori.map(c => rgba(c));
    for (let i = 0; i < n; i++) {
      const g = gruppo[i]!, cer = g === v.gruppoCerbero;
      const p = cer ? suTronco(caso(i, 1), caso(i, 2), caso(i, 3)) : suCervello((v.px[i]! - v.palco.cx) / hw, (v.py[i]! - v.palco.cy) / hh, caso(i, 4), caso(i, 5));
      this.pos3[i * 3] = p[0]; this.pos3[i * 3 + 1] = p[1]; this.pos3[i * 3 + 2] = p[2];
      const c = colori[g] ?? [1, 1, 1, 1];
      const tinta = g >= 2 && !cer;
      campo.metti(i, p, c, (tinta ? 3.6 : 2.2) + v.ps[i]! * 1.3, clamp(v.pa[i]! * (cer ? 0.5 : tinta ? (this.chiaro ? 1 : 0.95) : 0.55), 0, 1), v.ph[i]! / TAU);
    }
    campo.usa(n);
    campo.mat.blending = this.chiaro ? THREE.NormalBlending : THREE.AdditiveBlending;
    this.campo = campo;
    this.scene.add(campo.obj);
    // la maglia fra particelle vicine: i collegamenti della rete, tenui; solo
    // fra le vicine anche in profondità (vicine nel piano non basta: farebbero strisce)
    const E = v.maglia, tutte = E.length / 2, buone: number[] = [];
    for (let k = 0; k < tutte && buone.length < 4000; k++) {
      const a = E[k * 2]!, b = E[k * 2 + 1]!;
      if (a >= n || b >= n) continue;
      const d = Math.hypot(this.pos3[a * 3]! - this.pos3[b * 3]!, this.pos3[a * 3 + 1]! - this.pos3[b * 3 + 1]!, this.pos3[a * 3 + 2]! - this.pos3[b * 3 + 2]!);
      if (d < 0.13) buone.push(a, b);
    }
    const m = buone.length / 2, lp = new Float32Array(m * 6);
    for (let k = 0; k < m; k++) {
      const a = buone[k * 2]!, b = buone[k * 2 + 1]!;
      lp.set([this.pos3[a * 3]!, this.pos3[a * 3 + 1]!, this.pos3[a * 3 + 2]!, this.pos3[b * 3]!, this.pos3[b * 3 + 1]!, this.pos3[b * 3 + 2]!], k * 6);
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position", new THREE.BufferAttribute(lp, 3));
    const mc = rgba(P.maglia);
    const lm = new THREE.LineBasicMaterial({
      color: new THREE.Color(mc[0], mc[1], mc[2]), transparent: true, depthWrite: false,
      opacity: this.chiaro ? 0.18 : 0.11, blending: fondo,
    });
    this.maglia = new THREE.LineSegments(lg, lm);
    this.maglia.frustumCulled = false;
    this.scene.add(this.maglia);
    // il centro di ogni zona, per il suo nome
    this.centri = v.nebulose.filter(c => c.name).map(cl => {
      let x = 0, y = 0, z = 0, k = 0;
      for (let i = cl.s; i < cl.e; i++) { x += this.pos3[i * 3]!; y += this.pos3[i * 3 + 1]!; z += this.pos3[i * 3 + 2]!; k++; }
      return { name: cl.name, col: cl.col, p: (k ? [x / k, y / k, z / k] : [0, 0, 0]) as V3 };
    });
    // le nubi: ogni zona del cervello ha il suo bagliore, del colore della sua categoria
    const nn = this.centri.length * 5, nubi = new Punti(Math.max(1, nn), 0.25);
    this.centri.forEach((c, j) => {
      const col = rgba(c.col);
      for (let q = 0; q < 5; q++) {
        const o: V3 = q === 0 ? [0, 0, 0] : [(caso(j * 5 + q, 41) - 0.5) * 0.5, (caso(j * 5 + q, 42) - 0.5) * 0.4, (caso(j * 5 + q, 43) - 0.5) * 0.6];
        nubi.metti(j * 5 + q, add(c.p, o), col, q === 0 ? 260 : 150 + 90 * caso(j * 5 + q, 44), this.chiaro ? 0.07 : 0.1, caso(j, 45));
      }
    });
    nubi.usa(nn); nubi.mat.blending = fondo;
    this.nubi = nubi; this.scene.add(nubi.obj);
    this.ridimensiona();
  }
  private particella(i: number): V3 { return [this.pos3[i * 3]!, this.pos3[i * 3 + 1]!, this.pos3[i * 3 + 2]!]; }
  private passaggio(v: Vista3D, id: Id | null | undefined): V3 | null {
    if (id == null) return null;
    const j = v.passaggioParticella.get(id);
    return j == null || j >= v.n ? null : this.particella(j);
  }

  // ─── il ciclo ────────────────────────────────────────────────────────────
  private readonly frame = (now: number): void => {
    if (this.morto) return;
    this.raf = requestAnimationFrame(this.frame);
    if (document.hidden || this.W < 4 || this.H < 4) { this.last = now; return; }
    const crudo = (now - this.last) / 1000, dt = Math.min(0.1, crudo);
    this.last = now;
    try {
      const v = this.sciame.vista3d();
      if (v.versione !== this.versione) { this.costruisci(v); this.nFoto = this.sFoto = 0; }
      else if (crudo < 0.5) { this.sFoto += crudo; if (++this.nFoto >= 45) this.valuta(); }
      this.passo(v, dt, now);
      this.renderer.render(this.scene, this.camera);
      this.sovrimpressione(v);
    } catch (e) {
      console.warn("cervello 3D: fermo", e);
      this.distruggi();
      try { this.onGuasto?.("errore"); } catch { /* chi ascolta non rompe il ciclo */ }
    }
  };

  /** ogni 45 fotogrammi: quanti al secondo? */
  private valuta(): void {
    const fps = this.nFoto / Math.max(1e-3, this.sFoto);
    this.nFoto = this.sFoto = 0;
    if (fps < 24 && this.qualita > 0.5) { this.qualita = Math.max(0.5, this.qualita - 0.25); this.ridimensiona(); return; }
    if (fps < 12) {
      if (++this.lenti < 2) return;
      console.info("cervello 3D: troppo lento su questa macchina, torno alla rete in piano");
      this.distruggi();
      try { this.onGuasto?.("lento"); } catch { /* chi ascolta non rompe il ciclo */ }
      return;
    }
    this.lenti = 0;
  }

  private passo(v: Vista3D, dt: number, now: number): void {
    const P = v.tavolozza, t = v.tempo;
    for (const p of this.strati()) p.mat.uniforms.time!.value = t;
    // dove va la rete: il centro dei passaggi che sta leggendo, o in mezzo al cervello
    const ids = v.fase >= 3 && v.contesto.length ? v.contesto : v.fuoco ?? [];
    let meta: V3 = [0, 0.05, 0], k = 0;
    const somma: V3 = [0, 0, 0];
    for (const id of ids) { const p = this.passaggio(v, id); if (p) { somma[0] += p[0]; somma[1] += p[1]; somma[2] += p[2]; k++; } }
    if (k) meta = mul(somma, 1 / k);
    if (v.finito || !v.inCorso && !k) meta = [0, 0.05, 0];
    meta = add(meta, [Math.sin(t * 0.23) * 0.05, Math.cos(t * 0.31) * 0.04, Math.sin(t * 0.17) * 0.05]);
    const sa = 1 - Math.exp(-dt * (this.ridotto ? 0.8 : 1.6));
    this.A = add(this.A, mul(sub(meta, this.A), sa));
    // la telecamera: dentro la nebulosa mentre lavora, attorno al cervello a riposo
    const lavora = v.inCorso || (!v.finito && v.fase >= 1);
    this.giro += dt * (this.ridotto ? 0.03 : lavora ? 0.1 : 0.07);
    if (now > this.manoFinoA) {
      let pos: V3, tgt: V3;
      if (lavora) {
        const dir = norm([Math.sin(this.giro), 0.28 + 0.12 * Math.sin(this.giro * 0.7), Math.cos(this.giro)]);
        pos = add(this.A, mul(dir, 1.05));
        tgt = this.A;
      } else {
        pos = [Math.sin(this.giro) * 3.05, 0.6 + 0.3 * Math.sin(this.giro * 0.6), Math.cos(this.giro) * 3.05];
        tgt = [0, -0.05, 0];
      }
      const sg = 1 - Math.exp(-dt * (this.ridotto ? 0.6 : 2.2));
      this.sguardoOra.x += (this.sguardo.x - this.sguardoOra.x) * sg;
      this.sguardoOra.y += (this.sguardo.y - this.sguardoOra.y) * sg;
      pos = ruotaSguardo(pos, tgt, this.sguardoOra.x, this.sguardoOra.y);
      const sc = 1 - Math.exp(-dt * (lavora ? 0.9 : 0.6));
      this.camPos = add(this.camPos, mul(sub(pos, this.camPos), sc));
      this.camTarget = add(this.camTarget, mul(sub(tgt, this.camTarget), sc));
      this.camera.position.set(...this.camPos);
      this.controls.target.set(...this.camTarget);
    } else {
      this.camPos = [this.camera.position.x, this.camera.position.y, this.camera.position.z];
      this.camTarget = [this.controls.target.x, this.controls.target.y, this.controls.target.z];
    }
    this.controls.update();

    // ─ le cose accese ─
    const L = this.linee, acc = this.accesi, imp = this.impulsi;
    L.inizio();
    let na = 0, ni = 0;
    const metti = (p: V3, c: RGBA, size: number, alpha: number) => { if (na < acc.cap) acc.metti(na++, p, c, size, alpha); };
    const impulso = (p: V3, c: RGBA, size: number, alpha: number) => { if (ni < imp.cap) imp.metti(ni++, p, c, size, alpha); };
    const A = this.A, ex = v.eccitazione;
    // il corpo della rete: un nucleo luminoso con le sue fibre
    const teal = rgba(P.teal), rosa: RGBA = [1, 0.24, 0.55, 1], viola = rgba(P.auraFuori);
    metti(A, teal, 70, this.chiaro ? 0.35 : 0.45);
    metti(A, viola, 150, this.chiaro ? 0.12 : 0.16);
    metti(A, rosa, 26 + 3 * Math.sin(t * 3.1), 0.95);
    metti(A, [1, 1, 1, 1], 9, this.chiaro ? 0.6 : 1);
    const fibre = this.ridotto ? 8 : 14, fc = rgba(P.zampe[1]), fd = rgba(P.zampe[3]);
    for (let f = 0; f < fibre; f++) {
      const az = (f / fibre) * TAU + t * 0.05, el = Math.sin(f * 2.4) * 0.9;
      const dir = norm([Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)]);
      const lun = (0.22 + 0.08 * Math.sin(f * 1.7 + t * 0.8)) * ex;
      const lato = norm(cross(dir, [0, 1, 0.001]));
      let prima: V3 = add(A, mul(dir, 0.03));
      for (let s = 1; s <= 8; s++) {
        const u = s / 8, ond = Math.sin(u * Math.PI * 2.2 - t * 2.4 + f) * 0.025 * Math.sin(Math.PI * u);
        const q = add(add(A, mul(dir, 0.03 + lun * u)), mul(lato, ond));
        L.seg(prima, q, u < 0.5 ? fc : fd, 0.9 - u * 0.6, 0.9 - (u + 0.125) * 0.6);
        prima = q;
      }
      metti(prima, rgba(P.piedi), 5, 0.8);
    }
    // i termini della domanda, attorno al nucleo
    if (v.termini.length && v.terminiSfumano == null) {
      const tc = rgba(P.tcol.term ?? "#a78bfa");
      v.termini.forEach((term, i) => {
        const g = ease((v.orologio - term.born) / 300);
        if (g <= 0) return;
        const az = (i / v.termini.length) * TAU;
        const p = add(A, mul([Math.cos(az), 0.25 * Math.sin(az * 2), Math.sin(az)], 0.32 * g));
        L.seg(A, p, tc, 0.7, 0.4);
        metti(p, tc, 7, 0.9);
      });
    }
    // i passaggi: un punto per stato, che si accende quando viene letto
    for (const [id, st] of v.passaggi) {
      const p = this.passaggio(v, id);
      if (!p) continue;
      let c = rgba(P.letto), s = 9, a = 0.95;
      if (st.st === "kept" || st.st === "ctx") { c = rgba(P.teal); s = 12; }
      else if (st.st === "bridge") { c = rgba(P.giallo); s = 12; }
      else if (st.st === "dup") c = rgba(P.ambra);
      else if (st.st === "dropped" || st.st === "below") { c = rgba(P.spento); s = 7; a = 0.5; }
      metti(p, c, s, a);
      if (st.glow > 0.02) metti(p, st.st === "seen" ? rgba(P.bagliorLetto) : c, 22 + st.glow * 40, st.glow * 0.5);
    }
    // i fasci verso i passaggi (e gli strumenti), con gli impulsi che li percorrono
    for (const T of v.tentacoli) {
      let dst: V3 | null = null;
      if (T.tg.chunk != null) dst = this.passaggio(v, T.tg.chunk);
      else if (T.tg.cer != null) dst = T.tg.cer < v.n ? this.particella(T.tg.cer) : null;
      else if (T.tg.rel) { const az = T.tg.rel[0]; dst = add(A, mul([Math.cos(az), Math.sin(az) * 0.6, Math.sin(az) * 0.8], 0.36)); }
      if (!dst) continue;
      const g = ease((v.orologio - T.born) / 280);
      if (g <= 0) continue;
      let al = T.die !== Infinity ? clamp((T.die - v.orologio) / 300, 0, 1) : 1;
      if (T.hide) al *= 0.45;
      const c = rgba(T.style === "read" && T.alt ? P.tcol.read2! : P.tcol[T.style] ?? P.tcol.read!);
      const d = sub(dst, A), lun = len(d) || 1, lato = norm(cross(d, [0, 1, 0.001]));
      const ctrl = add(add(A, mul(d, 0.5)), add(mul(lato, T.bend * lun * 0.28 + Math.sin(t * 1.4 + T.seed) * 0.03), [0, 0.06 * lun, 0]));
      const segm = 18;
      let prima = A;
      for (let s = 1; s <= segm; s++) {
        const u = (s / segm) * g, q = quad(A, ctrl, dst, u);
        const ond = Math.sin((s / segm) * Math.PI * 3 - t * 3.2 + T.seed) * 0.012 * Math.sin(Math.PI * (s / segm));
        const qq = add(q, mul(lato, ond));
        L.seg(prima, qq, c, al * (1 - (s - 1) / segm * 0.4), al * (1 - s / segm * 0.4));
        prima = qq;
      }
      if (g >= 1) {
        metti(dst, c, 10, al);
        if (!T.hide && T.style !== "dim") {
          const u = (t * 0.7 + T.seed) % 1;
          impulso(quad(A, ctrl, dst, u), c, 9, al);
          impulso(quad(A, ctrl, dst, (u + 0.5) % 1), c, 6, al * 0.6);
        }
      }
    }
    // i ponti: archi che attraversano il cervello, con un impulso
    for (const B of v.ponti) {
      const p2 = this.passaggio(v, B.to);
      if (!p2) continue;
      const p1 = this.passaggio(v, B.from) ?? A;
      const g = ease((v.orologio - B.born) / 750), dim = (v.fase > 4 ? 0.6 : 1) * (B.cut ? 0.45 : 1);
      const ctrl = mul(add(p1, p2), 0.25);
      const c = rgba(B.cut ? P.ponteTagliato(1) : P.ponte(1));
      let prima = p1;
      for (let s = 1; s <= 24; s++) { const q = quad(p1, ctrl, p2, (s / 24) * g); L.seg(prima, q, c, 0.6 * dim); prima = q; }
      if (g >= 1 && !B.cut) { impulso(quad(p1, ctrl, p2, (t * 0.32 + B.seed) % 1), rgba(P.giallo), 14, 0.9 * dim); metti(p2, rgba(P.giallo), 14, 0.9 * dim); }
    }
    // i concetti: stelle attorno al nucleo, legate fra loro e ai loro passaggi
    const posConcetto = new Map<Id, V3>();
    v.concetti.forEach((kc, i) => {
      const g = ease((v.orologio - kc.born) / 380);
      if (g <= 0) return;
      const el = (kc.ring ? 0.35 : -0.2) + 0.08 * Math.sin(t * 0.6 + i);
      const p = add(A, mul([Math.cos(kc.ang) * Math.cos(el), Math.sin(el), Math.sin(kc.ang) * Math.cos(el)], 0.5 * g));
      posConcetto.set(kc.id, p);
      const col = rgba(v.coloreCategoria(kc.cat)), dim = v.fase === 7 ? 0.45 : v.fase > 5 ? 0.7 : 1;
      metti(p, col, 16 + kc.w * 4, 0.9 * dim);
      metti(p, col, 40, 0.25 * dim);
      const fc2 = rgba(P.concettoFilo(1));
      for (const id of kc.chunks) { const q = this.passaggio(v, id); if (q) L.seg(p, q, fc2, 0.18 * dim, 0.05 * dim); }
    });
    for (const e of v.relazioni) {
      const a = posConcetto.get(e.a), b = posConcetto.get(e.b);
      if (a && b) L.seg(a, b, rgba(P.concettoFilo(1)), 0.6, 0.6);
    }
    // gli strumenti: il tronco si accende quando la rete chiede i dati veri
    if (v.cerbero && v.cerberoAcceso > 0.05) metti([0, -1.05, -0.25], rgba("#FB7185"), 90, 0.3 * v.cerberoAcceso);
    acc.usa(na); imp.usa(ni); L.fine();
    this.camPos = [this.camera.position.x, this.camera.position.y, this.camera.position.z];
  }

  // ─── la sovrimpressione: nomi, pillole, parole ───────────────────────────
  private proietta(p: V3): { x: number; y: number; z: number } | null {
    const w = new THREE.Vector3(p[0], p[1], p[2]).project(this.camera);
    if (w.z > 1 || w.z < -1) return null;
    return { x: (w.x * 0.5 + 0.5) * this.W, y: (-w.y * 0.5 + 0.5) * this.H, z: w.z };
  }
  private sovrimpressione(v: Vista3D): void {
    const ctx = this.ctx, P = v.tavolozza;
    ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);
    const mono = '"JetBrains Mono",ui-monospace,Menlo,monospace';
    // i nomi delle zone, più tenui quando sono lontane
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.font = `500 11px ${mono}`;
    const camP = this.camera.position, TT = v.titolo;
    const sottoTitolo = (x: number, y: number, w = 0, h = 0) => x < TT.x + TT.w && x + w > TT.x && y < TT.y + TT.h && y + h > TT.y;
    for (const c of this.centri) {
      const s = this.proietta(c.p);
      if (!s) continue;
      const lw = ctx.measureText(c.name).width;
      if (sottoTitolo(s.x - lw / 2, s.y - 8, lw, 16)) continue;
      const d = Math.hypot(c.p[0] - camP.x, c.p[1] - camP.y, c.p[2] - camP.z), a = clamp(1.4 - d * 0.32, 0.12, 0.95);
      ctx.lineWidth = 3; ctx.strokeStyle = P.alone; ctx.globalAlpha = a; ctx.strokeText(c.name, s.x, s.y);
      ctx.fillStyle = P.nome(1); ctx.fillText(c.name, s.x, s.y);
    }
    ctx.globalAlpha = 1;
    // le pillole dei passaggi: dal lato del fascio, senza coprirsi
    const pill: Array<{ x: number; y: number; t: string; st: StilePillola; a: number }> = [];
    const A = this.A;
    for (const T of v.tentacoli) {
      if (!T.text || T.hide) continue;
      if ((v.orologio - T.born) < 280) continue;
      let dst: V3 | null = null;
      if (T.tg.chunk != null) dst = this.passaggio(v, T.tg.chunk);
      else if (T.tg.cer != null) dst = T.tg.cer < v.n ? this.particella(T.tg.cer) : null;
      else if (T.tg.rel) { const az = T.tg.rel[0]; dst = add(A, mul([Math.cos(az), Math.sin(az) * 0.6, Math.sin(az) * 0.8], 0.36)); }
      if (!dst) continue;
      const s = this.proietta(dst);
      if (!s) continue;
      pill.push({ x: s.x, y: s.y, t: T.text, st: T.style, a: T.die !== Infinity ? clamp((T.die - v.orologio) / 300, 0, 1) : 1 });
    }
    if (v.termini.length && v.terminiSfumano == null) {
      v.termini.forEach((term, i) => {
        const az = (i / v.termini.length) * TAU, p = add(A, mul([Math.cos(az), 0.25 * Math.sin(az * 2), Math.sin(az)], 0.32)), s = this.proietta(p);
        if (s) pill.push({ x: s.x, y: s.y, t: term.w, st: "term", a: ease((v.orologio - term.born) / 300) });
      });
    }
    ctx.font = `500 9.5px ${mono}`; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    pill.sort((a, b) => a.y - b.y);
    const messe: Array<{ x: number; y: number; w: number }> = [];
    for (const p of pill.slice(0, 26)) {
      const w = Math.ceil(ctx.measureText(p.t).width) + 10, h = 15;
      let x = clamp(p.x + 8, 4, this.W - w - 4), y = p.y - h / 2;
      if (sottoTitolo(x, y, w, h)) y = TT.y + TT.h + 2;
      for (let k = 0; k < 12 && messe.some(q => x < q.x + q.w + 3 && q.x < x + w + 3 && Math.abs(q.y - y) < h + 2); k++) y += h + 2;
      messe.push({ x, y, w });
      const st = P.pill[p.st] ?? P.pill.read;
      ctx.globalAlpha = p.a;
      ctx.beginPath(); ctx.roundRect(x, y, w, h, 3); ctx.fillStyle = st.bg; ctx.fill();
      if (st.dash) ctx.setLineDash([2, 2]);
      ctx.strokeStyle = st.br; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = st.tx; ctx.fillText(p.t, x + 5, y + h / 2 + 0.5);
      if (Math.abs(y + h / 2 - p.y) > 4) { ctx.strokeStyle = st.br; ctx.lineWidth = 0.6; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(x, y + h / 2); ctx.stroke(); }
    }
    ctx.globalAlpha = 1;
    // le parole della risposta: dal nucleo verso la chat (a destra, o sotto sui telefoni)
    const sA = this.proietta(A);
    if (sA && v.parole.length) {
      const fine = v.risposta === "sotto" ? { x: this.W * 0.5, y: this.H + 10 } : { x: this.W + 10, y: this.H * 0.42 };
      ctx.font = `500 10px ${mono}`; ctx.textAlign = "center";
      for (const w of v.parole) {
        const u = clamp((v.tempo - w.born) / w.dur, 0, 1), e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
        const cx = (sA.x + fine.x) / 2, cy = (sA.y + fine.y) / 2 + w.bend;
        const x = (1 - e) * (1 - e) * sA.x + 2 * (1 - e) * e * cx + e * e * fine.x, y = (1 - e) * (1 - e) * sA.y + 2 * (1 - e) * e * cy + e * e * fine.y;
        ctx.globalAlpha = Math.sin(u * Math.PI) * (this.chiaro ? 0.85 : 0.7);
        ctx.fillStyle = P.parola; ctx.fillText(w.w, x, y);
      }
      ctx.globalAlpha = 1;
    }
  }
}

/** C'è WebGL in questo browser? (la vista 3D ne ha bisogno) */
export function webglDisponibile(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch { return false; }
}

