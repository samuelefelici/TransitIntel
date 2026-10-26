--
-- PostgreSQL database dump
--
--
-- Copia ripulita per il repository (26/10/2026): tolti i blocchi ACL e DEFAULT ACL
-- (chi può leggere cosa) e la tabella caronte.app_users, che non è di Cerbero.
-- Il resto è il dump com'è uscito dalla produzione. Il baseline non cambia.
--

-- Dumped from database version 17.0 (Debian 17.0-1.pgdg110+1)
-- Dumped by pg_dump version 17.0 (Debian 17.0-1.pgdg110+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: caronte; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA caronte;


--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: active_trips; Type: TABLE; Schema: caronte; Owner: -
--

CREATE TABLE caronte.active_trips (
    id uuid NOT NULL,
    trip_id text NOT NULL,
    route_id text,
    vehicle_id text,
    device_id text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    source text
);


--
-- Name: avm_controllo_settimanale; Type: TABLE; Schema: caronte; Owner: -
--

CREATE TABLE caronte.avm_controllo_settimanale (
    settimana date NOT NULL,
    generato_il timestamp with time zone DEFAULT now() NOT NULL,
    versione integer NOT NULL,
    dati jsonb NOT NULL
);


--
-- Name: avm_diario; Type: TABLE; Schema: caronte; Owner: -
--

CREATE TABLE caronte.avm_diario (
    day date NOT NULL,
    vehicle_ref text NOT NULL,
    letture integer DEFAULT 0 NOT NULL,
    letture_fresche integer DEFAULT 0 NOT NULL,
    letture_monitorata integer DEFAULT 0 NOT NULL,
    letture_posizione integer DEFAULT 0 NOT NULL,
    letture_corsa integer DEFAULT 0 NOT NULL,
    letture_errore_gps integer DEFAULT 0 NOT NULL,
    letture_errore_gprs integer DEFAULT 0 NOT NULL,
    letture_rimessa integer DEFAULT 0 NOT NULL,
    primo_contatto timestamp with time zone,
    ultimo_contatto timestamp with time zone,
    linee text[] DEFAULT '{}'::text[] NOT NULL,
    corse text[] DEFAULT '{}'::text[] NOT NULL,
    first_seen timestamp with time zone DEFAULT now() NOT NULL,
    last_seen timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: journey_code_days; Type: TABLE; Schema: caronte; Owner: -
--

CREATE TABLE caronte.journey_code_days (
    day date NOT NULL,
    rounds integer DEFAULT 0 NOT NULL,
    vehicles integer DEFAULT 0 NOT NULL,
    with_code integer DEFAULT 0 NOT NULL,
    matched integer DEFAULT 0 NOT NULL,
    matched_by_id integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: journey_codes; Type: TABLE; Schema: caronte; Owner: -
--

CREATE TABLE caronte.journey_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    day date NOT NULL,
    journey_ref text NOT NULL,
    trip_id text DEFAULT ''::text NOT NULL,
    matched_by text,
    vehicle_ref text,
    line_ref text,
    published_line_name text,
    route_ref text,
    course_ref text,
    framed_ref text,
    data_frame_ref text,
    pattern_ref text,
    block_ref text,
    avm_departure text,
    avm_destination text,
    route_id text,
    gtfs_departure text,
    gtfs_headsign text,
    observations integer DEFAULT 1 NOT NULL,
    first_seen timestamp with time zone DEFAULT now() NOT NULL,
    last_seen timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: journeys; Type: TABLE; Schema: caronte; Owner: -
--

CREATE TABLE caronte.journeys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id text,
    ticket_uid text,
    trip_id text,
    route_id text,
    stop_in text,
    stop_out text,
    cluster_in text,
    cluster_out text,
    fare_kind text,
    expected_price double precision,
    charged_price double precision,
    price_match boolean,
    tap_in_id uuid,
    tap_out_id uuid,
    ts_start timestamp with time zone,
    ts_end timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stop_alias_overrides; Type: TABLE; Schema: caronte; Owner: -
--

CREATE TABLE caronte.stop_alias_overrides (
    mizar_ref text NOT NULL,
    stop_id text,
    nome text,
    nota text,
    updated_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stop_predictions; Type: TABLE; Schema: caronte; Owner: -
--

CREATE TABLE caronte.stop_predictions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    day date NOT NULL,
    trip_id text NOT NULL,
    stop_id text NOT NULL,
    mizar_ref text NOT NULL,
    vehicle_ref text,
    line_ref text,
    aimed_ts timestamp with time zone,
    expected_ts timestamp with time zone NOT NULL,
    expected_first_ts timestamp with time zone NOT NULL,
    status text,
    recorded_at timestamp with time zone,
    observations integer DEFAULT 1 NOT NULL,
    first_seen timestamp with time zone DEFAULT now() NOT NULL,
    last_seen timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stop_transits; Type: TABLE; Schema: caronte; Owner: -
--

CREATE TABLE caronte.stop_transits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    trip_id text,
    route_id text,
    vehicle_id text,
    device_id text,
    stop_id text NOT NULL,
    stop_seq integer,
    scheduled text,
    actual_ts timestamp with time zone DEFAULT now() NOT NULL,
    delay_seconds integer,
    lat double precision,
    lon double precision,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source text
);


--
-- Name: tap_events; Type: TABLE; Schema: caronte; Owner: -
--

CREATE TABLE caronte.tap_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id text NOT NULL,
    vehicle_id text,
    trip_id text,
    route_id text,
    direction text NOT NULL,
    stop_id text,
    cluster_id text,
    stop_seq integer,
    ticket_uid text,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    lat double precision,
    lon double precision,
    raw_nfc jsonb
);


--
-- Name: vehicle_positions; Type: TABLE; Schema: caronte; Owner: -
--

CREATE TABLE caronte.vehicle_positions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vehicle_id text,
    trip_id text,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    lat double precision NOT NULL,
    lon double precision NOT NULL,
    nearest_stop_id text,
    speed double precision,
    heading double precision,
    source text
);


--
-- Name: accessi_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accessi_log (
    id bigint NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid,
    email text,
    esito text NOT NULL,
    ip text,
    user_agent text
);


--
-- Name: accessi_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.accessi_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: accessi_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.accessi_log_id_seq OWNED BY public.accessi_log.id;


--
-- Name: accessi_tentativi; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accessi_tentativi (
    chiave text NOT NULL,
    ip text NOT NULL,
    errori integer DEFAULT 0 NOT NULL,
    inizio timestamp with time zone,
    ultimo timestamp with time zone DEFAULT now() NOT NULL,
    bloccato_fino timestamp with time zone
);


--
-- Name: agent_optimize_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_optimize_jobs (
    id uuid NOT NULL,
    user_id uuid,
    ps_project_id uuid,
    mode text,
    status text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone,
    progress jsonb,
    params jsonb,
    request jsonb,
    error text,
    scenario_id uuid,
    dss_id uuid,
    scenario_name text,
    result_compact jsonb,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: app_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_settings (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: bus_routes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bus_routes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    line_code text,
    name text NOT NULL,
    service_type text DEFAULT 'urban'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: bus_stops; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bus_stops (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text,
    name text NOT NULL,
    lng double precision NOT NULL,
    lat double precision NOT NULL,
    lines text[] DEFAULT '{}'::text[],
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: census_sections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.census_sections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    istat_code text,
    centroid_lng double precision DEFAULT 0 NOT NULL,
    centroid_lat double precision DEFAULT 0 NOT NULL,
    population integer DEFAULT 0 NOT NULL,
    area_km2 double precision DEFAULT 0 NOT NULL,
    density double precision DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    geojson jsonb
);


--
-- Name: coincidence_zone_stops; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.coincidence_zone_stops (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    zone_id uuid NOT NULL,
    gtfs_stop_id text NOT NULL,
    stop_name text NOT NULL,
    stop_lat double precision NOT NULL,
    stop_lon double precision NOT NULL,
    distance_km double precision,
    walk_min_from_hub integer
);


--
-- Name: coincidence_zones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.coincidence_zones (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    hub_id text NOT NULL,
    hub_name text NOT NULL,
    hub_type text NOT NULL,
    hub_lat double precision NOT NULL,
    hub_lng double precision NOT NULL,
    walk_minutes integer DEFAULT 5 NOT NULL,
    radius_km double precision DEFAULT 0.5 NOT NULL,
    color text DEFAULT '#06b6d4'::text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    schedules jsonb,
    ps_project_id uuid
);


--
-- Name: deadhead_arcs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deadhead_arcs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    from_key text NOT NULL,
    from_type text NOT NULL,
    from_name text,
    from_lat double precision NOT NULL,
    from_lon double precision NOT NULL,
    to_key text NOT NULL,
    to_type text NOT NULL,
    to_name text,
    to_lat double precision NOT NULL,
    to_lon double precision NOT NULL,
    geometry jsonb,
    road_km double precision,
    travel_min double precision,
    custom_min double precision,
    custom_km double precision,
    via_points jsonb,
    source text DEFAULT 'osrm'::text NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    ps_project_id uuid
);


--
-- Name: depots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.depots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    address text,
    lat double precision,
    lon double precision,
    capacity integer,
    operating_hours_start text,
    operating_hours_end text,
    has_diesel boolean DEFAULT false,
    has_methane boolean DEFAULT false,
    has_electric boolean DEFAULT false,
    charging_points integer DEFAULT 0,
    cng_points integer DEFAULT 0,
    color text DEFAULT '#3b82f6'::text,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    ps_project_id uuid
);


--
-- Name: driver_schedule_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_schedule_members (
    scenario_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'editor'::text NOT NULL,
    added_by uuid,
    added_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: driver_shift_scenarios; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_shift_scenarios (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    service_program_scenario_id uuid NOT NULL,
    name text NOT NULL,
    result jsonb NOT NULL,
    config jsonb,
    created_at timestamp with time zone DEFAULT now(),
    owner_user_id uuid,
    project_id uuid,
    is_shared boolean DEFAULT false NOT NULL,
    description text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_operational boolean DEFAULT false NOT NULL,
    stale_since timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    superseded_by uuid,
    valid_from date,
    valid_to date
);


--
-- Name: fares_polimetriche_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fares_polimetriche_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text,
    agency_name text,
    zoning_method text,
    route_count integer,
    product_count integer,
    area_count integer,
    html text,
    meta jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    html_gz bytea
);


--
-- Name: gtfs_calendar; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtfs_calendar (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid,
    service_id text NOT NULL,
    monday integer DEFAULT 0 NOT NULL,
    tuesday integer DEFAULT 0 NOT NULL,
    wednesday integer DEFAULT 0 NOT NULL,
    thursday integer DEFAULT 0 NOT NULL,
    friday integer DEFAULT 0 NOT NULL,
    saturday integer DEFAULT 0 NOT NULL,
    sunday integer DEFAULT 0 NOT NULL,
    start_date text NOT NULL,
    end_date text NOT NULL
);


--
-- Name: gtfs_calendar_dates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtfs_calendar_dates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid,
    service_id text NOT NULL,
    date text NOT NULL,
    exception_type integer NOT NULL
);


--
-- Name: gtfs_fare_areas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtfs_fare_areas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid,
    area_id text NOT NULL,
    area_name text NOT NULL,
    network_id text,
    route_id text,
    km_from double precision,
    km_to double precision,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: gtfs_fare_attributes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtfs_fare_attributes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid,
    fare_id text NOT NULL,
    price double precision NOT NULL,
    currency_type text DEFAULT 'EUR'::text NOT NULL,
    payment_method integer DEFAULT 0 NOT NULL,
    transfers integer,
    agency_id text,
    transfer_duration integer,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: gtfs_fare_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtfs_fare_audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid,
    action text NOT NULL,
    description text NOT NULL,
    actor text DEFAULT 'system'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: gtfs_fare_leg_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtfs_fare_leg_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid,
    leg_group_id text NOT NULL,
    network_id text,
    from_area_id text,
    to_area_id text,
    fare_product_id text NOT NULL,
    rule_priority integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    from_timeframe_group_id text,
    to_timeframe_group_id text
);


--
-- Name: gtfs_fare_media; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtfs_fare_media (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid,
    fare_media_id text NOT NULL,
    fare_media_name text NOT NULL,
    fare_media_type integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: gtfs_fare_network_edges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtfs_fare_network_edges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid NOT NULL,
    from_cluster_id text NOT NULL,
    to_cluster_id text NOT NULL,
    km double precision NOT NULL,
    route_id text,
    route_short_name text,
    shape_id text,
    source text DEFAULT 'dominant'::text NOT NULL,
    bidirectional boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: gtfs_fare_networks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtfs_fare_networks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid,
    network_id text NOT NULL,
    network_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: gtfs_fare_node_assignment_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtfs_fare_node_assignment_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid NOT NULL,
    status text NOT NULL,
    total_stops integer,
    assigned_by_layer jsonb,
    clusters_before integer,
    clusters_after integer,
    duration_ms integer,
    error_message text,
    params jsonb,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone
);


--
-- Name: gtfs_fare_od_matrix; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtfs_fare_od_matrix (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid NOT NULL,
    from_cluster_id text NOT NULL,
    to_cluster_id text NOT NULL,
    km_tariffario double precision NOT NULL,
    fascia integer,
    prezzo double precision NOT NULL,
    fare_product_id text,
    path_clusters jsonb NOT NULL,
    path_routes jsonb NOT NULL,
    hop_count integer NOT NULL,
    is_urban boolean DEFAULT false NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: gtfs_fare_od_matrix_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtfs_fare_od_matrix_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid NOT NULL,
    status text NOT NULL,
    edge_count integer,
    pairs_computed integer,
    pairs_skipped integer,
    duration_ms integer,
    error_message text,
    params jsonb,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone
);


--
-- Name: gtfs_fare_official_nodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtfs_fare_official_nodes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid NOT NULL,
    official_code text NOT NULL,
    official_name text NOT NULL,
    name_normalized text NOT NULL,
    centroid_lat double precision,
    centroid_lon double precision,
    aliases jsonb DEFAULT '[]'::jsonb,
    source text DEFAULT 'manual'::text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: gtfs_fare_products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtfs_fare_products (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid,
    fare_product_id text NOT NULL,
    fare_product_name text NOT NULL,
    network_id text,
    rider_category_id text,
    fare_media_id text,
    amount double precision NOT NULL,
    currency text DEFAULT 'EUR'::text NOT NULL,
    duration_minutes integer,
    fare_type text DEFAULT 'single'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    is_urban_hourly boolean DEFAULT false NOT NULL
);


