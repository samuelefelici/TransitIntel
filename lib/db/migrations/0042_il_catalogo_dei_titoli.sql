-- ════════════════════════════════════════════════════════════════════════
-- 0042 — Il catalogo dei titoli di viaggio (tappa 6.9)
-- ────────────────────────────────────────────────────────────────────────
-- I biglietti e gli abbonamenti con cui si riempie un feed erano tre elenchi
-- nel codice, con i nomi e i prezzi di una sola azienda. Da qui sono un
-- catalogo dell'azienda:
--   titoli_catalogo   una riga per titolo. Chi riempie un feed dalla pagina
--                     Tariffe copia da qui i titoli che nel feed mancano.
--     titolo          l'identificativo, quello che finisce nel GTFS
--                     (fare_product_id): non cambia;
--     rete            la rete del titolo (tabella reti);
--     tipo            biglietto di corsa semplice (single) o di andata e
--                     ritorno (return), abbonamento settimanale, mensile o
--                     annuale;
--     fascia          solo per i titoli extraurbani che hanno un prezzo per
--                     fascia chilometrica: il numero della fascia (tabella
--                     fasce_km). Nel feed il nome prende la fascia e i suoi
--                     chilometri;
--     di_riferimento  il biglietto di corsa semplice con cui si calcola il
--                     prezzo di una corsa su una rete urbana: al più uno per
--                     rete.
-- I biglietti extraurbani di corsa semplice non stanno qui: sono uno per
-- fascia chilometrica, col prezzo della fascia.
-- Il catalogo di Conerobus entra solo nell'installazione di Conerobus (la
-- riga di azienda con gtfs_agency_id «conerobus»), uguale agli elenchi che
-- erano nel codice. Una nuova parte col catalogo vuoto.
-- ════════════════════════════════════════════════════════════════════════
DO $titoli$
BEGIN
  IF pg_catalog.to_regclass('public.titoli_catalogo') IS NULL THEN
    CREATE TABLE public.titoli_catalogo (
      titolo          text PRIMARY KEY CONSTRAINT titoli_catalogo_titolo CHECK (titolo ~ '^[a-z][a-z0-9_]{1,59}$'),
      nome            text NOT NULL CONSTRAINT titoli_catalogo_nome CHECK (char_length(btrim(nome)) BETWEEN 1 AND 120 AND nome !~ '[[:cntrl:]"]'),
      rete            text NOT NULL CONSTRAINT titoli_catalogo_rete_fkey REFERENCES public.reti (rete),
      tipo            text NOT NULL CONSTRAINT titoli_catalogo_tipo CHECK (tipo IN
                        ('single', 'return', 'abbonamento_settimanale', 'abbonamento_mensile', 'abbonamento_annuale')),
      categoria       text NOT NULL DEFAULT 'ordinario' CONSTRAINT titoli_catalogo_categoria CHECK (categoria ~ '^[a-z][a-z0-9_]{1,39}$'),
      prezzo          numeric(8,2) NOT NULL CONSTRAINT titoli_catalogo_prezzo CHECK (prezzo >= 0 AND prezzo <= 99999.99),
      durata_minuti   integer CONSTRAINT titoli_catalogo_durata CHECK (durata_minuti BETWEEN 1 AND 5256000),
      fascia          smallint CONSTRAINT titoli_catalogo_fascia CHECK (fascia BETWEEN 1 AND 60),
      di_riferimento  boolean NOT NULL DEFAULT false,
      ordine          integer NOT NULL DEFAULT 0 CONSTRAINT titoli_catalogo_ordine CHECK (ordine BETWEEN 0 AND 99999),
      aggiornato_il   timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT titoli_catalogo_fascia_extraurbana CHECK (fascia IS NULL OR rete = 'extraurbano'),
      CONSTRAINT titoli_catalogo_riferimento_urbano CHECK (NOT di_riferimento OR (tipo = 'single' AND rete <> 'extraurbano'))
    );
  END IF;
  IF pg_catalog.to_regclass('public.titoli_catalogo_un_riferimento') IS NULL THEN
    CREATE UNIQUE INDEX titoli_catalogo_un_riferimento ON public.titoli_catalogo (rete) WHERE di_riferimento;
  END IF;
  IF pg_catalog.to_regclass('public.titoli_catalogo_rete') IS NULL THEN
    CREATE INDEX titoli_catalogo_rete ON public.titoli_catalogo (rete, ordine);
  END IF;
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    ALTER TABLE public.titoli_catalogo OWNER TO cerbero_owner;
  END IF;
