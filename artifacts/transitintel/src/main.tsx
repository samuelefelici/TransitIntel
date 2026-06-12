import { createRoot } from "react-dom/client";
import { setBaseUrl } from "@workspace/api-client-react";
import App from "./App";
import "./index.css";
// Patch globale fetch: forza credentials:'include' su tutte le chiamate /api
// (necessario per cookie ti_auth cross-site Vercel ↔ Render).
import "./lib/fetch-credentials-patch";

// In produzione (Vercel), punta al backend Render
// In dev (Replit/locale), usa la stessa origine (proxy)
const apiBase = import.meta.env.VITE_API_BASE_URL || "";
if (apiBase) {
  setBaseUrl(apiBase);
}

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
