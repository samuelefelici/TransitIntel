/* Il lanciatore unico di Python (lib/lavori/python.ts): elenco degli script,
 * ambiente senza segreti, parser del progresso, e il processo vero (con node
 * al posto di python3): UTF-8 spezzato, righe di stderr, timeout, stop, tetto,
 * avvio fallito, EPIPE. */
import { describe, it, expect } from "vitest";
import {
  SCRIPT_CONSENTITI, ambientePython, eseguiProcesso, leggiProgresso, percorsoScript, scriptConsentito, type Progresso,
} from "../lib/lavori/python";

const NODE = process.execPath;
const nodo = (codice: string, o: Partial<Parameters<typeof eseguiProcesso>[0]> = {}) =>
  eseguiProcesso({ comando: NODE, argomenti: ["-e", codice], env: { PATH: process.env.PATH }, ...o });

describe("quali script e con quale ambiente", () => {
  it("solo gli 8 script dell'elenco, senza cartelle", () => {
    expect(SCRIPT_CONSENTITI).toHaveLength(8);
    expect(percorsoScript("crew_scheduler_v4.py", "/app/scripts")).toBe("/app/scripts/crew_scheduler_v4.py");
    for (const nome of ["../crew_scheduler_v4.py", "os.py", "crew_scheduler_v3.py", "/tmp/x.py", "crew_tools.py/../x.py", ""]) {
      expect(() => percorsoScript(nome, "/app/scripts"), nome).toThrow(/non consentito/);
      expect(scriptConsentito(nome)).toBe(false);
    }
  });

  it("Python non riceve i segreti dell'API", () => {
    const sorgente = {
      PATH: "/usr/bin", PYTHONPATH: "/app/.python_packages:/app/scripts", PYTHONDONTWRITEBYTECODE: "1", LC_ALL: "C.UTF-8", HOME: "/home/node",
      JWT_SECRET: "s", DATABASE_URL: "postgres://x", DATABASE_MIGRATOR_URL: "postgres://y", CERBERO_CHIAVE_MFA: "k", CRON_SECRET: "c",
      ARGOS_CRON_SECRET: "a", SIRI_PASSWORD: "p", FLEETCARE_SSO_SECRET: "f", CERBERO_ADMIN_PASSWORD: "x", OPENROUTE_API_KEY: "o",
      MAPBOX_TOKEN: "m", MAPBOX_ACCESS_TOKEN: "m2", HTTPS_PROXY: "http://proxy",
    };
    const env = ambientePython("crew_scheduler_v4.py", sorgente);
    expect(Object.keys(env).sort()).toEqual(["HOME", "LC_ALL", "PATH", "PYTHONDONTWRITEBYTECODE", "PYTHONPATH"]);
    // la relazione scarica le mappe: solo lei ha Mapbox, il proxy e i certificati
    const rel = ambientePython("report_builder.py", sorgente);
    expect(rel.MAPBOX_TOKEN).toBe("m");
    expect(rel.MAPBOX_ACCESS_TOKEN).toBe("m2");
    expect(rel.HTTPS_PROXY).toBe("http://proxy");
    expect(rel.JWT_SECRET).toBeUndefined();
    expect(rel.DATABASE_URL).toBeUndefined();
  });
});

describe("il progresso", () => {
  it("legge fase, percentuale, dettaglio ed extra", () => {
    expect(leggiProgresso("PROGRESS|optimize|42.5|scenario 3/14|", 1)).toEqual({ phase: "optimize", percentage: 42.5, detail: "scenario 3/14", timestamp: 1 });
    expect(leggiProgresso('PROGRESS|solving|150|x|{"round":2,"roundName":"a|b"}', 1)).toEqual({
      phase: "solving", percentage: 100, detail: "x", extra: { round: 2, roundName: "a|b" }, timestamp: 1,
    });
    expect(leggiProgresso("PROGRESS|x|nan|y|{rotto", 1)).toEqual({ phase: "x", percentage: 0, detail: "y", timestamp: 1 });
    expect(leggiProgresso("PROGRESS|solo|due")).toBeNull();
    expect(leggiProgresso("una riga qualunque")).toBeNull();
  });
});

describe("il processo", () => {
  it("JSON su stdin e stdout, con un carattere UTF-8 spezzato fra due pezzi", async () => {
    const e = await nodo(`
      let s = ""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => {
        const x = JSON.parse(s); process.stdout.write('{"ciao":"' + x.nome + ' ');
        process.stdout.write(Buffer.from([0xc3]));
        setTimeout(() => { process.stdout.write(Buffer.from([0xa9])); process.stdout.write('"}'); }, 50);
      });`, { ingresso: { nome: "Città" } });
    expect(e.motivo).toBe("uscito");
    expect(e.codice).toBe(0);
    expect(JSON.parse(e.stdout)).toEqual({ ciao: "Città é" });
  });

  it("righe di stderr e progresso separati, anche a pezzi", async () => {
    const righe: string[] = [];
    const prog: Progresso[] = [];
    const e = await nodo(`
      process.stderr.write("prima riga\\nPROGRESS|fase|5|det");
      setTimeout(() => process.stderr.write("taglio|\\nultima senza a capo"), 30);`,
    { suRigaStderr: r => righe.push(r), suProgresso: p => prog.push(p) });
    expect(e.codice).toBe(0);
    expect(righe).toEqual(["prima riga", "ultima senza a capo"]);
    expect(prog.map(p => [p.phase, p.percentage, p.detail])).toEqual([["fase", 5, "dettaglio"]]);
    expect(e.stderrTesta).toContain("prima riga");
    expect(e.stderrCoda).toContain("ultima senza a capo");
  });

  it("timeout: SIGINT, poi SIGKILL se il processo non esce", async () => {
    const e = await nodo(`process.on("SIGINT", () => {}); setInterval(() => {}, 1000);`, { timeoutMs: 200, attesaKillMs: 200 });
    expect(e.motivo).toBe("timeout");
    expect(e.segnaleUscita).toBe("SIGKILL");
  });

  it("stop: SIGINT, e lo script si ferma in ordine", async () => {
    const ac = new AbortController();
    const p = nodo(`process.on("SIGINT", () => { process.stdout.write('{"parziale":true}'); process.exit(0); }); setInterval(() => {}, 1000);`,
      { segnale: ac.signal, attesaKillMs: 2000, suAvvio: () => setTimeout(() => ac.abort(), 150) });
    const e = await p;
    expect(e.motivo).toBe("fermato");
    expect(e.codice).toBe(0);
  });

  it("uno stdout oltre il tetto ferma il processo", async () => {
    const e = await nodo(`process.stdout.write("x".repeat(100000)); setInterval(() => {}, 1000);`, { tettoStdout: 1000 });
    expect(e.motivo).toBe("tetto");
    expect(e.stdout).toBe("");
  });

  it("un comando che non parte", async () => {
    const e = await eseguiProcesso({ comando: "/non/esiste/python3", argomenti: [], env: {} });
    expect(e.motivo).toBe("avvio");
    expect(e.erroreAvvio).toMatch(/ENOENT/);
  });

  it("un processo che esce senza leggere lo stdin non fa cadere niente (EPIPE)", async () => {
    const e = await nodo(`process.exit(3)`, { ingresso: { grande: "x".repeat(5_000_000) } });
    expect(e.codice).toBe(3);
    expect(e.motivo).toBe("uscito");
  });
});