END $titoli$;
--> statement-breakpoint
SELECT registro.sorveglia('public.titoli_catalogo', ARRAY['titolo'], NULL, NULL, true, '{}', '{}', '{}');
--> statement-breakpoint
-- I dati come cerbero_owner, solo se sono già sue le tabelle che si toccano
-- (su un database appena creato sono ancora di chi migra) e se può già usare
-- lo schema: dove public non è aperto a tutti, il permesso lo dà il
-- riallineamento dei ruoli, dopo le migrazioni.
DO $come$ BEGIN
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    IF pg_catalog.has_schema_privilege('cerbero_owner', 'public', 'USAGE')
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                        WHERE c.oid IN (pg_catalog.to_regclass('public.azienda'), pg_catalog.to_regclass('public.reti'),
                                        pg_catalog.to_regclass('public.titoli_catalogo'))
                          AND c.relowner IS DISTINCT FROM pg_catalog.to_regrole('cerbero_owner')) THEN
      EXECUTE 'SET LOCAL ROLE cerbero_owner';
    END IF;
  END IF;
END $come$;
--> statement-breakpoint
-- Il catalogo di Conerobus, come era nel codice (tariffe ATMA, DGR Marche n.
-- 1036 del 2022). Le colonne: titolo, nome, rete, tipo, categoria, prezzo,
-- durata in minuti, fascia, di riferimento, ordine. Solo se il catalogo è
-- ancora vuoto, e solo i titoli delle reti che ci sono ancora: una seconda
-- esecuzione non rimette niente sopra a quello che l'amministratore ha cambiato.
INSERT INTO public.titoli_catalogo (titolo, nome, rete, tipo, categoria, prezzo, durata_minuti, fascia, di_riferimento, ordine)
SELECT t.titolo, t.nome, t.rete, t.tipo, t.categoria, t.prezzo, t.durata_minuti, t.fascia, t.di_riferimento, t.ordine
  FROM (VALUES
    ('ancona_mens_ord', 'Abbonamento Urbano Ancona Mensile Ordinario', 'urbano_ancona', 'abbonamento_mensile', 'ordinario', 35.00, 43200, NULL, false, 1),
    ('ancona_mens_argento', 'Abbonamento Urbano Ancona Mensile Argento (over 65)', 'urbano_ancona', 'abbonamento_mensile', 'anziano', 20.00, 43200, NULL, false, 2),
    ('ancona_mens_rosa', 'Abbonamento Urbano Ancona Mensile Rosa', 'urbano_ancona', 'abbonamento_mensile', 'ordinario', 27.00, 43200, NULL, false, 3),
    ('ancona_mens_isee', 'Abbonamento Urbano Ancona Mensile ISEE < 18.000', 'urbano_ancona', 'abbonamento_mensile', 'agevolato', 25.00, 43200, NULL, false, 4),
    ('ancona_ann_ord', 'Abbonamento Urbano Ancona Annuale Ordinario', 'urbano_ancona', 'abbonamento_annuale', 'ordinario', 300.00, 525600, NULL, false, 5),
    ('ancona_ann_web', 'Abbonamento Urbano Ancona Annuale Web', 'urbano_ancona', 'abbonamento_annuale', 'ordinario', 291.00, 525600, NULL, false, 6),
    ('ancona_ann_arg_isee_low', 'Abbonamento Urbano Ancona Annuale Argento ISEE < 18.000', 'urbano_ancona', 'abbonamento_annuale', 'agevolato', 210.00, 525600, NULL, false, 7),
    ('ancona_ann_arg_isee_high', 'Abbonamento Urbano Ancona Annuale Argento ISEE > 18.000', 'urbano_ancona', 'abbonamento_annuale', 'anziano', 240.00, 525600, NULL, false, 8),
    ('ancona_family_mens', 'Abbonamento Family Urbano Ancona Mensile', 'urbano_ancona', 'abbonamento_mensile', 'ordinario', 40.00, 43200, NULL, false, 9),
    ('ancona_mens_st_14p', 'Abbonamento Urbano Ancona Mensile Studente over 14', 'urbano_ancona', 'abbonamento_mensile', 'studente', 30.00, 43200, NULL, false, 10),
    ('ancona_mens_st_14m', 'Abbonamento Urbano Ancona Mensile Studente under 14', 'urbano_ancona', 'abbonamento_mensile', 'studente_under14', 20.00, 43200, NULL, false, 11),
    ('ancona_mens_st_isee', 'Abbonamento Urbano Ancona Mensile Studente ISEE < 18.000', 'urbano_ancona', 'abbonamento_mensile', 'studente_agevolato', 20.00, 43200, NULL, false, 12),
    ('ancona_ann_st_14p', 'Abbonamento Urbano Ancona Annuale Studente over 14 (1 set–31 ago)', 'urbano_ancona', 'abbonamento_annuale', 'studente', 225.00, 525600, NULL, false, 13),
    ('ancona_ann_st_14p_web', 'Abbonamento Urbano Ancona Annuale Studente Web', 'urbano_ancona', 'abbonamento_annuale', 'studente', 219.00, 525600, NULL, false, 14),
    ('ancona_ann_st_14m', 'Abbonamento Urbano Ancona Annuale Studente under 14', 'urbano_ancona', 'abbonamento_annuale', 'studente_under14', 150.00, 525600, NULL, false, 15),
    ('jesi_mens_ord', 'Abbonamento Urbano Jesi Mensile Ordinario', 'urbano_jesi', 'abbonamento_mensile', 'ordinario', 35.00, 43200, NULL, false, 16),
    ('jesi_ann_ord', 'Abbonamento Urbano Jesi Annuale Ordinario', 'urbano_jesi', 'abbonamento_annuale', 'ordinario', 320.00, 525600, NULL, false, 17),
    ('jesi_mens_anziani', 'Abbonamento Urbano Jesi Mensile Anziani (over 65)', 'urbano_jesi', 'abbonamento_mensile', 'anziano', 35.00, 43200, NULL, false, 18),
    ('jesi_mens_st', 'Abbonamento Urbano Jesi Mensile Studente', 'urbano_jesi', 'abbonamento_mensile', 'studente', 32.00, 43200, NULL, false, 19),
    ('jesi_ann_st', 'Abbonamento Urbano Jesi Annuale Studente (1 set–31 ago)', 'urbano_jesi', 'abbonamento_annuale', 'studente', 225.00, 525600, NULL, false, 20),
    ('falc_sett_ord', 'Abbonamento Urbano Falconara Settimanale Ordinario', 'urbano_falconara', 'abbonamento_settimanale', 'ordinario', 11.30, 10080, NULL, false, 21),
    ('falc_mens_ord', 'Abbonamento Urbano Falconara Mensile Ordinario', 'urbano_falconara', 'abbonamento_mensile', 'ordinario', 30.00, 43200, NULL, false, 22),
    ('falc_mens_argento', 'Abbonamento Urbano Falconara Mensile Argento (over 65)', 'urbano_falconara', 'abbonamento_mensile', 'anziano', 20.00, 43200, NULL, false, 23),
    ('falc_ann_ord', 'Abbonamento Urbano Falconara Annuale Ordinario', 'urbano_falconara', 'abbonamento_annuale', 'ordinario', 300.00, 525600, NULL, false, 24),
    ('falc_mens_st', 'Abbonamento Urbano Falconara Mensile Studente', 'urbano_falconara', 'abbonamento_mensile', 'studente', 30.00, 43200, NULL, false, 25),
    ('falc_mens_st_14m', 'Abbonamento Urbano Falconara Mensile Studente under 14', 'urbano_falconara', 'abbonamento_mensile', 'studente_under14', 20.00, 43200, NULL, false, 26),
    ('falc_ann_st', 'Abbonamento Urbano Falconara Annuale Studente (1 set–31 ago)', 'urbano_falconara', 'abbonamento_annuale', 'studente', 225.00, 525600, NULL, false, 27),
    ('cfd_mens_ord', 'Abbonamento Urbano Castelfidardo Mensile Ordinario', 'urbano_castelfidardo', 'abbonamento_mensile', 'ordinario', 30.00, 43200, NULL, false, 28),
    ('cfd_mens_st', 'Abbonamento Urbano Castelfidardo Mensile Studente', 'urbano_castelfidardo', 'abbonamento_mensile', 'studente', 30.00, 43200, NULL, false, 29),
    ('cfd_ann_st', 'Abbonamento Urbano Castelfidardo Annuale Studente (1 set–31 ago)', 'urbano_castelfidardo', 'abbonamento_annuale', 'studente', 225.00, 525600, NULL, false, 30),
    ('sasso_mens_ord', 'Abbonamento Urbano Sassoferrato Mensile Ordinario', 'urbano_sassoferrato', 'abbonamento_mensile', 'ordinario', 30.00, 43200, NULL, false, 31),
    ('sasso_sett_ord', 'Abbonamento Urbano Sassoferrato Settimanale Ordinario', 'urbano_sassoferrato', 'abbonamento_settimanale', 'ordinario', 11.30, 10080, NULL, false, 32),
    ('sasso_sett_st', 'Abbonamento Urbano Sassoferrato Settimanale Studente', 'urbano_sassoferrato', 'abbonamento_settimanale', 'studente', 11.30, 10080, NULL, false, 33),
    ('sasso_mens_st', 'Abbonamento Urbano Sassoferrato Mensile Studente', 'urbano_sassoferrato', 'abbonamento_mensile', 'studente', 30.00, 43200, NULL, false, 34),
    ('sasso_ann_st', 'Abbonamento Urbano Sassoferrato Annuale Studente (1 set–31 ago)', 'urbano_sassoferrato', 'abbonamento_annuale', 'studente', 225.00, 525600, NULL, false, 35),
    ('senigallia_sett_ord', 'Abbonamento Urbano Senigallia Settimanale Ordinario', 'urbano_senigallia', 'abbonamento_settimanale', 'ordinario', 11.30, 10080, NULL, false, 36),
    ('senigallia_mens_ord', 'Abbonamento Urbano Senigallia Mensile Ordinario', 'urbano_senigallia', 'abbonamento_mensile', 'ordinario', 30.00, 43200, NULL, false, 37),
    ('senigallia_mens_st', 'Abbonamento Urbano Senigallia Mensile Studente', 'urbano_senigallia', 'abbonamento_mensile', 'studente', 30.00, 43200, NULL, false, 38),
    ('senigallia_ann_st', 'Abbonamento Urbano Senigallia Annuale Studente (1 set–31 ago)', 'urbano_senigallia', 'abbonamento_annuale', 'studente', 225.00, 525600, NULL, false, 39),
    ('univpm_alpha', 'UNIVPM Alpha — Urbano Ancona 9 mesi (ott–giu), quota studente', 'urbano_ancona', 'abbonamento_annuale', 'studente_univpm', 130.00, 388800, NULL, false, 40),
    ('univpm_beta', 'UNIVPM Beta — Urbano Ancona 12 mesi, quota studente', 'urbano_ancona', 'abbonamento_annuale', 'studente_univpm', 150.00, 525600, NULL, false, 41),
    ('univpm_gamma', 'UNIVPM Gamma — Integrato extraurbano ≤18 km + urbano, quota studente', 'extraurbano', 'abbonamento_annuale', 'studente_univpm', 250.00, 388800, NULL, false, 42),
    ('univpm_delta', 'UNIVPM Delta — Integrato extraurbano ≤36 km + urbano, quota studente', 'extraurbano', 'abbonamento_annuale', 'studente_univpm', 300.00, 388800, NULL, false, 43),
    ('extra_sett_ord_fascia_1', 'Extraurbano Settimanale Ordinario', 'extraurbano', 'abbonamento_settimanale', 'ordinario', 11.30, 10080, 1, false, 44),
    ('extra_sett_ord_fascia_2', 'Extraurbano Settimanale Ordinario', 'extraurbano', 'abbonamento_settimanale', 'ordinario', 16.20, 10080, 2, false, 45),
    ('extra_sett_ord_fascia_3', 'Extraurbano Settimanale Ordinario', 'extraurbano', 'abbonamento_settimanale', 'ordinario', 19.80, 10080, 3, false, 46),
    ('extra_sett_ord_fascia_4', 'Extraurbano Settimanale Ordinario', 'extraurbano', 'abbonamento_settimanale', 'ordinario', 23.40, 10080, 4, false, 47),
    ('extra_sett_ord_fascia_5', 'Extraurbano Settimanale Ordinario', 'extraurbano', 'abbonamento_settimanale', 'ordinario', 26.10, 10080, 5, false, 48),
    ('extra_sett_ord_fascia_6', 'Extraurbano Settimanale Ordinario', 'extraurbano', 'abbonamento_settimanale', 'ordinario', 28.40, 10080, 6, false, 49),
    ('extra_sett_ord_fascia_7', 'Extraurbano Settimanale Ordinario', 'extraurbano', 'abbonamento_settimanale', 'ordinario', 30.60, 10080, 7, false, 50),
    ('extra_sett_ord_fascia_8', 'Extraurbano Settimanale Ordinario', 'extraurbano', 'abbonamento_settimanale', 'ordinario', 34.70, 10080, 8, false, 51),
    ('extra_sett_ord_fascia_9', 'Extraurbano Settimanale Ordinario', 'extraurbano', 'abbonamento_settimanale', 'ordinario', 36.90, 10080, 9, false, 52),
    ('extra_sett_ord_fascia_10', 'Extraurbano Settimanale Ordinario', 'extraurbano', 'abbonamento_settimanale', 'ordinario', 37.80, 10080, 10, false, 53),
    ('extra_sett_ord_fascia_11', 'Extraurbano Settimanale Ordinario', 'extraurbano', 'abbonamento_settimanale', 'ordinario', 42.30, 10080, 11, false, 54),
    ('extra_sett_ord_fascia_12', 'Extraurbano Settimanale Ordinario', 'extraurbano', 'abbonamento_settimanale', 'ordinario', 46.35, 10080, 12, false, 55),
    ('extra_mens_ord_fascia_1', 'Extraurbano Mensile Ordinario', 'extraurbano', 'abbonamento_mensile', 'ordinario', 30.00, 43200, 1, false, 56),
    ('extra_mens_ord_fascia_2', 'Extraurbano Mensile Ordinario', 'extraurbano', 'abbonamento_mensile', 'ordinario', 43.20, 43200, 2, false, 57),
    ('extra_mens_ord_fascia_3', 'Extraurbano Mensile Ordinario', 'extraurbano', 'abbonamento_mensile', 'ordinario', 52.80, 43200, 3, false, 58),
    ('extra_mens_ord_fascia_4', 'Extraurbano Mensile Ordinario', 'extraurbano', 'abbonamento_mensile', 'ordinario', 62.40, 43200, 4, false, 59),
    ('extra_mens_ord_fascia_5', 'Extraurbano Mensile Ordinario', 'extraurbano', 'abbonamento_mensile', 'ordinario', 69.60, 43200, 5, false, 60),
    ('extra_mens_ord_fascia_6', 'Extraurbano Mensile Ordinario', 'extraurbano', 'abbonamento_mensile', 'ordinario', 75.60, 43200, 6, false, 61),
    ('extra_mens_ord_fascia_7', 'Extraurbano Mensile Ordinario', 'extraurbano', 'abbonamento_mensile', 'ordinario', 81.60, 43200, 7, false, 62),
    ('extra_mens_ord_fascia_8', 'Extraurbano Mensile Ordinario', 'extraurbano', 'abbonamento_mensile', 'ordinario', 92.40, 43200, 8, false, 63),
    ('extra_mens_ord_fascia_9', 'Extraurbano Mensile Ordinario', 'extraurbano', 'abbonamento_mensile', 'ordinario', 98.40, 43200, 9, false, 64),
    ('extra_mens_ord_fascia_10', 'Extraurbano Mensile Ordinario', 'extraurbano', 'abbonamento_mensile', 'ordinario', 100.80, 43200, 10, false, 65),
    ('extra_mens_ord_fascia_11', 'Extraurbano Mensile Ordinario', 'extraurbano', 'abbonamento_mensile', 'ordinario', 112.80, 43200, 11, false, 66),
    ('extra_mens_ord_fascia_12', 'Extraurbano Mensile Ordinario', 'extraurbano', 'abbonamento_mensile', 'ordinario', 123.60, 43200, 12, false, 67),
    ('extra_mens_st_fascia_1', 'Extraurbano Mensile Studente', 'extraurbano', 'abbonamento_mensile', 'studente', 30.00, 43200, 1, false, 68),
    ('extra_mens_st_fascia_2', 'Extraurbano Mensile Studente', 'extraurbano', 'abbonamento_mensile', 'studente', 43.20, 43200, 2, false, 69),
    ('extra_mens_st_fascia_3', 'Extraurbano Mensile Studente', 'extraurbano', 'abbonamento_mensile', 'studente', 52.80, 43200, 3, false, 70),
    ('extra_mens_st_fascia_4', 'Extraurbano Mensile Studente', 'extraurbano', 'abbonamento_mensile', 'studente', 62.40, 43200, 4, false, 71),
    ('extra_mens_st_fascia_5', 'Extraurbano Mensile Studente', 'extraurbano', 'abbonamento_mensile', 'studente', 69.60, 43200, 5, false, 72),
    ('extra_mens_st_fascia_6', 'Extraurbano Mensile Studente', 'extraurbano', 'abbonamento_mensile', 'studente', 75.60, 43200, 6, false, 73),
    ('extra_mens_st_fascia_7', 'Extraurbano Mensile Studente', 'extraurbano', 'abbonamento_mensile', 'studente', 81.60, 43200, 7, false, 74),
    ('extra_mens_st_fascia_8', 'Extraurbano Mensile Studente', 'extraurbano', 'abbonamento_mensile', 'studente', 92.40, 43200, 8, false, 75),
    ('extra_mens_st_fascia_9', 'Extraurbano Mensile Studente', 'extraurbano', 'abbonamento_mensile', 'studente', 98.40, 43200, 9, false, 76),
    ('extra_mens_st_fascia_10', 'Extraurbano Mensile Studente', 'extraurbano', 'abbonamento_mensile', 'studente', 100.80, 43200, 10, false, 77),
    ('extra_mens_st_fascia_11', 'Extraurbano Mensile Studente', 'extraurbano', 'abbonamento_mensile', 'studente', 112.80, 43200, 11, false, 78),
    ('extra_mens_st_fascia_12', 'Extraurbano Mensile Studente', 'extraurbano', 'abbonamento_mensile', 'studente', 123.60, 43200, 12, false, 79),
    ('extra_ann_ord_fascia_1', 'Extraurbano Annuale Ordinario', 'extraurbano', 'abbonamento_annuale', 'ordinario', 300.00, 525600, 1, false, 80),
    ('extra_ann_ord_fascia_2', 'Extraurbano Annuale Ordinario', 'extraurbano', 'abbonamento_annuale', 'ordinario', 432.00, 525600, 2, false, 81),
    ('extra_ann_ord_fascia_3', 'Extraurbano Annuale Ordinario', 'extraurbano', 'abbonamento_annuale', 'ordinario', 528.00, 525600, 3, false, 82),
    ('extra_ann_ord_fascia_4', 'Extraurbano Annuale Ordinario', 'extraurbano', 'abbonamento_annuale', 'ordinario', 624.00, 525600, 4, false, 83),
    ('extra_ann_ord_fascia_5', 'Extraurbano Annuale Ordinario', 'extraurbano', 'abbonamento_annuale', 'ordinario', 696.00, 525600, 5, false, 84),
    ('extra_ann_ord_fascia_6', 'Extraurbano Annuale Ordinario', 'extraurbano', 'abbonamento_annuale', 'ordinario', 756.00, 525600, 6, false, 85),
    ('extra_ann_ord_fascia_7', 'Extraurbano Annuale Ordinario', 'extraurbano', 'abbonamento_annuale', 'ordinario', 816.00, 525600, 7, false, 86),
    ('extra_ann_ord_fascia_8', 'Extraurbano Annuale Ordinario', 'extraurbano', 'abbonamento_annuale', 'ordinario', 924.00, 525600, 8, false, 87),
    ('extra_ann_ord_fascia_9', 'Extraurbano Annuale Ordinario', 'extraurbano', 'abbonamento_annuale', 'ordinario', 984.00, 525600, 9, false, 88),
    ('extra_ann_ord_fascia_10', 'Extraurbano Annuale Ordinario', 'extraurbano', 'abbonamento_annuale', 'ordinario', 1008.00, 525600, 10, false, 89),
    ('extra_ann_ord_fascia_11', 'Extraurbano Annuale Ordinario', 'extraurbano', 'abbonamento_annuale', 'ordinario', 1128.00, 525600, 11, false, 90),
    ('extra_ann_ord_fascia_12', 'Extraurbano Annuale Ordinario', 'extraurbano', 'abbonamento_annuale', 'ordinario', 1236.00, 525600, 12, false, 91),
    ('extra_ann_st_fascia_1', 'Extraurbano Annuale Studente', 'extraurbano', 'abbonamento_annuale', 'studente', 225.00, 525600, 1, false, 92),
    ('extra_ann_st_fascia_2', 'Extraurbano Annuale Studente', 'extraurbano', 'abbonamento_annuale', 'studente', 324.00, 525600, 2, false, 93),
    ('extra_ann_st_fascia_3', 'Extraurbano Annuale Studente', 'extraurbano', 'abbonamento_annuale', 'studente', 396.00, 525600, 3, false, 94),
    ('extra_ann_st_fascia_4', 'Extraurbano Annuale Studente', 'extraurbano', 'abbonamento_annuale', 'studente', 468.00, 525600, 4, false, 95),
    ('extra_ann_st_fascia_5', 'Extraurbano Annuale Studente', 'extraurbano', 'abbonamento_annuale', 'studente', 522.00, 525600, 5, false, 96),
    ('extra_ann_st_fascia_6', 'Extraurbano Annuale Studente', 'extraurbano', 'abbonamento_annuale', 'studente', 567.00, 525600, 6, false, 97),
    ('extra_ann_st_fascia_7', 'Extraurbano Annuale Studente', 'extraurbano', 'abbonamento_annuale', 'studente', 612.00, 525600, 7, false, 98),
    ('extra_ann_st_fascia_8', 'Extraurbano Annuale Studente', 'extraurbano', 'abbonamento_annuale', 'studente', 693.00, 525600, 8, false, 99),
    ('extra_ann_st_fascia_9', 'Extraurbano Annuale Studente', 'extraurbano', 'abbonamento_annuale', 'studente', 738.00, 525600, 9, false, 100),
    ('extra_ann_st_fascia_10', 'Extraurbano Annuale Studente', 'extraurbano', 'abbonamento_annuale', 'studente', 756.00, 525600, 10, false, 101),
    ('extra_ann_st_fascia_11', 'Extraurbano Annuale Studente', 'extraurbano', 'abbonamento_annuale', 'studente', 846.00, 525600, 11, false, 102),
    ('extra_ann_st_fascia_12', 'Extraurbano Annuale Studente', 'extraurbano', 'abbonamento_annuale', 'studente', 927.00, 525600, 12, false, 103),
    ('extra_mens_int_ord_fascia_1', 'Extraurbano Mensile Integrato Ancona', 'extraurbano', 'abbonamento_mensile', 'ordinario', 52.50, 43200, 1, false, 104),
    ('extra_mens_int_ord_fascia_2', 'Extraurbano Mensile Integrato Ancona', 'extraurbano', 'abbonamento_mensile', 'ordinario', 64.20, 43200, 2, false, 105),
    ('extra_mens_int_ord_fascia_3', 'Extraurbano Mensile Integrato Ancona', 'extraurbano', 'abbonamento_mensile', 'ordinario', 71.20, 43200, 3, false, 106),
    ('extra_mens_int_ord_fascia_4', 'Extraurbano Mensile Integrato Ancona', 'extraurbano', 'abbonamento_mensile', 'ordinario', 78.00, 43200, 4, false, 107),
    ('extra_mens_int_ord_fascia_5', 'Extraurbano Mensile Integrato Ancona', 'extraurbano', 'abbonamento_mensile', 'ordinario', 84.00, 43200, 5, false, 108),
    ('extra_mens_int_ord_fascia_6', 'Extraurbano Mensile Integrato Ancona', 'extraurbano', 'abbonamento_mensile', 'ordinario', 89.70, 43200, 6, false, 109),
    ('extra_mens_int_ord_fascia_7', 'Extraurbano Mensile Integrato Ancona', 'extraurbano', 'abbonamento_mensile', 'ordinario', 95.40, 43200, 7, false, 110),
    ('extra_mens_int_ord_fascia_8', 'Extraurbano Mensile Integrato Ancona', 'extraurbano', 'abbonamento_mensile', 'ordinario', 105.70, 43200, 8, false, 111),
    ('extra_mens_int_ord_fascia_9', 'Extraurbano Mensile Integrato Ancona', 'extraurbano', 'abbonamento_mensile', 'ordinario', 111.40, 43200, 9, false, 112),
    ('extra_mens_int_ord_fascia_10', 'Extraurbano Mensile Integrato Ancona', 'extraurbano', 'abbonamento_mensile', 'ordinario', 113.70, 43200, 10, false, 113),
    ('extra_mens_int_ord_fascia_11', 'Extraurbano Mensile Integrato Ancona', 'extraurbano', 'abbonamento_mensile', 'ordinario', 125.10, 43200, 11, false, 114),
    ('extra_mens_int_ord_fascia_12', 'Extraurbano Mensile Integrato Ancona', 'extraurbano', 'abbonamento_mensile', 'ordinario', 135.30, 43200, 12, false, 115),
    ('extra_mens_int_st_fascia_1', 'Extraurbano Mensile Integrato Ancona Studente', 'extraurbano', 'abbonamento_mensile', 'studente', 37.50, 43200, 1, false, 116),
    ('extra_mens_int_st_fascia_2', 'Extraurbano Mensile Integrato Ancona Studente', 'extraurbano', 'abbonamento_mensile', 'studente', 50.70, 43200, 2, false, 117),
    ('extra_mens_int_st_fascia_3', 'Extraurbano Mensile Integrato Ancona Studente', 'extraurbano', 'abbonamento_mensile', 'studente', 60.30, 43200, 3, false, 118),
    ('extra_mens_int_st_fascia_4', 'Extraurbano Mensile Integrato Ancona Studente', 'extraurbano', 'abbonamento_mensile', 'studente', 69.60, 43200, 4, false, 119),
    ('extra_mens_int_st_fascia_5', 'Extraurbano Mensile Integrato Ancona Studente', 'extraurbano', 'abbonamento_mensile', 'studente', 77.10, 43200, 5, false, 120),
    ('extra_mens_int_st_fascia_6', 'Extraurbano Mensile Integrato Ancona Studente', 'extraurbano', 'abbonamento_mensile', 'studente', 83.10, 43200, 6, false, 121),
    ('extra_mens_int_st_fascia_7', 'Extraurbano Mensile Integrato Ancona Studente', 'extraurbano', 'abbonamento_mensile', 'studente', 89.10, 43200, 7, false, 122),
    ('extra_mens_int_st_fascia_8', 'Extraurbano Mensile Integrato Ancona Studente', 'extraurbano', 'abbonamento_mensile', 'studente', 99.90, 43200, 8, false, 123),
    ('extra_mens_int_st_fascia_9', 'Extraurbano Mensile Integrato Ancona Studente', 'extraurbano', 'abbonamento_mensile', 'studente', 105.90, 43200, 9, false, 124),
    ('extra_mens_int_st_fascia_10', 'Extraurbano Mensile Integrato Ancona Studente', 'extraurbano', 'abbonamento_mensile', 'studente', 108.30, 43200, 10, false, 125),
    ('extra_mens_int_st_fascia_11', 'Extraurbano Mensile Integrato Ancona Studente', 'extraurbano', 'abbonamento_mensile', 'studente', 120.30, 43200, 11, false, 126),
    ('extra_mens_int_st_fascia_12', 'Extraurbano Mensile Integrato Ancona Studente', 'extraurbano', 'abbonamento_mensile', 'studente', 131.10, 43200, 12, false, 127),
    ('extra_ann_int_st_fascia_1', 'Extraurbano Annuale Integrato Ancona Studente', 'extraurbano', 'abbonamento_annuale', 'studente', 281.25, 525600, 1, false, 128),
    ('extra_ann_int_st_fascia_2', 'Extraurbano Annuale Integrato Ancona Studente', 'extraurbano', 'abbonamento_annuale', 'studente', 380.25, 525600, 2, false, 129),
    ('extra_ann_int_st_fascia_3', 'Extraurbano Annuale Integrato Ancona Studente', 'extraurbano', 'abbonamento_annuale', 'studente', 452.25, 525600, 3, false, 130),
    ('extra_ann_int_st_fascia_4', 'Extraurbano Annuale Integrato Ancona Studente', 'extraurbano', 'abbonamento_annuale', 'studente', 524.25, 525600, 4, false, 131),
    ('extra_ann_int_st_fascia_5', 'Extraurbano Annuale Integrato Ancona Studente', 'extraurbano', 'abbonamento_annuale', 'studente', 578.25, 525600, 5, false, 132),
    ('extra_ann_int_st_fascia_6', 'Extraurbano Annuale Integrato Ancona Studente', 'extraurbano', 'abbonamento_annuale', 'studente', 623.25, 525600, 6, false, 133),
    ('extra_ann_int_st_fascia_7', 'Extraurbano Annuale Integrato Ancona Studente', 'extraurbano', 'abbonamento_annuale', 'studente', 688.25, 525600, 7, false, 134),
    ('extra_ann_int_st_fascia_8', 'Extraurbano Annuale Integrato Ancona Studente', 'extraurbano', 'abbonamento_annuale', 'studente', 749.25, 525600, 8, false, 135),
    ('extra_ann_int_st_fascia_9', 'Extraurbano Annuale Integrato Ancona Studente', 'extraurbano', 'abbonamento_annuale', 'studente', 794.25, 525600, 9, false, 136),
    ('extra_ann_int_st_fascia_10', 'Extraurbano Annuale Integrato Ancona Studente', 'extraurbano', 'abbonamento_annuale', 'studente', 812.25, 525600, 10, false, 137),
    ('extra_ann_int_st_fascia_11', 'Extraurbano Annuale Integrato Ancona Studente', 'extraurbano', 'abbonamento_annuale', 'studente', 902.25, 525600, 11, false, 138),
    ('extra_ann_int_st_fascia_12', 'Extraurbano Annuale Integrato Ancona Studente', 'extraurbano', 'abbonamento_annuale', 'studente', 983.25, 525600, 12, false, 139),
    ('ancona_60min', 'Biglietto Urbano Ancona 60 min', 'urbano_ancona', 'single', 'ordinario', 1.35, 60, NULL, true, 140),
    ('ancona_100min', 'Biglietto Urbano Ancona 100 min', 'urbano_ancona', 'single', 'ordinario', 1.50, 100, NULL, false, 141),
    ('ancona_ar', 'Biglietto Urbano Ancona A/R (240 min)', 'urbano_ancona', 'return', 'ordinario', 2.50, NULL, NULL, false, 142),
    ('ancona_24h', 'Biglietto Urbano Ancona 24 ore', 'urbano_ancona', 'single', 'ordinario', 4.00, NULL, NULL, false, 143),
    ('ancona_7gg', 'Biglietto Urbano Ancona 7 giorni', 'urbano_ancona', 'single', 'ordinario', 12.00, NULL, NULL, false, 144),
    ('ancona_bordo', 'Biglietto Urbano Ancona emesso a bordo', 'urbano_ancona', 'single', 'ordinario', 3.00, NULL, NULL, false, 145),
    ('ancona_bordo_100min', 'Biglietto Urbano Ancona 100 min (emettitrice)', 'urbano_ancona', 'single', 'ordinario', 2.00, NULL, NULL, false, 146),
    ('ancona_bordo_ar', 'Biglietto Urbano Ancona A/R (emettitrice)', 'urbano_ancona', 'return', 'ordinario', 4.00, NULL, NULL, false, 147),
    ('ancona_bordo_24h', 'Biglietto Urbano Ancona 24h (emettitrice)', 'urbano_ancona', 'single', 'ordinario', 5.00, NULL, NULL, false, 148),
    ('ancona_ascensore', 'Biglietto Ascensore Passetto Ancona', 'urbano_ancona', 'single', 'ordinario', 1.00, NULL, NULL, false, 149),
    ('jesi_60min', 'Biglietto Urbano Jesi 60 min', 'urbano_jesi', 'single', 'ordinario', 1.35, 60, NULL, true, 150),
    ('jesi_ar', 'Biglietto Urbano Jesi A/R', 'urbano_jesi', 'return', 'ordinario', 2.20, 60, NULL, false, 151),
    ('jesi_giorn', 'Biglietto Urbano Jesi Giornaliero', 'urbano_jesi', 'single', 'ordinario', 3.50, NULL, NULL, false, 152),
    ('jesi_bordo', 'Biglietto Urbano Jesi emesso a bordo', 'urbano_jesi', 'single', 'ordinario', 2.00, NULL, NULL, false, 153),
    ('falc_60min', 'Biglietto Urbano Falconara 60 min', 'urbano_falconara', 'single', 'ordinario', 1.35, 60, NULL, true, 154),
    ('falc_ar', 'Biglietto Urbano Falconara A/R', 'urbano_falconara', 'return', 'ordinario', 2.00, 60, NULL, false, 155),
    ('falc_giorn', 'Biglietto Urbano Falconara Giornaliero', 'urbano_falconara', 'single', 'ordinario', 3.30, NULL, NULL, false, 156),
    ('cfd_60min', 'Biglietto Urbano Castelfidardo 60 min', 'urbano_castelfidardo', 'single', 'ordinario', 1.35, 60, NULL, true, 157),
    ('sasso_60min', 'Biglietto Urbano Sassoferrato 60 min', 'urbano_sassoferrato', 'single', 'ordinario', 1.35, 60, NULL, true, 158),
    ('senigallia_60min', 'Biglietto Urbano Senigallia 60 min', 'urbano_senigallia', 'single', 'ordinario', 1.35, 60, NULL, true, 159)
  ) AS t(titolo, nome, rete, tipo, categoria, prezzo, durata_minuti, fascia, di_riferimento, ordine)
 WHERE EXISTS (SELECT 1 FROM public.azienda a WHERE a.gtfs_agency_id = 'conerobus')
   AND NOT EXISTS (SELECT 1 FROM public.titoli_catalogo)
   AND EXISTS (SELECT 1 FROM public.reti r WHERE r.rete = t.rete);
--> statement-breakpoint
RESET ROLE;
