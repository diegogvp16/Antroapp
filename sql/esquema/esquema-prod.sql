-- Esquema de AntroApp extraído del catálogo (prod). Solo estructura, sin datos.
-- Generado por scripts/db/extraer-esquema.mjs. No editar a mano: regenerar.
set check_function_bodies = off;

-- ============================================================
-- Extensiones
-- ============================================================
create extension if not exists pg_stat_statements with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists supabase_vault with schema vault;
create extension if not exists "uuid-ossp" with schema extensions;

-- ============================================================
-- Tipos enum
-- ============================================================

-- ============================================================
-- Secuencias
-- ============================================================

-- ============================================================
-- Funciones de public
-- ============================================================
CREATE OR REPLACE FUNCTION public.clubs_candado_bono()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null or public.current_role_name() = 'admin' then
    return new;
  end if;

  if new.bono_organica_tipo is distinct from old.bono_organica_tipo
     or new.bono_organica_monto is distinct from old.bono_organica_monto then
    raise exception 'El bono de plataforma solo lo define AntroApp.';
  end if;

  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.clubs_candado_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null or public.current_role_name() = 'admin' then
    return new;
  end if;

  new.estado_verificacion := 'borrador';
  new.motivo_rechazo := null;
  new.verificado_en := null;
  new.bono_organica_tipo := 'fijo';
  new.bono_organica_monto := 0;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.clubs_candado_verificacion()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null or public.current_role_name() = 'admin' then
    return new;
  end if;

  if new.verificado_en is distinct from old.verificado_en
     or new.motivo_rechazo is distinct from old.motivo_rechazo then
    raise exception 'Solo AntroApp puede aprobar o rechazar una verificación.';
  end if;

  if new.estado_verificacion is not distinct from old.estado_verificacion then
    return new;
  end if;

  if not (old.estado_verificacion in ('borrador', 'rechazado')
          and new.estado_verificacion = 'en_revision') then
    raise exception 'No puedes cambiar la verificación de % a %.',
      old.estado_verificacion, new.estado_verificacion;
  end if;

  if not exists (
       select 1 from public.verificacion_documentos
       where club_id = new.id and tipo = 'comprobante_fiscal')
     or not exists (
       select 1 from public.verificacion_documentos
       where club_id = new.id and tipo = 'foto_local') then
    raise exception 'Faltan documentos requeridos para enviar a revisión.';
  end if;

  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.current_club_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(
    (select club_id from profiles where id = auth.uid()),
    (select id from clubs where dueno_id = auth.uid())
  );
$function$;

CREATE OR REPLACE FUNCTION public.current_role_name()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select role from profiles where id = auth.uid();
$function$;