--
-- Name: gtfs_fare_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtfs_fare_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid,
    fare_id text NOT NULL,
    route_id text,
    origin_id text,
    destination_id text,
    contains_id text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: gtfs_fare_stop_assignment_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtfs_fare_stop_assignment_overrides (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid NOT NULL,
    stop_id text NOT NULL,
    from_cluster_id text,
    to_cluster_id text,
    reason text,
    actor text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: gtfs_fare_transfer_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtfs_fare_transfer_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid,
    from_leg_group_id text,
    to_leg_group_id text,
    transfer_count integer,
    duration_limit integer,
    duration_limit_type integer,
    fare_transfer_type integer,
    fare_product_id text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: gtfs_fare_zone_cluster_stops; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtfs_fare_zone_cluster_stops (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid,
    cluster_id text NOT NULL,
    stop_id text NOT NULL,
    stop_name text NOT NULL,
    stop_lat double precision NOT NULL,
    stop_lon double precision NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    assignment_layer text,
    assignment_confidence integer DEFAULT 0,
    assignment_source text,
    assigned_at timestamp with time zone DEFAULT now()
);


--
-- Name: gtfs_fare_zone_clusters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtfs_fare_zone_clusters (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid,
    cluster_id text NOT NULL,
    cluster_name text NOT NULL,
    polygon jsonb,
    centroid_lat double precision,
    centroid_lon double precision,
    color text DEFAULT '#3b82f6'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    is_official boolean DEFAULT false NOT NULL,
    official_code text
);


--
-- Name: gtfs_feed_analysis; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtfs_feed_analysis (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid NOT NULL,
    total_km_day double precision DEFAULT 0,
    total_hours_day double precision DEFAULT 0,
    total_trips_day integer DEFAULT 0,
    active_routes integer DEFAULT 0,
    active_stops integer DEFAULT 0,
    bbox_min_lat double precision,
    bbox_max_lat double precision,
    bbox_min_lon double precision,
    bbox_max_lon double precision,
    population_covered integer DEFAULT 0,
    population_total integer DEFAULT 0,
    total_cost_day double precision DEFAULT 0,
    total_revenue_day double precision DEFAULT 0,
    margin_day double precision DEFAULT 0,
    per_route jsonb,
    anomalies jsonb,
    computed_at timestamp with time zone DEFAULT now()
);


--
-- Name: gtfs_feed_economic_params; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtfs_feed_economic_params (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid NOT NULL,
    fuel_consumption_l_100 double precision DEFAULT 35 NOT NULL,
    fuel_price_eur_l double precision DEFAULT 1.65 NOT NULL,
    driver_cost_eur_h double precision DEFAULT 28 NOT NULL,
    maintenance_eur_km double precision DEFAULT 0.35 NOT NULL,
    amortization_eur_km double precision DEFAULT 0.25 NOT NULL,
    fare_urban_eur_km double precision DEFAULT 2.5 NOT NULL,
    fare_suburban_eur_km double precision DEFAULT 1.8 NOT NULL,
    fare_night_eur_km double precision DEFAULT 2.2 NOT NULL,
    per_route_overrides jsonb,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: gtfs_feed_info; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtfs_feed_info (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid,
    feed_publisher_name text NOT NULL,
    feed_publisher_url text NOT NULL,
    feed_lang text DEFAULT 'it'::text NOT NULL,
    default_lang text,
    feed_start_date text,
    feed_end_date text,
    feed_version text,
    feed_contact_email text,
    feed_contact_url text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: gtfs_feeds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtfs_feeds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    filename text NOT NULL,
    agency_name text,
    feed_start_date text,
    feed_end_date text,
    stops_count integer DEFAULT 0,
    routes_count integer DEFAULT 0,
    trips_count integer DEFAULT 0,
    shapes_count integer DEFAULT 0,
    uploaded_at timestamp with time zone DEFAULT now(),
    is_active boolean DEFAULT false NOT NULL,
    owner_user_id uuid,
    is_default boolean DEFAULT false NOT NULL,
    archived_at timestamp with time zone
);


--
-- Name: gtfs_rider_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtfs_rider_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid,
    rider_category_id text NOT NULL,
    rider_category_name text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    eligibility_url text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: gtfs_route_networks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtfs_route_networks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid,
    route_id text NOT NULL,
    network_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: gtfs_routes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtfs_routes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid,
    route_id text NOT NULL,
    agency_id text,
    route_short_name text,
    route_long_name text,
    route_type integer DEFAULT 3,
    route_color text,
    route_text_color text,
    trips_count integer DEFAULT 0,
    route_url text
);


--
-- Name: gtfs_shapes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtfs_shapes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid,
    shape_id text NOT NULL,
    route_id text,
    route_short_name text,
    route_color text,
    geojson jsonb NOT NULL
);


--
-- Name: gtfs_stop_areas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtfs_stop_areas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid,
    area_id text NOT NULL,
    stop_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: gtfs_stop_times; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtfs_stop_times (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid,
    trip_id text NOT NULL,
    stop_id text NOT NULL,
    stop_sequence integer NOT NULL,
    departure_time text,
    arrival_time text,
    pickup_type integer DEFAULT 0 NOT NULL,
    drop_off_type integer DEFAULT 0 NOT NULL
);


--
-- Name: gtfs_stops; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtfs_stops (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid,
    stop_id text NOT NULL,
    stop_code text,
    stop_name text NOT NULL,
    stop_desc text,
    stop_lat double precision NOT NULL,
    stop_lon double precision NOT NULL,
    wheelchair_boarding integer DEFAULT 0,
    trips_count integer DEFAULT 0,
    morning_peak_trips integer DEFAULT 0,
    evening_peak_trips integer DEFAULT 0,
    service_score double precision DEFAULT 0,
    stop_classification integer,
    stop_classification_label text,
    fare_kind text
);


--
-- Name: gtfs_timeframes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtfs_timeframes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid,
    timeframe_group_id text NOT NULL,
    start_time text,
    end_time text,
    service_id text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: gtfs_trips; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtfs_trips (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid,
    trip_id text NOT NULL,
    route_id text NOT NULL,
    service_id text NOT NULL,
    trip_headsign text,
    direction_id integer DEFAULT 0,
    shape_id text,
    on_demand boolean DEFAULT false,
    variant_code text,
    block_id text
);


