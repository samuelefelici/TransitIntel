-- ═══════════════════════════════════════════════════════════════════════════
-- Il diario dell'AVM: una riga per (giornata, matricola)
-- ───────────────────────────────────────────────────────────────────────────
-- Lo stato del parco è un'istantanea, e su un'istantanea non si scrive una
-- segnalazione: chi la riceve risponde che quel giorno il mezzo era in
-- rimessa, e ha ragione. Questa tabella accumula invece la GIORNATA di ogni
-- apparato — quante volte ha parlato col centro, quante volte il centro lo
-- seguiva, quante volte si è localizzato, quante volte era su una corsa — così
-- che dopo una settimana si possa dire quali funzionano, quali no, e di chi è
-- il pezzo che manca.
--
-- I contatori sono CAMPIONI, non letture dell'AVM: il connettore scrive al
-- massimo una volta ogni due minuti (v. avm-diario-store.ts). Per le domande
-- che questa tabella deve reggere — "quel giorno ha fatto almeno una corsa?" —
-- un campione ogni due minuti è abbondante, e risparmia duemila riscritture
-- di ogni riga al giorno.
--
-- L'applicazione crea la tabella da sé al primo bisogno: questo file serve a
-- chi preferisce applicarla prima, e a lasciarne traccia nel repository.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS caronte.avm_diario (
  day                  date    NOT NULL,
  vehicle_ref          text    NOT NULL,
  letture              integer NOT NULL DEFAULT 0,
  letture_fresche      integer NOT NULL DEFAULT 0,
  letture_monitorata   integer NOT NULL DEFAULT 0,
  letture_posizione    integer NOT NULL DEFAULT 0,
  letture_corsa        integer NOT NULL DEFAULT 0,
  letture_errore_gps   integer NOT NULL DEFAULT 0,
  letture_errore_gprs  integer NOT NULL DEFAULT 0,
  letture_rimessa      integer NOT NULL DEFAULT 0,
  primo_contatto       timestamptz,
  ultimo_contatto      timestamptz,
  linee                text[]  NOT NULL DEFAULT '{}',
  corse                text[]  NOT NULL DEFAULT '{}',
  first_seen           timestamptz NOT NULL DEFAULT now(),
  last_seen            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, vehicle_ref)
);

CREATE INDEX IF NOT EXISTS idx_caronte_avm_diario_day
  ON caronte.avm_diario(day);
