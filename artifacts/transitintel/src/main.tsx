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

createRoot(document.getElementById("root")!).render(<App />);
