import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Shield, Lock, Eye, EyeOff, AlertTriangle, ShieldCheck } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import logoImg from "/logo.png";

/* ─── MATRIX RAIN on <canvas>  (SLOWER) ─── */
function useMatrixRain(canvasRef: React.RefObject<HTMLCanvasElement | null>) {
  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext("2d")!;
    let animId: number;
    let cols: number[] = [];

    const CHARS = "01アイウエオカキクケコサシスセソタチツテトナニヌネノ⌐░▒▓█ABCDEF";
    const FONT_SIZE = 14;
    const w = () => cvs!.width;
    const h = () => cvs!.height;

    function resize() {
      cvs!.width = window.innerWidth;
      cvs!.height = window.innerHeight;
      const c = Math.floor(w() / FONT_SIZE);
      cols = Array.from({ length: c }, () => Math.random() * h() / FONT_SIZE);
    }
    resize();
    window.addEventListener("resize", resize);

    function draw() {
      // Slightly more aggressive fade → chars linger but still disappear
      ctx.fillStyle = "rgba(3, 7, 18, 0.04)";
      ctx.fillRect(0, 0, w(), h());

      for (let i = 0; i < cols.length; i++) {
        const ch = CHARS[Math.floor(Math.random() * CHARS.length)];
        const x = i * FONT_SIZE;
        const y = cols[i] * FONT_SIZE;

        const hue = Math.random() > 0.5 ? 199 : 220;
        const light = 40 + Math.random() * 35;
        const alpha = 0.5 + Math.random() * 0.35;
        ctx.fillStyle = `hsla(${hue}, 89%, ${light}%, ${alpha})`;
        ctx.font = `${FONT_SIZE}px monospace`;
        ctx.fillText(ch, x, y);

        if (Math.random() > 0.97) {
          ctx.fillStyle = `hsla(199, 100%, 75%, 0.85)`;
          ctx.fillText(ch, x, y);
        }

        if (y > h() && Math.random() > 0.98) {
          cols[i] = 0;
        }
        // ▸▸▸ MUCH SLOWER: was 0.6 + rand*0.4, now 0.15 + rand*0.2 ◂◂◂
        cols[i] += 0.15 + Math.random() * 0.20;
      }
      animId = requestAnimationFrame(draw);
    }
    draw();

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", resize);
    };
  }, [canvasRef]);
}

/* ─── SCANNING LINE EFFECT ─── */
function ScanLine() {
  return (
    <motion.div
      className="absolute left-0 right-0 h-px bg-gradient-to-r from-transparent via-cyan-400/30 to-transparent pointer-events-none"
      animate={{ top: ["0%", "100%"] }}
      transition={{ duration: 8, repeat: Infinity, ease: "linear" }}
    />
  );
}

