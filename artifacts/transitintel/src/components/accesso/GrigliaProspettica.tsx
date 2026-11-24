/**
 * Il fondo della pagina di accesso (tappa 7.33): una griglia in prospettiva
 * che respira piano e segue di poco il puntatore. Un solo shader su un
 * rettangolo a tutto schermo (WebGL 2), senza librerie.
 *
 * - Pixel limitati (DPR al più 1.5) e la griglia si ferma quando la scheda non
 *   si vede: la pagina resta leggera anche su un portatile vecchio.
 * - Con «riduci il movimento» del sistema si disegna un fotogramma solo.
 * - Senza WebGL resta il fondo in CSS della pagina (accesso.css).
 */
import { useEffect, useRef } from "react";

const VERTICI = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAMMENTI = `#version 300 es
precision highp float;
uniform vec2 u_dim;
uniform float u_t;
uniform vec2 u_mouse;
uniform vec3 u_linea;
uniform float u_forza;
out vec4 colore;

float griglia(vec2 q, float spessore) {
  vec2 d = fwidth(q);
  vec2 g = abs(fract(q - 0.5) - 0.5) / max(d, vec2(1e-4));
  return 1.0 - min(min(g.x, g.y) / spessore, 1.0);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_dim) / u_dim.y;
  float orizzonte = -0.16 + u_mouse.y * 0.015;
  float a = 0.0;
  if (uv.y < orizzonte) {
    float h = orizzonte - uv.y;
    float z = 0.42 / h;
    vec2 piano = vec2((uv.x + u_mouse.x * 0.04) * z * 1.6, z + u_t * 0.18);
    float linee = griglia(piano * 0.9, 1.15);
    float maggiori = griglia(piano * 0.18, 1.6);
    float nebbia = exp(-z * 0.11);
    float respiro = 0.78 + 0.22 * sin(u_t * 0.55);
    a = (linee * 0.55 + maggiori * 0.6) * nebbia * respiro;
    a += smoothstep(0.035, 0.0, h) * 0.55 * respiro;
  }
  float vignetta = smoothstep(1.25, 0.25, length(uv * vec2(0.8, 1.0)));
  colore = vec4(u_linea * a * vignetta * u_forza, a * vignetta * u_forza);
}`;

function compila(gl: WebGL2RenderingContext, tipo: number, sorgente: string): WebGLShader | null {
  const s = gl.createShader(tipo);
  if (!s) return null;
  gl.shaderSource(s, sorgente);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { gl.deleteShader(s); return null; }
  return s;
}

/** Il colore delle linee: verde menta sullo scuro, verde profondo sul chiaro. */
const LINEE: Record<"scuro" | "chiaro", { rgb: [number, number, number]; forza: number }> = {
  scuro: { rgb: [168 / 255, 216 / 255, 196 / 255], forza: 0.55 },
  chiaro: { rgb: [47 / 255, 125 / 255, 102 / 255], forza: 0.42 },
};

export default function GrigliaProspettica({ tema }: { tema: "scuro" | "chiaro" }) {
  const tela = useRef<HTMLCanvasElement>(null);
  const temaRef = useRef(tema);
  temaRef.current = tema;

  useEffect(() => {
    const cvs = tela.current;
    if (!cvs) return;
    const gl = cvs.getContext("webgl2", { alpha: true, antialias: true, premultipliedAlpha: true });
    if (!gl) { cvs.style.display = "none"; return; }
    const vs = compila(gl, gl.VERTEX_SHADER, VERTICI);
    const fs = compila(gl, gl.FRAGMENT_SHADER, FRAMMENTI);
    const prog = gl.createProgram();
    if (!vs || !fs || !prog) { cvs.style.display = "none"; return; }
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { cvs.style.display = "none"; return; }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const u = {
      dim: gl.getUniformLocation(prog, "u_dim"),
      t: gl.getUniformLocation(prog, "u_t"),
      mouse: gl.getUniformLocation(prog, "u_mouse"),
      linea: gl.getUniformLocation(prog, "u_linea"),
      forza: gl.getUniformLocation(prog, "u_forza"),
    };

    const fermo = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let w = 0, h = 0;
    const misura = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      w = Math.max(1, Math.floor(cvs.clientWidth * dpr));
      h = Math.max(1, Math.floor(cvs.clientHeight * dpr));
      if (cvs.width !== w || cvs.height !== h) { cvs.width = w; cvs.height = h; }
      gl.viewport(0, 0, w, h);
    };

    /* il puntatore sposta la griglia di poco, e con calma */
    const verso = { x: 0, y: 0 };
    const ora = { x: 0, y: 0 };
    const segui = (e: PointerEvent) => {
      verso.x = (e.clientX / window.innerWidth - 0.5) * 2;
      verso.y = (e.clientY / window.innerHeight - 0.5) * -2;
    };

    const inizio = performance.now();
    const disegna = (adesso: number) => {
      misura();
      ora.x += (verso.x - ora.x) * 0.03;
      ora.y += (verso.y - ora.y) * 0.03;
      const l = LINEE[temaRef.current];
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(u.dim, w, h);
      gl.uniform1f(u.t, fermo ? 4 : (adesso - inizio) / 1000);
      gl.uniform2f(u.mouse, ora.x, ora.y);
      gl.uniform3f(u.linea, l.rgb[0], l.rgb[1], l.rgb[2]);
      gl.uniform1f(u.forza, l.forza);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    let id = 0;
    const passo = (t: number) => {
      if (!document.hidden) disegna(t);
      id = requestAnimationFrame(passo);
    };
    const ridisegna = () => disegna(performance.now());

    if (fermo) {
      ridisegna();
      window.addEventListener("resize", ridisegna);
    } else {
      window.addEventListener("pointermove", segui, { passive: true });
      id = requestAnimationFrame(passo);
    }
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener("resize", ridisegna);
      window.removeEventListener("pointermove", segui);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buf);
    };
  }, []);

  /* col movimento fermo, il cambio di tema ridisegna l'unico fotogramma */
  useEffect(() => {
    window.dispatchEvent(new Event("resize"));
  }, [tema]);

  return <canvas ref={tela} aria-hidden className="accesso-griglia" />;
}
