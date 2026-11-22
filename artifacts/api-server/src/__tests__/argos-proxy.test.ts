/**
 * Il segreto che apre la porta di Argos arriva su OGNI chiamata.
 *
 * Argos ora rifiuta qualunque richiesta senza X-Argos-Proxy-Secret (salvo
 * /health): una fetch verso ARGOS_URL scritta domani senza argosHeaders()
 * prenderebbe un 401 in produzione, e il pannello si spegnerebbe in silenzio
 * su quella funzione. Il test legge i sorgenti: ogni `fetch(\`${ARGOS_URL}`
 * deve avere argosHeaders( dentro la sua chiamata.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { argosHeaders, argosProxyConfigured, ARGOS_PROXY_HEADER } from "../lib/argos-proxy";

const SRC = path.resolve(__dirname, "..");

function sorgenti(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "__tests__" && e.name !== "node_modules") out.push(...sorgenti(p)); }
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Il testo della chiamata fetch( … ) che inizia a `start`, parentesi bilanciate. */
function chiamata(testo: string, start: number): string {
  let depth = 0;
  for (let i = testo.indexOf("(", start); i < testo.length; i++) {
    if (testo[i] === "(") depth++;
    else if (testo[i] === ")") { depth--; if (depth === 0) return testo.slice(start, i + 1); }
  }
  return testo.slice(start);
}

describe("argosHeaders", () => {
  const prima = process.env.ARGOS_PROXY_SECRET;
  afterEach(() => {
    if (prima === undefined) delete process.env.ARGOS_PROXY_SECRET; else process.env.ARGOS_PROXY_SECRET = prima;
  });

  it("aggiunge il segreto alle intestazioni date, senza perderle", () => {
    process.env.ARGOS_PROXY_SECRET = "segreto-lungo";
    expect(argosHeaders({ "content-type": "application/json" }))
      .toEqual({ "content-type": "application/json", [ARGOS_PROXY_HEADER]: "segreto-lungo" });
    expect(argosProxyConfigured()).toBe(true);
  });

  it("senza segreto non inventa nulla: Argos risponderà 401 e /health lo dirà", () => {
    delete process.env.ARGOS_PROXY_SECRET;
    expect(argosHeaders({ a: "1" })).toEqual({ a: "1" });
    expect(argosProxyConfigured()).toBe(false);
    process.env.ARGOS_PROXY_SECRET = "   ";
    expect(argosProxyConfigured()).toBe(false);
  });

  it("non modifica l'oggetto che riceve", () => {
    process.env.ARGOS_PROXY_SECRET = "s";
    const base = { a: "1" };
    argosHeaders(base);
    expect(base).toEqual({ a: "1" });
  });
});

describe("ogni chiamata ad Argos porta il segreto", () => {
  const chiamate: { file: string; testo: string }[] = [];
  for (const f of sorgenti(SRC)) {
    const t = fs.readFileSync(f, "utf8");
    let i = t.indexOf("fetch(`${ARGOS_URL}");
    while (i >= 0) {
      chiamate.push({ file: path.relative(SRC, f), testo: chiamata(t, i) });
      i = t.indexOf("fetch(`${ARGOS_URL}", i + 1);
    }
  }

  it("le chiamate esistono (il test non gira a vuoto)", () => {
    expect(chiamate.length).toBeGreaterThanOrEqual(13);
  });

  it("nessuna fetch verso ARGOS_URL senza argosHeaders()", () => {
    const senza = chiamate.filter(c => !c.testo.includes("argosHeaders(")).map(c => `${c.file}: ${c.testo.slice(0, 80)}`);
    expect(senza).toEqual([]);
  });
});

describe("controllo all'avvio", () => {
  const salva = { ...process.env };
  afterEach(() => {
    for (const k of ["ARGOS_URL", "ARGOS_PROXY_SECRET", "CRON_SECRET", "ARGOS_CRON_SECRET"]) {
      if (salva[k] === undefined) delete process.env[k]; else process.env[k] = salva[k];
    }
  });

  it("avvisa se Argos è configurato ma il segreto manca", async () => {
    const { controllaSegretoArgosProxy } = await import("../lib/argos-proxy");
    process.env.ARGOS_URL = "http://argos:8000";
    delete process.env.ARGOS_PROXY_SECRET;
    expect(controllaSegretoArgosProxy().some(a => a.includes("ARGOS_PROXY_SECRET no"))).toBe(true);
  });

  it("avvisa se il segreto è uguale a un segreto cron", async () => {
    const { controllaSegretoArgosProxy } = await import("../lib/argos-proxy");
    process.env.ARGOS_URL = "http://argos:8000";
    process.env.ARGOS_PROXY_SECRET = "stesso";
    process.env.ARGOS_CRON_SECRET = "stesso";
    expect(controllaSegretoArgosProxy().some(a => a.includes("uguale a un segreto cron"))).toBe(true);
  });

  it("tace quando è tutto a posto", async () => {
    const { controllaSegretoArgosProxy } = await import("../lib/argos-proxy");
    process.env.ARGOS_URL = "http://argos:8000";
    process.env.ARGOS_PROXY_SECRET = "proprio";
    process.env.CRON_SECRET = "altro";
    process.env.ARGOS_CRON_SECRET = "altro-ancora";
    expect(controllaSegretoArgosProxy()).toEqual([]);
  });
});
