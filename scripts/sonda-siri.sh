#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Sonda SIRI: che cosa espone DAVVERO il server Mizar, oltre a quello che usiamo.
#
# Oggi interroghiamo un solo servizio (GetVehicleMonitoring, dettaglio "calls").
# Questo script manda al medesimo endpoint, con la medesima busta SOAP 1.1 e lo
# stesso RequestorRef, sei domande diverse e salva le risposte intere in una
# cartella, con un riassunto a video: c'è un Fault? c'è un ErrorCondition?
# quanti elementi utili contiene la risposta?
#
# Legge le stesse variabili d'ambiente dell'api-server, così si può lanciare
# dentro il container in produzione senza copiare nulla:
#
#   docker exec -it <container-api> bash /app/scripts/sonda-siri.sh
#
# oppure da qualunque macchina che raggiunge Mizar:
#
#   SIRI_VM_URL=https://... SIRI_REQUESTOR_REF=... bash scripts/sonda-siri.sh
#
# Variabili: SIRI_VM_URL (obbligatoria), SIRI_REQUESTOR_REF (default TransitIntel),
#            SIRI_SOAP_ACTION (default: il nome dell'operazione), SIRI_USERNAME,
#            SIRI_PASSWORD, SIRI_TIMEOUT_MS (default 20000),
#            SONDA_STOP (StopPointRef per la prova StopMonitoring; se manca si
#            prende la prima fermata trovata nella risposta VehicleMonitoring),
#            SONDA_DIR (cartella di uscita; default ./sonda-siri-<data-ora>).
#
# Non scrive nulla sul server: sono tutte richieste di lettura.
# ─────────────────────────────────────────────────────────────────────────────
set -u

URL="${SIRI_VM_URL:-}"
if [ -z "$URL" ]; then
  echo "SIRI_VM_URL non impostata: è l'endpoint SOAP di Mizar." >&2
  exit 2
fi
REQ="${SIRI_REQUESTOR_REF:-TransitIntel}"
TIMEOUT_S=$(( ${SIRI_TIMEOUT_MS:-20000} / 1000 ))
[ "$TIMEOUT_S" -lt 5 ] && TIMEOUT_S=5
OUT="${SONDA_DIR:-./sonda-siri-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT"

AUTH=()
if [ -n "${SIRI_USERNAME:-}" ]; then
  AUTH=(-u "${SIRI_USERNAME}:${SIRI_PASSWORD:-}")
fi

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
mid() { echo "TI-sonda-$(date +%s)-$RANDOM"; }

busta() {  # busta <corpo>
  printf '<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:siri="http://www.siri.org.uk/siri"><soap:Body>%s</soap:Body></soap:Envelope>' "$1"
}

# Le due intestazioni che GetVehicleMonitoring usa già oggi, identiche.
info() {
  printf '<ServiceRequestInfo><siri:RequestTimestamp>%s</siri:RequestTimestamp><siri:RequestorRef>%s</siri:RequestorRef><siri:MessageIdentifier>%s</siri:MessageIdentifier></ServiceRequestInfo>' "$(ts)" "$REQ" "$(mid)"
}
testa_richiesta() {
  printf '<siri:RequestTimestamp>%s</siri:RequestTimestamp><siri:MessageIdentifier>%s</siri:MessageIdentifier>' "$(ts)" "$(mid)"
}

# conta <nome> in un file, tollerando il prefisso di namespace
conta() { grep -o "<\(siri:\)\?$2[ >/]" "$1" 2>/dev/null | wc -l | tr -d ' '; }

# spedisci <nome-operazione> <file-xml-richiesta>
spedisci() {
  local op="$1" reqfile="$2" resfile="$OUT/$1.risposta.xml" code
  local action="${SIRI_SOAP_ACTION:-$op}"
  code=$(curl -sS -o "$resfile" -w '%{http_code}' --max-time "$TIMEOUT_S" \
    "${AUTH[@]}" -H 'Content-Type: text/xml; charset=utf-8' -H "SOAPAction: $action" \
    --data-binary @"$reqfile" "$URL" 2>"$OUT/$op.curl.err") || code="000"
  local esito
  if [ "$code" = "000" ]; then
    esito="nessuna risposta ($(head -c 120 "$OUT/$op.curl.err"))"
  elif grep -q '<\(soap:\)\?Fault' "$resfile"; then
    esito="SOAP Fault: $(grep -o '<faultstring>[^<]*' "$resfile" | head -1 | sed 's/<faultstring>//')"
  elif grep -q 'ErrorCondition' "$resfile"; then
    esito="ErrorCondition: $(grep -o '<\(siri:\)\?\(ErrorText\|Description\)>[^<]*' "$resfile" | head -1 | sed 's/.*>//')"
  elif grep -q '<\(siri:\)\?Status>false' "$resfile"; then
    esito="Status=false (il servizio risponde ma non consegna)"
  else
    esito="risposta valida"
  fi
  printf '%-26s HTTP %s  %7s byte  %s\n' "$op" "$code" "$(wc -c <"$resfile" | tr -d ' ')" "$esito"
}

