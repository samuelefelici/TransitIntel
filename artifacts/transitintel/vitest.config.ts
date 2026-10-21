/* I test della SPA: logica senza browser (menu, conti delle pagine). Niente
 * plugin di vite: solo l'alias «@» come nel build. */
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
