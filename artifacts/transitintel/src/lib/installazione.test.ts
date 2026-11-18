import { describe, expect, it } from "vitest";
import { collegamento, riassuntoInstallazione, vociInOrdine, type Voce } from "./installazione";

const voce = (v: string, stato: Voce["stato"], avviso: string | null = null, sezione: string | null = `azienda-${v}`): Voce => ({
  voce: v, titolo: v, stato, dettaglio: "", seManca: "", avviso, dove: { pagina: sezione ? "/admin/azienda" : "/admin/parametri", sezione, etichetta: v },
});

describe("lo stato dell'installazione nella pagina Azienda", () => {
  it("prima quello che serve, poi le facoltative, poi le compilate; dentro, l'ordine dell'API", () => {
    const voci = [voce("a", "compilata"), voce("b", "facoltativa"), voce("c", "da_compilare"), voce("d", "compilata"), voce("e", "da_compilare")];
    expect(vociInOrdine(voci).map((v) => v.voce)).toEqual(["c", "e", "b", "a", "d"]);
  });

  it("la riga in cima", () => {
    expect(riassuntoInstallazione({ daCompilare: 0, facoltativeVuote: 0, voci: [] })).toBe("Le voci che servono sono tutte compilate.");
    expect(riassuntoInstallazione({ daCompilare: 1, facoltativeVuote: 2, voci: [voce("x", "compilata", "attenzione")] }))
      .toBe("1 voce da compilare, 2 facoltative vuote, 1 avviso.");
    expect(riassuntoInstallazione({ daCompilare: 10, facoltativeVuote: 1, voci: [] })).toBe("10 voci da compilare, 1 facoltativa vuota.");
  });

  it("il collegamento: la sezione di questa pagina, o l'altra pagina", () => {
    expect(collegamento(voce("reti", "compilata"), "/admin/azienda")).toEqual({ tipo: "sezione", id: "azienda-reti" });
    expect(collegamento(voce("auto", "facoltativa", null, null), "/admin/azienda")).toEqual({ tipo: "pagina", href: "/admin/parametri" });
    expect(collegamento(voce("reti", "compilata"), "/altrove")).toEqual({ tipo: "pagina", href: "/admin/azienda#azienda-reti" });
  });
});
