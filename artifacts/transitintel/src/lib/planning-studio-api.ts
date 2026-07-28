/**
 * PlannerStudio API client — tipato.
 *
 * Specchia gli endpoint definiti in api-server/src/lib/planning-studio.ts.
 */
import { apiFetch, getApiBase } from "@/lib/api";

/* ─── Tipi ─── */

export interface PsProject {
  id: string;
  ownerUserId: string;
  name: string;
  description?: string | null;
  isShared: boolean;
  sourceFeedId?: string | null;
  sourceFeedLabel?: string | null;
  agencyName?: string | null;
  agencyUrl?: string | null;
  agencyTimezone: string;
  defaultLang: string;
  schedulingProjectId?: string | null;
  status: string;
  lastOpenedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  ownerEmail?: string;
  ownerFullName?: string;
  memberCount?: number;
  myRole?: "owner" | "editor" | "viewer";
  counts?: { stops: number; routes: number; variants: number; trips: number; calendars: number };
  /** numero di Unità di Progettazione (UDP) create nel progetto */
  unitCount?: number;
  materializedFeedId?: string | null;
  materializedAt?: string | null;
  /** true se il feed materializzato è quello attivo = programma di esercizio operativo */
  isOperational?: boolean;
}

export interface PsStop {
  id: string;
  projectId: string;
  code?: string | null;
  name: string;
  description?: string | null;
  lat: number;
  lon: number;
  zoneId?: string | null;
  locationType: number;
  parentStation?: string | null;
  wheelchairBoarding: number;
  platformCode?: string | null;
  attributes: Record<string, any>;
  clusterId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PsRoute {
  id: string;
  projectId: string;
  code?: string | null;
  shortName: string;
  longName?: string | null;
  description?: string | null;
  routeType: number;
  color?: string | null;
  textColor?: string | null;
  agencyId?: string | null;
  sortOrder: number;
  attributes: Record<string, any>;
  createdAt: string;
  updatedAt: string;
  variantCount?: number;
}

export interface PsVariant {
  id: string;
  projectId: string;
  routeId: string;
  name: string;
  /** codice del percorso: modificabile; se assente le viste mostrano il progressivo */
  code?: string | null;
  direction: number;
  headsign?: string | null;
  isDefault: boolean;
  attributes: Record<string, any>;
  createdAt: string;
  updatedAt: string;
  stopCount?: number;
  hasShape?: boolean;
}

export interface PsVariantStop {
  seq: number;
  stopId: string;
  stopName: string;
  stopCode?: string | null;
  lat: number;
  lon: number;
  pickupType: number;
  dropOffType: number;
  timepoint: number;
  shapeDistTraveled?: number | null;
}

export interface PsWaypoint {
  lng: number;
  lat: number;
  stopId?: string | null;
  mode?: "snap" | "manual";
}

export interface PsShape {
  id: string;
  projectId: string;
  variantId: string;
  mode: string;
  geometry: { type: "LineString"; coordinates: [number, number][] };
  waypoints: PsWaypoint[];
  distanceM: number | null;
  durationS: number | null;
  updatedAt: string;
}

export interface PsCalendar {
  id: string;
  projectId: string;
  code: string;
  name?: string | null;
  monday: boolean; tuesday: boolean; wednesday: boolean; thursday: boolean;
  friday: boolean; saturday: boolean; sunday: boolean;
  /** Pattern settimanale effettivo [lun…dom]: uguale ai flag sopra, ma per i
   *  calendari "solo calendar_dates" (flag tutti false) è dedotto dai giorni
   *  della settimana delle date operative. Usato per i bollini in Corse. */
  effectiveWeekdays?: boolean[];
  startDate: string;
  endDate: string;
  createdAt: string;
  updatedAt: string;
}

export interface PsTrip {
  id: string;
  projectId: string;
  routeId: string;
  variantId: string;
  calendarId?: string | null;
  headsign?: string | null;
  shortName?: string | null;
  direction: number;
  blockId?: string | null;
  attributes: Record<string, any>;
  validFrom?: string | null;     // YYYY-MM-DD: validità per singola corsa
  validTo?: string | null;
  isActive: boolean;             // se false la corsa è disattivata
  serviceLabel?: string | null;  // etichetta libera (es. "Solo scolastico")
  firstDeparture?: string | null; // HH:MM:SS del primo stop_time (dalla lista)
  /** day-type validi dal calendario aziendale (feriale/sabato/festivo/…) */
  dayTypeCodes?: string[];
  /** macro-categorie del calendario aziendale (es. Scuole Aperte) */
  categories?: Array<{ id: string; code: string; name: string; color: string | null }>;
  createdAt: string;
}

export interface PsTripException {
  tripId: string;
  date: string;          // YYYY-MM-DD
  exceptionType: 1 | 2;  // 1 = aggiunta, 2 = soppressione
  reason?: string | null;
}

export interface PsStopTime {
  tripId: string;
  stopSeq: number;
  stopId: string;
  stopName: string;
  stopCode?: string | null;
  arrivalTime: string;
  departureTime: string;
  pickupType: number;
  dropOffType: number;
  timepoint: number;
  shapeDistTraveled?: number | null;
}

export interface PsMember {
  userId: string;
  role: "owner" | "editor" | "viewer";
  email?: string | null;
  fullName?: string | null;
  addedAt: string;
}

export interface PsActivity {
  id: string;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  payload: Record<string, any>;
  at: string;
  userId: string;
  userEmail?: string | null;
  userFullName?: string | null;
}

/* ─── Progetti ─── */

export async function listPsProjects(): Promise<PsProject[]> {
  const r = await apiFetch<{ projects: PsProject[] }>("/api/planning-studio/projects");
  return r.projects;
}

export async function getPsProject(id: string): Promise<PsProject> {
  const r = await apiFetch<{ project: PsProject }>(`/api/planning-studio/projects/${id}`);
  return r.project;
}

export async function createPsProject(input: {
  name: string; description?: string; agencyName?: string;
  agencyTimezone?: string; schedulingProjectId?: string;
}): Promise<PsProject> {
  const r = await apiFetch<{ project: PsProject }>("/api/planning-studio/projects", {
    method: "POST", body: JSON.stringify(input),
  });
  return r.project;
}

export async function updatePsProject(id: string, patch: Partial<PsProject>): Promise<PsProject> {
  const r = await apiFetch<{ project: PsProject }>(`/api/planning-studio/projects/${id}`, {
    method: "PATCH", body: JSON.stringify(patch),
  });
  return r.project;
}

export async function deletePsProject(id: string): Promise<void> {
  await apiFetch<{ ok: boolean }>(`/api/planning-studio/projects/${id}`, { method: "DELETE" });
}

/** Duplica un progetto (copia profonda: fermate, linee, percorsi, orari,
 *  calendari, corse, validità…). La copia nasce non operativa. */
export async function duplicatePsProject(id: string, name?: string): Promise<PsProject> {
  const r = await apiFetch<{ project: PsProject }>(`/api/planning-studio/projects/${id}/duplicate`, {
    method: "POST", body: JSON.stringify(name ? { name } : {}),
  });
  return r.project;
}

/** "Metti in esercizio": promuove il feed materializzato a feed attivo unico.
 * Da quel momento Sala Operativa, AVM, GTFS-RT e tariffe puntano a questo
 * programma. Richiede progetto già materializzato (sync PS → feed). */
/** Metti in esercizio. `effectiveFrom` (YYYY-MM-DD) opzionale: se futura, lo
 *  snapshot viene materializzato subito ma lo switch avviene alla decorrenza. */
export async function activatePsProject(id: string, effectiveFrom?: string): Promise<{ ok: true; feedId: string; scheduledFor?: string }> {
  return apiFetch<{ ok: true; feedId: string; scheduledFor?: string }>(`/api/planning-studio/projects/${id}/activate`, {
    method: "POST",
    ...(effectiveFrom ? { body: JSON.stringify({ effectiveFrom }) } : {}),
  });
}

/* ─── Controllo salute progetto (pre-flight di attivazione) ─── */

export interface PsHealthCheck {
  key: string;
  level: "error" | "warning";
  label: string;
  count: number;
  samples: string[];
}
export interface PsProjectHealth { checks: PsHealthCheck[]; errors: number; warnings: number }

export async function getPsProjectHealth(id: string): Promise<PsProjectHealth> {
  return apiFetch<PsProjectHealth>(`/api/planning-studio/projects/${id}/health`);
}

/* ─── Membri / attività ─── */

export async function listPsMembers(projectId: string): Promise<PsMember[]> {
  const r = await apiFetch<{ members: PsMember[] }>(`/api/planning-studio/projects/${projectId}/members`);
  return r.members;
}
export async function addPsMember(projectId: string, userId: string, role: "editor" | "viewer" = "editor"): Promise<void> {
  await apiFetch<{ ok: boolean }>(`/api/planning-studio/projects/${projectId}/members`, {
    method: "POST", body: JSON.stringify({ userId, role }),
  });
}
export async function removePsMember(projectId: string, userId: string): Promise<void> {
  await apiFetch<{ ok: boolean }>(`/api/planning-studio/projects/${projectId}/members/${userId}`, { method: "DELETE" });
}
export async function listPsActivity(projectId: string, limit = 50): Promise<PsActivity[]> {
  const r = await apiFetch<{ activity: PsActivity[] }>(`/api/planning-studio/projects/${projectId}/activity?limit=${limit}`);
  return r.activity;
}

/* ─── Fermate ─── */

export async function listPsStops(projectId: string): Promise<PsStop[]> {
  const r = await apiFetch<{ stops: PsStop[] }>(`/api/planning-studio/projects/${projectId}/stops`);
  return r.stops;
}
export async function createPsStop(projectId: string, input: Partial<PsStop> & { name: string; lat: number; lon: number }): Promise<PsStop> {
  const r = await apiFetch<{ stop: PsStop }>(`/api/planning-studio/projects/${projectId}/stops`, {
    method: "POST", body: JSON.stringify(input),
  });
  return r.stop;
}
export async function updatePsStop(projectId: string, stopId: string, patch: Partial<PsStop>): Promise<PsStop> {
  const r = await apiFetch<{ stop: PsStop }>(`/api/planning-studio/projects/${projectId}/stops/${stopId}`, {
    method: "PATCH", body: JSON.stringify(patch),
  });
  return r.stop;
}
export async function deletePsStop(projectId: string, stopId: string): Promise<void> {
  await apiFetch<{ ok: boolean }>(`/api/planning-studio/projects/${projectId}/stops/${stopId}`, { method: "DELETE" });
}

/* ─── Linee + varianti ─── */

export async function listPsRoutes(projectId: string): Promise<PsRoute[]> {
  const r = await apiFetch<{ routes: PsRoute[] }>(`/api/planning-studio/projects/${projectId}/routes`);
  return r.routes;
}
export async function createPsRoute(projectId: string, input: Partial<PsRoute> & { shortName: string }): Promise<PsRoute> {
  const r = await apiFetch<{ route: PsRoute }>(`/api/planning-studio/projects/${projectId}/routes`, {
    method: "POST", body: JSON.stringify(input),
  });
  return r.route;
}
export async function updatePsRoute(projectId: string, routeId: string, patch: Partial<PsRoute>): Promise<PsRoute> {
  const r = await apiFetch<{ route: PsRoute }>(`/api/planning-studio/projects/${projectId}/routes/${routeId}`, {
    method: "PATCH", body: JSON.stringify(patch),
  });
  return r.route;
}
export async function deletePsRoute(projectId: string, routeId: string): Promise<void> {
  await apiFetch<{ ok: boolean }>(`/api/planning-studio/projects/${projectId}/routes/${routeId}`, { method: "DELETE" });
}

export async function listPsVariants(projectId: string, routeId: string): Promise<PsVariant[]> {
  const r = await apiFetch<{ variants: PsVariant[] }>(
    `/api/planning-studio/projects/${projectId}/routes/${routeId}/variants`
  );
  return r.variants;
}
export async function createPsVariant(projectId: string, routeId: string, input: Partial<PsVariant> & { name: string }): Promise<PsVariant> {
  const r = await apiFetch<{ variant: PsVariant }>(
    `/api/planning-studio/projects/${projectId}/routes/${routeId}/variants`,
    { method: "POST", body: JSON.stringify(input) }
  );
  return r.variant;
}
export async function getPsVariant(projectId: string, variantId: string): Promise<{ variant: PsVariant; stops: PsVariantStop[]; shape: PsShape | null }> {
  return apiFetch(`/api/planning-studio/projects/${projectId}/variants/${variantId}`);
}
/** Tutte le varianti del progetto con la sequenza fermate in UNA chiamata (per il TTD). */
export async function listPsVariantsWithStops(projectId: string): Promise<{ variant: PsVariant; stops: PsVariantStop[] }[]> {
  const r = await apiFetch<{ variants: { variant: PsVariant; stops: PsVariantStop[] }[] }>(
    `/api/planning-studio/projects/${projectId}/variants-with-stops`
  );
  return r.variants;
}
export async function updatePsVariant(projectId: string, variantId: string, patch: Partial<PsVariant>): Promise<PsVariant> {
  const r = await apiFetch<{ variant: PsVariant }>(
    `/api/planning-studio/projects/${projectId}/variants/${variantId}`,
    { method: "PATCH", body: JSON.stringify(patch) }
  );
  return r.variant;
}
/** Elimina un percorso. Se ha corse collegate il server risponde 409 con
 *  { tripCount }: ripetere con force=true per eliminare ANCHE le corse. */
export async function deletePsVariant(projectId: string, variantId: string, opts?: { force?: boolean }): Promise<void> {
  await apiFetch<{ ok: boolean }>(
    `/api/planning-studio/projects/${projectId}/variants/${variantId}${opts?.force ? "?force=1" : ""}`,
    { method: "DELETE" },
  );
}
export async function setPsVariantStops(projectId: string, variantId: string, stops: { stopId: string }[]): Promise<void> {
  await apiFetch<{ ok: boolean; count: number }>(
    `/api/planning-studio/projects/${projectId}/variants/${variantId}/stops`,
    { method: "PUT", body: JSON.stringify({ stops }) }
  );
}
export async function setPsVariantShape(
  projectId: string, variantId: string,
  payload: { mode: string; geometry: { type: "LineString"; coordinates: [number, number][] }; waypoints: PsWaypoint[]; distanceM?: number; durationS?: number }
): Promise<PsShape> {
  const r = await apiFetch<{ shape: PsShape }>(
    `/api/planning-studio/projects/${projectId}/variants/${variantId}/shape`,
    { method: "PUT", body: JSON.stringify(payload) }
  );
  return r.shape;
}

/* ─── Snap routing OSRM (proxy server-side) ─── */

export async function routeSnap(
  points: [number, number][],
  mode: "driving" | "manual" = "driving",
  opts?: {
    /** modo per SEGMENTO (forza tratti manuali, es. corsie riservate) */
    modes?: ("driving" | "manual")[];
    /** arrivo lato marciapiede alle fermate (default true) */
    curb?: boolean;
    /** quali punti sono fermate (curb) vs waypoint liberi */
    curbMask?: boolean[];
    /** abilita il check zone vietate del progetto */
    projectId?: string;
  },
): Promise<{
  geometry: { type: "LineString"; coordinates: [number, number][] };
  segments: { geometry: any; distanceM: number; durationS: number; mode: string }[];
  /** km per tratta (su strada, dalle legs OSRM) allineati ai punti */
  legDistances?: number[];
  legModes?: string[];
  distanceM: number;
  durationS: number;
  violations?: { zoneId: string; name: string }[];
}> {
  return apiFetch("/api/planning-studio/route-snap", {
    method: "POST",
    body: JSON.stringify({ points, mode, ...(opts ?? {}) }),
  });
}

/* ─── Zone vietate bus (poligoni per progetto) ─── */

export interface PsNoGoZone {
  id: string;
  name: string;
  polygon: [number, number][];
  active: boolean;
}

export async function listPsNoGoZones(projectId: string): Promise<PsNoGoZone[]> {
  const r = await apiFetch<{ zones: PsNoGoZone[] }>(`/api/planning-studio/projects/${projectId}/no-go-zones`);
  return r.zones;
}
export async function createPsNoGoZone(projectId: string, input: { name: string; polygon: [number, number][] }): Promise<PsNoGoZone> {
  const r = await apiFetch<{ zone: PsNoGoZone }>(`/api/planning-studio/projects/${projectId}/no-go-zones`, {
    method: "POST", body: JSON.stringify(input),
  });
  return r.zone;
}
export async function updatePsNoGoZone(projectId: string, zoneId: string, patch: { name?: string; active?: boolean }): Promise<PsNoGoZone> {
  const r = await apiFetch<{ zone: PsNoGoZone }>(`/api/planning-studio/projects/${projectId}/no-go-zones/${zoneId}`, {
    method: "PATCH", body: JSON.stringify(patch),
  });
  return r.zone;
}
export async function deletePsNoGoZone(projectId: string, zoneId: string): Promise<void> {
  await apiFetch<{ ok: boolean }>(`/api/planning-studio/projects/${projectId}/no-go-zones/${zoneId}`, { method: "DELETE" });
}

/* ─── Calendari ─── */

export async function listPsCalendars(projectId: string): Promise<PsCalendar[]> {
  const r = await apiFetch<{ calendars: PsCalendar[] }>(`/api/planning-studio/projects/${projectId}/calendars`);
  return r.calendars;
}
export async function createPsCalendar(projectId: string, input: Partial<PsCalendar> & { code: string; startDate: string; endDate: string }): Promise<PsCalendar> {
  const r = await apiFetch<{ calendar: PsCalendar }>(`/api/planning-studio/projects/${projectId}/calendars`, {
    method: "POST", body: JSON.stringify(input),
  });
  return r.calendar;
}
export async function updatePsCalendar(projectId: string, calId: string, patch: Partial<PsCalendar>): Promise<PsCalendar> {
  const r = await apiFetch<{ calendar: PsCalendar }>(`/api/planning-studio/projects/${projectId}/calendars/${calId}`, {
    method: "PATCH", body: JSON.stringify(patch),
  });
  return r.calendar;
}
export async function deletePsCalendar(projectId: string, calId: string): Promise<void> {
  await apiFetch<{ ok: boolean }>(`/api/planning-studio/projects/${projectId}/calendars/${calId}`, { method: "DELETE" });
}

/* ─── Trip / stop times ─── */

export async function listPsTrips(projectId: string, opts: { routeId?: string; variantId?: string; categoryId?: string } = {}): Promise<PsTrip[]> {
  const qs = new URLSearchParams();
  if (opts.routeId) qs.set("routeId", opts.routeId);
  if (opts.variantId) qs.set("variantId", opts.variantId);
  if (opts.categoryId) qs.set("categoryId", opts.categoryId);
  const q = qs.toString();
  const r = await apiFetch<{ trips: PsTrip[] }>(
    `/api/planning-studio/projects/${projectId}/trips${q ? `?${q}` : ""}`
  );
  return r.trips;
}
export async function createPsTrip(projectId: string, input: Partial<PsTrip> & { routeId: string; variantId: string }): Promise<PsTrip> {
  const r = await apiFetch<{ trip: PsTrip }>(`/api/planning-studio/projects/${projectId}/trips`, {
    method: "POST", body: JSON.stringify(input),
  });
  return r.trip;
}
export async function deletePsTrip(projectId: string, tripId: string): Promise<void> {
  await apiFetch<{ ok: boolean }>(`/api/planning-studio/projects/${projectId}/trips/${tripId}`, { method: "DELETE" });
}
/** Contatore corse/km del progetto (badge nella toolbar del Planner Studio). */
export async function countPsTrips(projectId: string): Promise<{ count: number; active: number; km: number; kmActive: number; prototypes?: number }> {
  return apiFetch(`/api/planning-studio/projects/${projectId}/trips-count`);
}
export async function updatePsTrip(
  projectId: string, tripId: string,
  patch: Partial<PsTrip> & { attributesMerge?: Record<string, any> },
): Promise<PsTrip> {
  const r = await apiFetch<{ trip: PsTrip }>(
    `/api/planning-studio/projects/${projectId}/trips/${tripId}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
  return r.trip;
}
export async function bulkUpdatePsTrips(
  projectId: string,
  tripIds: string[],
  patch: Partial<Pick<PsTrip, "calendarId" | "validFrom" | "validTo" | "isActive" | "serviceLabel">> & { attributesMerge?: Record<string, any> },
): Promise<{ ok: boolean; count: number }> {
  return apiFetch(
    `/api/planning-studio/projects/${projectId}/trips/bulk-update`,
    { method: "POST", body: JSON.stringify({ tripIds, patch }) },
  );
}
export async function bulkDeletePsTrips(
  projectId: string,
  tripIds: string[],
): Promise<{ ok: boolean; count: number }> {
  return apiFetch(
    `/api/planning-studio/projects/${projectId}/trips/bulk-delete`,
    { method: "POST", body: JSON.stringify({ tripIds }) },
  );
}
/** Crea una Corsa ZERO (prototipo) per ogni percorso (variante) con ≥2 fermate
 *  e nessuna corsa. Serve a ripartire con «Genera a cadenza» quando un progetto
 *  ha i percorsi ma non le corse (es. GTFS importato e corse cancellate). */
export async function prototypeMissingPsTrips(
  projectId: string,
  opts: { variantIds?: string[]; speedKmh?: number; dwellSec?: number; dayTypeCode?: string } = {},
): Promise<{ ok: boolean; created: number; tripIds: string[]; variants: { variantId: string; name: string; tripId: string; stops: number; giroMin: number }[] }> {
  return apiFetch(
    `/api/planning-studio/projects/${projectId}/trips/prototype-missing`,
    { method: "POST", body: JSON.stringify(opts) },
  );
}
export async function listPsTripExceptions(projectId: string, tripId: string): Promise<PsTripException[]> {
  const r = await apiFetch<{ exceptions: PsTripException[] }>(
    `/api/planning-studio/projects/${projectId}/trips/${tripId}/exceptions`,
  );
  return r.exceptions;
}
export async function addPsTripException(
  projectId: string, tripId: string,
  input: { date: string; exceptionType?: 1 | 2; reason?: string },
): Promise<void> {
  await apiFetch<{ ok: boolean }>(
    `/api/planning-studio/projects/${projectId}/trips/${tripId}/exceptions`,
    { method: "POST", body: JSON.stringify(input) },
  );
}
export async function deletePsTripException(projectId: string, tripId: string, date: string): Promise<void> {
  await apiFetch<{ ok: boolean }>(
    `/api/planning-studio/projects/${projectId}/trips/${tripId}/exceptions/${date}`,
    { method: "DELETE" },
  );
}
export async function getPsStopTimes(projectId: string, tripId: string): Promise<PsStopTime[]> {
  const r = await apiFetch<{ stopTimes: PsStopTime[] }>(
    `/api/planning-studio/projects/${projectId}/trips/${tripId}/stop-times`
  );
  return r.stopTimes;
}

/** Orari di molte corse in una sola chiamata (evita N GET → 429). */
export async function getPsStopTimesBulk(
  projectId: string, tripIds: string[],
): Promise<Record<string, PsStopTime[]>> {
  if (tripIds.length === 0) return {};
  const out: Record<string, PsStopTime[]> = {};
  // chunk prudenziale: payload contenuti anche con migliaia di corse
  for (let i = 0; i < tripIds.length; i += 500) {
    const r = await apiFetch<{ stopTimesByTrip: Record<string, PsStopTime[]> }>(
      `/api/planning-studio/projects/${projectId}/stop-times/bulk`,
      { method: "POST", body: JSON.stringify({ tripIds: tripIds.slice(i, i + 500) }) },
    );
    Object.assign(out, r.stopTimesByTrip);
  }
  return out;
}
export async function setPsStopTimes(
  projectId: string, tripId: string,
  stopTimes: { stopId: string; arrivalTime: string; departureTime: string }[]
): Promise<void> {
  await apiFetch<{ ok: boolean; count: number }>(
    `/api/planning-studio/projects/${projectId}/trips/${tripId}/stop-times`,
    { method: "PUT", body: JSON.stringify({ stopTimes }) }
  );
}

/** Trasla tutti gli orari di una corsa di ±N minuti (drag nell'orario grafico). */
export async function shiftPsTripTimes(
  projectId: string, tripId: string, deltaMinutes: number,
): Promise<{ ok: boolean; count: number; deltaMinutes: number }> {
  return apiFetch(
    `/api/planning-studio/projects/${projectId}/trips/${tripId}/shift`,
    { method: "POST", body: JSON.stringify({ deltaMinutes }) },
  );
}

/** Input per la creazione batch di corse (cadenzamento da orario grafico). */
export interface PsBatchTripInput {
  routeId: string;
  variantId: string;
  calendarId?: string | null;
  headsign?: string | null;
  shortName?: string | null;
  direction?: number;
  serviceLabel?: string | null;
  attributes?: Record<string, any>;
  /** corsa da cui EREDITARE la validità (day-type + categorie calendario aziendale) */
  baseTripId?: string;
  stopTimes: { stopId: string; arrivalTime: string; departureTime: string; timepoint?: number }[];
}

/** Crea N corse con i rispettivi stop_times in una sola chiamata. */
export async function batchCreatePsTrips(
  projectId: string, trips: PsBatchTripInput[],
): Promise<{ ok: boolean; count: number; tripIds: string[] }> {
  return apiFetch(
    `/api/planning-studio/projects/${projectId}/trips/batch-create`,
    { method: "POST", body: JSON.stringify({ trips }) },
  );
}

/** Sdoppia una corsa per validità: crea una copia (stesso orario) con le
 *  categorie scelte, togliendole all'originale. Poi si sposta la copia nel TTD. */
export async function splitPsTripByCategories(
  projectId: string, tripId: string, categoryIds: string[],
): Promise<{ ok: boolean; newTripId: string; moved: number }> {
  return apiFetch(
    `/api/planning-studio/projects/${projectId}/trips/${tripId}/split-categories`,
    { method: "POST", body: JSON.stringify({ categoryIds }) },
  );
}

/* ─── KM annui per linea e categoria (stampa elenco corse) ─── */
export interface PsCorseKm {
  from: string | null; to: string | null; hasCalendar: boolean; hasOnDemand: boolean;
  categories: { code: string; name: string; color: string | null; sort: number }[];
  lines: {
    routeId: string; shortName: string; longName: string | null; color: string | null;
    kmByCategory: Record<string, number>; kmTotal: number;
    onDemandByCategory: Record<string, number>; onDemandTotal: number;
  }[];
  totalsByCategory: Record<string, number>;
  grandTotal: number;
  onDemandTotalsByCategory: Record<string, number>;
  onDemandGrandTotal: number;
}
/** km annui (dal calendario aziendale, ignorando il periodo delle corse),
 *  per linea e ripartiti per categoria di validità, con i totali. */
export async function getPsCorseKm(projectId: string, routeIds?: string[]): Promise<PsCorseKm> {
  const q = routeIds && routeIds.length ? `?routeIds=${encodeURIComponent(routeIds.join(","))}` : "";
  return apiFetch(`/api/planning-studio/projects/${projectId}/corse-km${q}`);
}

/* ─── Unifica corse gemelle ─── */
export interface MergeTwinGroup {
  primaryId: string; removeIds: string[];
  variantId: string; headsign: string | null; departure: string; count: number;
  unionWeekdays: boolean[]; unionWeekdaysLabel: string;
  unionStart: string | null; unionEnd: string | null; anyCal: boolean;
  validFrom: string | null; validTo: string | null;
  unionCategories?: Array<{ name: string; code: string; color: string | null }>;
}
export interface MergeTwinsResult {
  dryRun: boolean; groups: MergeTwinGroup[];
  tripsBefore: number; tripsAfter: number; removed: number;
}
/** Anteprima (dryRun) o applica la fusione delle corse gemelle (stessa variante,
 *  stessi orari a tutte le fermate, stesso headsign) in una sola corsa con
 *  validità unione + calendario-unione. */
export async function mergePsTwins(
  projectId: string, opts?: { dryRun?: boolean; routeId?: string },
): Promise<MergeTwinsResult> {
  const dry = opts?.dryRun ? "?dryRun=1" : "";
  return apiFetch(`/api/planning-studio/projects/${projectId}/trips/merge-twins${dry}`, {
    method: "POST", body: JSON.stringify({ routeId: opts?.routeId }),
  });
}

/* ─── Import GTFS ─── */

export interface PsImportCounts {
  stops: number;
  routes: number;
  calendars: number;
  calendarDates: number;
  variants: number;
  shapes: number;
  trips: number;
  stopTimes: number;
}

/**
 * Carica uno zip GTFS e sovrascrive il database del progetto.
 * NOTA: usa fetch raw (non apiFetch) perché FormData richiede che il browser
 * imposti automaticamente Content-Type con il boundary multipart corretto.
 */
export interface PsMergeImportCounts {
  stops: { added: number; updated: number };
  routes: { added: number; updated: number };
  variants: { added: number; matched: number };
  calendars: { added: number; updated: number };
  trips: { added: number; updated: number; deactivated: number; keptManual: number };
  stopTimes: number;
  shapes: number;
}

export async function importPsGtfs(
  projectId: string,
  file: File,
  routeIds?: string[],
  mode?: "replace" | "merge",
  dryRun?: boolean,
): Promise<{ ok: boolean; counts?: PsImportCounts; mode?: string; dryRun?: boolean; merge?: PsMergeImportCounts }> {
  const fd = new FormData();
  fd.append("file", file);
  // routeIds assente → importa tutte le linee (comportamento storico)
  if (routeIds && routeIds.length) fd.append("routeIds", JSON.stringify(routeIds));
  // mode="merge" → re-import non distruttivo: UUID conservati per chiave
  // stabile, validità/cluster/UDP sopravvivono; default = sostituzione totale.
  if (mode === "merge") fd.append("mode", "merge");
  // dryRun → ANTEPRIMA del merge: conteggi esatti, nessuna scrittura (rollback)
  if (mode === "merge" && dryRun) fd.append("dryRun", "1");
  const res = await fetch(
    `${getApiBase()}/api/planning-studio/projects/${projectId}/import-gtfs`,
    { method: "POST", credentials: "include", body: fd }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string })?.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export interface PsGtfsPreviewRoute {
  routeId: string;
  shortName: string;
  longName: string | null;
  routeType: number;
  color: string | null;
  trips: number;
}
/** Legge lo zip GTFS e restituisce l'elenco linee (senza scrivere nulla),
 *  così l'utente può scegliere quali importare. */
export async function previewPsGtfs(
  projectId: string,
  file: File,
): Promise<{ routes: PsGtfsPreviewRoute[]; totalRoutes: number; totalTrips: number }> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(
    `${getApiBase()}/api/planning-studio/projects/${projectId}/import-gtfs/preview`,
    { method: "POST", credentials: "include", body: fd }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string })?.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/* ─── Cluster di fermate (interscambi) ─── */

/**
 * Tipo di cluster (= nodo logico che raggruppa più fermate fisiche):
 *   - "interchange": punto di cambio conducente. Usato da Scheduling Engine
 *     come change point nei turni macchina (driver block changes).
 *   - "rest": nodo di sosta. Luogo idoneo alla sosta inoperosa extraurbana
 *     (deposito o capolinea con servizi igienici/strutture). Usato dallo
 *     scheduler turni guida per piazzare le soste inoperose.
 *   - "none": solo nodo logico (raggruppamento, intermodalità, ecc.).
 */
export type PsClusterKind = "interchange" | "rest" | "none";

export interface PsCluster {
  id: string;
  projectId: string;
  code?: string | null;
  name: string;
  kind: PsClusterKind;
  centerLat: number | null;
  centerLon: number | null;
  radiusM: number;
  attributes: Record<string, any>;
  createdAt: string;
  updatedAt: string;
  stopCount?: number;
}

export interface PsClusterSuggestion {
  suggestedName: string;
  centerLat: number;
  centerLon: number;
  stops: { id: string; code: string | null; name: string; lat: number; lon: number }[];
}

export async function listPsClusters(projectId: string): Promise<PsCluster[]> {
  const r = await apiFetch<{ clusters: PsCluster[] }>(`/api/planning-studio/projects/${projectId}/clusters`);
  return r.clusters;
}
export async function createPsCluster(projectId: string, input: Partial<PsCluster> & { name: string }): Promise<PsCluster> {
  const r = await apiFetch<{ cluster: PsCluster }>(`/api/planning-studio/projects/${projectId}/clusters`, {
    method: "POST", body: JSON.stringify(input),
  });
  return r.cluster;
}
export async function updatePsCluster(projectId: string, clusterId: string, patch: Partial<PsCluster>): Promise<PsCluster> {
  const r = await apiFetch<{ cluster: PsCluster }>(`/api/planning-studio/projects/${projectId}/clusters/${clusterId}`, {
    method: "PATCH", body: JSON.stringify(patch),
  });
  return r.cluster;
}
export async function deletePsCluster(projectId: string, clusterId: string): Promise<void> {
  await apiFetch<{ ok: boolean }>(`/api/planning-studio/projects/${projectId}/clusters/${clusterId}`, { method: "DELETE" });
}
export async function setPsClusterStops(projectId: string, clusterId: string, stopIds: string[]): Promise<void> {
  await apiFetch<{ ok: boolean; count: number }>(
    `/api/planning-studio/projects/${projectId}/clusters/${clusterId}/stops`,
    { method: "PUT", body: JSON.stringify({ stopIds }) },
  );
}
export async function suggestPsClusters(
  projectId: string, opts: { radius?: number; minSize?: number } = {},
): Promise<{ radius: number; minSize: number; suggestions: PsClusterSuggestion[] }> {
  const qs = new URLSearchParams();
  if (opts.radius != null) qs.set("radius", String(opts.radius));
  if (opts.minSize != null) qs.set("minSize", String(opts.minSize));
  const q = qs.toString();
  return apiFetch(`/api/planning-studio/projects/${projectId}/clusters/suggest${q ? `?${q}` : ""}`);
}

/* ─── Service Periods (periodi di esercizio: Estivo, Invernale, ecc.) ─── */

export interface PsServicePeriod {
  id: string;
  projectId: string;
  code?: string | null;
  name: string;
  startDate: string;     // YYYY-MM-DD
  endDate: string;       // YYYY-MM-DD
  isDefault: boolean;
  color?: string | null;
  notes?: string | null;
  createdAt: string;
}

export async function listPsServicePeriods(projectId: string): Promise<PsServicePeriod[]> {
  const r = await apiFetch<{ servicePeriods: PsServicePeriod[] }>(
    `/api/planning-studio/projects/${projectId}/service-periods`,
  );
  return r.servicePeriods;
}
export async function createPsServicePeriod(
  projectId: string,
  input: Partial<PsServicePeriod> & { name: string; startDate: string; endDate: string },
): Promise<PsServicePeriod> {
  const r = await apiFetch<{ servicePeriod: PsServicePeriod }>(
    `/api/planning-studio/projects/${projectId}/service-periods`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return r.servicePeriod;
}
export async function updatePsServicePeriod(
  projectId: string, periodId: string, patch: Partial<PsServicePeriod>,
): Promise<PsServicePeriod> {
  const r = await apiFetch<{ servicePeriod: PsServicePeriod }>(
    `/api/planning-studio/projects/${projectId}/service-periods/${periodId}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
  return r.servicePeriod;
}
export async function deletePsServicePeriod(projectId: string, periodId: string): Promise<void> {
  await apiFetch<{ ok: boolean }>(
    `/api/planning-studio/projects/${projectId}/service-periods/${periodId}`,
    { method: "DELETE" },
  );
}

/* ─── Change-points (cluster interchange esposti per Scheduling Engine) ─── */

export interface PsChangePoint {
  id: string;
  code?: string | null;
  name: string;
  centerLat: number | null;
  centerLon: number | null;
  radiusM: number;
  stops: { id: string; code: string | null; name: string; lat: number; lon: number }[];
}

export async function listPsChangePoints(projectId: string): Promise<PsChangePoint[]> {
  const r = await apiFetch<{ changePoints: PsChangePoint[] }>(
    `/api/planning-studio/projects/${projectId}/change-points`,
  );
  return r.changePoints;
}

/* ─── Rest-points (cluster di sosta esposti per lo scheduler turni guida) ─── */

export interface PsRestPoint extends PsChangePoint {
  /** strutture adeguate (servizi igienici): la sosta conta al 12% invece che al 25% */
  hasFacilities: boolean;
}

export async function listPsRestPoints(projectId: string): Promise<PsRestPoint[]> {
  const r = await apiFetch<{ restPoints: PsRestPoint[] }>(
    `/api/planning-studio/projects/${projectId}/rest-points`,
  );
  return r.restPoints;
}

/* ─── Network Inspector (vista relazionale aggregata) ─── */

export interface PsRouteDetail {
  route: {
    id: string; code: string | null; shortName: string; longName: string | null;
    description: string | null; routeType: number;
    color: string | null; textColor: string | null; sortOrder: number;
    attributes: Record<string, any>;
  };
  agency: {
    id: string | null; name: string | null;
    url: string | null; timezone: string | null;
  };
  variants: Array<{
    id: string; name: string; code?: string; direction: number; headsign: string | null;
    isDefault: boolean; stopCount: number; tripCount: number; hasShape: boolean;
  }>;
  stops: Array<{
    id: string; code: string | null; name: string;
    lat: number; lon: number; variantCount: number;
  }>;
  validity: { from: string | null; to: string | null };
  tripCount: number;
  activeCount: number;
}

export interface PsVariantDetail {
  variant: {
    id: string; name: string; code?: string; direction: number;
    headsign: string | null; isDefault: boolean;
    attributes: Record<string, any>;
  };
  route: {
    id: string; shortName: string; longName: string | null;
    color: string | null; textColor: string | null; routeType: number;
  };
  stops: Array<{
    seq: number; stopId: string; code: string | null; name: string;
    lat: number; lon: number;
    pickupType: number; dropOffType: number; timepoint: number;
    shapeDistTraveled: number | null;
  }>;
  shape: {
    id: string; mode: string;
    distanceM: number | null; durationS: number | null;
  } | null;
  trips: {
    total: number;
    sample: Array<{
      id: string; headsign: string | null; shortName: string | null;
      validFrom: string | null; validTo: string | null; isActive: boolean;
      calendarId: string | null; calendarCode: string | null;
      firstDeparture: string | null;
    }>;
  };
}

export interface PsStopDetail {
  stop: {
    id: string; code: string | null; name: string; description: string | null;
    lat: number; lon: number;
    zoneId: string | null; locationType: number;
    parentStation: string | null;
    wheelchairBoarding: number;
    platformCode: string | null;
    attributes: Record<string, any>;
  };
  cluster: { id: string; code: string | null; name: string; kind: string } | null;
  routes: Array<{
    id: string; shortName: string; longName: string | null;
    color: string | null; textColor: string | null; routeType: number;
    variants: Array<{
      id: string; name: string; code?: string; direction: number;
      headsign: string | null; tripCount: number;
    }>;
    totalTrips: number;
  }>;
  totalTripCount: number;
}

export async function getPsRouteDetail(projectId: string, routeId: string): Promise<PsRouteDetail> {
  return apiFetch(`/api/planning-studio/projects/${projectId}/routes/${routeId}/detail`);
}
export async function getPsVariantDetail(projectId: string, variantId: string): Promise<PsVariantDetail> {
  return apiFetch(`/api/planning-studio/projects/${projectId}/variants/${variantId}/detail`);
}
export async function getPsStopDetail(projectId: string, stopId: string): Promise<PsStopDetail> {
  return apiFetch(`/api/planning-studio/projects/${projectId}/stops/${stopId}/detail`);
}


