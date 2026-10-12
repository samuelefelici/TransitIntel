-- ═══════════════════════════════════════════════════════════════════════════
-- L'archivio dei controlli settimanali dell'AVM: una riga per settimana chiusa
-- ───────────────────────────────────────────────────────────────────────────
-- Mentre l'officina e Mizar rimettono a posto gli apparati, la domanda è:
-- rispetto alla settimana prima, quali hanno ripreso a localizzarsi e quali
-- hanno smesso? Il controllo si calcola dal diario (caronte.avm_diario) e si
-- archivia qui il lunedì dopo la chiusura della settimana, congelato con lo
-- stato dell'officina e gli interventi di quel momento: chi lo rilegge dopo
-- tre settimane deve vedere quello che si vedeva allora.
--
-- `dati` è il controllo intero (ControlloSettimanale in
-- artifacts/api-server/src/lib/avm-controllo.ts), `versione` il calcolo che
-- l'ha prodotto. La settimana è identificata dal suo lunedì.
--
-- L'applicazione crea la tabella da sé al primo bisogno: questo file serve a
-- chi preferisce applicarla prima, e a lasciarne traccia nel repository.
--   psql "$DATABASE_URL" -f migrations/2026-10_avm_controllo_settimanale.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS caronte.avm_controllo_settimanale (
  settimana date PRIMARY KEY,
  generato_il timestamptz NOT NULL DEFAULT now(),
  versione integer NOT NULL,
  dati jsonb NOT NULL
);
