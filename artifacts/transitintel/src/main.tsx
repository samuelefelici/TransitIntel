import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
// Patch globale fetch: forza credentials:'include' su tutte le chiamate /api
// (necessario per cookie ti_auth cross-site Vercel ↔ Render).
import "./lib/fetch-credentials-patch";

// Recovery automatico da chunk obsoleti: dopo un deploy i vecchi hash non
// esistono più e i dynamic import falliscono (es. "Invalid mapLib" sulla
// mappa). Vite emette vite:preloadError: ricarichiamo una volta la pagina
// per riallineare la shell ai chunk nuovi.
window.addEventListener("vite:preloadError", () => {
  const KEY = "tt_chunk_reload";
  if (sessionStorage.getItem(KEY)) return; // evita loop di reload
  sessionStorage.setItem(KEY, "1");
  window.location.reload();
});

createRoot(document.getElementById("root")!).render(<App />);