echo "Endpoint : $URL"
echo "Requestor: $REQ"
echo "Cartella : $OUT"
echo

# ── 0. Il WSDL: l'elenco delle operazioni che il server dichiara ─────────────
# È la prova più economica: una GET. Se il WSDL nomina GetEstimatedTimetable
# o GetStopMonitoring, i servizi esistono anche se poi rispondono vuoto.
echo "0. WSDL (operazioni dichiarate dal server)"
if curl -sS --max-time "$TIMEOUT_S" "${AUTH[@]}" -o "$OUT/wsdl.xml" "${URL}?wsdl" 2>"$OUT/wsdl.curl.err"; then
  ops=$(grep -o '<\(wsdl:\)\?operation name="[^"]*"' "$OUT/wsdl.xml" | sed 's/.*name="//;s/"//' | sort -u | tr '\n' ' ')
  if [ -n "$ops" ]; then echo "   operazioni: $ops"; else echo "   nessuna <operation> trovata ($(wc -c <"$OUT/wsdl.xml" | tr -d ' ') byte: forse non è un WSDL)"; fi
else
  echo "   ?wsdl non raggiungibile: $(head -c 120 "$OUT/wsdl.curl.err")"
fi
echo

# ── 1. GetCapabilities per TUTTI i servizi, non solo VehicleMonitoring ───────
echo "1. Che cosa il server dichiara di sapere fare"
cat >"$OUT/GetCapabilities.richiesta.xml" <<EOF
$(busta "<siri:GetCapabilities><Request version=\"1.4\">$(testa_richiesta)<siri:RequestorRef>$REQ</siri:RequestorRef>\
<siri:VehicleMonitoringCapabilitiesRequest>$(testa_richiesta)</siri:VehicleMonitoringCapabilitiesRequest>\
<siri:StopMonitoringCapabilitiesRequest>$(testa_richiesta)</siri:StopMonitoringCapabilitiesRequest>\
<siri:EstimatedTimetableCapabilitiesRequest>$(testa_richiesta)</siri:EstimatedTimetableCapabilitiesRequest>\
<siri:ProductionTimetableCapabilitiesRequest>$(testa_richiesta)</siri:ProductionTimetableCapabilitiesRequest>\
<siri:SituationExchangeCapabilitiesRequest>$(testa_richiesta)</siri:SituationExchangeCapabilitiesRequest>\
</Request><RequestExtension/></siri:GetCapabilities>")
EOF
spedisci GetCapabilities "$OUT/GetCapabilities.richiesta.xml"
r="$OUT/GetCapabilities.risposta.xml"
for s in VehicleMonitoring StopMonitoring EstimatedTimetable ProductionTimetable SituationExchange; do
  if grep -q "${s}ServiceCapabilities" "$r" 2>/dev/null; then
    ps=$(grep -o '<\(siri:\)\?PublishSubscribe>[^<]*' "$r" | head -1 | sed 's/.*>//')
    echo "   $s: dichiarato (PublishSubscribe=${ps:-?})"
  else
    echo "   $s: non dichiarato"
  fi
done
for k in DefaultDetailLevel HasNumberOfPreviousCalls HasNumberOfOnwardsCalls FilterByLineRef ShortestPossibleCycle; do
  v=$(grep -o "<\(siri:\)\?$k>[^<]*" "$r" 2>/dev/null | head -1 | sed 's/.*>//')
  [ -n "$v" ] && echo "   $k = $v"
done
echo

# ── 2. VehicleMonitoring col dettaglio massimo ("full" invece di "calls") ────
echo "2. VehicleMonitoring, dettaglio full: arriva qualcosa in più di 'calls'?"
for lvl in calls full; do
  cat >"$OUT/GetVehicleMonitoring-$lvl.richiesta.xml" <<EOF
$(busta "<siri:GetVehicleMonitoring>$(info)<Request version=\"1.4\">$(testa_richiesta)\
<siri:VehicleMonitoringDetailLevel>$lvl</siri:VehicleMonitoringDetailLevel>\
</Request><RequestExtension/></siri:GetVehicleMonitoring>")
EOF
  spedisci "GetVehicleMonitoring-$lvl" "$OUT/GetVehicleMonitoring-$lvl.richiesta.xml"
  r="$OUT/GetVehicleMonitoring-$lvl.risposta.xml"
  echo "   mezzi $(conta "$r" VehicleActivity) · PreviousCall $(conta "$r" PreviousCall) · OnwardCall $(conta "$r" OnwardCall)" \
       "· ActualArrivalTime $(conta "$r" ActualArrivalTime) · ExpectedArrivalTime $(conta "$r" ExpectedArrivalTime)" \
       "· elementi distinti $(grep -o '<\(siri:\)\?[A-Za-z]*' "$r" | sort -u | wc -l | tr -d ' ')"
