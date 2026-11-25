/**
 * Il globo della pagina di accesso (tappa 7.34).
 *
 * La Terra a punti (le terre emerse di lib/terra.ts) che gira piano, con i
 * paralleli e i meridiani, l'atmosfera, tre anelli in orbita coi loro
 * satelliti, i nodi che pulsano e gli archi su cui corre la luce da un nodo
 * all'altro. Un mirino passa da un nodo all'altro e ne dice le coordinate.
 *
 * Three.js c'era già fra le dipendenze; si carica solo quando serve (import
 * dinamico), così il modulo di accesso è subito usabile. Pixel limitati (DPR
 * al più 1,75), pausa quando il globo non si vede o la scheda è nascosta,
 * un fotogramma solo con «riduci il movimento». Senza WebGL resta l'alone in
 * CSS dietro al globo.
 */
import { useEffect, useRef, useState } from "react";
import type * as T from "three";
import { grigliaTerre } from "@/lib/terra";

type Tema = "scuro" | "chiaro";

/** I nodi del globo: punti di una rete immaginaria, in gradi (nord, est). */
export const NODI: ReadonlyArray<readonly [number, number]> = [
  [51.51, -0.13], [48.86, 2.35], [52.52, 13.4], [40.42, -3.7], [41.9, 12.5], [59.33, 18.07],
  [45.46, 9.19], [37.98, 23.73], [40.71, -74.01], [35.68, 139.69], [-23.55, -46.63], [1.35, 103.82],
  [-33.87, 151.21], [19.43, -99.13], [30.04, 31.24], [55.76, 37.62],
];
const ARCHI: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 4], [4, 6], [6, 2], [2, 5], [3, 1], [4, 7], [0, 8], [1, 14], [2, 15],
  [11, 9], [8, 13], [3, 10], [11, 12], [7, 14], [5, 15],
];

const PALETTE: Record<Tema, {
  punti: [string, string, string]; nucleo: string; atmosfera: string; anelli: string;
  nodi: string; archi: string; reticolo: string; additivo: boolean; forza: number;
}> = {
  scuro: { punti: ["#38bdf8", "#3b82f6", "#a78bfa"], nucleo: "#030a19", atmosfera: "#1d8fe6", anelli: "#38bdf8", nodi: "#67e8f9", archi: "#22d3ee", reticolo: "#1e40af", additivo: true, forza: 1 },
  chiaro: { punti: ["#0284c7", "#1d4ed8", "#6d28d9"], nucleo: "#eaf1fa", atmosfera: "#60a5fa", anelli: "#0369a1", nodi: "#0e7490", archi: "#0284c7", reticolo: "#94a3b8", additivo: false, forza: 0.9 },
};

/** Un punto della sfera da gradi: longitudine 0 guarda la camera. */
function vettore(THREE: typeof T, nord: number, est: number, raggio = 1): T.Vector3 {
  const f = (nord * Math.PI) / 180, l = (est * Math.PI) / 180;
  return new THREE.Vector3(Math.cos(f) * Math.sin(l), Math.sin(f), Math.cos(f) * Math.cos(l)).multiplyScalar(raggio);
}

function testoCoordinate([n, e]: readonly [number, number]): string {
  return `${Math.abs(n).toFixed(2)} ${n >= 0 ? "N" : "S"} · ${Math.abs(e).toFixed(2)} ${e >= 0 ? "E" : "O"}`;
}

export default function Globo({ tema }: { tema: Tema }) {
  const contenitore = useRef<HTMLDivElement>(null);
  const mirino = useRef<HTMLDivElement>(null);
  const temaRef = useRef<Tema>(tema);
  const [nodo, setNodo] = useState(4);
  const [pronto, setPronto] = useState(false);
  temaRef.current = tema;

  useEffect(() => {
    let vivo = true;
    let pulisci: () => void = () => {};
    import("three")
      .then((THREE) => {
        if (!vivo || !contenitore.current) return;
        pulisci = avvia(THREE, contenitore.current, mirino, temaRef, setNodo, () => setPronto(true));
      })
      .catch(() => { /* senza Three resta l'alone in CSS */ });
    return () => { vivo = false; pulisci(); };
  }, []);

  return (
    <div className={`landing-globo ${pronto ? "landing-globo-pronto" : ""}`} aria-hidden>
      <div className="landing-globo-alone" />
      <div ref={contenitore} className="landing-globo-tela" />
      <div ref={mirino} className="landing-mirino">
        <span className="landing-mirino-angoli" />
        <span className="landing-mirino-anello" />
        <span className="landing-mirino-etichetta">
          <b>NODO {String(nodo + 1).padStart(2, "0")}</b>
          <span>{testoCoordinate(NODI[nodo]!)}</span>
        </span>
      </div>
    </div>
  );
}