CREATE OR REPLACE FUNCTION public.obtener_reserva_por_qr(p_qr text)
 RETURNS TABLE(cliente_nombre text, fecha date, personas integer, status text, qr_code text, club_nombre text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select r.cliente_nombre,
         r.fecha,
         r.personas,
         r.status,
         r.qr_code,
         c.nombre as club_nombre
  from public.reservations r
  left join public.clubs c on c.id = r.club_id
  where r.qr_code = p_qr
  limit 1;
$function$;

CREATE OR REPLACE FUNCTION public.profiles_bloquear_cambio_privilegios()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null or public.current_role_name() = 'admin' then
    return new;
  end if;
  if new.role is distinct from old.role then
    raise exception 'No puedes cambiar el rol de un perfil.';
  end if;
  if new.club_id is distinct from old.club_id then
    raise exception 'No puedes cambiar el club de un perfil.';
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.registrar_comision_reserva(p_reservation_id uuid, p_rp_id uuid, p_club_id uuid, p_consumo_monto numeric, p_week_start timestamp with time zone, p_week_end timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_tipo text;
  v_monto numeric;
  v_desbloqueo int;
  v_count_semana int;
  v_monto_final numeric;
begin
  if not (
    (public.current_role_name() in ('staff', 'gerente', 'dueno') and p_club_id = public.current_club_id())
    or public.current_role_name() = 'admin'
  ) then
    raise exception 'No autorizado para registrar comisiones de este club';
  end if;

  select comision_tipo, comision_monto, comision_desbloqueo_reservas
    into v_tipo, v_monto, v_desbloqueo
  from public.rp_comision_overrides
  where club_id = p_club_id and rp_id = p_rp_id;

  if not found then
    select comision_tipo, comision_monto, comision_desbloqueo_reservas
      into v_tipo, v_monto, v_desbloqueo
    from public.clubs
    where id = p_club_id;
  end if;

  select count(*) into v_count_semana
  from public.commissions c
  join public.reservations r on r.id = c.reservation_id
  where c.rp_id = p_rp_id
    and r.club_id = p_club_id
    and c.created_at >= p_week_start
    and c.created_at <= p_week_end;

  v_monto_final := case
    when (v_count_semana + 1) < v_desbloqueo then 0
    when v_tipo = 'fijo' then v_monto
    else (v_monto / 100) * p_consumo_monto
  end;

  insert into public.commissions (reservation_id, rp_id, tipo, monto, status)
  values (p_reservation_id, p_rp_id, 'rp', v_monto_final, 'pendiente');
end;
$function$;

CREATE OR REPLACE FUNCTION public.registrar_pago_dia(p_rp_attendance_id uuid, p_rp_id uuid, p_club_id uuid, p_fecha date, p_week_start timestamp with time zone, p_week_end timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_posicion int;
  v_monto numeric;
begin
  if not (
    (public.current_role_name() in ('staff', 'gerente', 'dueno') and p_club_id = public.current_club_id())
    or public.current_role_name() = 'admin'
  ) then
    raise exception 'No autorizado para registrar pagos de este club';
  end if;

  if not exists (
    select 1 from public.rp_attendance
    where id = p_rp_attendance_id and rp_id = p_rp_id and club_id = p_club_id
  ) then
    raise exception 'Asistencia inválida';
  end if;

  select count(*) into v_posicion
  from public.rp_attendance
  where rp_id = p_rp_id
    and club_id = p_club_id
    and scanned_at >= p_week_start
    and scanned_at <= p_week_end;

  if v_posicion = 0 then
    v_posicion := 1;
  end if;

  select monto into v_monto
  from (
    select distinct on (posicion) posicion, monto
    from (
      select posicion, monto, 1 as prioridad
      from public.rp_dia_tarifa_overrides
      where club_id = p_club_id and rp_id = p_rp_id
      union all
      select posicion, monto, 0 as prioridad
      from public.club_dia_tarifas
      where club_id = p_club_id
    ) fuentes
    order by posicion, prioridad desc
  ) tarifa_efectiva
  where posicion <= v_posicion
  order by posicion desc
  limit 1;

  if v_monto is null then
    v_monto := 0;
  end if;

  insert into public.rp_pagos_dia (rp_attendance_id, rp_id, club_id, fecha, posicion, monto, status)
  values (p_rp_attendance_id, p_rp_id, p_club_id, p_fecha, v_posicion, v_monto, 'pendiente');
end;
$function$;

CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;


-- ============================================================
-- Tablas
-- ============================================================
create table public.club_dia_tarifas (
  id uuid default gen_random_uuid() not null,
  club_id uuid not null,
  posicion integer not null,
  monto numeric default 0 not null,
  created_at timestamp with time zone default now() not null
);
create table public.club_photos (
  id uuid default gen_random_uuid() not null,
  club_id uuid not null,
  url text not null,
  storage_path text not null,
  orden integer default 0 not null,
  created_at timestamp with time zone default now() not null
);
create table public.club_tables (
  id uuid default gen_random_uuid() not null,
  club_id uuid not null,
  numero text not null,
  capacidad integer default 4 not null,
  created_at timestamp with time zone default now() not null
);
create table public.clubs (
  id uuid default gen_random_uuid() not null,
  nombre text not null,
  direccion text not null,
  horario text not null,
  deposito_monto numeric default 100 not null,
  dueno_id uuid,
  suscripcion_activa boolean default false not null,
  suscripcion_activada_en timestamp with time zone,
  comision_tipo text default 'fijo'::text not null,
  comision_monto numeric default 0 not null,
  comision_desbloqueo_reservas integer default 0 not null,
  bono_organica_tipo text default 'fijo'::text not null,
  bono_organica_monto numeric default 0 not null,
  lat numeric,
  lng numeric,
  pago_rp_modo text default 'reserva'::text not null,
  ambiente text,
  tipo_musica text,
  codigo_vestimenta text,
  edad_minima integer,
  ciudad text,
  estado_verificacion text default 'borrador'::text not null,
  motivo_rechazo text,
  verificado_en timestamp with time zone
);
create table public.commissions (
  id uuid default gen_random_uuid() not null,
  reservation_id uuid not null,
  rp_id uuid,
  tipo text not null,
  monto numeric default 0 not null,
  status text default 'pendiente'::text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table public.consumption_entries (
  id uuid default gen_random_uuid() not null,
  reservation_id uuid not null,
  monto numeric not null,
  created_at timestamp with time zone default now() not null
);
create table public.profiles (
  id uuid not null,
  nombre text not null,
  telefono text,
  role text default 'rp'::text not null,
  club_id uuid,
  created_at timestamp with time zone default now() not null,
  activo boolean default true not null
);
create table public.reservations (
  id uuid default gen_random_uuid() not null,
  cliente_nombre text not null,
  cliente_telefono text,
  rp_id uuid,
  source text not null,
  fecha date not null,
  personas integer default 1 not null,
  status text default 'pendiente'::text not null,
  qr_code text not null,
  created_at timestamp with time zone default now(),
  club_id uuid,
  mesa_id uuid,
  consumo_monto numeric,
  cliente_id uuid,
  se_retiro_sin_consumir boolean
);
create table public.rp_attendance (
  id uuid default gen_random_uuid() not null,
  rp_id uuid not null,
  club_id uuid not null,
  fecha date not null,
  scanned_at timestamp with time zone default now() not null,
  metodo text not null,
  marcado_por uuid
);
create table public.rp_comision_overrides (
  id uuid default gen_random_uuid() not null,
  club_id uuid not null,
  rp_id uuid not null,
  comision_tipo text not null,
  comision_monto numeric not null,
  comision_desbloqueo_reservas integer not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table public.rp_dia_tarifa_overrides (
  id uuid default gen_random_uuid() not null,
  club_id uuid not null,
  rp_id uuid not null,
  posicion integer not null,
  monto numeric not null,
  created_at timestamp with time zone default now() not null
);
create table public.rp_pagos_dia (
  id uuid default gen_random_uuid() not null,
  rp_attendance_id uuid not null,
  rp_id uuid not null,
  club_id uuid not null,
  fecha date not null,
  posicion integer not null,
  monto numeric not null,
  status text default 'pendiente'::text not null,
  created_at timestamp with time zone default now() not null
);
create table public.rp_schedule (
  id uuid default gen_random_uuid() not null,
  rp_id uuid not null,
  club_id uuid not null,
  fecha date not null,
  created_at timestamp with time zone default now() not null,
  es_fijo boolean default false not null,
  dias_semana integer[],
  fecha_inicio date
);
create table public.verificacion_documentos (
  id uuid default gen_random_uuid() not null,
  club_id uuid not null,
  tipo text not null,
  storage_path text not null,
  created_at timestamp with time zone default now() not null
);

-- ============================================================
-- Restricciones (PK, UNIQUE, CHECK, EXCLUDE) y luego llaves foráneas
-- ============================================================
alter table public.club_dia_tarifas add constraint club_dia_tarifas_club_id_posicion_key UNIQUE (club_id, posicion);
alter table public.club_dia_tarifas add constraint club_dia_tarifas_pkey PRIMARY KEY (id);
alter table public.club_dia_tarifas add constraint club_dia_tarifas_posicion_check CHECK ((posicion > 0));
alter table public.club_photos add constraint club_photos_pkey PRIMARY KEY (id);
alter table public.club_tables add constraint club_tables_pkey PRIMARY KEY (id);
alter table public.clubs add constraint clubs_bono_organica_tipo_check CHECK ((bono_organica_tipo = ANY (ARRAY['fijo'::text, 'porcentaje'::text])));
alter table public.clubs add constraint clubs_comision_tipo_check CHECK ((comision_tipo = ANY (ARRAY['fijo'::text, 'porcentaje'::text])));
alter table public.clubs add constraint clubs_estado_verificacion_check CHECK ((estado_verificacion = ANY (ARRAY['borrador'::text, 'en_revision'::text, 'verificado'::text, 'rechazado'::text])));
alter table public.clubs add constraint clubs_pago_rp_modo_check CHECK ((pago_rp_modo = ANY (ARRAY['reserva'::text, 'dia'::text])));
alter table public.clubs add constraint clubs_pkey PRIMARY KEY (id);
alter table public.commissions add constraint commissions_pkey PRIMARY KEY (id);
alter table public.commissions add constraint commissions_reservation_id_key UNIQUE (reservation_id);
alter table public.commissions add constraint commissions_status_check CHECK ((status = ANY (ARRAY['pendiente'::text, 'en_revision'::text, 'validada'::text, 'pagada'::text, 'anulada'::text])));
alter table public.commissions add constraint commissions_tipo_check CHECK ((tipo = ANY (ARRAY['rp'::text, 'plataforma'::text])));
alter table public.consumption_entries add constraint consumption_entries_pkey PRIMARY KEY (id);
alter table public.profiles add constraint profiles_pkey1 PRIMARY KEY (id);
alter table public.profiles add constraint profiles_role_check CHECK ((role = ANY (ARRAY['cliente'::text, 'rp'::text, 'staff'::text, 'gerente'::text, 'admin'::text, 'dueno'::text])));
alter table public.reservations add constraint reservations_pkey PRIMARY KEY (id);
alter table public.reservations add constraint reservations_qr_code_key UNIQUE (qr_code);
alter table public.reservations add constraint reservations_source_check CHECK ((source = ANY (ARRAY['organica'::text, 'rp'::text])));
alter table public.reservations add constraint reservations_status_check CHECK ((status = ANY (ARRAY['pendiente'::text, 'confirmada'::text, 'usada'::text])));
alter table public.rp_attendance add constraint rp_attendance_metodo_check CHECK ((metodo = ANY (ARRAY['qr'::text, 'manual'::text])));
alter table public.rp_attendance add constraint rp_attendance_pkey PRIMARY KEY (id);
alter table public.rp_attendance add constraint rp_attendance_rp_id_fecha_key UNIQUE (rp_id, fecha);
alter table public.rp_comision_overrides add constraint rp_comision_overrides_club_id_rp_id_key UNIQUE (club_id, rp_id);
alter table public.rp_comision_overrides add constraint rp_comision_overrides_comision_desbloqueo_reservas_check CHECK ((comision_desbloqueo_reservas >= 0));
alter table public.rp_comision_overrides add constraint rp_comision_overrides_comision_monto_check CHECK ((comision_monto >= (0)::numeric));
alter table public.rp_comision_overrides add constraint rp_comision_overrides_comision_tipo_check CHECK ((comision_tipo = ANY (ARRAY['fijo'::text, 'porcentaje'::text])));
alter table public.rp_comision_overrides add constraint rp_comision_overrides_pkey PRIMARY KEY (id);
alter table public.rp_dia_tarifa_overrides add constraint rp_dia_tarifa_overrides_club_id_rp_id_posicion_key UNIQUE (club_id, rp_id, posicion);
alter table public.rp_dia_tarifa_overrides add constraint rp_dia_tarifa_overrides_monto_check CHECK ((monto >= (0)::numeric));
alter table public.rp_dia_tarifa_overrides add constraint rp_dia_tarifa_overrides_pkey PRIMARY KEY (id);
alter table public.rp_dia_tarifa_overrides add constraint rp_dia_tarifa_overrides_posicion_check CHECK ((posicion >= 1));
alter table public.rp_pagos_dia add constraint rp_pagos_dia_pkey PRIMARY KEY (id);
alter table public.rp_schedule add constraint rp_schedule_pkey PRIMARY KEY (id);
alter table public.rp_schedule add constraint rp_schedule_rp_club_fecha_key UNIQUE (rp_id, club_id, fecha);
alter table public.rp_schedule add constraint rp_schedule_rp_id_fecha_key UNIQUE (rp_id, fecha);
alter table public.verificacion_documentos add constraint verificacion_documentos_pkey PRIMARY KEY (id);
alter table public.verificacion_documentos add constraint verificacion_documentos_tipo_check CHECK ((tipo = ANY (ARRAY['comprobante_fiscal'::text, 'foto_local'::text, 'identificacion'::text])));
alter table public.club_dia_tarifas add constraint club_dia_tarifas_club_id_fkey FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE;
alter table public.club_photos add constraint club_photos_club_id_fkey FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE;
alter table public.club_tables add constraint club_tables_club_id_fkey FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE;
alter table public.clubs add constraint clubs_dueno_id_fkey FOREIGN KEY (dueno_id) REFERENCES profiles(id) ON DELETE SET NULL;
alter table public.commissions add constraint commissions_reservation_id_fkey FOREIGN KEY (reservation_id) REFERENCES reservations(id) ON DELETE CASCADE;
alter table public.commissions add constraint commissions_rp_id_fkey FOREIGN KEY (rp_id) REFERENCES profiles(id);
alter table public.consumption_entries add constraint consumption_entries_reservation_id_fkey FOREIGN KEY (reservation_id) REFERENCES reservations(id) ON DELETE CASCADE;
alter table public.profiles add constraint profiles_club_id_fkey FOREIGN KEY (club_id) REFERENCES clubs(id);
alter table public.profiles add constraint profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.reservations add constraint reservations_cliente_id_fkey FOREIGN KEY (cliente_id) REFERENCES profiles(id);
alter table public.reservations add constraint reservations_club_id_fkey FOREIGN KEY (club_id) REFERENCES clubs(id);
alter table public.reservations add constraint reservations_mesa_id_fkey FOREIGN KEY (mesa_id) REFERENCES club_tables(id);
alter table public.reservations add constraint reservations_rp_id_fkey FOREIGN KEY (rp_id) REFERENCES profiles(id) NOT VALID;
alter table public.rp_attendance add constraint rp_attendance_club_id_fkey FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE;
alter table public.rp_attendance add constraint rp_attendance_marcado_por_fkey FOREIGN KEY (marcado_por) REFERENCES profiles(id);
alter table public.rp_attendance add constraint rp_attendance_rp_id_fkey FOREIGN KEY (rp_id) REFERENCES profiles(id) ON DELETE CASCADE;
alter table public.rp_comision_overrides add constraint rp_comision_overrides_club_id_fkey FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE;
alter table public.rp_comision_overrides add constraint rp_comision_overrides_rp_id_fkey FOREIGN KEY (rp_id) REFERENCES profiles(id) ON DELETE CASCADE;
alter table public.rp_dia_tarifa_overrides add constraint rp_dia_tarifa_overrides_club_id_fkey FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE;
alter table public.rp_dia_tarifa_overrides add constraint rp_dia_tarifa_overrides_rp_id_fkey FOREIGN KEY (rp_id) REFERENCES profiles(id) ON DELETE CASCADE;
alter table public.rp_pagos_dia add constraint rp_pagos_dia_club_id_fkey FOREIGN KEY (club_id) REFERENCES clubs(id);
alter table public.rp_pagos_dia add constraint rp_pagos_dia_rp_attendance_id_fkey FOREIGN KEY (rp_attendance_id) REFERENCES rp_attendance(id) ON DELETE CASCADE;
alter table public.rp_pagos_dia add constraint rp_pagos_dia_rp_id_fkey FOREIGN KEY (rp_id) REFERENCES profiles(id);
alter table public.rp_schedule add constraint rp_schedule_club_id_fkey FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE;
alter table public.rp_schedule add constraint rp_schedule_rp_id_fkey FOREIGN KEY (rp_id) REFERENCES profiles(id) ON DELETE CASCADE;
alter table public.verificacion_documentos add constraint verificacion_documentos_club_id_fkey FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE;

-- ============================================================
-- Índices
-- ============================================================

-- ============================================================
-- Vistas
-- ============================================================

-- ============================================================
-- Row Level Security
-- ============================================================
alter table public.club_dia_tarifas enable row level security;
alter table public.club_photos enable row level security;
alter table public.club_tables enable row level security;
alter table public.clubs enable row level security;
alter table public.commissions enable row level security;
alter table public.consumption_entries enable row level security;
alter table public.profiles enable row level security;
alter table public.reservations enable row level security;
alter table public.rp_attendance enable row level security;
alter table public.rp_comision_overrides enable row level security;
alter table public.rp_dia_tarifa_overrides enable row level security;
alter table public.rp_pagos_dia enable row level security;
alter table public.rp_schedule enable row level security;
alter table public.verificacion_documentos enable row level security;

-- ============================================================
-- Políticas (public y storage.objects/buckets)
-- ============================================================
create policy club_dia_tarifas_delete_gerencia on public.club_dia_tarifas as permissive for delete to authenticated
  using ((((current_role_name() = ANY (ARRAY['dueno'::text, 'gerente'::text])) AND (club_id = current_club_id())) OR (current_role_name() = 'admin'::text)));
create policy club_dia_tarifas_insert_gerencia on public.club_dia_tarifas as permissive for insert to authenticated
  with check ((((current_role_name() = ANY (ARRAY['dueno'::text, 'gerente'::text])) AND (club_id = current_club_id())) OR (current_role_name() = 'admin'::text)));
create policy club_dia_tarifas_select_gerencia on public.club_dia_tarifas as permissive for select to authenticated
  using ((((current_role_name() = ANY (ARRAY['dueno'::text, 'gerente'::text])) AND (club_id = current_club_id())) OR (current_role_name() = 'admin'::text)));
create policy club_dia_tarifas_update_gerencia on public.club_dia_tarifas as permissive for update to authenticated
  using ((((current_role_name() = ANY (ARRAY['dueno'::text, 'gerente'::text])) AND (club_id = current_club_id())) OR (current_role_name() = 'admin'::text)))
  with check ((((current_role_name() = ANY (ARRAY['dueno'::text, 'gerente'::text])) AND (club_id = current_club_id())) OR (current_role_name() = 'admin'::text)));
create policy club_photos_delete_dueno on public.club_photos as permissive for delete to authenticated
  using (((EXISTS ( SELECT 1
   FROM clubs c
  WHERE ((c.id = club_photos.club_id) AND (c.dueno_id = auth.uid())))) OR (current_role_name() = 'admin'::text)));
create policy club_photos_insert_dueno on public.club_photos as permissive for insert to authenticated
  with check (((EXISTS ( SELECT 1
   FROM clubs c
  WHERE ((c.id = club_photos.club_id) AND (c.dueno_id = auth.uid())))) OR (current_role_name() = 'admin'::text)));
create policy club_photos_restrictiva_select_publicados on public.club_photos as restrictive for select to public
  using ((EXISTS ( SELECT 1
   FROM clubs c
  WHERE (c.id = club_photos.club_id))));
create policy club_photos_select_public on public.club_photos as permissive for select to anon, authenticated
  using (true);
create policy club_tables_delete_dueno on public.club_tables as permissive for delete to authenticated
  using ((((current_role_name() = 'dueno'::text) AND (club_id = current_club_id())) OR (current_role_name() = 'admin'::text)));
create policy club_tables_insert_dueno on public.club_tables as permissive for insert to authenticated
  with check ((((current_role_name() = 'dueno'::text) AND (club_id = current_club_id())) OR (current_role_name() = 'admin'::text)));
create policy club_tables_select_club_staff on public.club_tables as permissive for select to authenticated
  using ((((current_role_name() = ANY (ARRAY['staff'::text, 'gerente'::text, 'dueno'::text])) AND (club_id = current_club_id())) OR (current_role_name() = 'admin'::text)));
create policy "clubs insert dueno o admin" on public.clubs as permissive for insert to authenticated
  with check (((dueno_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))));
create policy "clubs select autenticado" on public.clubs as permissive for select to authenticated
  using (true);
create policy "clubs update dueno o admin" on public.clubs as permissive for update to authenticated
  using (((dueno_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))));
create policy clubs_restrictiva_select_publicados on public.clubs as restrictive for select to public
  using ((((estado_verificacion = 'verificado'::text) AND (suscripcion_activa = true)) OR (( SELECT current_role_name() AS current_role_name) = 'admin'::text) OR ((dueno_id IS NOT NULL) AND (dueno_id = ( SELECT auth.uid() AS uid))) OR ((( SELECT current_role_name() AS current_role_name) = ANY (ARRAY['staff'::text, 'gerente'::text, 'rp'::text])) AND (id = ( SELECT current_club_id() AS current_club_id)))));
create policy clubs_select_anon_verificados on public.clubs as permissive for select to anon
  using (((estado_verificacion = 'verificado'::text) AND (suscripcion_activa = true)));
create policy commissions_insert_club_staff on public.commissions as permissive for insert to authenticated
  with check ((EXISTS ( SELECT 1
   FROM reservations r
  WHERE ((r.id = commissions.reservation_id) AND (((current_role_name() = ANY (ARRAY['staff'::text, 'gerente'::text, 'dueno'::text])) AND (r.club_id = current_club_id())) OR (current_role_name() = 'admin'::text))))));
create policy commissions_restrictiva_insert on public.commissions as restrictive for insert to public
  with check (((( SELECT current_role_name() AS current_role_name) = 'admin'::text) OR ((tipo = 'plataforma'::text) AND (rp_id IS NULL) AND (status = 'pendiente'::text) AND (EXISTS ( SELECT 1
   FROM reservations r
  WHERE ((r.id = commissions.reservation_id) AND (r.source = 'organica'::text)))))));
create policy commissions_restrictiva_select_sin_staff on public.commissions as restrictive for select to public
  using ((( SELECT current_role_name() AS current_role_name) IS DISTINCT FROM 'staff'::text));
create policy commissions_select_club_staff on public.commissions as permissive for select to authenticated
  using ((EXISTS ( SELECT 1
   FROM reservations r
  WHERE ((r.id = commissions.reservation_id) AND (((current_role_name() = ANY (ARRAY['staff'::text, 'gerente'::text, 'dueno'::text])) AND (r.club_id = current_club_id())) OR (current_role_name() = 'admin'::text))))));
create policy commissions_select_rp_own on public.commissions as permissive for select to authenticated
  using ((rp_id = auth.uid()));
create policy consumption_entries_insert_club_staff on public.consumption_entries as permissive for insert to authenticated
  with check ((EXISTS ( SELECT 1
   FROM reservations r
  WHERE ((r.id = consumption_entries.reservation_id) AND (((current_role_name() = ANY (ARRAY['staff'::text, 'gerente'::text, 'dueno'::text])) AND (r.club_id = current_club_id())) OR (current_role_name() = 'admin'::text))))));
create policy consumption_entries_select_club_staff on public.consumption_entries as permissive for select to authenticated
  using ((EXISTS ( SELECT 1
   FROM reservations r
  WHERE ((r.id = consumption_entries.reservation_id) AND (((current_role_name() = ANY (ARRAY['staff'::text, 'gerente'::text, 'dueno'::text])) AND (r.club_id = current_club_id())) OR (current_role_name() = 'admin'::text))))));
create policy profiles_insert_propio on public.profiles as permissive for insert to authenticated
  with check (((id = ( SELECT auth.uid() AS uid)) AND (role = ANY (ARRAY['cliente'::text, 'dueno'::text]))));
create policy profiles_select_admin on public.profiles as permissive for select to authenticated
  using ((( SELECT current_role_name() AS current_role_name) = 'admin'::text));
create policy profiles_select_mismo_club on public.profiles as permissive for select to authenticated
  using (((club_id IS NOT NULL) AND (club_id = ( SELECT current_club_id() AS current_club_id)) AND (( SELECT current_role_name() AS current_role_name) = ANY (ARRAY['staff'::text, 'gerente'::text, 'dueno'::text]))));
create policy profiles_select_propio on public.profiles as permissive for select to authenticated
  using ((id = ( SELECT auth.uid() AS uid)));
create policy profiles_update_admin on public.profiles as permissive for update to authenticated
  using ((( SELECT current_role_name() AS current_role_name) = 'admin'::text))
  with check ((( SELECT current_role_name() AS current_role_name) = 'admin'::text));
create policy profiles_update_mismo_club on public.profiles as permissive for update to authenticated
  using (((club_id IS NOT NULL) AND (club_id = ( SELECT current_club_id() AS current_club_id)) AND (( SELECT current_role_name() AS current_role_name) = ANY (ARRAY['staff'::text, 'gerente'::text, 'dueno'::text]))))
  with check (((club_id IS NOT NULL) AND (club_id = ( SELECT current_club_id() AS current_club_id)) AND (( SELECT current_role_name() AS current_role_name) = ANY (ARRAY['staff'::text, 'gerente'::text, 'dueno'::text]))));
create policy profiles_update_propio on public.profiles as permissive for update to authenticated
  using ((id = ( SELECT auth.uid() AS uid)))
  with check ((id = ( SELECT auth.uid() AS uid)));
create policy reservations_insert_anonimo on public.reservations as permissive for insert to anon
  with check (((club_id IS NOT NULL) AND (source = 'organica'::text) AND (rp_id IS NULL) AND (cliente_id IS NULL) AND (status = 'pendiente'::text) AND (consumo_monto IS NULL) AND (mesa_id IS NULL) AND (COALESCE(se_retiro_sin_consumir, false) = false) AND ((personas >= 1) AND (personas <= 20)) AND (fecha >= ((now() AT TIME ZONE 'America/Mexico_City'::text))::date)));
create policy reservations_insert_cliente_logueado on public.reservations as permissive for insert to authenticated
  with check (((club_id IS NOT NULL) AND (source = 'organica'::text) AND (rp_id IS NULL) AND (cliente_id = ( SELECT auth.uid() AS uid)) AND (( SELECT current_role_name() AS current_role_name) = 'cliente'::text) AND (status = 'pendiente'::text) AND (consumo_monto IS NULL) AND (mesa_id IS NULL) AND (COALESCE(se_retiro_sin_consumir, false) = false) AND ((personas >= 1) AND (personas <= 20)) AND (fecha >= ((now() AT TIME ZONE 'America/Mexico_City'::text))::date)));
create policy reservations_insert_rp on public.reservations as permissive for insert to authenticated
  with check (((source = 'rp'::text) AND (rp_id = auth.uid()) AND (cliente_id IS NULL) AND (current_role_name() = 'rp'::text)));
create policy reservations_select_admin on public.reservations as permissive for select to authenticated
  using ((current_role_name() = 'admin'::text));
create policy reservations_select_cliente_own on public.reservations as permissive for select to authenticated
  using ((cliente_id = auth.uid()));
create policy reservations_select_club_staff on public.reservations as permissive for select to authenticated
  using (((current_role_name() = ANY (ARRAY['staff'::text, 'gerente'::text, 'dueno'::text])) AND (club_id = current_club_id())));
create policy reservations_select_rp_own on public.reservations as permissive for select to authenticated
  using ((rp_id = auth.uid()));
create policy reservations_update_club_staff on public.reservations as permissive for update to authenticated
  using (((current_role_name() = ANY (ARRAY['staff'::text, 'gerente'::text, 'dueno'::text])) AND (club_id = current_club_id())))
  with check (((current_role_name() = ANY (ARRAY['staff'::text, 'gerente'::text, 'dueno'::text])) AND (club_id = current_club_id())));
create policy rp_attendance_insert on public.rp_attendance as permissive for insert to authenticated
  with check (((current_role_name() = ANY (ARRAY['staff'::text, 'gerente'::text, 'dueno'::text])) AND (club_id = current_club_id())));
create policy rp_attendance_select on public.rp_attendance as permissive for select to authenticated
  using (((rp_id = auth.uid()) OR ((current_role_name() = ANY (ARRAY['staff'::text, 'gerente'::text, 'dueno'::text])) AND (club_id = current_club_id())) OR (current_role_name() = 'admin'::text)));
create policy rp_comision_overrides_delete on public.rp_comision_overrides as permissive for delete to public
  using (((current_role_name() = 'admin'::text) OR ((current_role_name() = ANY (ARRAY['dueno'::text, 'gerente'::text])) AND (current_club_id() = club_id))));
create policy rp_comision_overrides_insert on public.rp_comision_overrides as permissive for insert to public
  with check (((current_role_name() = 'admin'::text) OR ((current_role_name() = ANY (ARRAY['dueno'::text, 'gerente'::text])) AND (current_club_id() = club_id))));
create policy rp_comision_overrides_select on public.rp_comision_overrides as permissive for select to public
  using (((rp_id = auth.uid()) OR (current_role_name() = 'admin'::text) OR ((current_role_name() = ANY (ARRAY['dueno'::text, 'gerente'::text])) AND (current_club_id() = club_id))));
create policy rp_comision_overrides_update on public.rp_comision_overrides as permissive for update to public
  using (((current_role_name() = 'admin'::text) OR ((current_role_name() = ANY (ARRAY['dueno'::text, 'gerente'::text])) AND (current_club_id() = club_id))));
create policy rp_dia_tarifa_overrides_delete on public.rp_dia_tarifa_overrides as permissive for delete to public
  using (((current_role_name() = 'admin'::text) OR ((current_role_name() = ANY (ARRAY['dueno'::text, 'gerente'::text])) AND (current_club_id() = club_id))));
create policy rp_dia_tarifa_overrides_insert on public.rp_dia_tarifa_overrides as permissive for insert to public
  with check (((current_role_name() = 'admin'::text) OR ((current_role_name() = ANY (ARRAY['dueno'::text, 'gerente'::text])) AND (current_club_id() = club_id))));
create policy rp_dia_tarifa_overrides_select on public.rp_dia_tarifa_overrides as permissive for select to public
  using (((current_role_name() = 'admin'::text) OR ((current_role_name() = ANY (ARRAY['dueno'::text, 'gerente'::text])) AND (current_club_id() = club_id))));
create policy rp_dia_tarifa_overrides_update on public.rp_dia_tarifa_overrides as permissive for update to public
  using (((current_role_name() = 'admin'::text) OR ((current_role_name() = ANY (ARRAY['dueno'::text, 'gerente'::text])) AND (current_club_id() = club_id))));
create policy rp_pagos_dia_insert_club_staff on public.rp_pagos_dia as permissive for insert to authenticated
  with check ((((current_role_name() = ANY (ARRAY['staff'::text, 'gerente'::text, 'dueno'::text])) AND (club_id = current_club_id())) OR (current_role_name() = 'admin'::text)));
create policy rp_pagos_dia_restrictiva_insert on public.rp_pagos_dia as restrictive for insert to public
  with check ((( SELECT current_role_name() AS current_role_name) = 'admin'::text));
create policy rp_pagos_dia_select_gerencia on public.rp_pagos_dia as permissive for select to authenticated
  using ((((current_role_name() = ANY (ARRAY['dueno'::text, 'gerente'::text])) AND (club_id = current_club_id())) OR (current_role_name() = 'admin'::text)));
create policy rp_pagos_dia_select_propio on public.rp_pagos_dia as permissive for select to authenticated
  using ((rp_id = auth.uid()));
create policy rp_schedule_delete on public.rp_schedule as permissive for delete to authenticated
  using (((current_role_name() = ANY (ARRAY['staff'::text, 'gerente'::text, 'dueno'::text])) AND (club_id = current_club_id())));
create policy rp_schedule_insert on public.rp_schedule as permissive for insert to authenticated
  with check (((current_role_name() = ANY (ARRAY['staff'::text, 'gerente'::text, 'dueno'::text])) AND (club_id = current_club_id())));
create policy rp_schedule_select on public.rp_schedule as permissive for select to authenticated
  using (((rp_id = auth.uid()) OR ((current_role_name() = ANY (ARRAY['staff'::text, 'gerente'::text, 'dueno'::text])) AND (club_id = current_club_id())) OR (current_role_name() = 'admin'::text)));
create policy verif_docs_delete on public.verificacion_documentos as permissive for delete to authenticated
  using ((EXISTS ( SELECT 1
   FROM clubs c
  WHERE ((c.id = verificacion_documentos.club_id) AND (c.dueno_id = ( SELECT auth.uid() AS uid))))));
create policy verif_docs_insert on public.verificacion_documentos as permissive for insert to authenticated
  with check ((EXISTS ( SELECT 1
   FROM clubs c
  WHERE ((c.id = verificacion_documentos.club_id) AND (c.dueno_id = ( SELECT auth.uid() AS uid))))));
create policy verif_docs_select on public.verificacion_documentos as permissive for select to authenticated
  using (((EXISTS ( SELECT 1
   FROM clubs c
  WHERE ((c.id = verificacion_documentos.club_id) AND (c.dueno_id = ( SELECT auth.uid() AS uid))))) OR (( SELECT current_role_name() AS current_role_name) = 'admin'::text)));
create policy verificacion_documentos_restrictiva_delete on public.verificacion_documentos as restrictive for delete to public
  using ((( SELECT current_role_name() AS current_role_name) = 'admin'::text));
drop policy if exists club_photos_restrictiva_delete on storage.objects;
create policy club_photos_restrictiva_delete on storage.objects as restrictive for delete to public
  using (((bucket_id <> 'club-photos'::text) OR (( SELECT current_role_name() AS current_role_name) = 'admin'::text) OR ((storage.foldername(name))[1] IN ( SELECT (c.id)::text AS id
   FROM clubs c
  WHERE (c.dueno_id = ( SELECT auth.uid() AS uid))))));
drop policy if exists club_photos_restrictiva_insert on storage.objects;
create policy club_photos_restrictiva_insert on storage.objects as restrictive for insert to public
  with check (((bucket_id <> 'club-photos'::text) OR (( SELECT current_role_name() AS current_role_name) = 'admin'::text) OR ((storage.foldername(name))[1] IN ( SELECT (c.id)::text AS id
   FROM clubs c
  WHERE (c.dueno_id = ( SELECT auth.uid() AS uid))))));
drop policy if exists club_photos_restrictiva_update on storage.objects;
create policy club_photos_restrictiva_update on storage.objects as restrictive for update to public
  using (((bucket_id <> 'club-photos'::text) OR (( SELECT current_role_name() AS current_role_name) = 'admin'::text) OR ((storage.foldername(name))[1] IN ( SELECT (c.id)::text AS id
   FROM clubs c
  WHERE (c.dueno_id = ( SELECT auth.uid() AS uid))))))
  with check (((bucket_id <> 'club-photos'::text) OR (( SELECT current_role_name() AS current_role_name) = 'admin'::text) OR ((storage.foldername(name))[1] IN ( SELECT (c.id)::text AS id
   FROM clubs c
  WHERE (c.dueno_id = ( SELECT auth.uid() AS uid))))));
drop policy if exists club_photos_storage_delete_open on storage.objects;
create policy club_photos_storage_delete_open on storage.objects as permissive for delete to public
  using ((bucket_id = 'club-photos'::text));
drop policy if exists club_photos_storage_insert_open on storage.objects;
create policy club_photos_storage_insert_open on storage.objects as permissive for insert to public
  with check ((bucket_id = 'club-photos'::text));
drop policy if exists club_photos_storage_select_public on storage.objects;
create policy club_photos_storage_select_public on storage.objects as permissive for select to public
  using ((bucket_id = 'club-photos'::text));
drop policy if exists verificacion_docs_delete_dueno on storage.objects;
create policy verificacion_docs_delete_dueno on storage.objects as permissive for delete to authenticated
  using (((bucket_id = 'verificacion-docs'::text) AND ((storage.foldername(name))[1] IN ( SELECT (c.id)::text AS id
   FROM clubs c
  WHERE (c.dueno_id = ( SELECT auth.uid() AS uid))))));
drop policy if exists verificacion_docs_insert_dueno on storage.objects;
create policy verificacion_docs_insert_dueno on storage.objects as permissive for insert to authenticated
  with check (((bucket_id = 'verificacion-docs'::text) AND ((storage.foldername(name))[1] IN ( SELECT (c.id)::text AS id
   FROM clubs c
  WHERE (c.dueno_id = ( SELECT auth.uid() AS uid))))));
drop policy if exists verificacion_docs_restrictiva on storage.objects;
create policy verificacion_docs_restrictiva on storage.objects as restrictive for all to public
  using (((bucket_id <> 'verificacion-docs'::text) OR (( SELECT current_role_name() AS current_role_name) = 'admin'::text) OR ((storage.foldername(name))[1] IN ( SELECT (c.id)::text AS id
   FROM clubs c
  WHERE (c.dueno_id = ( SELECT auth.uid() AS uid))))))
  with check (((bucket_id <> 'verificacion-docs'::text) OR (( SELECT current_role_name() AS current_role_name) = 'admin'::text) OR ((storage.foldername(name))[1] IN ( SELECT (c.id)::text AS id
   FROM clubs c
  WHERE (c.dueno_id = ( SELECT auth.uid() AS uid))))));
drop policy if exists verificacion_docs_select_admin on storage.objects;
create policy verificacion_docs_select_admin on storage.objects as permissive for select to authenticated
  using (((bucket_id = 'verificacion-docs'::text) AND (( SELECT current_role_name() AS current_role_name) = 'admin'::text)));
drop policy if exists verificacion_docs_select_dueno on storage.objects;
create policy verificacion_docs_select_dueno on storage.objects as permissive for select to authenticated
  using (((bucket_id = 'verificacion-docs'::text) AND ((storage.foldername(name))[1] IN ( SELECT (c.id)::text AS id
   FROM clubs c
  WHERE (c.dueno_id = ( SELECT auth.uid() AS uid))))));

-- ============================================================
-- Triggers (public, y los de auth/storage que llaman funciones de public)
-- ============================================================
CREATE TRIGGER clubs_candado_bono BEFORE UPDATE ON public.clubs FOR EACH ROW EXECUTE FUNCTION clubs_candado_bono();
CREATE TRIGGER clubs_candado_insert BEFORE INSERT ON public.clubs FOR EACH ROW EXECUTE FUNCTION clubs_candado_insert();
CREATE TRIGGER clubs_candado_verificacion BEFORE UPDATE ON public.clubs FOR EACH ROW EXECUTE FUNCTION clubs_candado_verificacion();
CREATE TRIGGER profiles_no_escalar BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION profiles_bloquear_cambio_privilegios();

-- ============================================================
-- Permisos (GRANT explícitos; en dev no hay exposición automática)
-- ============================================================
grant usage on schema public to anon;
grant usage on schema public to authenticated;
grant usage on schema public to service_role;
grant usage on schema storage to anon;
grant usage on schema storage to authenticated;
grant usage on schema storage to service_role;
revoke all on table public.club_dia_tarifas from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.club_dia_tarifas to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.club_dia_tarifas to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.club_dia_tarifas to service_role;
revoke all on table public.club_photos from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.club_photos to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.club_photos to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.club_photos to service_role;
revoke all on table public.club_tables from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.club_tables to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.club_tables to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.club_tables to service_role;
revoke all on table public.clubs from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.clubs to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.clubs to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.clubs to service_role;
revoke all on table public.commissions from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.commissions to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.commissions to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.commissions to service_role;
revoke all on table public.consumption_entries from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.consumption_entries to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.consumption_entries to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.consumption_entries to service_role;
revoke all on table public.profiles from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.profiles to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.profiles to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.profiles to service_role;
revoke all on table public.reservations from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.reservations to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.reservations to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.reservations to service_role;
revoke all on table public.rp_attendance from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.rp_attendance to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.rp_attendance to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.rp_attendance to service_role;
revoke all on table public.rp_comision_overrides from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.rp_comision_overrides to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.rp_comision_overrides to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.rp_comision_overrides to service_role;
revoke all on table public.rp_dia_tarifa_overrides from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.rp_dia_tarifa_overrides to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.rp_dia_tarifa_overrides to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.rp_dia_tarifa_overrides to service_role;
revoke all on table public.rp_pagos_dia from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.rp_pagos_dia to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.rp_pagos_dia to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.rp_pagos_dia to service_role;
revoke all on table public.rp_schedule from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.rp_schedule to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.rp_schedule to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.rp_schedule to service_role;
revoke all on table public.verificacion_documentos from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.verificacion_documentos to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.verificacion_documentos to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.verificacion_documentos to service_role;
revoke all on function public.clubs_candado_bono() from public, anon, authenticated, service_role;
grant execute on function public.clubs_candado_bono() to anon;
grant execute on function public.clubs_candado_bono() to authenticated;
grant execute on function public.clubs_candado_bono() to public;
grant execute on function public.clubs_candado_bono() to service_role;
revoke all on function public.clubs_candado_insert() from public, anon, authenticated, service_role;
grant execute on function public.clubs_candado_insert() to anon;
grant execute on function public.clubs_candado_insert() to authenticated;
grant execute on function public.clubs_candado_insert() to public;
grant execute on function public.clubs_candado_insert() to service_role;
revoke all on function public.clubs_candado_verificacion() from public, anon, authenticated, service_role;
grant execute on function public.clubs_candado_verificacion() to anon;
grant execute on function public.clubs_candado_verificacion() to authenticated;
grant execute on function public.clubs_candado_verificacion() to public;
grant execute on function public.clubs_candado_verificacion() to service_role;
revoke all on function public.current_club_id() from public, anon, authenticated, service_role;
grant execute on function public.current_club_id() to anon;
grant execute on function public.current_club_id() to authenticated;
grant execute on function public.current_club_id() to public;
grant execute on function public.current_club_id() to service_role;
revoke all on function public.current_role_name() from public, anon, authenticated, service_role;
grant execute on function public.current_role_name() to anon;
grant execute on function public.current_role_name() to authenticated;
grant execute on function public.current_role_name() to public;
grant execute on function public.current_role_name() to service_role;
revoke all on function public.obtener_reserva_por_qr(p_qr text) from public, anon, authenticated, service_role;
grant execute on function public.obtener_reserva_por_qr(p_qr text) to anon;
grant execute on function public.obtener_reserva_por_qr(p_qr text) to authenticated;
grant execute on function public.obtener_reserva_por_qr(p_qr text) to service_role;
revoke all on function public.profiles_bloquear_cambio_privilegios() from public, anon, authenticated, service_role;
grant execute on function public.profiles_bloquear_cambio_privilegios() to anon;
grant execute on function public.profiles_bloquear_cambio_privilegios() to authenticated;
grant execute on function public.profiles_bloquear_cambio_privilegios() to public;
grant execute on function public.profiles_bloquear_cambio_privilegios() to service_role;
revoke all on function public.registrar_comision_reserva(p_reservation_id uuid, p_rp_id uuid, p_club_id uuid, p_consumo_monto numeric, p_week_start timestamp with time zone, p_week_end timestamp with time zone) from public, anon, authenticated, service_role;
grant execute on function public.registrar_comision_reserva(p_reservation_id uuid, p_rp_id uuid, p_club_id uuid, p_consumo_monto numeric, p_week_start timestamp with time zone, p_week_end timestamp with time zone) to anon;
grant execute on function public.registrar_comision_reserva(p_reservation_id uuid, p_rp_id uuid, p_club_id uuid, p_consumo_monto numeric, p_week_start timestamp with time zone, p_week_end timestamp with time zone) to authenticated;
grant execute on function public.registrar_comision_reserva(p_reservation_id uuid, p_rp_id uuid, p_club_id uuid, p_consumo_monto numeric, p_week_start timestamp with time zone, p_week_end timestamp with time zone) to service_role;
revoke all on function public.registrar_pago_dia(p_rp_attendance_id uuid, p_rp_id uuid, p_club_id uuid, p_fecha date, p_week_start timestamp with time zone, p_week_end timestamp with time zone) from public, anon, authenticated, service_role;
grant execute on function public.registrar_pago_dia(p_rp_attendance_id uuid, p_rp_id uuid, p_club_id uuid, p_fecha date, p_week_start timestamp with time zone, p_week_end timestamp with time zone) to anon;
grant execute on function public.registrar_pago_dia(p_rp_attendance_id uuid, p_rp_id uuid, p_club_id uuid, p_fecha date, p_week_start timestamp with time zone, p_week_end timestamp with time zone) to authenticated;
grant execute on function public.registrar_pago_dia(p_rp_attendance_id uuid, p_rp_id uuid, p_club_id uuid, p_fecha date, p_week_start timestamp with time zone, p_week_end timestamp with time zone) to service_role;
revoke all on function public.rls_auto_enable() from public, anon, authenticated, service_role;
grant execute on function public.rls_auto_enable() to anon;
grant execute on function public.rls_auto_enable() to authenticated;
grant execute on function public.rls_auto_enable() to public;
grant execute on function public.rls_auto_enable() to service_role;

-- ============================================================
-- Buckets de Storage
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values ('club-photos', 'club-photos', true, null, null) on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values ('verificacion-docs', 'verificacion-docs', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']) on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- ============================================================
-- Publicación de realtime
-- ============================================================

-- ============================================================
-- Event triggers (que llaman funciones de public)
-- ============================================================
drop event trigger if exists ensure_rls;
create event trigger ensure_rls on ddl_command_end when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO') execute function public.rls_auto_enable();

-- Resumen: {"extensiones":5,"enums":0,"funciones":10,"tablas":14,"columnas":117,"restricciones":65,"indices":0,"vistas":0,"politicas":70,"triggers":4,"buckets":2,"event_triggers":1,"tablas_con_rls":14}
