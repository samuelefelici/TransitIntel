-- ═══════════════════════════════════════════════════════════════════════════
-- 0005 · Le richieste a Mizar: vetture da togliere o da aggiungere al flusso SIRI
-- ───────────────────────────────────────────────────────────────────────────
-- Mentre si sistemano gli apparati AVM, chi segue il parco chiede a Mizar
-- (il centro AVM) di togliere dall'anagrafica le vetture che l'officina non
-- ha più e di aggiungere quelle nuove. Qui si ricorda che cosa si è chiesto
-- e quando: la pagina AVM (scheda «Andamento») mostra le richieste ancora
-- aperte e da quanti giorni, e le chiude da sola quando il diario dell'AVM
-- (caronte.avm_diario) mostra la vettura sparita dal flusso o comparsa
-- (artifacts/api-server/src/lib/avm-storia.ts). chiusa_da NULL con esito
-- «fatta» vuol dire verificata da Cerbero.
--
-- Accanto agli altri archivi dell'AVM di Cerbero (avm_diario,
-- avm_controllo_settimanale). La scrive solo l'API, con il permesso
-- «centrale». argos_ro non la vede (il suo contratto è un elenco chiuso di
-- tabelle) e caronte_app neppure (caronte_setup.sql concede un elenco
-- esplicito). Di chi segna o chiude una richiesta si tiene solo l'id, senza
-- FK, come coda.lavori; le richieste chiuse si cancellano dopo 24 mesi.
--
-- Tabella nuova: nessun lock su tabelle esistenti, e il codice di prima non
-- la usa.
-- ═══════════════════════════════════════════════════════════════════════════
DO $richieste$
BEGIN
  IF to_regclass('caronte.avm_richieste_mizar') IS NULL THEN
    CREATE TABLE caronte.avm_richieste_mizar (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      -- la matricola come la pubblica SIRI
      vehicle_ref  text NOT NULL CONSTRAINT avm_richieste_mizar_vettura CHECK (char_length(vehicle_ref) BETWEEN 1 AND 20),
      tipo         text NOT NULL CONSTRAINT avm_richieste_mizar_tipo CHECK (tipo IN ('togliere', 'aggiungere')),
      -- il giorno in cui la richiesta è partita (lo dice chi la segna)
      richiesta_il date NOT NULL,
      nota         text CONSTRAINT avm_richieste_mizar_nota CHECK (char_length(nota) <= 500),
      creata_da    uuid,
      creata_il    timestamptz NOT NULL DEFAULT now(),
      -- NULL finché è aperta
      esito        text CONSTRAINT avm_richieste_mizar_esito CHECK (esito IN ('fatta', 'annullata')),
      chiusa_il    date,
      chiusa_da    uuid,
      CONSTRAINT avm_richieste_mizar_chiusura CHECK (
        (esito IS NULL) = (chiusa_il IS NULL) AND (chiusa_il IS NULL OR chiusa_il >= richiesta_il))
    );
  END IF;
END
$richieste$;
--> statement-breakpoint
DO $richieste$
BEGIN
  -- al più una richiesta aperta per vettura e tipo: il doppio clic e due persone insieme non la duplicano
  IF to_regclass('caronte.avm_richieste_mizar_aperte') IS NULL THEN
    CREATE UNIQUE INDEX avm_richieste_mizar_aperte
      ON caronte.avm_richieste_mizar (vehicle_ref, tipo) WHERE esito IS NULL;
  END IF;
END
$richieste$;