function avvia(
  THREE: typeof T,
  box: HTMLDivElement,
  mirino: React.RefObject<HTMLDivElement | null>,
  temaRef: React.RefObject<Tema>,
  setNodo: (n: number) => void,
  pronto: () => void,
): () => void {
  const fermo = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const piccolo = Math.min(box.clientWidth, box.clientHeight) < 640;

  let renderer: T.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  } catch {
    return () => {};
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.setClearColor(0x000000, 0);
  box.appendChild(renderer.domElement);

  const scena = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  camera.position.set(0, 0, 3.35);

  const inclinazione = new THREE.Group();
  inclinazione.rotation.x = 0.32;
  inclinazione.rotation.z = -0.08;
  inclinazione.position.y = -0.12;
  scena.add(inclinazione);
  const terra = new THREE.Group();
  terra.rotation.y = -0.35;
  inclinazione.add(terra);

  const daButtare: Array<{ dispose(): void }> = [];
  const tieni = <X extends { dispose(): void }>(x: X) => { daButtare.push(x); return x; };

  /* ── il nucleo: copre i punti dietro ── */
  const matNucleo = tieni(new THREE.MeshBasicMaterial({ color: PALETTE.scuro.nucleo }));
  const geoNucleo = tieni(new THREE.SphereGeometry(0.985, 64, 64));
  terra.add(new THREE.Mesh(geoNucleo, matNucleo));

  /* ── le terre a punti (sfera di Fibonacci, solo i punti sulla terra) ── */
  const griglia = grigliaTerre();
  const N = piccolo ? 42000 : 72000;
  const pos: number[] = [], caso: number[] = [];
  const aureo = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) {
    const y = 1 - ((i + 0.5) / N) * 2;
    const r = Math.sqrt(1 - y * y);
    const ang = i * aureo;
    const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
    const nord = (Math.asin(y) * 180) / Math.PI;
    const est = (Math.atan2(x, z) * 180) / Math.PI;
    const riga = Math.min(179, Math.max(0, Math.floor(90 - nord)));
    const col = ((Math.floor(est + 180) % 360) + 360) % 360;
    if (griglia[riga * 360 + col] !== 1) continue;
    pos.push(x, y, z);
    caso.push(Math.random());
  }
  const geoPunti = tieni(new THREE.BufferGeometry());
  geoPunti.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geoPunti.setAttribute("aCaso", new THREE.Float32BufferAttribute(caso, 1));
  const uPunti = {
    uTempo: { value: 0 }, uPixel: { value: 1 }, uForza: { value: 1 },
    uC1: { value: new THREE.Color() }, uC2: { value: new THREE.Color() }, uC3: { value: new THREE.Color() },
  };
  const matPunti = tieni(new THREE.ShaderMaterial({
    uniforms: uPunti,
    transparent: true,
    depthWrite: false,
    vertexShader: `
      uniform float uTempo; uniform float uPixel;
      attribute float aCaso;
      varying float vLuce; varying float vCaso; varying float vFaccia;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 n = normalize(normalMatrix * position);
        vFaccia = dot(n, normalize(-mv.xyz));
        vCaso = aCaso;
        vLuce = 0.55 + 0.45 * sin(uTempo * (0.5 + aCaso * 1.6) + aCaso * 40.0);
        gl_PointSize = uPixel * (1.6 + 1.5 * aCaso) * (3.4 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uC1; uniform vec3 uC2; uniform vec3 uC3; uniform float uForza;
      varying float vLuce; varying float vCaso; varying float vFaccia;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        float tondo = smoothstep(0.5, 0.15, d);
        vec3 c = vCaso < 0.8 ? mix(uC1, uC2, vCaso / 0.8) : uC3;
        float lato = smoothstep(-0.02, 0.4, vFaccia);
        gl_FragColor = vec4(c, tondo * (0.35 + 0.65 * vLuce) * lato * uForza);
      }`,
  }));
  terra.add(new THREE.Points(geoPunti, matPunti));

  /* ── paralleli e meridiani ── */
  const linee: number[] = [];
  const tratto = 3;
  for (let nord = -60; nord <= 60; nord += 30) {
    for (let est = -180; est < 180; est += tratto) {
      const a = vettore(THREE, nord, est, 1.002), b = vettore(THREE, nord, est + tratto, 1.002);
      linee.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  }
  for (let est = -180; est < 180; est += 30) {
    for (let nord = -90; nord < 90; nord += tratto) {
      const a = vettore(THREE, nord, est, 1.002), b = vettore(THREE, nord + tratto, est, 1.002);
      linee.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  }
  const geoReticolo = tieni(new THREE.BufferGeometry());
  geoReticolo.setAttribute("position", new THREE.Float32BufferAttribute(linee, 3));
  const matReticolo = tieni(new THREE.LineBasicMaterial({ transparent: true, opacity: 0.16, depthWrite: false }));
  terra.add(new THREE.LineSegments(geoReticolo, matReticolo));

  /* ── l'atmosfera ── */
  const uAtmosfera = { uColore: { value: new THREE.Color() }, uForza: { value: 1 } };
  const matAtmosfera = tieni(new THREE.ShaderMaterial({
    uniforms: uAtmosfera,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    vertexShader: `
      varying vec3 vN;
      void main() { vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform vec3 uColore; uniform float uForza; varying vec3 vN;
      void main() { float i = pow(max(0.0, 0.72 - dot(vN, vec3(0.0, 0.0, 1.0))), 3.0); gl_FragColor = vec4(uColore, i * uForza); }`,
  }));
  const geoAtmosfera = tieni(new THREE.SphereGeometry(1.16, 64, 64));
  inclinazione.add(new THREE.Mesh(geoAtmosfera, matAtmosfera));

  /* ── i nodi: un punto e un'onda che si allarga ── */
  const matNodo = tieni(new THREE.MeshBasicMaterial({ transparent: true }));
  const geoNodo = tieni(new THREE.CircleGeometry(0.012, 20));
  const geoOnda = tieni(new THREE.RingGeometry(0.018, 0.023, 48));
  const onde: Array<{ mesh: T.Mesh; mat: T.MeshBasicMaterial; fase: number }> = [];
  const posNodi = NODI.map(([n, e]) => vettore(THREE, n, e, 1.004));
  posNodi.forEach((p, i) => {
    const centro = new THREE.Mesh(geoNodo, matNodo);
    centro.position.copy(p);
    centro.lookAt(p.clone().multiplyScalar(2));
    terra.add(centro);
    const mat = tieni(new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    const onda = new THREE.Mesh(geoOnda, mat);
    onda.position.copy(p);
    onda.lookAt(p.clone().multiplyScalar(2));
    terra.add(onda);
    onde.push({ mesh: onda, mat, fase: (i * 0.37) % 1 });
  });

  /* ── gli archi: la luce che corre da un nodo all'altro ── */
  const archi: Array<{ mat: T.ShaderMaterial }> = [];
  ARCHI.forEach(([a, b], i) => {
    const pa = posNodi[a]!, pb = posNodi[b]!;
    const angolo = pa.angleTo(pb);
    const mezzo = pa.clone().add(pb).normalize().multiplyScalar(1 + 0.12 + angolo * 0.22);
    const curva = new THREE.QuadraticBezierCurve3(pa, mezzo, pb);
    const punti = curva.getPoints(80);
    const geo = tieni(new THREE.BufferGeometry().setFromPoints(punti));
    geo.setAttribute("aT", new THREE.Float32BufferAttribute(punti.map((_, k) => k / 80), 1));
    const mat = tieni(new THREE.ShaderMaterial({
      uniforms: { uTempo: { value: 0 }, uFase: { value: (i * 0.173) % 1 }, uColore: { value: new THREE.Color() }, uForza: { value: 1 } },
      transparent: true,
      depthWrite: false,
      vertexShader: `
        attribute float aT; varying float vT;
        void main() { vT = aT; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform float uTempo; uniform float uFase; uniform vec3 uColore; uniform float uForza; varying float vT;
        void main() {
          float testa = fract(uTempo * 0.16 + uFase) * 1.6 - 0.3;
          float d = vT - testa;
          float scia = smoothstep(-0.28, 0.0, d) * (1.0 - smoothstep(0.0, 0.015, d));
          gl_FragColor = vec4(uColore, (0.1 + scia) * uForza);
        }`,
    }));
    terra.add(new THREE.Line(geo, mat));
    archi.push({ mat });
  });

  /* ── tre anelli in orbita, coi loro satelliti ── */
  const orbite = new THREE.Group();
  inclinazione.add(orbite);
  const matAnello = tieni(new THREE.LineBasicMaterial({ transparent: true, opacity: 0.22, depthWrite: false }));
  const matSatellite = tieni(new THREE.PointsMaterial({ size: 0.035, transparent: true, depthWrite: false, sizeAttenuation: true }));
  const satelliti: Array<{ punto: T.Points; curva: T.EllipseCurve; anello: T.Object3D; velocita: number; t: number }> = [];
  [
    { rx: 1.32, ry: 1.18, rotX: 1.25, rotY: 0.3, vel: 0.035 },
    { rx: 1.48, ry: 1.36, rotX: 1.05, rotY: -0.6, vel: -0.025 },
    { rx: 1.62, ry: 1.5, rotX: 1.45, rotY: 1.1, vel: 0.018 },
  ].forEach((o, i) => {
    const curva = new THREE.EllipseCurve(0, 0, o.rx, o.ry, 0, Math.PI * 2, false, 0);
    const geo = tieni(new THREE.BufferGeometry().setFromPoints(curva.getPoints(220).map((p) => new THREE.Vector3(p.x, p.y, 0))));
    const anello = new THREE.LineLoop(geo, matAnello);
    anello.rotation.x = o.rotX;
    anello.rotation.y = o.rotY;
    orbite.add(anello);
    const gs = tieni(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3()]));
    const punto = new THREE.Points(gs, matSatellite);
    anello.add(punto);
    satelliti.push({ punto, curva, anello, velocita: o.vel, t: i * 0.33 });
  });

  /* ── i colori del tema ── */
  let temaApplicato: Tema | null = null;
  const applicaTema = () => {
    const t = temaRef.current ?? "scuro";
    if (t === temaApplicato) return;
    temaApplicato = t;
    const p = PALETTE[t];
    const blend = p.additivo ? THREE.AdditiveBlending : THREE.NormalBlending;
    matNucleo.color.set(p.nucleo);
    uPunti.uC1.value.set(p.punti[0]); uPunti.uC2.value.set(p.punti[1]); uPunti.uC3.value.set(p.punti[2]);
    uPunti.uForza.value = p.forza;
    matPunti.blending = blend; matPunti.needsUpdate = true;
    matReticolo.color.set(p.reticolo);
    uAtmosfera.uColore.value.set(p.atmosfera);
    uAtmosfera.uForza.value = p.additivo ? 1 : 0.55;
    matAtmosfera.blending = blend; matAtmosfera.needsUpdate = true;
    matNodo.color.set(p.nodi);
    onde.forEach((o) => { o.mat.color.set(p.nodi); });
    archi.forEach((a) => { (a.mat.uniforms.uColore.value as T.Color).set(p.archi); a.mat.uniforms.uForza.value = p.forza; a.mat.blending = blend; a.mat.needsUpdate = true; });
    matAnello.color.set(p.anelli);
    matSatellite.color.set(p.nodi);
  };

  /* ── misure ── */
  const misura = () => {
    const w = Math.max(1, box.clientWidth), h = Math.max(1, box.clientHeight);
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = `${w}px`;
    renderer.domElement.style.height = `${h}px`;
    camera.aspect = w / h;
    /* in verticale il globo si allontana, perché stia nella larghezza */
    camera.position.z = w / h < 0.8 ? 4.6 : 3.7;
    camera.updateProjectionMatrix();
    uPunti.uPixel.value = renderer.getPixelRatio() * Math.min(1.6, Math.max(0.8, h / 900));
  };
  misura();
  const osservaMisure = new ResizeObserver(() => { misura(); if (fermo) disegna(0); });
  osservaMisure.observe(box);

  /* ── il mirino: va di nodo in nodo fra quelli rivolti verso chi guarda ── */
  let attivo = 4;
  const schermo = { x: -999, y: -999 };
  const verso = new THREE.Vector3();
  const mondo = new THREE.Vector3();
  const nodoVisibile = (i: number) => {
    mondo.copy(posNodi[i]!).applyMatrix4(terra.matrixWorld);
    verso.copy(camera.position).sub(mondo).normalize();
    return mondo.clone().normalize().dot(verso) > 0.45;
  };
  /* prima i nodi fuori dal titolo (ai lati o in alto), poi qualunque nodo visibile */
  const fuoriDalTitolo = (i: number) => {
    mondo.copy(posNodi[i]!).applyMatrix4(terra.matrixWorld).project(camera);
    return Math.abs(mondo.x) > 0.5 || mondo.y > 0.68;
  };
  const prossimoNodo = () => {
    for (const fuori of [true, false]) {
      for (let k = 1; k <= NODI.length; k++) {
        const i = (attivo + k) % NODI.length;
        if (nodoVisibile(i) && (!fuori || fuoriDalTitolo(i))) { attivo = i; setNodo(i); return; }
      }
    }
  };
  const intervalloMirino = fermo ? 0 : window.setInterval(prossimoNodo, 3600);

  /* ── il puntatore sposta il globo di poco ── */
  const voluto = { x: 0, y: 0 }, ora = { x: 0, y: 0 };
  const segui = (e: PointerEvent) => {
    voluto.x = (e.clientX / window.innerWidth - 0.5) * 2;
    voluto.y = (e.clientY / window.innerHeight - 0.5) * 2;
  };
  if (!fermo) window.addEventListener("pointermove", segui, { passive: true });

  /* ── il disegno ── */
  let tempo = 0, ultimo = performance.now(), primo = true;
  const disegna = (dt: number) => {
    applicaTema();
    tempo += dt;
    if (!fermo) {
      terra.rotation.y += dt * 0.045;
      orbite.rotation.z += dt * 0.012;
      ora.x += (voluto.x - ora.x) * 0.03;
      ora.y += (voluto.y - ora.y) * 0.03;
      inclinazione.rotation.y = ora.x * 0.18;
      inclinazione.rotation.x = 0.32 + ora.y * 0.08;
    }
    uPunti.uTempo.value = tempo;
    archi.forEach((a) => { a.mat.uniforms.uTempo.value = tempo; });
    onde.forEach((o) => {
      const f = (tempo * 0.45 + o.fase) % 1;
      o.mesh.scale.setScalar(1 + f * 2.6);
      o.mat.opacity = (1 - f) * 0.85;
    });
    satelliti.forEach((s) => {
      s.t = (s.t + dt * s.velocita + 1) % 1;
      const p = s.curva.getPoint(s.t);
      (s.punto.geometry.getAttribute("position") as T.BufferAttribute).setXYZ(0, p.x, p.y, 0);
      s.punto.geometry.getAttribute("position").needsUpdate = true;
    });
    renderer.render(scena, camera);

    /* il mirino segue il nodo, con calma */
    const el = mirino.current;
    if (el) {
      terra.updateMatrixWorld();
      mondo.copy(posNodi[attivo]!).applyMatrix4(terra.matrixWorld);
      const proiettato = mondo.clone().project(camera);
      const w = box.clientWidth, h = box.clientHeight;
      const tx = (proiettato.x * 0.5 + 0.5) * w, ty = (-proiettato.y * 0.5 + 0.5) * h;
      if (schermo.x < -900 || fermo) { schermo.x = tx; schermo.y = ty; }
      schermo.x += (tx - schermo.x) * 0.08;
      schermo.y += (ty - schermo.y) * 0.08;
      el.style.transform = `translate3d(${schermo.x}px, ${schermo.y}px, 0)`;
      el.style.opacity = nodoVisibile(attivo) ? "1" : "0";
    }
    if (primo) { primo = false; pronto(); }
  };

  let id = 0, visibile = true;
  const passo = (adesso: number) => {
    const dt = Math.min(0.05, (adesso - ultimo) / 1000);
    ultimo = adesso;
    if (visibile && !document.hidden) disegna(dt);
    id = requestAnimationFrame(passo);
  };
  const osservaVista = new IntersectionObserver(([v]) => { visibile = !!v?.isIntersecting; }, { threshold: 0 });
  osservaVista.observe(box);
  if (fermo) {
    terra.updateMatrixWorld();
    prossimoNodo();
    disegna(0);
  } else {
    id = requestAnimationFrame(passo);
  }
  /* col movimento fermo il cambio di tema ridisegna */
  const ridisegnaFermo = fermo ? window.setInterval(() => { if (temaRef.current !== temaApplicato) disegna(0); }, 400) : 0;

  return () => {
    cancelAnimationFrame(id);
    window.clearInterval(intervalloMirino);
    window.clearInterval(ridisegnaFermo);
    window.removeEventListener("pointermove", segui);
    osservaMisure.disconnect();
    osservaVista.disconnect();
    daButtare.forEach((x) => x.dispose());
    renderer.dispose();
    renderer.domElement.remove();
  };
}