--
-- Name: intermodal_hub_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.intermodal_hub_schedules (
    hub_id text NOT NULL,
    payload jsonb NOT NULL,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: isochrone_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.isochrone_cache (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lat_round double precision NOT NULL,
    lng_round double precision NOT NULL,
    minutes integer NOT NULL,
    geojson jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: istat_commuting_od; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.istat_commuting_od (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    origin_istat text NOT NULL,
    origin_name text,
    dest_istat text NOT NULL,
    dest_name text,
    reason text,
    mode text,
    time_slot text,
    duration_min integer,
    flow integer DEFAULT 0 NOT NULL,
    origin_lat double precision,
    origin_lon double precision,
    dest_lat double precision,
    dest_lon double precision,
    imported_at timestamp with time zone DEFAULT now()
);


--
-- Name: optimizer_rule_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.optimizer_rule_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid,
    scope text DEFAULT 'company'::text NOT NULL,
    project_id uuid,
    name text NOT NULL,
    service_type text,
    config_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    domain text DEFAULT 'crew'::text NOT NULL,
    CONSTRAINT ck_orp_project_scope CHECK ((NOT ((scope = 'project'::text) AND (project_id IS NULL))))
);


--
-- Name: planning_analysis_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.planning_analysis_results (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scenario_id uuid NOT NULL,
    module text NOT NULL,
    input_params jsonb,
    result jsonb NOT NULL,
    edits_hash text,
    computed_at timestamp with time zone DEFAULT now()
);


--
-- Name: planning_pois; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.planning_pois (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid NOT NULL,
    name text NOT NULL,
    category text NOT NULL,
    lat double precision NOT NULL,
    lng double precision NOT NULL,
    weight double precision DEFAULT 1 NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: planning_route_classifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.planning_route_classifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid NOT NULL,
    route_id text NOT NULL,
    category text NOT NULL,
    fare_type text,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: planning_scenario_edits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.planning_scenario_edits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scenario_id uuid NOT NULL,
    kind text NOT NULL,
    target_type text,
    target_gtfs_id text,
    payload jsonb NOT NULL,
    undo_of_edit_id uuid,
    applied_by text,
    applied_at timestamp with time zone DEFAULT now()
);


--
-- Name: planning_scenarios; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.planning_scenarios (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    baseline_feed_id uuid NOT NULL,
    mode text DEFAULT 'ab'::text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    economic_params jsonb,
    summary jsonb,
    created_by text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    owner_user_id uuid
);


--
-- Name: points_of_interest; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.points_of_interest (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    osm_id integer,
    name text,
    category text NOT NULL,
    lng double precision NOT NULL,
    lat double precision NOT NULL,
    properties jsonb DEFAULT '{}'::jsonb,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: polim_imports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.polim_imports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    filename text,
    agency_name text,
    created_by text,
    line_count integer DEFAULT 0 NOT NULL,
    percorso_count integer DEFAULT 0 NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: polim_polimetriche; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.polim_polimetriche (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    import_id uuid NOT NULL,
    route_id text NOT NULL,
    line_code text,
    line_name text,
    variant_id text NOT NULL,
    direction text DEFAULT 'AB'::text NOT NULL,
    name text,
    total_km double precision,
    stop_count integer,
    tratta_count integer,
    boundaries jsonb,
    tratte jsonb,
    stops jsonb,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: process_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.process_reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scenario_id uuid,
    dss_id uuid,
    project_id uuid,
    ps_project_id uuid,
    owner_user_id uuid,
    title text NOT NULL,
    is_test boolean DEFAULT false NOT NULL,
    summary jsonb,
    dossier jsonb NOT NULL,
    html text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: project_activity_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_activity_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    user_id uuid NOT NULL,
    action text NOT NULL,
    target_type text,
    target_id text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: project_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_members (
    project_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'editor'::text NOT NULL,
    added_by uuid,
    added_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ps_activation_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ps_activation_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    feed_id uuid NOT NULL,
    user_id uuid,
    activated_at timestamp with time zone DEFAULT now() NOT NULL,
    deactivated_at timestamp with time zone
);


--
-- Name: ps_argos_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ps_argos_messages (
    id bigint NOT NULL,
    project_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    thread text DEFAULT 'chat'::text NOT NULL
);


--
-- Name: ps_argos_messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.ps_argos_messages ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.ps_argos_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: ps_argos_watches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ps_argos_watches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    user_id uuid NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    work_goals boolean DEFAULT false NOT NULL,
    cadence_hours integer DEFAULT 24 NOT NULL,
    last_run_at timestamp with time zone,
    last_status text,
    last_summary text,
    last_findings jsonb,
    last_goal_note text,
    unseen boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ps_calendar_dates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ps_calendar_dates (
    calendar_id uuid NOT NULL,
    date date NOT NULL,
    exception_type smallint DEFAULT 1 NOT NULL
);


--
-- Name: ps_calendar_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ps_calendar_profiles (
    project_id uuid NOT NULL,
    school_periods jsonb DEFAULT '[]'::jsonb NOT NULL,
    summer_period jsonb,
    extra_holidays jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_periods jsonb DEFAULT '[]'::jsonb NOT NULL,
    categories_synced_at timestamp with time zone
);


--
-- Name: ps_calendars; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ps_calendars (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    code text NOT NULL,
    name text,
    monday boolean DEFAULT false NOT NULL,
    tuesday boolean DEFAULT false NOT NULL,
    wednesday boolean DEFAULT false NOT NULL,
    thursday boolean DEFAULT false NOT NULL,
    friday boolean DEFAULT false NOT NULL,
    saturday boolean DEFAULT false NOT NULL,
    sunday boolean DEFAULT false NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    gtfs_id text
);


--
-- Name: ps_day_calendar; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ps_day_calendar (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid,
    date date NOT NULL,
    day_type_id uuid NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ps_day_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ps_day_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid,
    code text NOT NULL,
    name text NOT NULL,
    color text NOT NULL,
    is_system boolean DEFAULT false NOT NULL,
    is_custom boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ps_network_shares; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ps_network_shares (
    token text NOT NULL,
    project_id uuid NOT NULL,
    route_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    title text,
    options jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone
);


--
-- Name: ps_no_go_zones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ps_no_go_zones (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    name text NOT NULL,
    polygon jsonb NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ps_pending_activations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ps_pending_activations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    feed_id uuid NOT NULL,
    user_id uuid,
    effective_from date NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ps_project_activity_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ps_project_activity_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    user_id uuid NOT NULL,
    action text NOT NULL,
    target_type text,
    target_id text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ps_project_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ps_project_members (
    project_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'editor'::text NOT NULL,
    added_by uuid,
    added_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ps_projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ps_projects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    is_shared boolean DEFAULT false NOT NULL,
    source_feed_id uuid,
    source_feed_label text,
    agency_name text,
    agency_url text,
    agency_timezone text DEFAULT 'Europe/Rome'::text NOT NULL,
    default_lang text DEFAULT 'it'::text NOT NULL,
    scheduling_project_id uuid,
    status text DEFAULT 'draft'::text NOT NULL,
    last_opened_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    materialized_feed_id uuid,
    materialized_at timestamp with time zone,
    agency_settings jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: ps_route_snap_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ps_route_snap_cache (
    id bigint NOT NULL,
    mode text NOT NULL,
    from_lon double precision NOT NULL,
    from_lat double precision NOT NULL,
    to_lon double precision NOT NULL,
    to_lat double precision NOT NULL,
    geometry jsonb NOT NULL,
    distance_m double precision NOT NULL,
    duration_s double precision NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ps_route_snap_cache_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ps_route_snap_cache_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ps_route_snap_cache_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ps_route_snap_cache_id_seq OWNED BY public.ps_route_snap_cache.id;


--
-- Name: ps_route_snap_multi_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ps_route_snap_multi_cache (
    key text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ps_route_variants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ps_route_variants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    route_id uuid NOT NULL,
    name text NOT NULL,
    direction smallint DEFAULT 0 NOT NULL,
    headsign text,
    is_default boolean DEFAULT false NOT NULL,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    variant_kind text DEFAULT 'standard'::text NOT NULL,
    valid_from date,
    valid_to date,
    distance_m_cached double precision,
    duration_s_cached double precision,
    notes text,
    code text,
    import_signature text
);


--
-- Name: ps_routes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ps_routes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    code text,
    short_name text NOT NULL,
    long_name text,
    description text,
    route_type smallint DEFAULT 3 NOT NULL,
    color text,
    text_color text,
    agency_id text,
    sort_order integer DEFAULT 0 NOT NULL,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    service_type text DEFAULT 'urban'::text NOT NULL,
    contract_id text,
    km_year_planned numeric,
    notes text,
    is_active boolean DEFAULT true NOT NULL,
    gtfs_id text
);


--
-- Name: ps_service_periods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ps_service_periods (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    color text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ps_shapes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ps_shapes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    variant_id uuid NOT NULL,
    mode text DEFAULT 'driving'::text NOT NULL,
    geometry jsonb NOT NULL,
    waypoints jsonb DEFAULT '[]'::jsonb NOT NULL,
    distance_m double precision,
    duration_s double precision,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ps_stop_clusters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ps_stop_clusters (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    code text,
    name text NOT NULL,
    kind text DEFAULT 'interchange'::text NOT NULL,
    center_lat double precision,
    center_lon double precision,
    radius_m integer DEFAULT 150 NOT NULL,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ps_stop_times; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ps_stop_times (
    trip_id uuid NOT NULL,
    stop_seq integer NOT NULL,
    stop_id uuid NOT NULL,
    arrival_time text NOT NULL,
    departure_time text NOT NULL,
    pickup_type smallint DEFAULT 0 NOT NULL,
    drop_off_type smallint DEFAULT 0 NOT NULL,
    timepoint smallint DEFAULT 1 NOT NULL,
    shape_dist_traveled double precision
);


--
-- Name: ps_stops; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ps_stops (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    code text,
    name text NOT NULL,
    description text,
    lat double precision NOT NULL,
    lon double precision NOT NULL,
    zone_id text,
    location_type smallint DEFAULT 0 NOT NULL,
    parent_station uuid,
    wheelchair_boarding smallint DEFAULT 0 NOT NULL,
    platform_code text,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    municipality text,
    province text,
    region text,
    shelter boolean DEFAULT false NOT NULL,
    bench boolean DEFAULT false NOT NULL,
    lighting boolean DEFAULT false NOT NULL,
    realtime_display boolean DEFAULT false NOT NULL,
    ticket_vending boolean DEFAULT false NOT NULL,
    bike_parking boolean DEFAULT false NOT NULL,
    surface_type text,
    pole_type text,
    signage_state text,
    photo_urls jsonb DEFAULT '[]'::jsonb NOT NULL,
    notes text,
    cluster_id uuid,
    gtfs_id text
);


--
-- Name: ps_timetable_map_shares; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ps_timetable_map_shares (
    token text NOT NULL,
    project_id uuid NOT NULL,
    route_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    title text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone
);


--
-- Name: ps_trip_category_validity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ps_trip_category_validity (
    trip_id uuid NOT NULL,
    category_id uuid NOT NULL
);


--
-- Name: ps_trip_day_validity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ps_trip_day_validity (
    trip_id uuid NOT NULL,
    day_type_id uuid NOT NULL,
    is_valid boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ps_trip_exceptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ps_trip_exceptions (
    trip_id uuid NOT NULL,
    date date NOT NULL,
    exception_type smallint DEFAULT 2 NOT NULL,
    reason text
);


--
-- Name: ps_trips; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ps_trips (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    route_id uuid NOT NULL,
    variant_id uuid NOT NULL,
    calendar_id uuid,
    headsign text,
    short_name text,
    direction smallint DEFAULT 0 NOT NULL,
    block_id text,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    valid_from date,
    valid_to date,
    is_active boolean DEFAULT true NOT NULL,
    service_label text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    gtfs_id text
);


--
-- Name: ps_validity_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ps_validity_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    color text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ps_validity_category_calendar; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ps_validity_category_calendar (
    date date NOT NULL,
    category_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    project_id uuid
);


--
-- Name: ps_validity_units; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ps_validity_units (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    validity_id text NOT NULL,
    name text NOT NULL,
    description text,
    category_id uuid,
    day_type_id uuid,
    trip_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    trip_count integer DEFAULT 0 NOT NULL,
    representative_dates jsonb DEFAULT '[]'::jsonb NOT NULL,
    day_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ps_variant_stops; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ps_variant_stops (
    variant_id uuid NOT NULL,
    seq integer NOT NULL,
    stop_id uuid NOT NULL,
    pickup_type smallint DEFAULT 0 NOT NULL,
    drop_off_type smallint DEFAULT 0 NOT NULL,
    timepoint smallint DEFAULT 1 NOT NULL,
    shape_dist_traveled double precision
);


--
-- Name: ps_variants; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.ps_variants AS
 SELECT id,
    project_id,
    route_id,
    name,
    direction,
    headsign,
    is_default,
    attributes,
    created_at,
    updated_at,
    variant_kind,
    valid_from,
    valid_to,
    distance_m_cached,
    duration_s_cached,
    notes,
    code,
    import_signature
   FROM public.ps_route_variants;


--
-- Name: roster_anagrafica_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roster_anagrafica_log (
    id bigint NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid,
    driver_id uuid,
    azione text NOT NULL,
    campi text[] DEFAULT '{}'::text[] NOT NULL,
    dettaglio jsonb
);


--
-- Name: roster_anagrafica_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.roster_anagrafica_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: roster_anagrafica_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.roster_anagrafica_log_id_seq OWNED BY public.roster_anagrafica_log.id;


--
-- Name: roster_anagrafica_passi; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roster_anagrafica_passi (
    passo text NOT NULL,
    fatto_il timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: roster_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roster_assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    driver_id uuid NOT NULL,
    day date NOT NULL,
    dss_id uuid NOT NULL,
    duty_code text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    snapshot jsonb,
    forzatura jsonb,
    ricollegamenti jsonb
);


--
-- Name: roster_categorie; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roster_categorie (
    codice text NOT NULL,
    nome text NOT NULL,
    alias text[] DEFAULT '{}'::text[] NOT NULL
);


--
-- Name: roster_depositi; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roster_depositi (
    codice text NOT NULL,
    nome text NOT NULL,
    gruppo text NOT NULL,
    cadenza_turni text NOT NULL,
    alias text[] DEFAULT '{}'::text[] NOT NULL,
    ordine integer DEFAULT 0 NOT NULL,
    CONSTRAINT roster_depositi_cadenza_turni_check CHECK ((cadenza_turni = ANY (ARRAY['settimanale'::text, 'semimensile'::text]))),
    CONSTRAINT roster_depositi_gruppo_check CHECK ((gruppo = ANY (ARRAY['A'::text, 'B'::text])))
);


--
-- Name: roster_driver_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roster_driver_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    driver_id uuid NOT NULL,
    kind text NOT NULL,
    value text,
    event_date date,
    expiry_date date,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: roster_drivers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roster_drivers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    badge text,
    is_fictitious boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    matricola text,
    cognome text,
    nome text,
    cf text,
    cellulare text,
    residenza_anagrafica text,
    residenza_servizio text,
    ore_settimanali integer,
    categoria text,
    data_nascita date,
    data_assunzione date,
    data_fine_servizio date,
    patente text,
    patente_validita date,
    cqc_numero text,
    cqc_validita date,
    visita_medica_validita date,
    note text,
    photo_url text,
    abilitazioni text[] DEFAULT '{}'::text[] NOT NULL,
    visita_ferrovie_validita date,
    visita_medico_competente_validita date,
    orario_settimanale_min integer,
    telefono text,
    inquadramento text,
    parametro smallint,
    ferie_annue numeric(6,1),
    ferie_residue numeric(6,1),
    ferie_residue_al date,
    ferie_unita text DEFAULT 'giorni'::text NOT NULL,
    scaglione_ferie text,
    rotazione_turni_gruppo_id uuid,
    rotazione_turni_posizione integer,
    visita_ferrovie_data date,
    visita_medico_competente_data date,
    visita_ferrovie_esito text,
    visita_medico_competente_esito text,
    patente_numero text,
    matricola_chiave text,
    versione integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone,
    motivo_cessazione text
);


--
-- Name: roster_dss_riassunti; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roster_dss_riassunti (
    dss_id uuid NOT NULL,
    impronta text NOT NULL,
    codici_doppi text[] DEFAULT '{}'::text[] NOT NULL,
    turni integer DEFAULT 0 NOT NULL,
    fatto_il timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: roster_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roster_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    driver_id uuid NOT NULL,
    day date NOT NULL,
    category text NOT NULL,
    code text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source text
);


--
-- Name: roster_gruppi_turni; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roster_gruppi_turni (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    deposito_codice text NOT NULL,
    nome text NOT NULL,
    data_riferimento date,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: roster_pubblicazioni; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roster_pubblicazioni (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tipo text DEFAULT 'pubblica'::text NOT NULL,
    ps_project_id uuid,
    programma text,
    dal date NOT NULL,
    al date NOT NULL,
    scelte jsonb DEFAULT '{}'::jsonb NOT NULL,
    prima jsonb DEFAULT '[]'::jsonb NOT NULL,
    riepilogo jsonb DEFAULT '{}'::jsonb NOT NULL,
    nota text,
    creata_da uuid,
    creata_il timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT roster_pubblicazioni_tipo_check CHECK ((tipo = ANY (ARRAY['pubblica'::text, 'ritira'::text])))
);


--
-- Name: roster_rotazione_assegnazioni; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roster_rotazione_assegnazioni (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rotazione_id uuid NOT NULL,
    week_index integer NOT NULL,
    driver_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: roster_rotazioni_riposi; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roster_rotazioni_riposi (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    weeks integer NOT NULL,
    pattern jsonb NOT NULL,
    meta jsonb,
    owner_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    anchor_date date
);


--
-- Name: roster_turni_dss; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roster_turni_dss (
    dss_id uuid NOT NULL,
    codice text NOT NULL,
    ordine integer NOT NULL,
    riassunto jsonb NOT NULL,
    firma text,
    corse jsonb DEFAULT '[]'::jsonb NOT NULL
);


--
-- Name: roster_turni_pubblicati; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roster_turni_pubblicati (
    id bigint NOT NULL,
    day date NOT NULL,
    udp_id uuid NOT NULL,
    dss_id uuid NOT NULL,
    ps_project_id uuid,
    udp_nome text,
    dss_nome text,
    pubblicazione_id uuid NOT NULL,
    sostituita_da uuid
);


--
-- Name: roster_turni_pubblicati_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.roster_turni_pubblicati_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: roster_turni_pubblicati_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.roster_turni_pubblicati_id_seq OWNED BY public.roster_turni_pubblicati.id;


--
-- Name: scenario_program_calendar_exceptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scenario_program_calendar_exceptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    calendar_id uuid NOT NULL,
    exception_date date NOT NULL,
    exception_type integer NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: scenario_program_calendars; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scenario_program_calendars (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    program_id uuid NOT NULL,
    service_id text NOT NULL,
    service_name text NOT NULL,
    monday boolean DEFAULT true NOT NULL,
    tuesday boolean DEFAULT true NOT NULL,
    wednesday boolean DEFAULT true NOT NULL,
    thursday boolean DEFAULT true NOT NULL,
    friday boolean DEFAULT true NOT NULL,
    saturday boolean DEFAULT false NOT NULL,
    sunday boolean DEFAULT false NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    cadence_multiplier double precision DEFAULT 1 NOT NULL,
    is_variant boolean DEFAULT false NOT NULL,
    variant_config jsonb,
    color text DEFAULT '#3b82f6'::text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: scenario_service_programs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scenario_service_programs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scenario_id uuid NOT NULL,
    name text NOT NULL,
    config jsonb NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: scenarios; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scenarios (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    color text DEFAULT '#3b82f6'::text NOT NULL,
    geojson jsonb NOT NULL,
    stops_count integer DEFAULT 0,
    length_km double precision DEFAULT 0,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: scheduling_projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduling_projects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    feed_id uuid,
    feed_label text,
    depot_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    cluster_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    deadhead_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    economic_params jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    current_stage text DEFAULT 'setup'::text NOT NULL,
    last_opened_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_shared boolean DEFAULT false NOT NULL,
    planning_studio_project_id uuid,
    validity_filter jsonb,
    validity_unit_id uuid
);


--
-- Name: scheduling_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduling_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    kind text NOT NULL,
    parent_run_id uuid,
    label text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    result jsonb,
    metrics jsonb,
    status text DEFAULT 'pending'::text NOT NULL,
    is_pinned boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone
);


--
-- Name: service_program_scenarios; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_program_scenarios (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    date text NOT NULL,
    feed_id uuid,
    input jsonb NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    owner_user_id uuid,
    project_id uuid,
    is_shared boolean DEFAULT false NOT NULL,
    description text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_operational boolean DEFAULT false NOT NULL,
    depot_id uuid,
    depots jsonb,
    stale_since timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    superseded_by uuid,
    valid_from date,
    valid_to date,
    config jsonb
);


--
-- Name: stop_cluster_stops; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stop_cluster_stops (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cluster_id uuid NOT NULL,
    gtfs_stop_id text NOT NULL,
    stop_name text NOT NULL,
    stop_lat double precision NOT NULL,
    stop_lon double precision NOT NULL
);


--
-- Name: stop_clusters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stop_clusters (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    transfer_from_depot_min integer DEFAULT 10 NOT NULL,
    color text DEFAULT '#3b82f6'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    is_interchange boolean DEFAULT true NOT NULL,
    is_logical boolean DEFAULT false NOT NULL,
    source_ps_project_id uuid
);


--
-- Name: traffic_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.traffic_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    segment_id text NOT NULL,
    lng double precision NOT NULL,
    lat double precision NOT NULL,
    speed double precision NOT NULL,
    freeflow_speed double precision NOT NULL,
    congestion_level double precision NOT NULL,
    captured_at timestamp with time zone DEFAULT now()
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    full_name text,
    role text DEFAULT 'user'::text NOT NULL,
    permissions jsonb DEFAULT '{"fares": true, "analytics": true, "scheduling": true}'::jsonb NOT NULL,
    active boolean DEFAULT true NOT NULL,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    fleetcare_role text DEFAULT 'driver'::text NOT NULL,
    sessione_versione integer DEFAULT 1 NOT NULL,
    dispositivi_versione integer DEFAULT 1 NOT NULL,
    password_cambiata_il timestamp with time zone,
    deve_cambiare_password boolean DEFAULT false NOT NULL,
    password_controllata boolean DEFAULT false NOT NULL,
    mfa_attiva boolean DEFAULT false NOT NULL,
    mfa_segreto text,
    mfa_recupero jsonb,
    mfa_recupero_chiave text,
    mfa_ultimo_passo bigint,
    mfa_errori integer DEFAULT 0 NOT NULL,
    mfa_bloccata_fino timestamp with time zone
);


--
-- Name: vehicle_schedule_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vehicle_schedule_members (
    scenario_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'editor'::text NOT NULL,
    added_by uuid,
    added_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: weather_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.weather_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lat double precision NOT NULL,
    lng double precision NOT NULL,
    location_name text,
    temp double precision,
    feels_like double precision,
    humidity integer,
    wind_speed double precision,
    weather_main text,
    weather_description text,
    weather_icon text,
    rain_1h double precision,
    snow_1h double precision,
    visibility integer,
    captured_at timestamp with time zone DEFAULT now()
);


--
-- Name: zones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.zones (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    istat_code text,
    geometry jsonb NOT NULL,
    properties jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: accessi_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accessi_log ALTER COLUMN id SET DEFAULT nextval('public.accessi_log_id_seq'::regclass);


--
-- Name: ps_route_snap_cache id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_route_snap_cache ALTER COLUMN id SET DEFAULT nextval('public.ps_route_snap_cache_id_seq'::regclass);


--
-- Name: roster_anagrafica_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_anagrafica_log ALTER COLUMN id SET DEFAULT nextval('public.roster_anagrafica_log_id_seq'::regclass);


--
-- Name: roster_turni_pubblicati id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_turni_pubblicati ALTER COLUMN id SET DEFAULT nextval('public.roster_turni_pubblicati_id_seq'::regclass);


--
-- Name: active_trips active_trips_pkey; Type: CONSTRAINT; Schema: caronte; Owner: -
--

ALTER TABLE ONLY caronte.active_trips
    ADD CONSTRAINT active_trips_pkey PRIMARY KEY (id);


--
-- Name: avm_controllo_settimanale avm_controllo_settimanale_pkey; Type: CONSTRAINT; Schema: caronte; Owner: -
--

ALTER TABLE ONLY caronte.avm_controllo_settimanale
    ADD CONSTRAINT avm_controllo_settimanale_pkey PRIMARY KEY (settimana);


--
-- Name: avm_diario avm_diario_pkey; Type: CONSTRAINT; Schema: caronte; Owner: -
--

ALTER TABLE ONLY caronte.avm_diario
    ADD CONSTRAINT avm_diario_pkey PRIMARY KEY (day, vehicle_ref);


--
-- Name: journey_code_days journey_code_days_pkey; Type: CONSTRAINT; Schema: caronte; Owner: -
--

ALTER TABLE ONLY caronte.journey_code_days
    ADD CONSTRAINT journey_code_days_pkey PRIMARY KEY (day);


--
-- Name: journey_codes journey_codes_pkey; Type: CONSTRAINT; Schema: caronte; Owner: -
--

ALTER TABLE ONLY caronte.journey_codes
    ADD CONSTRAINT journey_codes_pkey PRIMARY KEY (id);


--
-- Name: journeys journeys_pkey; Type: CONSTRAINT; Schema: caronte; Owner: -
--

ALTER TABLE ONLY caronte.journeys
    ADD CONSTRAINT journeys_pkey PRIMARY KEY (id);


--
-- Name: stop_alias_overrides stop_alias_overrides_pkey; Type: CONSTRAINT; Schema: caronte; Owner: -
--

ALTER TABLE ONLY caronte.stop_alias_overrides
    ADD CONSTRAINT stop_alias_overrides_pkey PRIMARY KEY (mizar_ref);


--
-- Name: stop_predictions stop_predictions_pkey; Type: CONSTRAINT; Schema: caronte; Owner: -
--

ALTER TABLE ONLY caronte.stop_predictions
    ADD CONSTRAINT stop_predictions_pkey PRIMARY KEY (id);


--
-- Name: stop_transits stop_transits_pkey; Type: CONSTRAINT; Schema: caronte; Owner: -
--

ALTER TABLE ONLY caronte.stop_transits
    ADD CONSTRAINT stop_transits_pkey PRIMARY KEY (id);


--
-- Name: tap_events tap_events_pkey; Type: CONSTRAINT; Schema: caronte; Owner: -
--

ALTER TABLE ONLY caronte.tap_events
    ADD CONSTRAINT tap_events_pkey PRIMARY KEY (id);


--
-- Name: vehicle_positions vehicle_positions_pkey; Type: CONSTRAINT; Schema: caronte; Owner: -
--

ALTER TABLE ONLY caronte.vehicle_positions
    ADD CONSTRAINT vehicle_positions_pkey PRIMARY KEY (id);


--
-- Name: accessi_log accessi_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accessi_log
    ADD CONSTRAINT accessi_log_pkey PRIMARY KEY (id);


--
-- Name: accessi_tentativi accessi_tentativi_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accessi_tentativi
    ADD CONSTRAINT accessi_tentativi_pkey PRIMARY KEY (chiave, ip);


--
-- Name: agent_optimize_jobs agent_optimize_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_optimize_jobs
    ADD CONSTRAINT agent_optimize_jobs_pkey PRIMARY KEY (id);


--
-- Name: app_settings app_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_pkey PRIMARY KEY (key);


--
-- Name: bus_routes bus_routes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bus_routes
    ADD CONSTRAINT bus_routes_pkey PRIMARY KEY (id);


--
-- Name: bus_stops bus_stops_code_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bus_stops
    ADD CONSTRAINT bus_stops_code_unique UNIQUE (code);


--
-- Name: bus_stops bus_stops_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bus_stops
    ADD CONSTRAINT bus_stops_pkey PRIMARY KEY (id);


--
-- Name: census_sections census_sections_istat_code_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.census_sections
    ADD CONSTRAINT census_sections_istat_code_unique UNIQUE (istat_code);


--
-- Name: census_sections census_sections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.census_sections
    ADD CONSTRAINT census_sections_pkey PRIMARY KEY (id);


--
-- Name: coincidence_zone_stops coincidence_zone_stops_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coincidence_zone_stops
    ADD CONSTRAINT coincidence_zone_stops_pkey PRIMARY KEY (id);


--
-- Name: coincidence_zones coincidence_zones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coincidence_zones
    ADD CONSTRAINT coincidence_zones_pkey PRIMARY KEY (id);


--
-- Name: deadhead_arcs deadhead_arcs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deadhead_arcs
    ADD CONSTRAINT deadhead_arcs_pkey PRIMARY KEY (id);


--
-- Name: depots depots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.depots
    ADD CONSTRAINT depots_pkey PRIMARY KEY (id);


--
-- Name: driver_schedule_members driver_schedule_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_schedule_members
    ADD CONSTRAINT driver_schedule_members_pkey PRIMARY KEY (scenario_id, user_id);


--
-- Name: driver_shift_scenarios driver_shift_scenarios_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_shift_scenarios
    ADD CONSTRAINT driver_shift_scenarios_pkey PRIMARY KEY (id);


--
-- Name: fares_polimetriche_snapshots fares_polimetriche_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fares_polimetriche_snapshots
    ADD CONSTRAINT fares_polimetriche_snapshots_pkey PRIMARY KEY (id);


--
-- Name: gtfs_calendar_dates gtfs_calendar_dates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_calendar_dates
    ADD CONSTRAINT gtfs_calendar_dates_pkey PRIMARY KEY (id);


--
-- Name: gtfs_calendar gtfs_calendar_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_calendar
    ADD CONSTRAINT gtfs_calendar_pkey PRIMARY KEY (id);


--
-- Name: gtfs_fare_areas gtfs_fare_areas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_fare_areas
    ADD CONSTRAINT gtfs_fare_areas_pkey PRIMARY KEY (id);


--
-- Name: gtfs_fare_attributes gtfs_fare_attributes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_fare_attributes
    ADD CONSTRAINT gtfs_fare_attributes_pkey PRIMARY KEY (id);


--
-- Name: gtfs_fare_audit_log gtfs_fare_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_fare_audit_log
    ADD CONSTRAINT gtfs_fare_audit_log_pkey PRIMARY KEY (id);


--
-- Name: gtfs_fare_leg_rules gtfs_fare_leg_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_fare_leg_rules
    ADD CONSTRAINT gtfs_fare_leg_rules_pkey PRIMARY KEY (id);


--
-- Name: gtfs_fare_media gtfs_fare_media_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_fare_media
    ADD CONSTRAINT gtfs_fare_media_pkey PRIMARY KEY (id);


--
-- Name: gtfs_fare_network_edges gtfs_fare_network_edges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_fare_network_edges
    ADD CONSTRAINT gtfs_fare_network_edges_pkey PRIMARY KEY (id);


--
-- Name: gtfs_fare_networks gtfs_fare_networks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_fare_networks
    ADD CONSTRAINT gtfs_fare_networks_pkey PRIMARY KEY (id);


--
-- Name: gtfs_fare_node_assignment_runs gtfs_fare_node_assignment_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_fare_node_assignment_runs
    ADD CONSTRAINT gtfs_fare_node_assignment_runs_pkey PRIMARY KEY (id);


--
-- Name: gtfs_fare_od_matrix gtfs_fare_od_matrix_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_fare_od_matrix
    ADD CONSTRAINT gtfs_fare_od_matrix_pkey PRIMARY KEY (id);


--
-- Name: gtfs_fare_od_matrix_runs gtfs_fare_od_matrix_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_fare_od_matrix_runs
    ADD CONSTRAINT gtfs_fare_od_matrix_runs_pkey PRIMARY KEY (id);


--
-- Name: gtfs_fare_official_nodes gtfs_fare_official_nodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_fare_official_nodes
    ADD CONSTRAINT gtfs_fare_official_nodes_pkey PRIMARY KEY (id);


--
-- Name: gtfs_fare_products gtfs_fare_products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_fare_products
    ADD CONSTRAINT gtfs_fare_products_pkey PRIMARY KEY (id);


--
-- Name: gtfs_fare_rules gtfs_fare_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_fare_rules
    ADD CONSTRAINT gtfs_fare_rules_pkey PRIMARY KEY (id);


--
-- Name: gtfs_fare_stop_assignment_overrides gtfs_fare_stop_assignment_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_fare_stop_assignment_overrides
    ADD CONSTRAINT gtfs_fare_stop_assignment_overrides_pkey PRIMARY KEY (id);


--
-- Name: gtfs_fare_transfer_rules gtfs_fare_transfer_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_fare_transfer_rules
    ADD CONSTRAINT gtfs_fare_transfer_rules_pkey PRIMARY KEY (id);


--
-- Name: gtfs_fare_zone_cluster_stops gtfs_fare_zone_cluster_stops_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_fare_zone_cluster_stops
    ADD CONSTRAINT gtfs_fare_zone_cluster_stops_pkey PRIMARY KEY (id);


--
-- Name: gtfs_fare_zone_clusters gtfs_fare_zone_clusters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_fare_zone_clusters
    ADD CONSTRAINT gtfs_fare_zone_clusters_pkey PRIMARY KEY (id);


--
-- Name: gtfs_feed_analysis gtfs_feed_analysis_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_feed_analysis
    ADD CONSTRAINT gtfs_feed_analysis_pkey PRIMARY KEY (id);


--
-- Name: gtfs_feed_economic_params gtfs_feed_economic_params_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_feed_economic_params
    ADD CONSTRAINT gtfs_feed_economic_params_pkey PRIMARY KEY (id);


--
-- Name: gtfs_feed_info gtfs_feed_info_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_feed_info
    ADD CONSTRAINT gtfs_feed_info_pkey PRIMARY KEY (id);


--
-- Name: gtfs_feeds gtfs_feeds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_feeds
    ADD CONSTRAINT gtfs_feeds_pkey PRIMARY KEY (id);


--
-- Name: gtfs_rider_categories gtfs_rider_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_rider_categories
    ADD CONSTRAINT gtfs_rider_categories_pkey PRIMARY KEY (id);


--
-- Name: gtfs_route_networks gtfs_route_networks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_route_networks
    ADD CONSTRAINT gtfs_route_networks_pkey PRIMARY KEY (id);


--
-- Name: gtfs_routes gtfs_routes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_routes
    ADD CONSTRAINT gtfs_routes_pkey PRIMARY KEY (id);


--
-- Name: gtfs_shapes gtfs_shapes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_shapes
    ADD CONSTRAINT gtfs_shapes_pkey PRIMARY KEY (id);


--
-- Name: gtfs_stop_areas gtfs_stop_areas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_stop_areas
    ADD CONSTRAINT gtfs_stop_areas_pkey PRIMARY KEY (id);


--
-- Name: gtfs_stop_times gtfs_stop_times_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_stop_times
    ADD CONSTRAINT gtfs_stop_times_pkey PRIMARY KEY (id);


--
-- Name: gtfs_stops gtfs_stops_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_stops
    ADD CONSTRAINT gtfs_stops_pkey PRIMARY KEY (id);


--
-- Name: gtfs_timeframes gtfs_timeframes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_timeframes
    ADD CONSTRAINT gtfs_timeframes_pkey PRIMARY KEY (id);


--
-- Name: gtfs_trips gtfs_trips_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_trips
    ADD CONSTRAINT gtfs_trips_pkey PRIMARY KEY (id);


--
-- Name: intermodal_hub_schedules intermodal_hub_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intermodal_hub_schedules
    ADD CONSTRAINT intermodal_hub_schedules_pkey PRIMARY KEY (hub_id);


--
-- Name: isochrone_cache isochrone_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.isochrone_cache
    ADD CONSTRAINT isochrone_cache_pkey PRIMARY KEY (id);


--
-- Name: istat_commuting_od istat_commuting_od_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.istat_commuting_od
    ADD CONSTRAINT istat_commuting_od_pkey PRIMARY KEY (id);


--
-- Name: optimizer_rule_profiles optimizer_rule_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.optimizer_rule_profiles
    ADD CONSTRAINT optimizer_rule_profiles_pkey PRIMARY KEY (id);


--
-- Name: planning_analysis_results planning_analysis_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_analysis_results
    ADD CONSTRAINT planning_analysis_results_pkey PRIMARY KEY (id);


--
-- Name: planning_pois planning_pois_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_pois
    ADD CONSTRAINT planning_pois_pkey PRIMARY KEY (id);


--
-- Name: planning_route_classifications planning_route_classifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_route_classifications
    ADD CONSTRAINT planning_route_classifications_pkey PRIMARY KEY (id);


--
-- Name: planning_scenario_edits planning_scenario_edits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_scenario_edits
    ADD CONSTRAINT planning_scenario_edits_pkey PRIMARY KEY (id);


--
-- Name: planning_scenarios planning_scenarios_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_scenarios
    ADD CONSTRAINT planning_scenarios_pkey PRIMARY KEY (id);


--
-- Name: points_of_interest points_of_interest_osm_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.points_of_interest
    ADD CONSTRAINT points_of_interest_osm_id_unique UNIQUE (osm_id);


--
-- Name: points_of_interest points_of_interest_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.points_of_interest
    ADD CONSTRAINT points_of_interest_pkey PRIMARY KEY (id);


--
-- Name: polim_imports polim_imports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.polim_imports
    ADD CONSTRAINT polim_imports_pkey PRIMARY KEY (id);


--
-- Name: polim_polimetriche polim_polimetriche_import_id_route_id_variant_id_direction_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.polim_polimetriche
    ADD CONSTRAINT polim_polimetriche_import_id_route_id_variant_id_direction_key UNIQUE (import_id, route_id, variant_id, direction);


--
-- Name: polim_polimetriche polim_polimetriche_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.polim_polimetriche
    ADD CONSTRAINT polim_polimetriche_pkey PRIMARY KEY (id);


--
-- Name: process_reports process_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.process_reports
    ADD CONSTRAINT process_reports_pkey PRIMARY KEY (id);


--
-- Name: project_activity_log project_activity_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_activity_log
    ADD CONSTRAINT project_activity_log_pkey PRIMARY KEY (id);


--
-- Name: project_members project_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_members
    ADD CONSTRAINT project_members_pkey PRIMARY KEY (project_id, user_id);


--
-- Name: ps_activation_log ps_activation_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_activation_log
    ADD CONSTRAINT ps_activation_log_pkey PRIMARY KEY (id);


--
-- Name: ps_argos_messages ps_argos_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_argos_messages
    ADD CONSTRAINT ps_argos_messages_pkey PRIMARY KEY (id);


--
-- Name: ps_argos_watches ps_argos_watches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_argos_watches
    ADD CONSTRAINT ps_argos_watches_pkey PRIMARY KEY (id);


--
-- Name: ps_argos_watches ps_argos_watches_project_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_argos_watches
    ADD CONSTRAINT ps_argos_watches_project_id_key UNIQUE (project_id);


--
-- Name: ps_calendar_dates ps_calendar_dates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_calendar_dates
    ADD CONSTRAINT ps_calendar_dates_pkey PRIMARY KEY (calendar_id, date);


--
-- Name: ps_calendar_profiles ps_calendar_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_calendar_profiles
    ADD CONSTRAINT ps_calendar_profiles_pkey PRIMARY KEY (project_id);


--
-- Name: ps_calendars ps_calendars_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_calendars
    ADD CONSTRAINT ps_calendars_pkey PRIMARY KEY (id);


--
-- Name: ps_day_calendar ps_day_calendar_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_day_calendar
    ADD CONSTRAINT ps_day_calendar_pkey PRIMARY KEY (id);


--
-- Name: ps_day_types ps_day_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_day_types
    ADD CONSTRAINT ps_day_types_pkey PRIMARY KEY (id);


--
-- Name: ps_network_shares ps_network_shares_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_network_shares
    ADD CONSTRAINT ps_network_shares_pkey PRIMARY KEY (token);


--
-- Name: ps_no_go_zones ps_no_go_zones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_no_go_zones
    ADD CONSTRAINT ps_no_go_zones_pkey PRIMARY KEY (id);


--
-- Name: ps_pending_activations ps_pending_activations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_pending_activations
    ADD CONSTRAINT ps_pending_activations_pkey PRIMARY KEY (id);


--
-- Name: ps_pending_activations ps_pending_activations_project_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_pending_activations
    ADD CONSTRAINT ps_pending_activations_project_id_key UNIQUE (project_id);


--
-- Name: ps_project_activity_log ps_project_activity_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_project_activity_log
    ADD CONSTRAINT ps_project_activity_log_pkey PRIMARY KEY (id);


--
-- Name: ps_project_members ps_project_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_project_members
    ADD CONSTRAINT ps_project_members_pkey PRIMARY KEY (project_id, user_id);


--
-- Name: ps_projects ps_projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_projects
    ADD CONSTRAINT ps_projects_pkey PRIMARY KEY (id);


--
-- Name: ps_route_snap_cache ps_route_snap_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_route_snap_cache
    ADD CONSTRAINT ps_route_snap_cache_pkey PRIMARY KEY (id);


--
-- Name: ps_route_snap_multi_cache ps_route_snap_multi_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_route_snap_multi_cache
    ADD CONSTRAINT ps_route_snap_multi_cache_pkey PRIMARY KEY (key);


--
-- Name: ps_route_variants ps_route_variants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_route_variants
    ADD CONSTRAINT ps_route_variants_pkey PRIMARY KEY (id);


--
-- Name: ps_routes ps_routes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_routes
    ADD CONSTRAINT ps_routes_pkey PRIMARY KEY (id);


--
-- Name: ps_service_periods ps_service_periods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_service_periods
    ADD CONSTRAINT ps_service_periods_pkey PRIMARY KEY (id);


--
-- Name: ps_shapes ps_shapes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_shapes
    ADD CONSTRAINT ps_shapes_pkey PRIMARY KEY (id);


--
-- Name: ps_shapes ps_shapes_variant_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_shapes
    ADD CONSTRAINT ps_shapes_variant_id_key UNIQUE (variant_id);


--
-- Name: ps_stop_clusters ps_stop_clusters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_stop_clusters
    ADD CONSTRAINT ps_stop_clusters_pkey PRIMARY KEY (id);


--
-- Name: ps_stop_times ps_stop_times_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_stop_times
    ADD CONSTRAINT ps_stop_times_pkey PRIMARY KEY (trip_id, stop_seq);


--
-- Name: ps_stops ps_stops_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_stops
    ADD CONSTRAINT ps_stops_pkey PRIMARY KEY (id);


--
-- Name: ps_timetable_map_shares ps_timetable_map_shares_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_timetable_map_shares
    ADD CONSTRAINT ps_timetable_map_shares_pkey PRIMARY KEY (token);


--
-- Name: ps_trip_category_validity ps_trip_category_validity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_trip_category_validity
    ADD CONSTRAINT ps_trip_category_validity_pkey PRIMARY KEY (trip_id, category_id);


--
-- Name: ps_trip_day_validity ps_trip_day_validity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_trip_day_validity
    ADD CONSTRAINT ps_trip_day_validity_pkey PRIMARY KEY (trip_id, day_type_id);


--
-- Name: ps_trip_exceptions ps_trip_exceptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_trip_exceptions
    ADD CONSTRAINT ps_trip_exceptions_pkey PRIMARY KEY (trip_id, date);


--
-- Name: ps_trips ps_trips_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_trips
    ADD CONSTRAINT ps_trips_pkey PRIMARY KEY (id);


--
-- Name: ps_validity_categories ps_validity_categories_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_validity_categories
    ADD CONSTRAINT ps_validity_categories_code_key UNIQUE (code);


--
-- Name: ps_validity_categories ps_validity_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_validity_categories
    ADD CONSTRAINT ps_validity_categories_pkey PRIMARY KEY (id);


--
-- Name: ps_validity_units ps_validity_units_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_validity_units
    ADD CONSTRAINT ps_validity_units_pkey PRIMARY KEY (id);


--
-- Name: ps_variant_stops ps_variant_stops_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_variant_stops
    ADD CONSTRAINT ps_variant_stops_pkey PRIMARY KEY (variant_id, seq);


--
-- Name: roster_anagrafica_log roster_anagrafica_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_anagrafica_log
    ADD CONSTRAINT roster_anagrafica_log_pkey PRIMARY KEY (id);


--
-- Name: roster_anagrafica_passi roster_anagrafica_passi_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_anagrafica_passi
    ADD CONSTRAINT roster_anagrafica_passi_pkey PRIMARY KEY (passo);


--
-- Name: roster_assignments roster_assignments_dss_id_day_duty_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_assignments
    ADD CONSTRAINT roster_assignments_dss_id_day_duty_code_key UNIQUE (dss_id, day, duty_code);


--
-- Name: roster_assignments roster_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_assignments
    ADD CONSTRAINT roster_assignments_pkey PRIMARY KEY (id);


--
-- Name: roster_categorie roster_categorie_nome_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_categorie
    ADD CONSTRAINT roster_categorie_nome_key UNIQUE (nome);


--
-- Name: roster_categorie roster_categorie_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_categorie
    ADD CONSTRAINT roster_categorie_pkey PRIMARY KEY (codice);


--
-- Name: roster_depositi roster_depositi_nome_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_depositi
    ADD CONSTRAINT roster_depositi_nome_key UNIQUE (nome);


--
-- Name: roster_depositi roster_depositi_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_depositi
    ADD CONSTRAINT roster_depositi_pkey PRIMARY KEY (codice);


--
-- Name: roster_driver_history roster_driver_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_driver_history
    ADD CONSTRAINT roster_driver_history_pkey PRIMARY KEY (id);


--
-- Name: roster_drivers roster_drivers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_drivers
    ADD CONSTRAINT roster_drivers_pkey PRIMARY KEY (id);


--
-- Name: roster_dss_riassunti roster_dss_riassunti_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_dss_riassunti
    ADD CONSTRAINT roster_dss_riassunti_pkey PRIMARY KEY (dss_id);


--
-- Name: roster_entries roster_entries_driver_id_day_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_entries
    ADD CONSTRAINT roster_entries_driver_id_day_code_key UNIQUE (driver_id, day, code);


--
-- Name: roster_entries roster_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_entries
    ADD CONSTRAINT roster_entries_pkey PRIMARY KEY (id);


--
-- Name: roster_gruppi_turni roster_gruppi_turni_deposito_codice_nome_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_gruppi_turni
    ADD CONSTRAINT roster_gruppi_turni_deposito_codice_nome_key UNIQUE (deposito_codice, nome);


--
-- Name: roster_gruppi_turni roster_gruppi_turni_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_gruppi_turni
    ADD CONSTRAINT roster_gruppi_turni_pkey PRIMARY KEY (id);


--
-- Name: roster_pubblicazioni roster_pubblicazioni_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_pubblicazioni
    ADD CONSTRAINT roster_pubblicazioni_pkey PRIMARY KEY (id);


--
-- Name: roster_rotazione_assegnazioni roster_rotazione_assegnazioni_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_rotazione_assegnazioni
    ADD CONSTRAINT roster_rotazione_assegnazioni_pkey PRIMARY KEY (id);


--
-- Name: roster_rotazione_assegnazioni roster_rotazione_assegnazioni_rotazione_id_driver_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_rotazione_assegnazioni
    ADD CONSTRAINT roster_rotazione_assegnazioni_rotazione_id_driver_id_key UNIQUE (rotazione_id, driver_id);


--
-- Name: roster_rotazioni_riposi roster_rotazioni_riposi_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_rotazioni_riposi
    ADD CONSTRAINT roster_rotazioni_riposi_pkey PRIMARY KEY (id);


--
-- Name: roster_turni_dss roster_turni_dss_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_turni_dss
    ADD CONSTRAINT roster_turni_dss_pkey PRIMARY KEY (dss_id, codice);


--
-- Name: roster_turni_pubblicati roster_turni_pubblicati_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_turni_pubblicati
    ADD CONSTRAINT roster_turni_pubblicati_pkey PRIMARY KEY (id);


--
-- Name: scenario_program_calendar_exceptions scenario_program_calendar_exceptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scenario_program_calendar_exceptions
    ADD CONSTRAINT scenario_program_calendar_exceptions_pkey PRIMARY KEY (id);


--
-- Name: scenario_program_calendars scenario_program_calendars_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scenario_program_calendars
    ADD CONSTRAINT scenario_program_calendars_pkey PRIMARY KEY (id);


--
-- Name: scenario_service_programs scenario_service_programs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scenario_service_programs
    ADD CONSTRAINT scenario_service_programs_pkey PRIMARY KEY (id);


--
-- Name: scenarios scenarios_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scenarios
    ADD CONSTRAINT scenarios_pkey PRIMARY KEY (id);


--
-- Name: scheduling_projects scheduling_projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_projects
    ADD CONSTRAINT scheduling_projects_pkey PRIMARY KEY (id);


--
-- Name: scheduling_runs scheduling_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_runs
    ADD CONSTRAINT scheduling_runs_pkey PRIMARY KEY (id);


--
-- Name: service_program_scenarios service_program_scenarios_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_program_scenarios
    ADD CONSTRAINT service_program_scenarios_pkey PRIMARY KEY (id);


--
-- Name: stop_cluster_stops stop_cluster_stops_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stop_cluster_stops
    ADD CONSTRAINT stop_cluster_stops_pkey PRIMARY KEY (id);


--
-- Name: stop_clusters stop_clusters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stop_clusters
    ADD CONSTRAINT stop_clusters_pkey PRIMARY KEY (id);


--
-- Name: traffic_snapshots traffic_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.traffic_snapshots
    ADD CONSTRAINT traffic_snapshots_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: vehicle_schedule_members vehicle_schedule_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_schedule_members
    ADD CONSTRAINT vehicle_schedule_members_pkey PRIMARY KEY (scenario_id, user_id);


--
-- Name: weather_snapshots weather_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weather_snapshots
    ADD CONSTRAINT weather_snapshots_pkey PRIMARY KEY (id);


--
-- Name: zones zones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zones
    ADD CONSTRAINT zones_pkey PRIMARY KEY (id);


--
-- Name: active_trips_open_idx; Type: INDEX; Schema: caronte; Owner: -
--

CREATE INDEX active_trips_open_idx ON caronte.active_trips USING btree (vehicle_id, started_at DESC) WHERE (ended_at IS NULL);


--
-- Name: idx_caronte_avm_diario_day; Type: INDEX; Schema: caronte; Owner: -
--

CREATE INDEX idx_caronte_avm_diario_day ON caronte.avm_diario USING btree (day);


--
-- Name: idx_caronte_jcodes_key; Type: INDEX; Schema: caronte; Owner: -
--

CREATE UNIQUE INDEX idx_caronte_jcodes_key ON caronte.journey_codes USING btree (day, journey_ref, trip_id);


--
-- Name: idx_caronte_journey_match; Type: INDEX; Schema: caronte; Owner: -
--

CREATE INDEX idx_caronte_journey_match ON caronte.journeys USING btree (price_match);


--
-- Name: idx_caronte_journey_ticket; Type: INDEX; Schema: caronte; Owner: -
--

CREATE INDEX idx_caronte_journey_ticket ON caronte.journeys USING btree (ticket_uid);


--
-- Name: idx_caronte_journey_trip; Type: INDEX; Schema: caronte; Owner: -
--

CREATE INDEX idx_caronte_journey_trip ON caronte.journeys USING btree (trip_id);


--
-- Name: idx_caronte_stop_pred_key; Type: INDEX; Schema: caronte; Owner: -
--

CREATE UNIQUE INDEX idx_caronte_stop_pred_key ON caronte.stop_predictions USING btree (day, trip_id, stop_id);


--
-- Name: idx_caronte_stop_pred_trip; Type: INDEX; Schema: caronte; Owner: -
--

CREATE INDEX idx_caronte_stop_pred_trip ON caronte.stop_predictions USING btree (trip_id, day);


--
-- Name: idx_caronte_tap_stop; Type: INDEX; Schema: caronte; Owner: -
--

CREATE INDEX idx_caronte_tap_stop ON caronte.tap_events USING btree (stop_id);


--
-- Name: idx_caronte_tap_ticket; Type: INDEX; Schema: caronte; Owner: -
--

CREATE INDEX idx_caronte_tap_ticket ON caronte.tap_events USING btree (ticket_uid);


--
-- Name: idx_caronte_tap_trip; Type: INDEX; Schema: caronte; Owner: -
--

CREATE INDEX idx_caronte_tap_trip ON caronte.tap_events USING btree (trip_id);


--
-- Name: idx_caronte_tap_ts; Type: INDEX; Schema: caronte; Owner: -
--

CREATE INDEX idx_caronte_tap_ts ON caronte.tap_events USING btree (ts);


--
-- Name: idx_caronte_transit_trip; Type: INDEX; Schema: caronte; Owner: -
--

CREATE INDEX idx_caronte_transit_trip ON caronte.stop_transits USING btree (trip_id);


--
-- Name: idx_caronte_transit_ts; Type: INDEX; Schema: caronte; Owner: -
--

CREATE INDEX idx_caronte_transit_ts ON caronte.stop_transits USING btree (actual_ts);


--
-- Name: idx_caronte_vpos_trip; Type: INDEX; Schema: caronte; Owner: -
--

CREATE INDEX idx_caronte_vpos_trip ON caronte.vehicle_positions USING btree (trip_id);


--
-- Name: idx_caronte_vpos_ts; Type: INDEX; Schema: caronte; Owner: -
--

CREATE INDEX idx_caronte_vpos_ts ON caronte.vehicle_positions USING btree (ts);


--
-- Name: idx_caronte_vpos_vehicle_ts; Type: INDEX; Schema: caronte; Owner: -
--

CREATE INDEX idx_caronte_vpos_vehicle_ts ON caronte.vehicle_positions USING btree (vehicle_id, ts DESC);


--
-- Name: stop_transits_trip_idx; Type: INDEX; Schema: caronte; Owner: -
--

CREATE INDEX stop_transits_trip_idx ON caronte.stop_transits USING btree (trip_id, stop_seq);


--
-- Name: gtfs_fare_network_edges_feed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtfs_fare_network_edges_feed_idx ON public.gtfs_fare_network_edges USING btree (feed_id);


--
-- Name: gtfs_fare_network_edges_from_to_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtfs_fare_network_edges_from_to_idx ON public.gtfs_fare_network_edges USING btree (feed_id, from_cluster_id, to_cluster_id);


--
-- Name: gtfs_fare_od_matrix_from_to_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtfs_fare_od_matrix_from_to_idx ON public.gtfs_fare_od_matrix USING btree (feed_id, from_cluster_id, to_cluster_id);


--
-- Name: gtfs_fare_od_matrix_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX gtfs_fare_od_matrix_unique_idx ON public.gtfs_fare_od_matrix USING btree (feed_id, from_cluster_id, to_cluster_id);


--
-- Name: gtfs_fare_official_nodes_feed_code_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX gtfs_fare_official_nodes_feed_code_idx ON public.gtfs_fare_official_nodes USING btree (feed_id, official_code);


--
-- Name: gtfs_fare_official_nodes_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtfs_fare_official_nodes_name_idx ON public.gtfs_fare_official_nodes USING btree (feed_id, name_normalized);


--
-- Name: gtfs_fare_stop_overrides_stop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtfs_fare_stop_overrides_stop_idx ON public.gtfs_fare_stop_assignment_overrides USING btree (feed_id, stop_id);


--
-- Name: idx_accessi_log_ts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accessi_log_ts ON public.accessi_log USING btree (ts DESC);


--
-- Name: idx_accessi_log_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accessi_log_user ON public.accessi_log USING btree (user_id, ts DESC);


--
-- Name: idx_census_istat_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_census_istat_code ON public.census_sections USING btree (istat_code);


--
-- Name: idx_coincidence_zones_ps; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coincidence_zones_ps ON public.coincidence_zones USING btree (ps_project_id);


--
-- Name: idx_czs_gtfs_stop_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_czs_gtfs_stop_id ON public.coincidence_zone_stops USING btree (gtfs_stop_id);


--
-- Name: idx_czs_zone_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_czs_zone_id ON public.coincidence_zone_stops USING btree (zone_id);


--
-- Name: idx_deadhead_arcs_from; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deadhead_arcs_from ON public.deadhead_arcs USING btree (from_key);


--
-- Name: idx_deadhead_arcs_ps; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deadhead_arcs_ps ON public.deadhead_arcs USING btree (ps_project_id);


--
-- Name: idx_depots_ps_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_depots_ps_project ON public.depots USING btree (ps_project_id);


--
-- Name: idx_driver_shift_scenarios_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_shift_scenarios_owner ON public.driver_shift_scenarios USING btree (owner_user_id);


--
-- Name: idx_dsm_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dsm_user ON public.driver_schedule_members USING btree (user_id);


--
-- Name: idx_dss_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dss_owner ON public.driver_shift_scenarios USING btree (owner_user_id);


--
-- Name: idx_dss_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dss_project ON public.driver_shift_scenarios USING btree (project_id);


--
-- Name: idx_dss_sps_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dss_sps_id ON public.driver_shift_scenarios USING btree (service_program_scenario_id);


--
-- Name: idx_fare_areas_feed_area; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_fare_areas_feed_area ON public.gtfs_fare_areas USING btree (feed_id, area_id);


--
-- Name: idx_fare_areas_feed_network; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fare_areas_feed_network ON public.gtfs_fare_areas USING btree (feed_id, network_id);


--
-- Name: idx_fare_areas_feed_route; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fare_areas_feed_route ON public.gtfs_fare_areas USING btree (feed_id, route_id);


--
-- Name: idx_fare_attr_feed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fare_attr_feed ON public.gtfs_fare_attributes USING btree (feed_id);


--
-- Name: idx_fare_attr_feed_fare; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fare_attr_feed_fare ON public.gtfs_fare_attributes USING btree (feed_id, fare_id);


--
-- Name: idx_fare_audit_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fare_audit_action ON public.gtfs_fare_audit_log USING btree (action);


--
-- Name: idx_fare_audit_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fare_audit_created ON public.gtfs_fare_audit_log USING btree (created_at);


--
-- Name: idx_fare_audit_feed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fare_audit_feed ON public.gtfs_fare_audit_log USING btree (feed_id);


--
-- Name: idx_fare_leg_rules_feed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fare_leg_rules_feed ON public.gtfs_fare_leg_rules USING btree (feed_id);


--
-- Name: idx_fare_leg_rules_network; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fare_leg_rules_network ON public.gtfs_fare_leg_rules USING btree (feed_id, network_id);


--
-- Name: idx_fare_media_feed_media; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_fare_media_feed_media ON public.gtfs_fare_media USING btree (feed_id, fare_media_id);


--
-- Name: idx_fare_networks_feed_network; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_fare_networks_feed_network ON public.gtfs_fare_networks USING btree (feed_id, network_id);


--
-- Name: idx_fare_products_feed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fare_products_feed ON public.gtfs_fare_products USING btree (feed_id);


--
-- Name: idx_fare_products_network; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fare_products_network ON public.gtfs_fare_products USING btree (feed_id, network_id);


--
-- Name: idx_fare_products_urban_hourly; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fare_products_urban_hourly ON public.gtfs_fare_products USING btree (feed_id, is_urban_hourly);


--
-- Name: idx_fare_rules_feed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fare_rules_feed ON public.gtfs_fare_rules USING btree (feed_id);


--
-- Name: idx_fare_rules_feed_fare; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fare_rules_feed_fare ON public.gtfs_fare_rules USING btree (feed_id, fare_id);


--
-- Name: idx_fare_transfer_rules_feed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fare_transfer_rules_feed ON public.gtfs_fare_transfer_rules USING btree (feed_id);


--
-- Name: idx_fare_zone_clusters_feed_cluster; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_fare_zone_clusters_feed_cluster ON public.gtfs_fare_zone_clusters USING btree (feed_id, cluster_id);


--
-- Name: idx_fare_zone_cs_feed_cluster; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fare_zone_cs_feed_cluster ON public.gtfs_fare_zone_cluster_stops USING btree (feed_id, cluster_id);


--
-- Name: idx_fare_zone_cs_feed_stop; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fare_zone_cs_feed_stop ON public.gtfs_fare_zone_cluster_stops USING btree (feed_id, stop_id);


--
-- Name: idx_fares_polimetriche_snapshots_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fares_polimetriche_snapshots_created_at ON public.fares_polimetriche_snapshots USING btree (created_at DESC);


--
-- Name: idx_feed_info_feed; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_feed_info_feed ON public.gtfs_feed_info USING btree (feed_id);


--
-- Name: idx_gtfs_cal_dates_feed_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gtfs_cal_dates_feed_date ON public.gtfs_calendar_dates USING btree (feed_id, date);


--
-- Name: idx_gtfs_cal_dates_feed_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gtfs_cal_dates_feed_id ON public.gtfs_calendar_dates USING btree (feed_id);


--
-- Name: idx_gtfs_cal_dates_feed_service; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gtfs_cal_dates_feed_service ON public.gtfs_calendar_dates USING btree (feed_id, service_id);


--
-- Name: idx_gtfs_calendar_feed_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gtfs_calendar_feed_id ON public.gtfs_calendar USING btree (feed_id);


--
-- Name: idx_gtfs_calendar_feed_service; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_gtfs_calendar_feed_service ON public.gtfs_calendar USING btree (feed_id, service_id);


--
-- Name: idx_gtfs_feed_analysis_feed; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_gtfs_feed_analysis_feed ON public.gtfs_feed_analysis USING btree (feed_id);


--
-- Name: idx_gtfs_feed_econ_feed; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_gtfs_feed_econ_feed ON public.gtfs_feed_economic_params USING btree (feed_id);


--
-- Name: idx_gtfs_feeds_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gtfs_feeds_active ON public.gtfs_feeds USING btree (is_active) WHERE (is_active = true);


--
-- Name: idx_gtfs_feeds_default; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gtfs_feeds_default ON public.gtfs_feeds USING btree (is_default) WHERE (is_default = true);


--
-- Name: idx_gtfs_feeds_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gtfs_feeds_owner ON public.gtfs_feeds USING btree (owner_user_id);


--
-- Name: idx_gtfs_routes_feed_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gtfs_routes_feed_id ON public.gtfs_routes USING btree (feed_id);


--
-- Name: idx_gtfs_routes_feed_route; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gtfs_routes_feed_route ON public.gtfs_routes USING btree (feed_id, route_id);


--
-- Name: idx_gtfs_shapes_feed_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gtfs_shapes_feed_id ON public.gtfs_shapes USING btree (feed_id);


--
-- Name: idx_gtfs_shapes_feed_shape; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gtfs_shapes_feed_shape ON public.gtfs_shapes USING btree (feed_id, shape_id);


--
-- Name: idx_gtfs_stop_times_feed_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gtfs_stop_times_feed_id ON public.gtfs_stop_times USING btree (feed_id);


--
-- Name: idx_gtfs_stop_times_feed_stop; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gtfs_stop_times_feed_stop ON public.gtfs_stop_times USING btree (feed_id, stop_id);


--
-- Name: idx_gtfs_stop_times_feed_trip; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gtfs_stop_times_feed_trip ON public.gtfs_stop_times USING btree (feed_id, trip_id);


--
-- Name: idx_gtfs_stop_times_feed_trip_seq; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gtfs_stop_times_feed_trip_seq ON public.gtfs_stop_times USING btree (feed_id, trip_id, stop_sequence);


--
-- Name: idx_gtfs_stops_feed_fare_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gtfs_stops_feed_fare_kind ON public.gtfs_stops USING btree (feed_id, fare_kind);


--
-- Name: idx_gtfs_stops_feed_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gtfs_stops_feed_id ON public.gtfs_stops USING btree (feed_id);


--
-- Name: idx_gtfs_stops_feed_stop; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gtfs_stops_feed_stop ON public.gtfs_stops USING btree (feed_id, stop_id);


--
-- Name: idx_gtfs_trips_feed_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gtfs_trips_feed_id ON public.gtfs_trips USING btree (feed_id);


--
-- Name: idx_gtfs_trips_feed_route; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gtfs_trips_feed_route ON public.gtfs_trips USING btree (feed_id, route_id);


--
-- Name: idx_gtfs_trips_feed_service; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gtfs_trips_feed_service ON public.gtfs_trips USING btree (feed_id, service_id);


--
-- Name: idx_gtfs_trips_feed_trip; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gtfs_trips_feed_trip ON public.gtfs_trips USING btree (feed_id, trip_id);


--
-- Name: idx_isochrone_lat_lng_min; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_isochrone_lat_lng_min ON public.isochrone_cache USING btree (lat_round, lng_round, minutes);


--
-- Name: idx_istat_od_dest; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_istat_od_dest ON public.istat_commuting_od USING btree (dest_istat);


--
-- Name: idx_istat_od_origin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_istat_od_origin ON public.istat_commuting_od USING btree (origin_istat);


--
-- Name: idx_istat_od_pair; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_istat_od_pair ON public.istat_commuting_od USING btree (origin_istat, dest_istat);


--
-- Name: idx_orp_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orp_owner ON public.optimizer_rule_profiles USING btree (owner_user_id);


--
-- Name: idx_orp_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orp_project ON public.optimizer_rule_profiles USING btree (project_id);


--
-- Name: idx_pal_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pal_project ON public.project_activity_log USING btree (project_id, at DESC);


--
-- Name: idx_planning_analysis_scenario; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_planning_analysis_scenario ON public.planning_analysis_results USING btree (scenario_id);


--
-- Name: idx_planning_analysis_scenario_module; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_planning_analysis_scenario_module ON public.planning_analysis_results USING btree (scenario_id, module);


--
-- Name: idx_planning_edits_scenario; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_planning_edits_scenario ON public.planning_scenario_edits USING btree (scenario_id);


--
-- Name: idx_planning_edits_scenario_applied; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_planning_edits_scenario_applied ON public.planning_scenario_edits USING btree (scenario_id, applied_at);


--
-- Name: idx_planning_pois_feed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_planning_pois_feed ON public.planning_pois USING btree (feed_id);


--
-- Name: idx_planning_routeclass_cat; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_planning_routeclass_cat ON public.planning_route_classifications USING btree (feed_id, category);


--
-- Name: idx_planning_routeclass_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_planning_routeclass_unique ON public.planning_route_classifications USING btree (feed_id, route_id);


--
-- Name: idx_planning_scenarios_baseline; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_planning_scenarios_baseline ON public.planning_scenarios USING btree (baseline_feed_id);


--
-- Name: idx_planning_scenarios_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_planning_scenarios_owner ON public.planning_scenarios USING btree (owner_user_id);


--
-- Name: idx_planning_scenarios_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_planning_scenarios_status ON public.planning_scenarios USING btree (status);


--
-- Name: idx_pm_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pm_user ON public.project_members USING btree (user_id);


--
-- Name: idx_poi_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_poi_category ON public.points_of_interest USING btree (category);


--
-- Name: idx_polim_imports_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_polim_imports_created_at ON public.polim_imports USING btree (created_at DESC);


--
-- Name: idx_polim_polimetriche_import; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_polim_polimetriche_import ON public.polim_polimetriche USING btree (import_id);


--
-- Name: idx_process_reports_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_process_reports_project ON public.process_reports USING btree (project_id, created_at DESC);


--
-- Name: idx_process_reports_scenario; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_process_reports_scenario ON public.process_reports USING btree (scenario_id, created_at DESC);


--
-- Name: idx_ps_activation_log_proj; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_activation_log_proj ON public.ps_activation_log USING btree (project_id, activated_at DESC);


--
-- Name: idx_ps_argos_msgs; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_argos_msgs ON public.ps_argos_messages USING btree (project_id, user_id, id);


--
-- Name: idx_ps_cal_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_cal_project ON public.ps_calendars USING btree (project_id);


--
-- Name: idx_ps_clusters_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_clusters_project ON public.ps_stop_clusters USING btree (project_id);


--
-- Name: idx_ps_day_calendar_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_day_calendar_lookup ON public.ps_day_calendar USING btree (project_id, date);


--
-- Name: idx_ps_day_types_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_day_types_project ON public.ps_day_types USING btree (project_id);


--
-- Name: idx_ps_nogo_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_nogo_project ON public.ps_no_go_zones USING btree (project_id);


--
-- Name: idx_ps_pal_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_pal_project ON public.ps_project_activity_log USING btree (project_id, at DESC);


--
-- Name: idx_ps_pm_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_pm_user ON public.ps_project_members USING btree (user_id);


--
-- Name: idx_ps_proj_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_proj_owner ON public.ps_projects USING btree (owner_user_id);


--
-- Name: idx_ps_proj_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_proj_updated ON public.ps_projects USING btree (updated_at DESC);


--
-- Name: idx_ps_routes_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_routes_project ON public.ps_routes USING btree (project_id);


--
-- Name: idx_ps_shapes_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_shapes_project ON public.ps_shapes USING btree (project_id);


--
-- Name: idx_ps_sp_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_sp_project ON public.ps_service_periods USING btree (project_id);


--
-- Name: idx_ps_st_stop; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_st_stop ON public.ps_stop_times USING btree (stop_id);


--
-- Name: idx_ps_stops_cluster; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_stops_cluster ON public.ps_stops USING btree (cluster_id);


--
-- Name: idx_ps_stops_geo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_stops_geo ON public.ps_stops USING btree (project_id, lat, lon);


--
-- Name: idx_ps_stops_gtfs; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_stops_gtfs ON public.ps_stops USING btree (project_id, gtfs_id);


--
-- Name: idx_ps_stops_municipality; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_stops_municipality ON public.ps_stops USING btree (project_id, municipality);


--
-- Name: idx_ps_stops_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_stops_project ON public.ps_stops USING btree (project_id);


--
-- Name: idx_ps_tcv_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_tcv_category ON public.ps_trip_category_validity USING btree (category_id);


--
-- Name: idx_ps_trip_day_validity_trip; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_trip_day_validity_trip ON public.ps_trip_day_validity USING btree (trip_id);


--
-- Name: idx_ps_trip_exc_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_trip_exc_date ON public.ps_trip_exceptions USING btree (date);


--
-- Name: idx_ps_trips_cal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_trips_cal ON public.ps_trips USING btree (calendar_id);


--
-- Name: idx_ps_trips_gtfs; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_trips_gtfs ON public.ps_trips USING btree (project_id, gtfs_id);


--
-- Name: idx_ps_trips_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_trips_project ON public.ps_trips USING btree (project_id);


--
-- Name: idx_ps_trips_route; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_trips_route ON public.ps_trips USING btree (route_id);


--
-- Name: idx_ps_trips_validity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_trips_validity ON public.ps_trips USING btree (project_id, valid_from, valid_to);


--
-- Name: idx_ps_trips_variant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_trips_variant ON public.ps_trips USING btree (variant_id);


--
-- Name: idx_ps_validity_units_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_validity_units_project ON public.ps_validity_units USING btree (project_id);


--
-- Name: idx_ps_variants_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_variants_project ON public.ps_route_variants USING btree (project_id);


--
-- Name: idx_ps_variants_route; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_variants_route ON public.ps_route_variants USING btree (route_id);


--
-- Name: idx_ps_vcc_cat; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_vcc_cat ON public.ps_validity_category_calendar USING btree (category_id);


--
-- Name: idx_ps_vcc_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_vcc_lookup ON public.ps_validity_category_calendar USING btree (project_id, date);


--
-- Name: idx_ps_vs_stop; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_vs_stop ON public.ps_variant_stops USING btree (stop_id);


--
-- Name: idx_rider_cat_feed_cat; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_rider_cat_feed_cat ON public.gtfs_rider_categories USING btree (feed_id, rider_category_id);


--
-- Name: idx_roster_anag_log_driver; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_roster_anag_log_driver ON public.roster_anagrafica_log USING btree (driver_id, at DESC);


--
-- Name: idx_roster_assign_day; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_roster_assign_day ON public.roster_assignments USING btree (day);


--
-- Name: idx_roster_assign_driver_day; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_roster_assign_driver_day ON public.roster_assignments USING btree (driver_id, day);


--
-- Name: idx_roster_entries_day; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_roster_entries_day ON public.roster_entries USING btree (day);


--
-- Name: idx_roster_entries_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_roster_entries_source ON public.roster_entries USING btree (source);


--
-- Name: idx_roster_hist_driver; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_roster_hist_driver ON public.roster_driver_history USING btree (driver_id, event_date DESC);


--
-- Name: idx_roster_pubblicazioni_il; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_roster_pubblicazioni_il ON public.roster_pubblicazioni USING btree (creata_il DESC);


--
-- Name: idx_roster_turni_pubblicati_dss; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_roster_turni_pubblicati_dss ON public.roster_turni_pubblicati USING btree (dss_id, day) WHERE (sostituita_da IS NULL);


--
-- Name: idx_rot_asg_drv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rot_asg_drv ON public.roster_rotazione_assegnazioni USING btree (driver_id);


--
-- Name: idx_rot_asg_rot; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rot_asg_rot ON public.roster_rotazione_assegnazioni USING btree (rotazione_id);


--
-- Name: idx_route_networks_feed_network; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_route_networks_feed_network ON public.gtfs_route_networks USING btree (feed_id, network_id);


--
-- Name: idx_route_networks_feed_route; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_route_networks_feed_route ON public.gtfs_route_networks USING btree (feed_id, route_id);


--
-- Name: idx_sched_proj_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sched_proj_owner ON public.scheduling_projects USING btree (owner_user_id);


--
-- Name: idx_sched_proj_ps; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sched_proj_ps ON public.scheduling_projects USING btree (planning_studio_project_id);


--
-- Name: idx_sched_proj_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sched_proj_updated ON public.scheduling_projects USING btree (updated_at DESC);


--
-- Name: idx_sched_runs_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sched_runs_kind ON public.scheduling_runs USING btree (project_id, kind, created_at DESC);


--
-- Name: idx_sched_runs_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sched_runs_project ON public.scheduling_runs USING btree (project_id);


--
-- Name: idx_scs_cluster_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_scs_cluster_id ON public.stop_cluster_stops USING btree (cluster_id);


--
-- Name: idx_scs_gtfs_stop_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_scs_gtfs_stop_id ON public.stop_cluster_stops USING btree (gtfs_stop_id);


--
-- Name: idx_service_program_scenarios_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_service_program_scenarios_owner ON public.service_program_scenarios USING btree (owner_user_id);


--
-- Name: idx_spc_program_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_spc_program_id ON public.scenario_program_calendars USING btree (program_id);


--
-- Name: idx_spce_calendar_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_spce_calendar_id ON public.scenario_program_calendar_exceptions USING btree (calendar_id);


--
-- Name: idx_spce_exception_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_spce_exception_date ON public.scenario_program_calendar_exceptions USING btree (exception_date);


--
-- Name: idx_sps_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sps_date ON public.service_program_scenarios USING btree (date);


--
-- Name: idx_sps_feed_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sps_feed_id ON public.service_program_scenarios USING btree (feed_id);


--
-- Name: idx_sps_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sps_owner ON public.service_program_scenarios USING btree (owner_user_id);


--
-- Name: idx_sps_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sps_project ON public.service_program_scenarios USING btree (project_id);


--
-- Name: idx_ssp_scenario_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ssp_scenario_id ON public.scenario_service_programs USING btree (scenario_id);


--
-- Name: idx_stop_areas_feed_area; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stop_areas_feed_area ON public.gtfs_stop_areas USING btree (feed_id, area_id);


--
-- Name: idx_stop_areas_feed_stop; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stop_areas_feed_stop ON public.gtfs_stop_areas USING btree (feed_id, stop_id);


--
-- Name: idx_stop_areas_unique_feed_area_stop; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_stop_areas_unique_feed_area_stop ON public.gtfs_stop_areas USING btree (feed_id, area_id, stop_id);


--
-- Name: idx_stop_clusters_source_ps_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stop_clusters_source_ps_project ON public.stop_clusters USING btree (source_ps_project_id);


--
-- Name: idx_timeframes_feed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_timeframes_feed ON public.gtfs_timeframes USING btree (feed_id);


--
-- Name: idx_timeframes_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_timeframes_group ON public.gtfs_timeframes USING btree (feed_id, timeframe_group_id);


--
-- Name: idx_traffic_captured_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_traffic_captured_at ON public.traffic_snapshots USING btree (captured_at);


--
-- Name: idx_traffic_segment_captured; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_traffic_segment_captured ON public.traffic_snapshots USING btree (segment_id, captured_at);


--
-- Name: idx_traffic_segment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_traffic_segment_id ON public.traffic_snapshots USING btree (segment_id);


--
-- Name: idx_users_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_email ON public.users USING btree (email);


--
-- Name: idx_vsm_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vsm_user ON public.vehicle_schedule_members USING btree (user_id);


--
-- Name: idx_weather_captured_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_weather_captured_at ON public.weather_snapshots USING btree (captured_at);


--
-- Name: idx_weather_location; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_weather_location ON public.weather_snapshots USING btree (lat, lng);


--
-- Name: idx_weather_main; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_weather_main ON public.weather_snapshots USING btree (weather_main);


--
-- Name: idx_zones_istat; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zones_istat ON public.zones USING btree (istat_code);


--
-- Name: uq_deadhead_arcs_pair_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_deadhead_arcs_pair_scope ON public.deadhead_arcs USING btree (from_key, to_key, COALESCE(ps_project_id, '00000000-0000-0000-0000-000000000000'::uuid));


--
-- Name: uq_ps_day_calendar_global; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_ps_day_calendar_global ON public.ps_day_calendar USING btree (date) WHERE (project_id IS NULL);


--
-- Name: uq_ps_day_calendar_project; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_ps_day_calendar_project ON public.ps_day_calendar USING btree (project_id, date) WHERE (project_id IS NOT NULL);


--
-- Name: uq_ps_day_types_global_code; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_ps_day_types_global_code ON public.ps_day_types USING btree (code) WHERE (project_id IS NULL);


--
-- Name: uq_ps_day_types_project_code; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_ps_day_types_project_code ON public.ps_day_types USING btree (project_id, code) WHERE (project_id IS NOT NULL);


--
-- Name: uq_ps_snap_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_ps_snap_key ON public.ps_route_snap_cache USING btree (mode, from_lon, from_lat, to_lon, to_lat);


--
-- Name: uq_ps_validity_units; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_ps_validity_units ON public.ps_validity_units USING btree (project_id, validity_id);


--
-- Name: uq_ps_vcc_global; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_ps_vcc_global ON public.ps_validity_category_calendar USING btree (date) WHERE (project_id IS NULL);


--
-- Name: uq_ps_vcc_project; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_ps_vcc_project ON public.ps_validity_category_calendar USING btree (project_id, date) WHERE (project_id IS NOT NULL);


--
-- Name: uq_roster_drivers_matricola; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_roster_drivers_matricola ON public.roster_drivers USING btree (matricola_chiave) WHERE (is_active AND (NOT is_fictitious) AND (matricola_chiave IS NOT NULL));


--
-- Name: uq_roster_turni_pubblicati_attivi; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_roster_turni_pubblicati_attivi ON public.roster_turni_pubblicati USING btree (day, udp_id) WHERE (sostituita_da IS NULL);


--
-- Name: users_email_normale_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_email_normale_uq ON public.users USING btree (lower(TRIM(BOTH FROM email)));


--
-- Name: coincidence_zone_stops coincidence_zone_stops_zone_id_coincidence_zones_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coincidence_zone_stops
    ADD CONSTRAINT coincidence_zone_stops_zone_id_coincidence_zones_id_fk FOREIGN KEY (zone_id) REFERENCES public.coincidence_zones(id) ON DELETE CASCADE;


--
-- Name: driver_schedule_members driver_schedule_members_scenario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_schedule_members
    ADD CONSTRAINT driver_schedule_members_scenario_id_fkey FOREIGN KEY (scenario_id) REFERENCES public.driver_shift_scenarios(id) ON DELETE CASCADE;


--
-- Name: driver_shift_scenarios driver_shift_scenarios_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_shift_scenarios
    ADD CONSTRAINT driver_shift_scenarios_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: driver_shift_scenarios driver_shift_scenarios_service_program_scenario_id_service_prog; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_shift_scenarios
    ADD CONSTRAINT driver_shift_scenarios_service_program_scenario_id_service_prog FOREIGN KEY (service_program_scenario_id) REFERENCES public.service_program_scenarios(id) ON DELETE CASCADE;


--
-- Name: gtfs_calendar_dates gtfs_calendar_dates_feed_id_gtfs_feeds_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_calendar_dates
    ADD CONSTRAINT gtfs_calendar_dates_feed_id_gtfs_feeds_id_fk FOREIGN KEY (feed_id) REFERENCES public.gtfs_feeds(id) ON DELETE CASCADE;


--
-- Name: gtfs_calendar gtfs_calendar_feed_id_gtfs_feeds_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_calendar
    ADD CONSTRAINT gtfs_calendar_feed_id_gtfs_feeds_id_fk FOREIGN KEY (feed_id) REFERENCES public.gtfs_feeds(id) ON DELETE CASCADE;


--
-- Name: gtfs_fare_areas gtfs_fare_areas_feed_id_gtfs_feeds_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_fare_areas
    ADD CONSTRAINT gtfs_fare_areas_feed_id_gtfs_feeds_id_fk FOREIGN KEY (feed_id) REFERENCES public.gtfs_feeds(id) ON DELETE CASCADE;


--
-- Name: gtfs_fare_attributes gtfs_fare_attributes_feed_id_gtfs_feeds_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_fare_attributes
    ADD CONSTRAINT gtfs_fare_attributes_feed_id_gtfs_feeds_id_fk FOREIGN KEY (feed_id) REFERENCES public.gtfs_feeds(id) ON DELETE CASCADE;


--
-- Name: gtfs_fare_audit_log gtfs_fare_audit_log_feed_id_gtfs_feeds_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_fare_audit_log
    ADD CONSTRAINT gtfs_fare_audit_log_feed_id_gtfs_feeds_id_fk FOREIGN KEY (feed_id) REFERENCES public.gtfs_feeds(id) ON DELETE CASCADE;


--
-- Name: gtfs_fare_leg_rules gtfs_fare_leg_rules_feed_id_gtfs_feeds_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_fare_leg_rules
    ADD CONSTRAINT gtfs_fare_leg_rules_feed_id_gtfs_feeds_id_fk FOREIGN KEY (feed_id) REFERENCES public.gtfs_feeds(id) ON DELETE CASCADE;


--
-- Name: gtfs_fare_media gtfs_fare_media_feed_id_gtfs_feeds_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_fare_media
    ADD CONSTRAINT gtfs_fare_media_feed_id_gtfs_feeds_id_fk FOREIGN KEY (feed_id) REFERENCES public.gtfs_feeds(id) ON DELETE CASCADE;


--
-- Name: gtfs_fare_network_edges gtfs_fare_network_edges_feed_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_fare_network_edges
    ADD CONSTRAINT gtfs_fare_network_edges_feed_id_fkey FOREIGN KEY (feed_id) REFERENCES public.gtfs_feeds(id) ON DELETE CASCADE;


--
-- Name: gtfs_fare_networks gtfs_fare_networks_feed_id_gtfs_feeds_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_fare_networks
    ADD CONSTRAINT gtfs_fare_networks_feed_id_gtfs_feeds_id_fk FOREIGN KEY (feed_id) REFERENCES public.gtfs_feeds(id) ON DELETE CASCADE;


--
-- Name: gtfs_fare_node_assignment_runs gtfs_fare_node_assignment_runs_feed_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_fare_node_assignment_runs
    ADD CONSTRAINT gtfs_fare_node_assignment_runs_feed_id_fkey FOREIGN KEY (feed_id) REFERENCES public.gtfs_feeds(id) ON DELETE CASCADE;


--
-- Name: gtfs_fare_od_matrix gtfs_fare_od_matrix_feed_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_fare_od_matrix
    ADD CONSTRAINT gtfs_fare_od_matrix_feed_id_fkey FOREIGN KEY (feed_id) REFERENCES public.gtfs_feeds(id) ON DELETE CASCADE;


--
-- Name: gtfs_fare_od_matrix_runs gtfs_fare_od_matrix_runs_feed_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_fare_od_matrix_runs
    ADD CONSTRAINT gtfs_fare_od_matrix_runs_feed_id_fkey FOREIGN KEY (feed_id) REFERENCES public.gtfs_feeds(id) ON DELETE CASCADE;


--
-- Name: gtfs_fare_official_nodes gtfs_fare_official_nodes_feed_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_fare_official_nodes
    ADD CONSTRAINT gtfs_fare_official_nodes_feed_id_fkey FOREIGN KEY (feed_id) REFERENCES public.gtfs_feeds(id) ON DELETE CASCADE;


--
-- Name: gtfs_fare_products gtfs_fare_products_feed_id_gtfs_feeds_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_fare_products
    ADD CONSTRAINT gtfs_fare_products_feed_id_gtfs_feeds_id_fk FOREIGN KEY (feed_id) REFERENCES public.gtfs_feeds(id) ON DELETE CASCADE;


--
-- Name: gtfs_fare_rules gtfs_fare_rules_feed_id_gtfs_feeds_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_fare_rules
    ADD CONSTRAINT gtfs_fare_rules_feed_id_gtfs_feeds_id_fk FOREIGN KEY (feed_id) REFERENCES public.gtfs_feeds(id) ON DELETE CASCADE;


--
-- Name: gtfs_fare_stop_assignment_overrides gtfs_fare_stop_assignment_overrides_feed_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_fare_stop_assignment_overrides
    ADD CONSTRAINT gtfs_fare_stop_assignment_overrides_feed_id_fkey FOREIGN KEY (feed_id) REFERENCES public.gtfs_feeds(id) ON DELETE CASCADE;


--
-- Name: gtfs_fare_transfer_rules gtfs_fare_transfer_rules_feed_id_gtfs_feeds_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_fare_transfer_rules
    ADD CONSTRAINT gtfs_fare_transfer_rules_feed_id_gtfs_feeds_id_fk FOREIGN KEY (feed_id) REFERENCES public.gtfs_feeds(id) ON DELETE CASCADE;


--
-- Name: gtfs_fare_zone_cluster_stops gtfs_fare_zone_cluster_stops_feed_id_gtfs_feeds_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_fare_zone_cluster_stops
    ADD CONSTRAINT gtfs_fare_zone_cluster_stops_feed_id_gtfs_feeds_id_fk FOREIGN KEY (feed_id) REFERENCES public.gtfs_feeds(id) ON DELETE CASCADE;


--
-- Name: gtfs_fare_zone_clusters gtfs_fare_zone_clusters_feed_id_gtfs_feeds_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_fare_zone_clusters
    ADD CONSTRAINT gtfs_fare_zone_clusters_feed_id_gtfs_feeds_id_fk FOREIGN KEY (feed_id) REFERENCES public.gtfs_feeds(id) ON DELETE CASCADE;


--
-- Name: gtfs_feed_analysis gtfs_feed_analysis_feed_id_gtfs_feeds_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_feed_analysis
    ADD CONSTRAINT gtfs_feed_analysis_feed_id_gtfs_feeds_id_fk FOREIGN KEY (feed_id) REFERENCES public.gtfs_feeds(id) ON DELETE CASCADE;


--
-- Name: gtfs_feed_economic_params gtfs_feed_economic_params_feed_id_gtfs_feeds_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_feed_economic_params
    ADD CONSTRAINT gtfs_feed_economic_params_feed_id_gtfs_feeds_id_fk FOREIGN KEY (feed_id) REFERENCES public.gtfs_feeds(id) ON DELETE CASCADE;


--
-- Name: gtfs_feed_info gtfs_feed_info_feed_id_gtfs_feeds_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_feed_info
    ADD CONSTRAINT gtfs_feed_info_feed_id_gtfs_feeds_id_fk FOREIGN KEY (feed_id) REFERENCES public.gtfs_feeds(id) ON DELETE CASCADE;


--
-- Name: gtfs_feeds gtfs_feeds_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_feeds
    ADD CONSTRAINT gtfs_feeds_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: gtfs_rider_categories gtfs_rider_categories_feed_id_gtfs_feeds_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_rider_categories
    ADD CONSTRAINT gtfs_rider_categories_feed_id_gtfs_feeds_id_fk FOREIGN KEY (feed_id) REFERENCES public.gtfs_feeds(id) ON DELETE CASCADE;


--
-- Name: gtfs_route_networks gtfs_route_networks_feed_id_gtfs_feeds_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_route_networks
    ADD CONSTRAINT gtfs_route_networks_feed_id_gtfs_feeds_id_fk FOREIGN KEY (feed_id) REFERENCES public.gtfs_feeds(id) ON DELETE CASCADE;


--
-- Name: gtfs_routes gtfs_routes_feed_id_gtfs_feeds_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_routes
    ADD CONSTRAINT gtfs_routes_feed_id_gtfs_feeds_id_fk FOREIGN KEY (feed_id) REFERENCES public.gtfs_feeds(id) ON DELETE CASCADE;


--
-- Name: gtfs_shapes gtfs_shapes_feed_id_gtfs_feeds_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_shapes
    ADD CONSTRAINT gtfs_shapes_feed_id_gtfs_feeds_id_fk FOREIGN KEY (feed_id) REFERENCES public.gtfs_feeds(id) ON DELETE CASCADE;


--
-- Name: gtfs_stop_areas gtfs_stop_areas_feed_id_gtfs_feeds_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_stop_areas
    ADD CONSTRAINT gtfs_stop_areas_feed_id_gtfs_feeds_id_fk FOREIGN KEY (feed_id) REFERENCES public.gtfs_feeds(id) ON DELETE CASCADE;


--
-- Name: gtfs_stop_times gtfs_stop_times_feed_id_gtfs_feeds_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_stop_times
    ADD CONSTRAINT gtfs_stop_times_feed_id_gtfs_feeds_id_fk FOREIGN KEY (feed_id) REFERENCES public.gtfs_feeds(id) ON DELETE CASCADE;


--
-- Name: gtfs_stops gtfs_stops_feed_id_gtfs_feeds_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_stops
    ADD CONSTRAINT gtfs_stops_feed_id_gtfs_feeds_id_fk FOREIGN KEY (feed_id) REFERENCES public.gtfs_feeds(id) ON DELETE CASCADE;


--
-- Name: gtfs_timeframes gtfs_timeframes_feed_id_gtfs_feeds_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_timeframes
    ADD CONSTRAINT gtfs_timeframes_feed_id_gtfs_feeds_id_fk FOREIGN KEY (feed_id) REFERENCES public.gtfs_feeds(id) ON DELETE CASCADE;


--
-- Name: gtfs_trips gtfs_trips_feed_id_gtfs_feeds_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtfs_trips
    ADD CONSTRAINT gtfs_trips_feed_id_gtfs_feeds_id_fk FOREIGN KEY (feed_id) REFERENCES public.gtfs_feeds(id) ON DELETE CASCADE;


--
-- Name: optimizer_rule_profiles optimizer_rule_profiles_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.optimizer_rule_profiles
    ADD CONSTRAINT optimizer_rule_profiles_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: planning_analysis_results planning_analysis_results_scenario_id_planning_scenarios_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_analysis_results
    ADD CONSTRAINT planning_analysis_results_scenario_id_planning_scenarios_id_fk FOREIGN KEY (scenario_id) REFERENCES public.planning_scenarios(id) ON DELETE CASCADE;


--
-- Name: planning_pois planning_pois_feed_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_pois
    ADD CONSTRAINT planning_pois_feed_id_fkey FOREIGN KEY (feed_id) REFERENCES public.gtfs_feeds(id) ON DELETE CASCADE;


--
-- Name: planning_route_classifications planning_route_classifications_feed_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_route_classifications
    ADD CONSTRAINT planning_route_classifications_feed_id_fkey FOREIGN KEY (feed_id) REFERENCES public.gtfs_feeds(id) ON DELETE CASCADE;


--
-- Name: planning_scenario_edits planning_scenario_edits_scenario_id_planning_scenarios_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_scenario_edits
    ADD CONSTRAINT planning_scenario_edits_scenario_id_planning_scenarios_id_fk FOREIGN KEY (scenario_id) REFERENCES public.planning_scenarios(id) ON DELETE CASCADE;


--
-- Name: planning_scenarios planning_scenarios_baseline_feed_id_gtfs_feeds_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_scenarios
    ADD CONSTRAINT planning_scenarios_baseline_feed_id_gtfs_feeds_id_fk FOREIGN KEY (baseline_feed_id) REFERENCES public.gtfs_feeds(id) ON DELETE RESTRICT;


--
-- Name: planning_scenarios planning_scenarios_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_scenarios
    ADD CONSTRAINT planning_scenarios_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: polim_polimetriche polim_polimetriche_import_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.polim_polimetriche
    ADD CONSTRAINT polim_polimetriche_import_id_fkey FOREIGN KEY (import_id) REFERENCES public.polim_imports(id) ON DELETE CASCADE;


--
-- Name: project_activity_log project_activity_log_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_activity_log
    ADD CONSTRAINT project_activity_log_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.scheduling_projects(id) ON DELETE CASCADE;


--
-- Name: project_members project_members_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_members
    ADD CONSTRAINT project_members_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.scheduling_projects(id) ON DELETE CASCADE;


--
-- Name: ps_activation_log ps_activation_log_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_activation_log
    ADD CONSTRAINT ps_activation_log_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.ps_projects(id) ON DELETE CASCADE;


--
-- Name: ps_argos_messages ps_argos_messages_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_argos_messages
    ADD CONSTRAINT ps_argos_messages_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.ps_projects(id) ON DELETE CASCADE;


--
-- Name: ps_calendar_dates ps_calendar_dates_calendar_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_calendar_dates
    ADD CONSTRAINT ps_calendar_dates_calendar_id_fkey FOREIGN KEY (calendar_id) REFERENCES public.ps_calendars(id) ON DELETE CASCADE;


--
-- Name: ps_calendar_profiles ps_calendar_profiles_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_calendar_profiles
    ADD CONSTRAINT ps_calendar_profiles_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.ps_projects(id) ON DELETE CASCADE;


--
-- Name: ps_calendars ps_calendars_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_calendars
    ADD CONSTRAINT ps_calendars_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.ps_projects(id) ON DELETE CASCADE;


--
-- Name: ps_day_calendar ps_day_calendar_day_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_day_calendar
    ADD CONSTRAINT ps_day_calendar_day_type_id_fkey FOREIGN KEY (day_type_id) REFERENCES public.ps_day_types(id) ON DELETE RESTRICT;


--
-- Name: ps_day_calendar ps_day_calendar_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_day_calendar
    ADD CONSTRAINT ps_day_calendar_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.ps_projects(id) ON DELETE CASCADE;


--
-- Name: ps_day_types ps_day_types_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_day_types
    ADD CONSTRAINT ps_day_types_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.ps_projects(id) ON DELETE CASCADE;


--
-- Name: ps_pending_activations ps_pending_activations_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_pending_activations
    ADD CONSTRAINT ps_pending_activations_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.ps_projects(id) ON DELETE CASCADE;


--
-- Name: ps_project_activity_log ps_project_activity_log_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_project_activity_log
    ADD CONSTRAINT ps_project_activity_log_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.ps_projects(id) ON DELETE CASCADE;


--
-- Name: ps_project_members ps_project_members_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_project_members
    ADD CONSTRAINT ps_project_members_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.ps_projects(id) ON DELETE CASCADE;


--
-- Name: ps_route_variants ps_route_variants_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_route_variants
    ADD CONSTRAINT ps_route_variants_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.ps_projects(id) ON DELETE CASCADE;


--
-- Name: ps_route_variants ps_route_variants_route_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_route_variants
    ADD CONSTRAINT ps_route_variants_route_id_fkey FOREIGN KEY (route_id) REFERENCES public.ps_routes(id) ON DELETE CASCADE;


--
-- Name: ps_routes ps_routes_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_routes
    ADD CONSTRAINT ps_routes_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.ps_projects(id) ON DELETE CASCADE;


--
-- Name: ps_service_periods ps_service_periods_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_service_periods
    ADD CONSTRAINT ps_service_periods_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.ps_projects(id) ON DELETE CASCADE;


--
-- Name: ps_shapes ps_shapes_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_shapes
    ADD CONSTRAINT ps_shapes_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.ps_projects(id) ON DELETE CASCADE;


--
-- Name: ps_shapes ps_shapes_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_shapes
    ADD CONSTRAINT ps_shapes_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.ps_route_variants(id) ON DELETE CASCADE;


--
-- Name: ps_stop_clusters ps_stop_clusters_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_stop_clusters
    ADD CONSTRAINT ps_stop_clusters_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.ps_projects(id) ON DELETE CASCADE;


--
-- Name: ps_stop_times ps_stop_times_stop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_stop_times
    ADD CONSTRAINT ps_stop_times_stop_id_fkey FOREIGN KEY (stop_id) REFERENCES public.ps_stops(id) ON DELETE RESTRICT;


--
-- Name: ps_stop_times ps_stop_times_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_stop_times
    ADD CONSTRAINT ps_stop_times_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.ps_trips(id) ON DELETE CASCADE;


--
-- Name: ps_stops ps_stops_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_stops
    ADD CONSTRAINT ps_stops_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.ps_projects(id) ON DELETE CASCADE;


--
-- Name: ps_trip_day_validity ps_trip_day_validity_day_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_trip_day_validity
    ADD CONSTRAINT ps_trip_day_validity_day_type_id_fkey FOREIGN KEY (day_type_id) REFERENCES public.ps_day_types(id) ON DELETE CASCADE;


--
-- Name: ps_trip_day_validity ps_trip_day_validity_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_trip_day_validity
    ADD CONSTRAINT ps_trip_day_validity_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.ps_trips(id) ON DELETE CASCADE;


--
-- Name: ps_trip_exceptions ps_trip_exceptions_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_trip_exceptions
    ADD CONSTRAINT ps_trip_exceptions_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.ps_trips(id) ON DELETE CASCADE;


--
-- Name: ps_trips ps_trips_calendar_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_trips
    ADD CONSTRAINT ps_trips_calendar_id_fkey FOREIGN KEY (calendar_id) REFERENCES public.ps_calendars(id) ON DELETE SET NULL;


--
-- Name: ps_trips ps_trips_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_trips
    ADD CONSTRAINT ps_trips_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.ps_projects(id) ON DELETE CASCADE;


--
-- Name: ps_trips ps_trips_route_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_trips
    ADD CONSTRAINT ps_trips_route_id_fkey FOREIGN KEY (route_id) REFERENCES public.ps_routes(id) ON DELETE CASCADE;


--
-- Name: ps_trips ps_trips_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_trips
    ADD CONSTRAINT ps_trips_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.ps_route_variants(id) ON DELETE RESTRICT;


--
-- Name: ps_validity_category_calendar ps_validity_category_calendar_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_validity_category_calendar
    ADD CONSTRAINT ps_validity_category_calendar_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.ps_validity_categories(id) ON DELETE CASCADE;


--
-- Name: ps_validity_category_calendar ps_validity_category_calendar_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_validity_category_calendar
    ADD CONSTRAINT ps_validity_category_calendar_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.ps_projects(id) ON DELETE CASCADE;


--
-- Name: ps_validity_units ps_validity_units_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_validity_units
    ADD CONSTRAINT ps_validity_units_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.ps_validity_categories(id) ON DELETE SET NULL;


--
-- Name: ps_validity_units ps_validity_units_day_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_validity_units
    ADD CONSTRAINT ps_validity_units_day_type_id_fkey FOREIGN KEY (day_type_id) REFERENCES public.ps_day_types(id) ON DELETE SET NULL;


--
-- Name: ps_validity_units ps_validity_units_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_validity_units
    ADD CONSTRAINT ps_validity_units_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.ps_projects(id) ON DELETE CASCADE;


--
-- Name: ps_variant_stops ps_variant_stops_stop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_variant_stops
    ADD CONSTRAINT ps_variant_stops_stop_id_fkey FOREIGN KEY (stop_id) REFERENCES public.ps_stops(id) ON DELETE RESTRICT;


--
-- Name: ps_variant_stops ps_variant_stops_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ps_variant_stops
    ADD CONSTRAINT ps_variant_stops_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.ps_route_variants(id) ON DELETE CASCADE;


--
-- Name: roster_assignments roster_assignments_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_assignments
    ADD CONSTRAINT roster_assignments_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.roster_drivers(id) ON DELETE CASCADE;


--
-- Name: roster_driver_history roster_driver_history_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_driver_history
    ADD CONSTRAINT roster_driver_history_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.roster_drivers(id) ON DELETE CASCADE;


--
-- Name: roster_dss_riassunti roster_dss_riassunti_dss_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_dss_riassunti
    ADD CONSTRAINT roster_dss_riassunti_dss_id_fkey FOREIGN KEY (dss_id) REFERENCES public.driver_shift_scenarios(id) ON DELETE CASCADE;


--
-- Name: roster_entries roster_entries_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_entries
    ADD CONSTRAINT roster_entries_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.roster_drivers(id) ON DELETE CASCADE;


--
-- Name: roster_gruppi_turni roster_gruppi_turni_deposito_codice_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_gruppi_turni
    ADD CONSTRAINT roster_gruppi_turni_deposito_codice_fkey FOREIGN KEY (deposito_codice) REFERENCES public.roster_depositi(codice);


--
-- Name: roster_rotazione_assegnazioni roster_rotazione_assegnazioni_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_rotazione_assegnazioni
    ADD CONSTRAINT roster_rotazione_assegnazioni_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.roster_drivers(id) ON DELETE CASCADE;


--
-- Name: roster_rotazione_assegnazioni roster_rotazione_assegnazioni_rotazione_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_rotazione_assegnazioni
    ADD CONSTRAINT roster_rotazione_assegnazioni_rotazione_id_fkey FOREIGN KEY (rotazione_id) REFERENCES public.roster_rotazioni_riposi(id) ON DELETE CASCADE;


--
-- Name: roster_turni_dss roster_turni_dss_dss_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_turni_dss
    ADD CONSTRAINT roster_turni_dss_dss_id_fkey FOREIGN KEY (dss_id) REFERENCES public.driver_shift_scenarios(id) ON DELETE CASCADE;


--
-- Name: roster_turni_pubblicati roster_turni_pubblicati_dss_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_turni_pubblicati
    ADD CONSTRAINT roster_turni_pubblicati_dss_id_fkey FOREIGN KEY (dss_id) REFERENCES public.driver_shift_scenarios(id) ON DELETE RESTRICT;


--
-- Name: roster_turni_pubblicati roster_turni_pubblicati_pubblicazione_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_turni_pubblicati
    ADD CONSTRAINT roster_turni_pubblicati_pubblicazione_id_fkey FOREIGN KEY (pubblicazione_id) REFERENCES public.roster_pubblicazioni(id);


--
-- Name: roster_turni_pubblicati roster_turni_pubblicati_sostituita_da_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_turni_pubblicati
    ADD CONSTRAINT roster_turni_pubblicati_sostituita_da_fkey FOREIGN KEY (sostituita_da) REFERENCES public.roster_pubblicazioni(id);


--
-- Name: scenario_program_calendar_exceptions scenario_program_calendar_exceptions_calendar_id_scenario_progr; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scenario_program_calendar_exceptions
    ADD CONSTRAINT scenario_program_calendar_exceptions_calendar_id_scenario_progr FOREIGN KEY (calendar_id) REFERENCES public.scenario_program_calendars(id) ON DELETE CASCADE;


--
-- Name: scenario_program_calendars scenario_program_calendars_program_id_scenario_service_programs; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scenario_program_calendars
    ADD CONSTRAINT scenario_program_calendars_program_id_scenario_service_programs FOREIGN KEY (program_id) REFERENCES public.scenario_service_programs(id) ON DELETE CASCADE;


--
-- Name: scenario_service_programs scenario_service_programs_scenario_id_scenarios_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scenario_service_programs
    ADD CONSTRAINT scenario_service_programs_scenario_id_scenarios_id_fk FOREIGN KEY (scenario_id) REFERENCES public.scenarios(id) ON DELETE CASCADE;


--
-- Name: scheduling_runs scheduling_runs_parent_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_runs
    ADD CONSTRAINT scheduling_runs_parent_run_id_fkey FOREIGN KEY (parent_run_id) REFERENCES public.scheduling_runs(id) ON DELETE SET NULL;


--
-- Name: scheduling_runs scheduling_runs_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_runs
    ADD CONSTRAINT scheduling_runs_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.scheduling_projects(id) ON DELETE CASCADE;


--
-- Name: service_program_scenarios service_program_scenarios_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_program_scenarios
    ADD CONSTRAINT service_program_scenarios_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: stop_cluster_stops stop_cluster_stops_cluster_id_stop_clusters_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stop_cluster_stops
    ADD CONSTRAINT stop_cluster_stops_cluster_id_stop_clusters_id_fk FOREIGN KEY (cluster_id) REFERENCES public.stop_clusters(id) ON DELETE CASCADE;


--
-- Name: vehicle_schedule_members vehicle_schedule_members_scenario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_schedule_members
    ADD CONSTRAINT vehicle_schedule_members_scenario_id_fkey FOREIGN KEY (scenario_id) REFERENCES public.service_program_scenarios(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