done
# Elementi che "full" aggiunge rispetto a "calls": è la risposta alla domanda.
diff <(grep -o '<\(siri:\)\?[A-Za-z]*' "$OUT/GetVehicleMonitoring-calls.risposta.xml" | sort -u) \
     <(grep -o '<\(siri:\)\?[A-Za-z]*' "$OUT/GetVehicleMonitoring-full.risposta.xml"  | sort -u) \
     | grep '^>' | sed 's/^> </   full aggiunge: /' || true
echo

# ── 3. EstimatedTimetable: i passaggi previsti corsa per corsa ───────────────
echo "3. EstimatedTimetable (prossime 2 ore): il servizio che darebbe gli orari stimati"
cat >"$OUT/GetEstimatedTimetable.richiesta.xml" <<EOF
$(busta "<siri:GetEstimatedTimetable>$(info)<Request version=\"1.4\">$(testa_richiesta)\
<siri:PreviewInterval>PT2H</siri:PreviewInterval>\
</Request><RequestExtension/></siri:GetEstimatedTimetable>")
EOF
spedisci GetEstimatedTimetable "$OUT/GetEstimatedTimetable.richiesta.xml"
r="$OUT/GetEstimatedTimetable.risposta.xml"
echo "   corse $(conta "$r" EstimatedVehicleJourney) · fermate $(conta "$r" EstimatedCall) · ExpectedArrivalTime $(conta "$r" ExpectedArrivalTime)"
echo

# ── 4. StopMonitoring su una fermata ─────────────────────────────────────────
STOP="${SONDA_STOP:-}"
if [ -z "$STOP" ]; then
  STOP=$(grep -o '<\(siri:\)\?StopPointRef>[^<]*' "$OUT/GetVehicleMonitoring-calls.risposta.xml" 2>/dev/null | head -1 | sed 's/.*>//')
fi
echo "4. StopMonitoring sulla fermata '${STOP:-nessuna trovata}': arrivi previsti per fermata"
if [ -n "$STOP" ]; then
  cat >"$OUT/GetStopMonitoring.richiesta.xml" <<EOF
$(busta "<siri:GetStopMonitoring>$(info)<Request version=\"1.4\">$(testa_richiesta)\
<siri:PreviewInterval>PT2H</siri:PreviewInterval>\
<siri:MonitoringRef>$STOP</siri:MonitoringRef>\
<siri:StopMonitoringDetailLevel>calls</siri:StopMonitoringDetailLevel>\
<siri:MaximumStopVisits>20</siri:MaximumStopVisits>\
</Request><RequestExtension/></siri:GetStopMonitoring>")
EOF
  spedisci GetStopMonitoring "$OUT/GetStopMonitoring.richiesta.xml"
  r="$OUT/GetStopMonitoring.risposta.xml"
  echo "   arrivi $(conta "$r" MonitoredStopVisit) · ExpectedArrivalTime $(conta "$r" ExpectedArrivalTime)"
else
  echo "   saltata: passa SONDA_STOP=<StopPointRef> per provarla"
fi
echo

# ── 5. ProductionTimetable: il programma del giorno secondo Mizar ────────────
echo "5. ProductionTimetable: le corse programmate oggi secondo Mizar (per confronto col GTFS)"
cat >"$OUT/GetProductionTimetable.richiesta.xml" <<EOF
$(busta "<siri:GetProductionTimetable>$(info)<Request version=\"1.4\">$(testa_richiesta)\
</Request><RequestExtension/></siri:GetProductionTimetable>")
EOF
spedisci GetProductionTimetable "$OUT/GetProductionTimetable.richiesta.xml"
r="$OUT/GetProductionTimetable.risposta.xml"
echo "   corse $(conta "$r" DatedVehicleJourney) · fermate $(conta "$r" DatedCall)"
echo

# ── 6. SituationExchange: avvisi e deviazioni ────────────────────────────────
echo "6. SituationExchange: avvisi di servizio"
cat >"$OUT/GetSituationExchange.richiesta.xml" <<EOF
$(busta "<siri:GetSituationExchange>$(info)<Request version=\"1.4\">$(testa_richiesta)\
</Request><RequestExtension/></siri:GetSituationExchange>")
EOF
spedisci GetSituationExchange "$OUT/GetSituationExchange.richiesta.xml"
echo "   situazioni $(conta "$OUT/GetSituationExchange.risposta.xml" PtSituationElement)"
echo

echo "Risposte intere in $OUT — da allegare così come sono."
