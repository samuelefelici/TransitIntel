/**
 * Cubo spazio-tempo — la resa three.js della vista «3D» del Grafico.
 *
 * Piano = cartografia minima (griglia scura + tracce a terra dei percorsi),
 * asse verticale = tempo. Ogni corsa accesa è un filo; i nodi di interscambio
 * sono piloni; le coincidenze entro soglia sono sfere col filo a piombo.
 *
 * I principi che rendono leggibile il 3D (e che qui sono cablati):
 *  - fuoco+contesto: tutto in fantasma, piena luce solo dentro la LAMA
 *    temporale e sulla corsa selezionata;
 *  - lama temporale: una finestra di N minuti che affetta il cubo (slider o
 *    scansione automatica col tasto play);
 *  - pareti-grafico: le ombre dei fili proiettate su due pareti si leggono
 *    come il diagramma orario 2D; attivabili;
 *  - camera disciplinata: preset Pianta/Laterale/Iso, mai solo tumbling.
 *
 * La matematica sta nel modulo puro lib/space-time-cube.ts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { CubeCoincidence, CubeNode, CubeThread } from "@/lib/space-time-cube";

const BG = 0x0b1018;
const SLAB_COLOR = 0x3d5a8a;
const GLOW = 0x7dffb0;

function secToHm(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export interface SpaceTimeCubeProps {
  threads: CubeThread[];
  nodes: CubeNode[];
  coincidences: CubeCoincidence[];
  /** y(sec) e finestra temporale: dalla stessa proiezione dei thread */
  toY: (sec: number) => number;
  tMin: number;
  tMax: number;
  planSize: number;
  selectedTripId: string | null;
  onSelectTrip: (tripId: string | null) => void;
}

