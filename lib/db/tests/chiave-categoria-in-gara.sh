#!/usr/bin/env bash
# ============================================================
# La migrazione 0013 mentre qualcuno cancella una categoria in uso (PR 2.15c).
#   bash lib/db/tests/chiave-categoria-in-gara.sh <database di prova>
# Dalla radice del repository, su un database di PROVA già migrato: toglie e
# rimette la chiave esterna sulla categoria, e scrive righe di prova che alla
# fine cancella. psql prende host, porta, utente e password dall'ambiente
# (PGHOST, PGPORT, PGUSER, PGPASSWORD): deve essere un superutente.
#
# Il caso: mentre il deploy migra, il container di prima serve ancora, e la sua
# versione dell'API può cancellare una categoria in uso. Se la cancellazione è
# a metà quando passa la 0013, il conteggio delle righe nel vuoto non la vede
# ancora; il vincolo, che aspetta la fine della cancellazione, sì. Senza il
# lucchetto preso prima di contare la migrazione fallisce e il deploy si ferma.
# Con il lucchetto aspetta chi sta cancellando, poi conta, avvisa e non mette
# il vincolo.
# ============================================================
set -euo pipefail
DB="${1:?manca il nome del database di prova}"
P=(psql -q -v ON_ERROR_STOP=1 -d "$DB")
CHIAVE="SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint WHERE conrelid = 'public.ps_trip_category_validity'::regclass AND conname = 'ps_trip_category_validity_category_id_fkey' AND convalidated"
LAVORO="$(mktemp -d)"

pulizia() {
  # le righe di prova via, e il vincolo di nuovo al suo posto
  "${P[@]}" > /dev/null 2>&1 <<'SQL' || true
DELETE FROM public.ps_trip_category_validity WHERE trip_id = 'c4000000-0000-4000-8000-000000000004';
DELETE FROM public.ps_trips WHERE id = 'c4000000-0000-4000-8000-000000000004';
DELETE FROM public.ps_projects WHERE id = 'c4000000-0000-4000-8000-000000000001';
DELETE FROM public.ps_validity_categories WHERE id = 'c4000000-0000-4000-8000-0000000000cc';
SQL
  "${P[@]}" -f lib/db/migrations/0013_chiave_esterna_sulla_categoria.sql > /dev/null 2>&1 || true
  rm -rf "$LAVORO"
}
trap pulizia EXIT

# com'era un database prima della 0013: niente chiave, e una categoria usata da una corsa
"${P[@]}" <<'SQL'
ALTER TABLE public.ps_trip_category_validity DROP CONSTRAINT IF EXISTS ps_trip_category_validity_category_id_fkey;
INSERT INTO public.ps_projects (id, owner_user_id, name)
VALUES ('c4000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-0000000000ff', 'Prova chiave in gara');
INSERT INTO public.ps_routes (id, project_id, short_name)
VALUES ('c4000000-0000-4000-8000-000000000002', 'c4000000-0000-4000-8000-000000000001', 'K4');
INSERT INTO public.ps_route_variants (id, project_id, route_id, name)
VALUES ('c4000000-0000-4000-8000-000000000003', 'c4000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000002', 'andata');
INSERT INTO public.ps_trips (id, project_id, route_id, variant_id)
VALUES ('c4000000-0000-4000-8000-000000000004', 'c4000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000002', 'c4000000-0000-4000-8000-000000000003');
INSERT INTO public.ps_validity_categories (id, code, name, color, sort_order)
VALUES ('c4000000-0000-4000-8000-0000000000cc', 'prova_chiave_in_gara', 'Prova chiave in gara', '#888888', 999);
INSERT INTO public.ps_trip_category_validity (trip_id, category_id)
VALUES ('c4000000-0000-4000-8000-000000000004', 'c4000000-0000-4000-8000-0000000000cc');
SQL

# chi cancella: la categoria in uso, in una transazione che resta aperta tre secondi
"${P[@]}" > "$LAVORO/cancella.log" 2>&1 <<SQL &
BEGIN;
DELETE FROM public.ps_validity_categories WHERE id = 'c4000000-0000-4000-8000-0000000000cc';
\! touch "$LAVORO/cancellata"
SELECT pg_catalog.pg_sleep(3);
COMMIT;
SQL
CANCELLA=$!
for _ in $(seq 1 100); do [ -e "$LAVORO/cancellata" ] && break; sleep 0.1; done
[ -e "$LAVORO/cancellata" ] || { echo "la cancellazione di prova non è partita"; cat "$LAVORO/cancella.log"; exit 1; }

# la migrazione, come la lancia il migratore: in una transazione, con lock_timeout
if ! "${P[@]}" -c "SET lock_timeout = '5s'" -c "BEGIN" -f lib/db/migrations/0013_chiave_esterna_sulla_categoria.sql -c "COMMIT" > "$LAVORO/migra.log" 2>&1; then
  echo "la 0013 è fallita mentre una categoria in uso veniva cancellata: il deploy si sarebbe fermato"; cat "$LAVORO/migra.log"; exit 1
fi
wait "$CANCELLA" || { echo "la cancellazione di prova è fallita"; cat "$LAVORO/cancella.log"; exit 1; }

grep -q "WARNING:  0013: 1 righe di ps_trip_category_validity puntano a una categoria cancellata" "$LAVORO/migra.log" \
  || { echo "la 0013 non ha avvisato della riga rimasta nel vuoto"; cat "$LAVORO/migra.log"; exit 1; }
[ "$("${P[@]}" -Atc "$CHIAVE")" = "0" ] || { echo "la 0013 ha messo il vincolo con una riga nel vuoto"; exit 1; }
[ "$("${P[@]}" -Atc "SELECT pg_catalog.count(*) FROM public.ps_trip_category_validity WHERE trip_id = 'c4000000-0000-4000-8000-000000000004'")" = "1" ] \
  || { echo "la riga con la categoria cancellata è stata toccata"; exit 1; }

# alla fine il database torna com'era: righe di prova via, vincolo al suo posto
trap - EXIT
pulizia
[ "$("${P[@]}" -Atc "$CHIAVE")" = "1" ] || { echo "dopo la prova il vincolo sulla categoria non è tornato"; exit 1; }
echo "chiave sulla categoria: una categoria cancellata mentre passa la 0013 dà un avviso, non un deploy fallito"
