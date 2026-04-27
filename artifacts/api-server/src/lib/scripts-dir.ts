/**
 * Resolve robusto della directory `scripts/` del monorepo.
 *
 * In dev (start-backend.sh) il cwd è `artifacts/api-server` → ../../scripts.
 * In produzione (Render: `node artifacts/api-server/dist/index.cjs`) il cwd è
 * la root del repo → ./scripts.
 * Vercel/altri ambienti possono variare ancora — proviamo una lista di
 * candidati e teniamo il primo che esiste.
 */
import path from "node:path";
import fs from "node:fs";

function firstExisting(candidates: string[]): string {
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, "vehicle_scheduler_cpsat.py"))) return c;
    } catch { /* ignore */ }
  }
  // Fallback: il primo candidato (errore più chiaro al primo spawn).
  return candidates[0];
}

const cwd = process.cwd();
const candidates = [
  path.resolve(cwd, "scripts"),                         // cwd = repo root (Render prod)
  path.resolve(cwd, "..", "..", "scripts"),             // cwd = artifacts/api-server (dev)
  path.resolve(cwd, "..", "scripts"),                   // cwd = artifacts (intermedio)
  path.resolve(__dirname, "..", "..", "..", "..", "scripts"),       // src/lib → root/scripts
  path.resolve(__dirname, "..", "..", "..", "..", "..", "scripts"), // dist bundle deeper
];

export const SCRIPTS_DIR: string = firstExisting(candidates);