export default function SpaceTimeCube({
  threads, nodes, coincidences, toY, tMin, tMax, planSize, selectedTripId, onSelectTrip,
}: SpaceTimeCubeProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [slabStart, setSlabStart] = useState(() => tMin);
  const [slabMin, setSlabMin] = useState(90);
  const [playing, setPlaying] = useState(false);
  const [walls, setWalls] = useState(true);
  const [ortho, setOrtho] = useState(false);
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);

  // stato vivo letto dal loop di animazione senza ricreare la scena
  const live = useRef({ slabStart: tMin, slabMin: 90, playing: false, selected: null as string | null });
  live.current.slabMin = slabMin;
  live.current.selected = selectedTripId;
  live.current.playing = playing;
  // lo slider comanda; il play fa scorrere slabStart via setState (sotto)
  live.current.slabStart = slabStart;

  const hourTicks = useMemo(() => {
    const out: number[] = [];
    for (let s = Math.ceil(tMin / 3600) * 3600; s <= tMax; s += 3600) out.push(s);
    return out;
  }, [tMin, tMax]);

  // Il play avanza la lama: ~90 minuti di cubo al secondo reale / 6.
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      setSlabStart(prev => {
        const next = prev + 15 * 60 / 10;
        return next > tMax - slabMin * 60 ? tMin : next;
      });
    }, 100);
    return () => window.clearInterval(id);
  }, [playing, tMin, tMax, slabMin]);

  // Anche gli ORARI entrano nella chiave: una corsa traslata (stessi id) deve
  // ricostruire i fili, non lasciare la scena vecchia.
  const rebuildKey = useMemo(
    () => `${threads.map(t => `${t.tripId}:${t.t0}`).join(",")}|${coincidences.length}|${nodes.length}|${walls}|${ortho}|${tMin}|${tMax}`,
    [threads, coincidences, nodes, walls, ortho, tMin, tMax],
  );

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const width = mount.clientWidth || 800;
    const height = mount.clientHeight || 520;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BG);
    scene.fog = new THREE.Fog(BG, planSize * 2, planSize * 5);

    const H = toY(tMax) + 0.4;
    const persp = new THREE.PerspectiveCamera(52, width / height, 0.1, 300);
    const oSize = Math.max(planSize, H) * 0.75;
    const orthoCam = new THREE.OrthographicCamera(
      -oSize * (width / height), oSize * (width / height), oSize, -oSize, 0.1, 300);
    const camera: THREE.Camera = ortho ? orthoCam : persp;
    const startPos = new THREE.Vector3(planSize * 1.15, H * 0.95, planSize * 1.15);
    camera.position.copy(startPos);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.localClippingEnabled = true;
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, H / 2.4, 0);
    controls.enableDamping = true;

    const disposables: Array<{ dispose(): void }> = [];
    const track = <T extends { dispose(): void }>(x: T): T => { disposables.push(x); return x; };

    // suolo + griglia
    const groundGeo = track(new THREE.PlaneGeometry(planSize * 1.3, planSize * 1.3));
    const groundMat = track(new THREE.MeshBasicMaterial({ color: 0x121a26 }));
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2; ground.position.y = -0.02;
    scene.add(ground);
    const grid = new THREE.GridHelper(planSize * 1.3, 26, 0x22324a, 0x182233);
    grid.position.y = -0.01; scene.add(grid);
    track(grid.geometry); track(grid.material as THREE.Material);

    // lama temporale: due piani-clip condivisi + due veli che la marcano
    const clipLo = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const clipHi = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
    const slabMat = track(new THREE.MeshBasicMaterial({ color: SLAB_COLOR, transparent: true, opacity: 0.06, side: THREE.DoubleSide }));
    const slabGeo = track(new THREE.PlaneGeometry(planSize * 1.3, planSize * 1.3));
    const slabA = new THREE.Mesh(slabGeo, slabMat); slabA.rotation.x = -Math.PI / 2;
    const slabB = new THREE.Mesh(slabGeo, slabMat); slabB.rotation.x = -Math.PI / 2;
    scene.add(slabA); scene.add(slabB);

    // pareti-grafico: righe orarie + ombre dei fili
    const WZ = -planSize * 0.62, WX = -planSize * 0.62, EXT = planSize * 0.68;
    if (walls) {
      const wallLineMat = track(new THREE.LineBasicMaterial({ color: 0x1f2c40 }));
      for (const s of hourTicks) {
        const y = toY(s);
        const g1 = track(new THREE.BufferGeometry().setFromPoints(
          [new THREE.Vector3(-EXT, y, WZ), new THREE.Vector3(EXT, y, WZ)]));
        scene.add(new THREE.Line(g1, wallLineMat));
        const g2 = track(new THREE.BufferGeometry().setFromPoints(
          [new THREE.Vector3(WX, y, -EXT), new THREE.Vector3(WX, y, EXT)]));
        scene.add(new THREE.Line(g2, wallLineMat));
      }
    }

    // fili: fantasma (Line sottile) + fuoco (tubo clippato dalla lama);
    // le ombre sulle pareti seguono la stessa lama.
    const focusMats: Array<{ mat: THREE.MeshBasicMaterial; tripId: string }> = [];
    const pickables: THREE.Mesh[] = [];
    const groundTrackDone = new Set<string>();
    for (const t of threads) {
      const pts = t.points.map(p => new THREE.Vector3(p.x, p.y, p.z));
      const ghostGeo = track(new THREE.BufferGeometry().setFromPoints(pts));
      const ghostMat = track(new THREE.LineBasicMaterial({ color: t.color, transparent: true, opacity: 0.12 }));
      scene.add(new THREE.Line(ghostGeo, ghostMat));

      const curve = new THREE.CatmullRomCurve3(pts);
      const tubeGeo = track(new THREE.TubeGeometry(curve, Math.min(pts.length * 2, 220), 0.022, 5));
      const tubeMat = track(new THREE.MeshBasicMaterial({ color: t.color, clippingPlanes: [clipLo, clipHi] }));
      const tube = new THREE.Mesh(tubeGeo, tubeMat);
      tube.userData = { tripId: t.tripId, label: t.label, t0: t.t0, t1: t.t1 };
      scene.add(tube);
      focusMats.push({ mat: tubeMat, tripId: t.tripId });
      pickables.push(tube);

      if (walls) {
        for (const wall of [
          pts.map(p => new THREE.Vector3(p.x, p.y, WZ + 0.02)),
          pts.map(p => new THREE.Vector3(WX + 0.02, p.y, p.z)),
        ]) {
          const g = track(new THREE.BufferGeometry().setFromPoints(wall));
          const m = track(new THREE.LineBasicMaterial({ color: t.color, transparent: true, opacity: 0.5, clippingPlanes: [clipLo, clipHi] }));
          scene.add(new THREE.Line(g, m));
        }
      }

      // traccia a terra: una volta per percorso (chiave = label senza orario)
      const trackKey = `${t.routeKey}|${t.points.length}`;
      if (!groundTrackDone.has(trackKey)) {
        groundTrackDone.add(trackKey);
        const g = track(new THREE.BufferGeometry().setFromPoints(pts.map(p => new THREE.Vector3(p.x, 0.01, p.z))));
        const m = track(new THREE.LineBasicMaterial({ color: t.color, transparent: true, opacity: 0.3 }));
        scene.add(new THREE.Line(g, m));
      }
    }

    // piloni dei nodi di interscambio
    const pilGeo = track(new THREE.CylinderGeometry(0.028, 0.028, H, 8));
    const pilMat = track(new THREE.MeshBasicMaterial({ color: 0xdfe8f5, transparent: true, opacity: 0.14 }));
    for (const n of nodes) {
      const pil = new THREE.Mesh(pilGeo, pilMat);
      pil.position.set(n.x, H / 2, n.z);
      scene.add(pil);
    }

    // coincidenze: sfera + filo a piombo + anello a terra
    const cGeo = track(new THREE.SphereGeometry(0.055, 12, 12));
    const cMat = track(new THREE.MeshBasicMaterial({ color: GLOW }));
    const cLineMat = track(new THREE.LineBasicMaterial({ color: GLOW, transparent: true, opacity: 0.35 }));
    const cRingGeo = track(new THREE.RingGeometry(0.05, 0.09, 20));
    const cRingMat = track(new THREE.MeshBasicMaterial({ color: GLOW, transparent: true, opacity: 0.5, side: THREE.DoubleSide }));
    for (const c of coincidences) {
      const y = toY(c.sec);
      const s = new THREE.Mesh(cGeo, cMat);
      s.position.set(c.x, y, c.z);
      s.userData = { coincidence: c };
      scene.add(s);
      pickables.push(s);
      const g = track(new THREE.BufferGeometry().setFromPoints(
        [new THREE.Vector3(c.x, 0.02, c.z), new THREE.Vector3(c.x, y, c.z)]));
      scene.add(new THREE.Line(g, cLineMat));
      const ring = new THREE.Mesh(cRingGeo, cRingMat);
      ring.rotation.x = -Math.PI / 2; ring.position.set(c.x, 0.02, c.z);
      scene.add(ring);
    }

    // hover/click: raycast sui tubi e sulle sfere
    const ray = new THREE.Raycaster();
    (ray.params as any).Line = { threshold: 0.08 };
    const mouse = new THREE.Vector2();
    const onMove = (e: MouseEvent) => {
      const r = renderer.domElement.getBoundingClientRect();
      mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(mouse, camera);
      const hit = ray.intersectObjects(pickables, false)[0];
      if (!hit) { setHover(null); renderer.domElement.style.cursor = "grab"; return; }
      renderer.domElement.style.cursor = "pointer";
      const u = hit.object.userData as any;
      const text = u.coincidence
        ? `Coincidenza · ${u.coincidence.nodeName}\n${u.coincidence.labelA} ↔ ${u.coincidence.labelB} · attesa ${u.coincidence.waitMin}′ · ~${secToHm(u.coincidence.sec)}`
        : `${u.label}\n${secToHm(u.t0)} → ${secToHm(u.t1)}`;
      setHover({ x: e.clientX - r.left + 12, y: e.clientY - r.top + 12, text });
    };
    const onClick = () => {
      ray.setFromCamera(mouse, camera);
      const hit = ray.intersectObjects(pickables, false)[0];
      const u = hit?.object.userData as any;
      onSelectTrip(u?.tripId ?? null);
    };
    renderer.domElement.addEventListener("mousemove", onMove);
    renderer.domElement.addEventListener("click", onClick);

    // preset di camera esposti al toolbar via ref DOM (evento custom)
    const preset = (which: string) => {
      if (which === "pianta") { camera.position.set(0.001, H * 1.9, 0.001); controls.target.set(0, 0, 0); }
      else if (which === "laterale") { camera.position.set(0, H / 2, planSize * 1.9); controls.target.set(0, H / 2, 0); }
      else { camera.position.copy(startPos); controls.target.set(0, H / 2.4, 0); }
    };
    const onPreset = (e: Event) => preset((e as CustomEvent).detail);
    mount.addEventListener("stc-preset", onPreset);

    let raf = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      const st = live.current;
      const yLo = toY(st.slabStart), yHi = toY(st.slabStart + st.slabMin * 60);
      clipLo.constant = -yLo; clipHi.constant = yHi;
      slabA.position.y = yLo; slabB.position.y = yHi;
      for (const f of focusMats) {
        const dim = st.selected != null && f.tripId !== st.selected;
        f.mat.transparent = dim;
        f.mat.opacity = dim ? 0.18 : 1;
      }
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(raf);
      renderer.domElement.removeEventListener("mousemove", onMove);
      renderer.domElement.removeEventListener("click", onClick);
      mount.removeEventListener("stc-preset", onPreset);
      controls.dispose();
      for (const d of disposables) d.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
    // ricrea la scena solo quando cambiano dati o modalità di resa
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rebuildKey]);

  const firePreset = useCallback((which: string) => {
    mountRef.current?.dispatchEvent(new CustomEvent("stc-preset", { detail: which }));
  }, []);

  const slabEndMax = Math.max(tMin, tMax - slabMin * 60);
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-800 bg-slate-900/70 text-[11px] flex-wrap">
        <span className="text-[9px] uppercase tracking-wider text-slate-500 font-semibold">Lama</span>
        <button onClick={() => setPlaying(p => !p)}
          className={`px-2 py-0.5 rounded border ${playing ? "bg-amber-600/20 border-amber-500/50 text-amber-200" : "border-slate-700 text-slate-300 hover:bg-slate-800"}`}>
          {playing ? "⏸ pausa" : "▶ scandisci"}
        </button>
        <input type="range" min={tMin} max={slabEndMax} step={300} value={Math.min(slabStart, slabEndMax)}
          onChange={e => { setPlaying(false); setSlabStart(Number(e.target.value)); }}
          className="w-44 accent-amber-500" />
        <span className="font-mono text-slate-300">{secToHm(slabStart)}–{secToHm(slabStart + slabMin * 60)}</span>
        <select value={slabMin} onChange={e => setSlabMin(Number(e.target.value))}
          className="bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-slate-300">
          {[30, 60, 90, 120, 240].map(m => <option key={m} value={m}>{m}′</option>)}
        </select>
        <span className="w-px h-4 bg-slate-700 mx-1" />
        <button onClick={() => setWalls(w => !w)}
          className={`px-2 py-0.5 rounded border ${walls ? "bg-sky-500/15 border-sky-500/50 text-sky-200" : "border-slate-700 text-slate-400 hover:bg-slate-800"}`}
          title="Ombre dei fili proiettate sulle pareti: si leggono come il grafico 2D">
          Pareti
        </button>
        <button onClick={() => setOrtho(o => !o)}
          className={`px-2 py-0.5 rounded border ${ortho ? "bg-violet-500/15 border-violet-500/50 text-violet-200" : "border-slate-700 text-slate-400 hover:bg-slate-800"}`}
          title="Ortografica: niente prospettiva, i tempi si confrontano ad occhio">
          Orto
        </button>
        <span className="w-px h-4 bg-slate-700 mx-1" />
        <span className="text-[9px] uppercase tracking-wider text-slate-500 font-semibold">Vista</span>
        {(["pianta", "laterale", "iso"] as const).map(v => (
          <button key={v} onClick={() => firePreset(v)}
            className="px-2 py-0.5 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 capitalize">{v}</button>
        ))}
        <span className="flex-1" />
        <span className="text-slate-500">
          {threads.length} corse · {coincidences.length} coincidenze · trascina = ruota · click su un filo = seleziona
        </span>
      </div>
      <div ref={mountRef} className="flex-1 relative min-h-0">
        {hover && (
          <div className="absolute z-20 pointer-events-none bg-slate-800/95 border border-slate-600 rounded px-2 py-1 text-[11px] text-slate-100 whitespace-pre shadow-xl"
            style={{ left: hover.x, top: hover.y }}>
            {hover.text}
          </div>
        )}
      </div>
    </div>
  );
}