/* ─── MAIN LOGIN PAGE ─── */
export default function LoginPage() {
  const { login } = useAuth();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState(false);
  const [shake, setShake] = useState(false);
  const [loading, setLoading] = useState(false);
  const [accessGranted, setAccessGranted] = useState(false);
  const [phase, setPhase] = useState<"idle" | "scanning" | "granted" | "entering">("idle");

  useMatrixRain(canvasRef);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      setError(false);
      setLoading(true);

      // Fake auth delay for cinematic feel
      setTimeout(() => {
        // Validate credentials without triggering auth state yet
        if (username !== "admin" || password !== "admin123") {
          setLoading(false);
          setError(true);
          setShake(true);
          setTimeout(() => setShake(false), 600);
        } else {
          setLoading(false);
          setAccessGranted(true);
          setPhase("scanning");

          // Phase 1: scanning (1.5s) → Phase 2: granted (2s) → Phase 3: entering (1.2s) → actually login
          setTimeout(() => setPhase("granted"), 1500);
          setTimeout(() => setPhase("entering"), 3500);
          setTimeout(() => login(username, password), 4700);
        }
      }, 1200);
    },
    [login, username, password],
  );

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[hsl(224,71%,4%)]">
      {/* Layer 1 — Matrix rain canvas */}
      <canvas ref={canvasRef} className="absolute inset-0 z-[1]" />

      {/* Layer 2 — Scan line */}
      <ScanLine />

      {/* Layer 3 — Vignette */}
      <div className="absolute inset-0 z-10 pointer-events-none bg-radial-[ellipse_at_center] from-transparent via-transparent to-[hsl(224,71%,4%)]" />

      {/* ═══ CINEMATIC ACCESS SEQUENCE ═══ */}
      <AnimatePresence>
        {accessGranted && (
          <motion.div
            className="absolute inset-0 z-50 flex items-center justify-center bg-[hsl(224,71%,4%)]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4 }}
          >
            {/* Phase 1: SCANNING — identity verification bars */}
            {phase === "scanning" && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="text-center"
              >
                <motion.div
                  className="w-16 h-16 mx-auto mb-6 rounded-full border border-cyan-500/40 flex items-center justify-center"
                  animate={{ rotate: 360 }}
                  transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                >
                  <div className="w-12 h-12 rounded-full border-2 border-transparent border-t-cyan-400 border-r-cyan-400/30" />
                </motion.div>
                <p className="font-mono text-sm text-cyan-400/80 tracking-[0.3em] uppercase">
                  Verifica Identità
                </p>
                <div className="mt-4 flex items-center justify-center gap-1">
                  {[0, 1, 2, 3, 4].map((j) => (
                    <motion.div
                      key={j}
                      className="w-8 h-1 rounded-full bg-cyan-500/30"
                      animate={{ backgroundColor: ["hsla(199,89%,48%,0.2)", "hsla(199,89%,48%,0.8)", "hsla(199,89%,48%,0.2)"] }}
                      transition={{ duration: 0.8, repeat: Infinity, delay: j * 0.15 }}
                    />
                  ))}
                </div>
                <p className="font-mono text-[10px] text-cyan-700 mt-3 tracking-wider">
                  Analisi credenziali in corso...
                </p>
              </motion.div>
            )}

            {/* Phase 2: GRANTED — big checkmark + authorized */}
            {phase === "granted" && (
              <motion.div
                initial={{ scale: 0.5, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: "spring", stiffness: 200, damping: 20 }}
                className="text-center"
              >
                <motion.div
                  className="w-24 h-24 mx-auto mb-5 rounded-full border-2 border-emerald-400/60 flex items-center justify-center"
                  animate={{
                    boxShadow: [
                      "0 0 0px hsla(160,60%,50%,0)",
                      "0 0 50px hsla(160,60%,50%,0.3)",
                      "0 0 0px hsla(160,60%,50%,0)",
                    ],
                  }}
                  transition={{ duration: 2, repeat: Infinity }}
                >
                  <motion.svg
                    width="48" height="48" viewBox="0 0 48 48"
                    initial={{ pathLength: 0 }}
                    animate={{ pathLength: 1 }}
                  >
                    <motion.path
                      d="M12 24 L20 32 L36 16"
                      fill="none"
                      stroke="hsl(160,60%,55%)"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      initial={{ pathLength: 0 }}
                      animate={{ pathLength: 1 }}
                      transition={{ duration: 0.6, ease: "easeOut" }}
                    />
                  </motion.svg>
                </motion.div>

                <motion.p
                  initial={{ y: 10, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ delay: 0.3 }}
                  className="font-mono text-xl text-emerald-400 tracking-[0.3em] uppercase"
                >
                  Accesso Autorizzato
                </motion.p>
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.6 }}
                  className="font-mono text-xs text-cyan-500/60 mt-2 tracking-wider"
                >
                  Livello di sicurezza: CLASSIFICATO
                </motion.p>
              </motion.div>
            )}

            {/* Phase 3: ENTERING — logo zoom + system boot */}
            {phase === "entering" && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.3 }}
                className="text-center"
              >
                <motion.img
                  src={logoImg}
                  alt="TransitIntel"
                  className="mx-auto h-24 w-auto object-contain"
                  initial={{ scale: 0.8, opacity: 0 }}
                  animate={{ scale: [0.8, 1.1, 1], opacity: 1 }}
                  transition={{ duration: 0.6, ease: "easeOut" }}
                />
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.3 }}
                  className="font-mono text-xs text-cyan-400/70 mt-4 tracking-[0.2em] uppercase"
                >
                  Inizializzazione sistema...
                </motion.p>
                <motion.div
                  className="mt-3 mx-auto h-0.5 rounded-full bg-cyan-900/50 overflow-hidden"
                  style={{ width: 200 }}
                >
                  <motion.div
                    className="h-full bg-gradient-to-r from-cyan-500 to-blue-500 rounded-full"
                    initial={{ width: "0%" }}
                    animate={{ width: "100%" }}
                    transition={{ duration: 1, ease: "easeInOut" }}
                  />
                </motion.div>
              </motion.div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* MAIN CONTENT */}
      <div className="relative z-20 flex flex-col items-center justify-center h-full px-4">
        {/* Top classified banner */}
        <motion.div
          initial={{ y: -40, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.2, duration: 0.8 }}
          className="absolute top-0 left-0 right-0 bg-cyan-500/10 border-b border-cyan-500/20 py-2 text-center"
        >
          <p className="font-mono text-[10px] text-cyan-400/70 tracking-[0.4em] uppercase">
            ▸ Sistema Classificato — Solo Personale Autorizzato ▸
          </p>
        </motion.div>

        {/* Logo section — image only, with floating luminous particles */}
        <motion.div
          initial={{ y: -30, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.5, duration: 0.8 }}
          className="text-center mb-8"
        >
          <div className="relative mx-auto w-full max-w-sm h-44 flex items-center justify-center">
            {/* Floating luminous particles around the logo */}
            {Array.from({ length: 12 }).map((_, i) => {
              const angle0 = (i / 12) * Math.PI * 2;
              const rx = 110 + (i % 3) * 18;
              const ry = 65 + (i % 2) * 15;
              const dur = 6 + (i % 4) * 1.5;
              const size = 2 + (i % 3);
              const delay = (i * 0.4);
              return (
                <motion.div
                  key={`p-${i}`}
                  className="absolute rounded-full"
                  style={{
                    width: size,
                    height: size,
                    background: i % 3 === 0
                      ? "hsl(199,89%,65%)"
                      : i % 3 === 1
                        ? "hsl(210,80%,60%)"
                        : "hsl(185,70%,55%)",
                    boxShadow: `0 0 ${size * 3}px ${
                      i % 3 === 0
                        ? "hsla(199,89%,65%,0.6)"
                        : i % 3 === 1
                          ? "hsla(210,80%,60%,0.5)"
                          : "hsla(185,70%,55%,0.5)"
                    }`,
                    top: "50%",
                    left: "50%",
                  }}
                  animate={{
                    x: [
                      Math.cos(angle0) * rx,
                      Math.cos(angle0 + Math.PI * 0.5) * rx * 0.9,
                      Math.cos(angle0 + Math.PI) * rx,
                      Math.cos(angle0 + Math.PI * 1.5) * rx * 0.9,
                      Math.cos(angle0) * rx,
                    ],
                    y: [
                      Math.sin(angle0) * ry,
                      Math.sin(angle0 + Math.PI * 0.5) * ry * 1.1,
                      Math.sin(angle0 + Math.PI) * ry,
                      Math.sin(angle0 + Math.PI * 1.5) * ry * 1.1,
                      Math.sin(angle0) * ry,
                    ],
                    opacity: [0.3, 0.7, 0.4, 0.8, 0.3],
                  }}
                  transition={{
                    duration: dur,
                    repeat: Infinity,
                    ease: "linear",
                    delay,
                  }}
                />
              );
            })}

            {/* Logo image */}
            <img
              src={logoImg}
              alt="TransitIntel"
              className="relative z-10 h-auto w-full max-w-sm object-contain drop-shadow-[0_0_20px_hsla(199,89%,48%,0.35)]"
            />
          </div>

          <p className="font-mono text-xs text-cyan-500/70 -mt-10 tracking-[0.25em] uppercase">
            Intelligence & Analytics Platform
          </p>
        </motion.div>

        {/* Login card */}
        <motion.div
          initial={{ y: 30, opacity: 0 }}
          animate={shake ? { x: [0, -10, 10, -10, 10, 0], y: 0, opacity: 1 } : { y: 0, opacity: 1 }}
          transition={shake ? { duration: 0.5 } : { delay: 0.8, duration: 0.8 }}
          className="w-full max-w-sm -mt-2"
        >
          <div className="relative rounded-xl border border-cyan-500/20 bg-[hsl(224,71%,4%)]/80 backdrop-blur-xl p-6 shadow-[0_0_60px_-15px_hsl(199,89%,48%,0.15)]">
            {/* Corner decorations */}
            <div className="absolute top-0 left-0 w-4 h-4 border-t-2 border-l-2 border-cyan-500/40 rounded-tl-xl" />
            <div className="absolute top-0 right-0 w-4 h-4 border-t-2 border-r-2 border-cyan-500/40 rounded-tr-xl" />
            <div className="absolute bottom-0 left-0 w-4 h-4 border-b-2 border-l-2 border-cyan-500/40 rounded-bl-xl" />
            <div className="absolute bottom-0 right-0 w-4 h-4 border-b-2 border-r-2 border-cyan-500/40 rounded-br-xl" />

            {/* Card header */}
            <div className="flex items-center gap-2 mb-6 pb-4 border-b border-cyan-500/10">
              <Lock className="w-4 h-4 text-cyan-500/60" />
              <span className="font-mono text-xs text-cyan-500/60 tracking-wider uppercase">
                Autenticazione Richiesta
              </span>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Username */}
              <div>
                <label className="block font-mono text-[11px] text-cyan-600 mb-1.5 tracking-wider uppercase">
                  Nome Utente
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full bg-[hsl(224,71%,8%)] border border-cyan-500/15 rounded-lg px-4 py-2.5 font-mono text-sm text-cyan-100 placeholder:text-cyan-800 focus:outline-none focus:border-cyan-500/40 focus:ring-1 focus:ring-cyan-500/20 transition-all"
                  placeholder="inserisci username"
                  autoComplete="username"
                  required
                />
              </div>

              {/* Password */}
              <div>
                <label className="block font-mono text-[11px] text-cyan-600 mb-1.5 tracking-wider uppercase">
                  Password
                </label>
                <div className="relative">
                  <input
                    type={showPass ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full bg-[hsl(224,71%,8%)] border border-cyan-500/15 rounded-lg px-4 py-2.5 pr-10 font-mono text-sm text-cyan-100 placeholder:text-cyan-800 focus:outline-none focus:border-cyan-500/40 focus:ring-1 focus:ring-cyan-500/20 transition-all"
                    placeholder="••••••••"
                    autoComplete="current-password"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPass(!showPass)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-cyan-600 hover:text-cyan-400 transition-colors"
                    tabIndex={-1}
                  >
                    {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* Error */}
              <AnimatePresence>
                {error && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="flex items-center gap-2 text-red-400 font-mono text-xs bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2"
                  >
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                    <span>Credenziali non valide. Accesso negato.</span>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Submit */}
              <button
                type="submit"
                disabled={loading}
                className="relative w-full py-2.5 rounded-lg font-mono text-sm tracking-wider uppercase overflow-hidden transition-all
                  bg-gradient-to-r from-cyan-600/80 to-blue-600/80 hover:from-cyan-500/90 hover:to-blue-500/90
                  text-white border border-cyan-400/20 hover:border-cyan-400/40 disabled:opacity-60"
              >
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <motion.span
                      className="inline-block w-4 h-4 border-2 border-white/40 border-t-white rounded-full"
                      animate={{ rotate: 360 }}
                      transition={{ duration: 0.8, repeat: Infinity, ease: "linear" }}
                    />
                    Verifica in corso...
                  </span>
                ) : (
                  <span className="flex items-center justify-center gap-2">
                    <Shield className="w-4 h-4" />
                    Accedi al Sistema
                  </span>
                )}
              </button>
            </form>
          </div>

          {/* Security badge — centered to match login card width */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1.5 }}
            className="mt-4 w-full flex justify-center"
          >
            <div className="inline-flex items-center gap-2.5 bg-emerald-500/10 border border-emerald-500/25 rounded-full px-5 py-2 whitespace-nowrap">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span className="font-mono text-[10px] text-emerald-300/90 tracking-wider">
                CONNESSIONE PROTETTA · CRITTOGRAFIA END-TO-END · v4.2.1
              </span>
            </div>
          </motion.div>
        </motion.div>

        {/* Bottom banner */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 2 }}
          className="absolute bottom-0 left-0 right-0 bg-slate-800/40 border-t border-slate-600/30 py-2.5 text-center backdrop-blur-sm"
        >
          <p className="font-mono text-[10px] text-slate-400 tracking-widest uppercase">
            © {new Date().getFullYear()} TransitIntel — Sistema Riservato — Tutti i diritti riservati
          </p>
        </motion.div>
      </div>
    </div>
  );
}
