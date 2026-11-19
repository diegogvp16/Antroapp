-- ============================================================================
-- AntroApp — Caja por mesa, puerta, cuenta de grupo y nómina
-- Fecha: 2026-11-20 (diseño del 12/11/2026 en docs/caja-por-mesa.md)
-- Estado: APLICADO Y PROBADO EN DEV (antroapp-dev). En producción NO, hasta
-- el pase del bloque 6, con su rollback (sql/2026-11-20-caja-por-mesa-rollback.sql).
--
-- Se aplica COMPLETO en una sola transacción (scripts/db/aplicar-dev.mjs lo
-- hace en dev; en el SQL Editor, pegar todo con begin/commit alrededor).
-- Las verificaciones de lectura que tenía el borrador se pasaron a pruebas
-- con sesiones reales: scripts/dev/probar-caja.mjs.
--
-- Principios:
--   * Dinero nuevo en centavos (bigint). commissions.monto sigue en pesos.
--   * Ninguna tabla de caja tiene políticas de escritura: todo pasa por
--     funciones SECURITY DEFINER que revisan el permiso en la base.
--   * Club, mesa, reserva, RP, noche, totales y comisiones los decide la
--     base, nunca el navegador.
--   * Nada se borra: consumos y pagos se anulan con motivo. Un trigger
--     (bloque 6B) impide DELETE/TRUNCATE en la caja y que un consumo o pago
--     cambie su monto; solo se puede anular, una vez y con motivo.
--   * GRANT explícitos en cada tabla nueva (en dev no hay exposición
--     automática de tablas; en producción la hay, y aquí se revoca).
--   * Lectura y permisos centralizados en caja_puede_ver(),
--     caja_tiene_permiso() y puede_ver_club(): la cuenta de grupo (y lo que
--     venga) se suma reemplazando esas funciones, sin tocar políticas.
--   * Fechas en la zona horaria de cada antro (clubs.zona_horaria), nunca
--     en una zona fija: todo pasa por club_fecha_operacion().
--   * Sin bono de plataforma: clubs.bono_organica_* se conservan sin usar.
--   * La comisión de RP respeta la configuración actual del antro.
--   * La app NO cobra nada a los clientes: no hay depósito, ni reembolso,
--     ni crédito, ni retención. caja_pagos es lo que el ANTRO cobra en su
--     mesa (efectivo, tarjeta), no un cobro de la app.
--
-- Orden: 1A–15 caja nueva; 17–18 cambian políticas existentes (clubs y
-- reserva anónima); 19–24 puerta y nómina. El 21 (candado de reservations)
-- exige que el código del staff ya use puerta_escanear/puerta_confirmar_entrada.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- BLOQUE 1A — Zona horaria por antro.
-- Cada antro tiene su zona IANA (por ejemplo 'America/Tijuana',
-- 'America/Cancun'). Noche operativa, corte de las 08:00, semana de
-- comisiones y reportes se calculan con ella, no con una zona fija.
-- Candado (decisión 11): solo el admin la cambia; un antro creado por un no
-- admin nace con la zona por defecto (como hace clubs_candado_insert con el
-- bono). Cambiarla con noches ya registradas mueve los cortes futuros, no
-- los pasados (fecha_operacion queda guardada en caja_noches).
-- ----------------------------------------------------------------------------
alter table public.clubs
  add column zona_horaria text not null default 'America/Mexico_City';

create or replace function public.clubs_candado_zona_horaria()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(public.current_role_name(), '') <> 'admin' and auth.uid() is not null then
    if tg_op = 'INSERT' then
      new.zona_horaria := 'America/Mexico_City';
    elsif new.zona_horaria is distinct from old.zona_horaria then
      raise exception 'Solo el admin cambia la zona horaria del antro';
    end if;
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.zona_horaria) then
    raise exception 'Zona horaria inválida: %', new.zona_horaria;
  end if;
  return new;
end;
$$;

create trigger clubs_candado_zona_horaria
  before insert or update of zona_horaria on public.clubs
  for each row execute function public.clubs_candado_zona_horaria();


-- ----------------------------------------------------------------------------
-- BLOQUE 1B — Fecha operativa de la noche en la zona del antro.
-- La noche pertenece al día en que empieza: corte a las 08:00 locales (lo
-- que pasa de 00:00 a 07:59 cuenta para el día anterior). El corte vive
-- solo aquí; si algún día es por antro, se agrega una columna y se lee aquí.
-- ----------------------------------------------------------------------------
create or replace function public.club_fecha_operacion(p_club_id uuid, p_momento timestamptz default now())
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select ((p_momento at time zone c.zona_horaria) - interval '8 hours')::date
  from public.clubs c
  where c.id = p_club_id;
$$;


-- ----------------------------------------------------------------------------
-- BLOQUE 1C — Puerta: tolerancia por antro y estado de puerta en la reserva.
-- Escanear el QR marca "en puerta"; "Confirmar entrada" es el check-in y pone
-- reservations.status = 'usada' (lo que hoy ya significa check-in en todo el
-- código). Si el antro no deja pasar a alguien, simplemente no se confirma:
-- no hay "no entra", ni motivos, ni nada que registrar.
-- se_retiro_sin_consumir se reutiliza igual, pero solo aplica tras entrar.
-- ----------------------------------------------------------------------------

-- Hora local límite de llegada. Nula = apagada (por defecto): nadie se marca
-- tarde. Si es menor a 08:00 se entiende de madrugada (después de medianoche).
alter table public.clubs
  add column tolerancia_hora time;

alter table public.reservations
  add column puerta_estado  text check (puerta_estado in ('en_puerta', 'entro')),
  add column en_puerta_en   timestamptz,
  add column en_puerta_por  uuid references public.profiles (id),
  add column entrada_en     timestamptz,   -- hora real de entrada; no penaliza por sí sola
  add column entrada_por    uuid references public.profiles (id),
  add column llegada_tarde  boolean;       -- solo se llena si el antro tiene tolerancia_hora


-- ----------------------------------------------------------------------------
-- BLOQUE 2 — Tablas: noches, sesiones de mesa y cuentas.
-- ----------------------------------------------------------------------------
create table public.caja_noches (
  id               uuid primary key default gen_random_uuid(),
  club_id          uuid not null references public.clubs (id),
  fecha_operacion  date not null,
  estado           text not null default 'abierta' check (estado in ('abierta', 'cerrada')),
  abierta_por      uuid references public.profiles (id),
  abierta_en       timestamptz not null default now(),
  cerrada_por      uuid references public.profiles (id),
  cerrada_en       timestamptz,
  unique (club_id, fecha_operacion)
);

create table public.mesa_sesiones (
  id            uuid primary key default gen_random_uuid(),
  club_id       uuid not null references public.clubs (id),
  noche_id      uuid not null references public.caja_noches (id),
  mesa_id       uuid not null references public.club_tables (id),
  estado        text not null default 'abierta' check (estado in ('abierta', 'cerrada', 'cuadrada')),
  abierta_por   uuid references public.profiles (id),
  abierta_en    timestamptz not null default now(),
  cerrada_por   uuid references public.profiles (id),
  cerrada_en    timestamptz,
  cuadrada_por  uuid references public.profiles (id),
  cuadrada_en   timestamptz
);
-- Una sola sesión abierta por mesa a la vez.
create unique index mesa_sesiones_una_abierta on public.mesa_sesiones (mesa_id) where estado = 'abierta';
create index mesa_sesiones_noche on public.mesa_sesiones (noche_id);

create table public.mesa_cuentas (
  id              uuid primary key default gen_random_uuid(),
  club_id         uuid not null references public.clubs (id),
  sesion_id       uuid not null references public.mesa_sesiones (id),
  reservation_id  uuid references public.reservations (id),
  rp_id           uuid references public.profiles (id),
  origen          text not null check (origen in ('reserva', 'walk_in')),
  cliente_nombre  text not null check (char_length(cliente_nombre) between 1 and 120),
  personas        int check (personas between 1 and 50),
  creada_por      uuid references public.profiles (id),
  creada_en       timestamptz not null default now(),
  liquidada_en    timestamptz,
  check ((origen = 'reserva') = (reservation_id is not null))
);
-- Una reserva se sienta en una sola cuenta.
create unique index mesa_cuentas_reserva_unica on public.mesa_cuentas (reservation_id) where reservation_id is not null;
create index mesa_cuentas_sesion on public.mesa_cuentas (sesion_id);


-- ----------------------------------------------------------------------------
-- BLOQUE 3 — Tablas: consumos, pagos y cuadres.
-- ----------------------------------------------------------------------------
create table public.caja_consumos (
  id                uuid primary key default gen_random_uuid(),
  club_id           uuid not null references public.clubs (id),
  noche_id          uuid not null references public.caja_noches (id),
  sesion_id         uuid not null references public.mesa_sesiones (id),
  mesa_id           uuid not null references public.club_tables (id),
  cuenta_id         uuid not null references public.mesa_cuentas (id),
  reservation_id    uuid references public.reservations (id),
  rp_id             uuid references public.profiles (id),
  monto_centavos    bigint not null check (monto_centavos between 1 and 100000000),
  concepto          text check (char_length(concepto) <= 120),
  registrado_por    uuid not null references public.profiles (id),
  registrado_en     timestamptz not null default now(),
  anulado           boolean not null default false,
  anulado_por       uuid references public.profiles (id),
  anulado_en        timestamptz,
  motivo_anulacion  text check (char_length(motivo_anulacion) <= 300),
  check (not anulado or (anulado_por is not null and motivo_anulacion is not null))
);
create index caja_consumos_cuenta on public.caja_consumos (cuenta_id);
create index caja_consumos_sesion on public.caja_consumos (sesion_id);

create table public.caja_pagos (
  id                uuid primary key default gen_random_uuid(),
  club_id           uuid not null references public.clubs (id),
  noche_id          uuid not null references public.caja_noches (id),
  sesion_id         uuid not null references public.mesa_sesiones (id),
  cuenta_id         uuid references public.mesa_cuentas (id),  -- nulo = pago de la mesa
  metodo            text not null check (metodo in ('efectivo', 'tarjeta', 'otro')),
  monto_centavos    bigint not null check (monto_centavos between 1 and 100000000),
  referencia        text check (char_length(referencia) <= 120),
  registrado_por    uuid not null references public.profiles (id),
  registrado_en     timestamptz not null default now(),
  anulado           boolean not null default false,
  anulado_por       uuid references public.profiles (id),
  anulado_en        timestamptz,
  motivo_anulacion  text check (char_length(motivo_anulacion) <= 300),
  check (not anulado or (anulado_por is not null and motivo_anulacion is not null))
);
create index caja_pagos_sesion on public.caja_pagos (sesion_id);

create table public.caja_cuadres (
  id                          uuid primary key default gen_random_uuid(),
  club_id                     uuid not null references public.clubs (id),
  noche_id                    uuid not null references public.caja_noches (id),
  sesion_id                   uuid references public.mesa_sesiones (id),
  tipo                        text not null check (tipo in ('mesa', 'noche')),
  registrado_centavos         bigint not null,  -- consumos vigentes
  cobrado_efectivo_centavos   bigint not null,
  cobrado_tarjeta_centavos    bigint not null,
  cobrado_otro_centavos       bigint not null,
  saldo_sin_cobrar_centavos   bigint not null,  -- registrado - cobrado
  contado_efectivo_centavos   bigint check (contado_efectivo_centavos >= 0),  -- solo noche
  contado_tarjeta_centavos    bigint check (contado_tarjeta_centavos >= 0),
  contado_otro_centavos       bigint check (contado_otro_centavos >= 0),
  diferencia_centavos         bigint,           -- contado - cobrado (solo noche)
  notas                       text check (char_length(notas) <= 500),
  hecho_por                   uuid not null references public.profiles (id),
  hecho_en                    timestamptz not null default now(),
  check ((tipo = 'mesa') = (sesion_id is not null))
);
create unique index caja_cuadres_uno_por_mesa on public.caja_cuadres (sesion_id) where tipo = 'mesa';
create unique index caja_cuadres_uno_por_noche on public.caja_cuadres (noche_id) where tipo = 'noche';


-- ----------------------------------------------------------------------------
-- BLOQUE 4 — Tablas: permisos (casillas) y bitácora.
-- ----------------------------------------------------------------------------
create table public.caja_permisos (
  id              uuid primary key default gen_random_uuid(),
  club_id         uuid not null references public.clubs (id),
  permiso         text not null check (permiso in (
                    'puerta',
                    'abrir_mesa', 'registrar_consumo', 'cobrar', 'cerrar_mesa',
                    'reabrir_mesa', 'anular', 'cuadrar_mesa', 'cerrar_noche')),
  -- La nómina NO es una casilla: solo gerente, dueño o admin, nunca
  -- configurable para el staff (ver es_gerente_o_dueno).
  rol             text check (rol in ('staff', 'gerente')),
  profile_id      uuid references public.profiles (id),
  permitido       boolean not null,
  actualizado_por uuid references public.profiles (id),
  actualizado_en  timestamptz not null default now(),
  check ((rol is null) <> (profile_id is null))
);
create unique index caja_permisos_por_rol on public.caja_permisos (club_id, permiso, rol) where rol is not null;
create unique index caja_permisos_por_persona on public.caja_permisos (club_id, permiso, profile_id) where profile_id is not null;

create table public.caja_eventos (
  id         bigint generated always as identity primary key,
  club_id    uuid not null references public.clubs (id),
  noche_id   uuid references public.caja_noches (id),
  sesion_id  uuid references public.mesa_sesiones (id),
  tipo       text not null,
  detalle    jsonb not null default '{}'::jsonb,
  hecho_por  uuid references public.profiles (id),
  hecho_en   timestamptz not null default now()
);
create index caja_eventos_noche on public.caja_eventos (noche_id);


-- ----------------------------------------------------------------------------
-- BLOQUE 4B — Cuenta de grupo: grupos, antros del grupo y miembros.
-- Un grupo junta antros de una o varias ciudades (cada antro conserva su
-- zona horaria). La membresía vive en tablas, NO en profiles.role: así una
-- misma persona puede ser dueña de un antro suelto y dueña de grupo, y no
-- hay que tocar el trigger profiles_no_escalar ni el ruteo por rol.
-- Escritura solo del admin (no hay políticas de escritura para nadie más).
-- ----------------------------------------------------------------------------
create table public.grupos (
  id          uuid primary key default gen_random_uuid(),
  nombre      text not null check (char_length(nombre) between 1 and 120),
  creado_en   timestamptz not null default now()
);

create table public.grupo_clubs (
  grupo_id    uuid not null references public.grupos (id) on delete cascade,
  club_id     uuid not null references public.clubs (id),
  agregado_en timestamptz not null default now(),
  primary key (grupo_id, club_id),
  unique (club_id)  -- un antro pertenece a un solo grupo (decisión 12)
);

create table public.grupo_miembros (
  grupo_id    uuid not null references public.grupos (id) on delete cascade,
  profile_id  uuid not null references public.profiles (id),
  rol_grupo   text not null check (rol_grupo in ('dueno_grupo')),  -- se pueden sumar roles después
  agregado_en timestamptz not null default now(),
  primary key (grupo_id, profile_id)
);

alter table public.grupos enable row level security;
alter table public.grupo_clubs enable row level security;
alter table public.grupo_miembros enable row level security;
revoke all on public.grupos, public.grupo_clubs, public.grupo_miembros from public, anon, authenticated;
grant select, insert, update, delete on public.grupos, public.grupo_clubs, public.grupo_miembros to authenticated;  -- las políticas dejan escribir solo al admin
grant all on public.grupos, public.grupo_clubs, public.grupo_miembros to service_role;

-- Lectura: el admin todo; un miembro ve sus grupos, los antros de sus grupos
-- y su propia membresía (no la lista de otros miembros).
create policy grupos_select on public.grupos for select to authenticated
  using ((select public.current_role_name()) = 'admin'
         or exists (select 1 from public.grupo_miembros m where m.grupo_id = grupos.id and m.profile_id = (select auth.uid())));
create policy grupo_clubs_select on public.grupo_clubs for select to authenticated
  using ((select public.current_role_name()) = 'admin'
         or exists (select 1 from public.grupo_miembros m where m.grupo_id = grupo_clubs.grupo_id and m.profile_id = (select auth.uid())));
create policy grupo_miembros_select on public.grupo_miembros for select to authenticated
  using ((select public.current_role_name()) = 'admin' or profile_id = (select auth.uid()));

-- Escritura: solo admin.
create policy grupos_admin_escribe on public.grupos for all to authenticated
  using ((select public.current_role_name()) = 'admin') with check ((select public.current_role_name()) = 'admin');
create policy grupo_clubs_admin_escribe on public.grupo_clubs for all to authenticated
  using ((select public.current_role_name()) = 'admin') with check ((select public.current_role_name()) = 'admin');
create policy grupo_miembros_admin_escribe on public.grupo_miembros for all to authenticated
  using ((select public.current_role_name()) = 'admin') with check ((select public.current_role_name()) = 'admin');


-- ----------------------------------------------------------------------------
-- BLOQUE 5 — Helpers de acceso por antro.
-- TODAS las políticas de caja (y, tras el bloque 17, las de clubs) llaman a
-- estas funciones por nombre. Para sumar un nuevo tipo de acceso (otro rol
-- de grupo, un auditor, etc.) se reemplaza el cuerpo de la función con
-- `create or replace` y ninguna política se reescribe.
-- ----------------------------------------------------------------------------

-- ¿Quien consulta es dueño de este antro?
create or replace function public.club_es_dueno(p_club_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
     and exists (select 1 from public.clubs c where c.id = p_club_id and c.dueno_id = auth.uid());
$$;

-- ¿Quien consulta es dueño de un grupo al que pertenece este antro?
create or replace function public.club_es_dueno_grupo(p_club_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
     and exists (
       select 1
       from public.grupo_miembros m
       join public.grupo_clubs gc on gc.grupo_id = m.grupo_id
       where m.profile_id = auth.uid()
         and m.rol_grupo = 'dueno_grupo'
         and gc.club_id = p_club_id);
$$;

-- Regla de lectura de la caja: admin, dueño del antro, dueño de su grupo, o
-- staff/gerente del antro. (RP y cliente no ven la caja.)
create or replace function public.caja_puede_ver(p_club_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rol text := public.current_role_name();
begin
  if v_rol = 'admin' then
    return true;
  end if;
  if public.club_es_dueno(p_club_id) or public.club_es_dueno_grupo(p_club_id) then
    return true;
  end if;
  return v_rol in ('staff', 'gerente') and public.current_club_id() = p_club_id;
end;
$$;

-- Regla general de lectura de un antro (para la política de clubs del
-- bloque 17): publicado, o admin, o su dueño, o dueño de su grupo, o
-- staff/gerente/RP del antro. Es la misma regla de
-- sql/2026-11-12-clubs-select-solo-publicados.sql más la rama de grupo.
create or replace function public.puede_ver_club(p_club_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rol text := public.current_role_name();
begin
  if exists (select 1 from public.clubs c
             where c.id = p_club_id and c.estado_verificacion = 'verificado' and c.suscripcion_activa) then
    return true;
  end if;
  if v_rol = 'admin' then
    return true;
  end if;
  if public.club_es_dueno(p_club_id) or public.club_es_dueno_grupo(p_club_id) then
    return true;
  end if;
  return v_rol in ('staff', 'gerente', 'rp') and public.current_club_id() = p_club_id;
end;
$$;

create or replace function public.caja_tiene_permiso(p_club_id uuid, p_permiso text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rol text := public.current_role_name();
  v_permitido boolean;
begin
  if auth.uid() is null then
    return false;
  end if;
  if v_rol = 'admin' then
    return true;
  end if;
  if public.club_es_dueno(p_club_id) then
    return true;
  end if;
  -- El dueño de grupo LEE todos sus antros (caja_puede_ver) pero no opera la
  -- caja (decisión 13). Si se decide que sí, basta con:
  --   if public.club_es_dueno_grupo(p_club_id) then return true; end if;
  if v_rol not in ('staff', 'gerente') or public.current_club_id() is distinct from p_club_id then
    return false;
  end if;
  if exists (select 1 from public.profiles p where p.id = auth.uid() and p.activo is false) then
    return false;
  end if;

  -- 1) Casilla de la persona.
  select cp.permitido into v_permitido
  from public.caja_permisos cp
  where cp.club_id = p_club_id and cp.permiso = p_permiso and cp.profile_id = auth.uid();
  if found then
    return v_permitido;
  end if;

  -- 2) Casilla del rol.
  select cp.permitido into v_permitido
  from public.caja_permisos cp
  where cp.club_id = p_club_id and cp.permiso = p_permiso and cp.rol = v_rol;
  if found then
    return v_permitido;
  end if;

  -- 3) Valores por defecto.
  if v_rol = 'gerente' then
    return true;
  end if;
  return p_permiso in ('puerta', 'abrir_mesa', 'registrar_consumo', 'cobrar', 'cerrar_mesa');
end;
$$;


-- ----------------------------------------------------------------------------
-- BLOQUE 6 — RLS: lectura por club, escritura cerrada.
-- ----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['caja_noches', 'mesa_sesiones', 'mesa_cuentas', 'caja_consumos',
                           'caja_pagos', 'caja_cuadres', 'caja_permisos', 'caja_eventos']
  loop
    execute format('alter table public.%I enable row level security', t);
    -- GRANT explícitos: el navegador solo lee (y RLS filtra por antro);
    -- escriben las funciones SECURITY DEFINER, que corren como dueño.
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);

    -- Lectura: permisiva + restrictiva con la misma regla.
    execute format(
      'create policy %I on public.%I for select to authenticated using ((select public.caja_puede_ver(club_id)))',
      t || '_select', t);
    execute format(
      'create policy %I on public.%I as restrictive for select to public using ((select public.caja_puede_ver(club_id)))',
      t || '_restrictiva_select', t);

    -- Escritura: candado. Solo escriben las funciones SECURITY DEFINER.
    execute format(
      'create policy %I on public.%I as restrictive for insert to public with check (false)',
      t || '_restrictiva_insert', t);
    execute format(
      'create policy %I on public.%I as restrictive for update to public using (false)',
      t || '_restrictiva_update', t);
    execute format(
      'create policy %I on public.%I as restrictive for delete to public using (false)',
      t || '_restrictiva_delete', t);
  end loop;
end;
$$;
grant usage, select on sequence public.caja_eventos_id_seq to service_role;


-- ----------------------------------------------------------------------------
-- BLOQUE 6B — Nada se borra en caja (ni con service_role ni con funciones).
-- DELETE y TRUNCATE fallan siempre. En consumos y pagos solo se puede pasar
-- de vigente a anulado (una vez, con quién, cuándo y motivo): el monto, la
-- cuenta, la mesa y quién lo registró no cambian nunca. Cuadres y bitácora
-- no se modifican.
-- Única excepción: limpiar datos de PRUEBA en dev, con
--   set local antroapp.borrado_pruebas = 'on';
-- dentro de una transacción del dueño de las tablas (postgres). Por la API
-- (anon, authenticated, service_role) no hay forma de activarlo.
-- ----------------------------------------------------------------------------
create or replace function public.caja_sin_borrar()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'postgres' and current_setting('antroapp.borrado_pruebas', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'En la caja nada se borra: se anula con motivo (%)', tg_table_name;
  end if;

  if tg_table_name in ('caja_cuadres', 'caja_eventos') then
    raise exception 'Los registros de % no se modifican', tg_table_name;
  end if;

  -- Una noche solo pasa de abierta a cerrada, una vez.
  if tg_table_name = 'caja_noches' then
    if old.estado <> 'abierta' or new.estado <> 'cerrada' or new.cerrada_en is null
       or (to_jsonb(new) - array['estado', 'cerrada_por', 'cerrada_en'])
          is distinct from (to_jsonb(old) - array['estado', 'cerrada_por', 'cerrada_en']) then
      raise exception 'Una noche solo pasa de abierta a cerrada, una vez';
    end if;
  end if;

  -- Sesión de mesa: abierta -> cerrada -> (abierta | cuadrada). Cuadrada es final.
  if tg_table_name = 'mesa_sesiones' then
    if (to_jsonb(new) - array['estado', 'cerrada_por', 'cerrada_en', 'cuadrada_por', 'cuadrada_en'])
       is distinct from (to_jsonb(old) - array['estado', 'cerrada_por', 'cerrada_en', 'cuadrada_por', 'cuadrada_en']) then
      raise exception 'Una sesión de mesa no cambia de antro, noche ni mesa';
    end if;
    if not ((old.estado = 'abierta' and new.estado = 'cerrada')
         or (old.estado = 'cerrada' and new.estado = 'abierta')
         or (old.estado = 'cerrada' and new.estado = 'cuadrada')) then
      raise exception 'Transición de mesa inválida: % -> %', old.estado, new.estado;
    end if;
  end if;

  -- Una cuenta solo se marca liquidada, una vez; nada más cambia.
  if tg_table_name = 'mesa_cuentas' then
    if old.liquidada_en is not null or new.liquidada_en is null
       or (to_jsonb(new) - 'liquidada_en') is distinct from (to_jsonb(old) - 'liquidada_en') then
      raise exception 'Una cuenta solo se marca liquidada, una vez';
    end if;
  end if;

  if tg_table_name in ('caja_consumos', 'caja_pagos') then
    if old.anulado then
      raise exception 'Un registro anulado ya no se modifica';
    end if;
    if (to_jsonb(new) - array['anulado', 'anulado_por', 'anulado_en', 'motivo_anulacion'])
       is distinct from (to_jsonb(old) - array['anulado', 'anulado_por', 'anulado_en', 'motivo_anulacion']) then
      raise exception 'Un consumo o pago no cambia: se anula con motivo y se registra de nuevo';
    end if;
    if not new.anulado or new.anulado_por is null or new.anulado_en is null
       or char_length(coalesce(trim(new.motivo_anulacion), '')) < 3 then
      raise exception 'La anulación necesita quién, cuándo y motivo';
    end if;
  end if;
  return new;
end;
$$;

-- INSERT coherente aunque sea con service_role o postgres (que se saltan
-- RLS): sesiones solo en noche abierta y mesa de su antro; cuentas,
-- consumos y pagos solo en una mesa abierta de una noche abierta, con
-- antro, noche, mesa y cuenta iguales a los de su sesión.
create or replace function public.caja_insert_coherente()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_s public.mesa_sesiones%rowtype;
  v_noche text;
begin
  if current_user = 'postgres' and current_setting('antroapp.borrado_pruebas', true) = 'on' then
    return new;
  end if;
  if tg_table_name = 'mesa_sesiones' then
    select estado into v_noche from public.caja_noches where id = new.noche_id and club_id = new.club_id;
    if v_noche is distinct from 'abierta' or new.estado <> 'abierta'
       or not exists (select 1 from public.club_tables t where t.id = new.mesa_id and t.club_id = new.club_id) then
      raise exception 'La sesión debe nacer abierta, en una noche abierta y en una mesa de su antro';
    end if;
    return new;
  end if;

  select * into v_s from public.mesa_sesiones where id = new.sesion_id;
  select estado into v_noche from public.caja_noches where id = v_s.noche_id;
  if v_s.estado is distinct from 'abierta' or v_noche is distinct from 'abierta' then
    raise exception 'Solo se registra en una mesa abierta de una noche abierta';
  end if;
  if new.club_id is distinct from v_s.club_id then
    raise exception 'El antro no coincide con la sesión';
  end if;
  if tg_table_name in ('caja_consumos', 'caja_pagos') then
    if new.noche_id is distinct from v_s.noche_id or new.anulado then
      raise exception 'Noche distinta a la de la sesión, o el registro nace anulado';
    end if;
    if new.cuenta_id is not null and not exists (
         select 1 from public.mesa_cuentas c where c.id = new.cuenta_id and c.sesion_id = new.sesion_id) then
      raise exception 'La cuenta no es de esta mesa';
    end if;
  end if;
  -- Anidado a propósito: en plpgsql "a and new.mesa_id" evalúa new.mesa_id
  -- aunque a sea falso, y mesa_cuentas / caja_pagos no tienen esa columna.
  if tg_table_name = 'caja_consumos' then
    if new.mesa_id is distinct from v_s.mesa_id then
      raise exception 'La mesa no coincide con la sesión';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.caja_insert_coherente() from public, anon, authenticated;

create trigger mesa_sesiones_insert_coherente before insert on public.mesa_sesiones for each row execute function public.caja_insert_coherente();
create trigger mesa_cuentas_insert_coherente  before insert on public.mesa_cuentas  for each row execute function public.caja_insert_coherente();
create trigger caja_consumos_insert_coherente before insert on public.caja_consumos for each row execute function public.caja_insert_coherente();
create trigger caja_pagos_insert_coherente    before insert on public.caja_pagos    for each row execute function public.caja_insert_coherente();

revoke all on function public.caja_sin_borrar() from public, anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['caja_noches', 'mesa_sesiones', 'mesa_cuentas', 'caja_consumos',
                           'caja_pagos', 'caja_cuadres', 'caja_eventos']
  loop
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.caja_sin_borrar()',
                   t || '_sin_borrar', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.caja_sin_borrar()',
                   t || '_sin_truncar', t);
  end loop;
end;
$$;


-- ----------------------------------------------------------------------------
-- BLOQUE 7 — Funciones internas: noche actual y bitácora.
-- ----------------------------------------------------------------------------
create or replace function public.caja_noche_actual(p_club_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fecha date := public.club_fecha_operacion(p_club_id, now());
  v_noche public.caja_noches%rowtype;
begin
  insert into public.caja_noches (club_id, fecha_operacion, abierta_por)
  values (p_club_id, v_fecha, auth.uid())
  on conflict (club_id, fecha_operacion) do nothing;

  -- "for share": si alguien está cerrando la noche (que la bloquea "for
  -- update"), abrir mesa espera y después ve que ya está cerrada.
  select * into v_noche
  from public.caja_noches
  where club_id = p_club_id and fecha_operacion = v_fecha
  for share;

  if v_noche.estado <> 'abierta' then
    raise exception 'La noche del % ya está cerrada', v_fecha;
  end if;
  return v_noche.id;
end;
$$;

create or replace function public.caja_evento(
  p_club_id uuid, p_noche_id uuid, p_sesion_id uuid, p_tipo text, p_detalle jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.caja_eventos (club_id, noche_id, sesion_id, tipo, detalle, hecho_por)
  values (p_club_id, p_noche_id, p_sesion_id, p_tipo, coalesce(p_detalle, '{}'::jsonb), auth.uid());
$$;

-- Sesión bloqueada para escribir, con chequeo de estado y de noche abierta.
create or replace function public.caja_sesion_para_escribir(p_sesion_id uuid, p_estado text)
returns public.mesa_sesiones
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sesion public.mesa_sesiones%rowtype;
begin
  select * into v_sesion from public.mesa_sesiones where id = p_sesion_id for update;
  if not found then
    raise exception 'Mesa no encontrada';
  end if;
  if v_sesion.estado <> p_estado then
    raise exception 'La mesa está % y esta acción requiere que esté %', v_sesion.estado, p_estado;
  end if;
  if exists (select 1 from public.caja_noches n where n.id = v_sesion.noche_id and n.estado <> 'abierta') then
    raise exception 'La noche ya está cerrada';
  end if;
  return v_sesion;
end;
$$;


-- ----------------------------------------------------------------------------
-- BLOQUE 8 — Abrir mesa y sentar clientes.
-- ----------------------------------------------------------------------------
create or replace function public.caja_abrir_mesa(p_mesa_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_club uuid;
  v_noche uuid;
  v_sesion uuid;
begin
  select club_id into v_club from public.club_tables where id = p_mesa_id;
  if v_club is null then
    raise exception 'Mesa no encontrada';
  end if;
  if not public.caja_tiene_permiso(v_club, 'abrir_mesa') then
    raise exception 'No tienes permiso para abrir mesas';
  end if;

  v_noche := public.caja_noche_actual(v_club);
  begin
    insert into public.mesa_sesiones (club_id, noche_id, mesa_id, abierta_por)
    values (v_club, v_noche, p_mesa_id, auth.uid())
    returning id into v_sesion;
  exception when unique_violation then
    raise exception 'La mesa ya está abierta';
  end;

  perform public.caja_evento(v_club, v_noche, v_sesion, 'abrir_mesa', jsonb_build_object('mesa_id', p_mesa_id));
  return v_sesion;
end;
$$;

create or replace function public.caja_sentar_cliente(
  p_sesion_id uuid,
  p_reservation_id uuid default null,
  p_cliente_nombre text default null,
  p_personas int default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sesion public.mesa_sesiones%rowtype;
  v_fecha date;
  v_res public.reservations%rowtype;
  v_cuenta uuid;
begin
  v_sesion := public.caja_sesion_para_escribir(p_sesion_id, 'abierta');
  if not public.caja_tiene_permiso(v_sesion.club_id, 'abrir_mesa') then
    raise exception 'No tienes permiso para sentar clientes';
  end if;

  if p_reservation_id is not null then
    select * into v_res from public.reservations where id = p_reservation_id for update;
    if not found or v_res.club_id is distinct from v_sesion.club_id then
      raise exception 'La reserva no es de este antro';
    end if;
    select fecha_operacion into v_fecha from public.caja_noches where id = v_sesion.noche_id;
    if v_res.fecha <> v_fecha then
      raise exception 'La reserva no es de esta noche';
    end if;
    -- Solo "Confirmar entrada" cuenta como check-in (bloque 20). Las
    -- reservas usadas antes de la puerta nueva tienen puerta_estado nulo.
    -- "is distinct from" para que un nulo no deje pasar a quien no entró.
    if coalesce(v_res.puerta_estado, case when v_res.status = 'usada' then 'entro' end)
       is distinct from 'entro' then
      raise exception 'Falta confirmar la entrada del cliente en la puerta';
    end if;

    begin
      insert into public.mesa_cuentas (club_id, sesion_id, reservation_id, rp_id, origen, cliente_nombre, personas, creada_por)
      values (v_sesion.club_id, v_sesion.id, v_res.id,
              -- El RP lo decide la reserva, y solo si es RP de este antro.
              case when v_res.source = 'rp' and exists (
                     select 1 from public.profiles p
                     where p.id = v_res.rp_id and p.role = 'rp' and p.club_id = v_sesion.club_id)
                   then v_res.rp_id end,
              'reserva', v_res.cliente_nombre, coalesce(p_personas, v_res.personas), auth.uid())
      returning id into v_cuenta;
    exception when unique_violation then
      raise exception 'Esa reserva ya está sentada en una mesa';
    end;

    -- Compatibilidad con el flujo actual.
    update public.reservations set mesa_id = v_sesion.mesa_id where id = v_res.id;
  else
    if p_cliente_nombre is null or char_length(trim(p_cliente_nombre)) = 0 then
      raise exception 'Escribe el nombre del cliente';
    end if;
    insert into public.mesa_cuentas (club_id, sesion_id, origen, cliente_nombre, personas, creada_por)
    values (v_sesion.club_id, v_sesion.id, 'walk_in', trim(p_cliente_nombre), p_personas, auth.uid())
    returning id into v_cuenta;
  end if;

  perform public.caja_evento(v_sesion.club_id, v_sesion.noche_id, v_sesion.id, 'sentar_cliente',
    jsonb_build_object('cuenta_id', v_cuenta, 'reservation_id', p_reservation_id));
  return v_cuenta;
end;
$$;


-- ----------------------------------------------------------------------------
-- BLOQUE 9 — Consumos y pagos (registrar y anular).
-- ----------------------------------------------------------------------------
create or replace function public.caja_registrar_consumo(
  p_cuenta_id uuid, p_monto_centavos bigint, p_concepto text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cuenta public.mesa_cuentas%rowtype;
  v_sesion public.mesa_sesiones%rowtype;
  v_id uuid;
begin
  select * into v_cuenta from public.mesa_cuentas where id = p_cuenta_id;
  if not found then
    raise exception 'Cuenta no encontrada';
  end if;
  v_sesion := public.caja_sesion_para_escribir(v_cuenta.sesion_id, 'abierta');
  if not public.caja_tiene_permiso(v_sesion.club_id, 'registrar_consumo') then
    raise exception 'No tienes permiso para registrar consumos';
  end if;
  if p_monto_centavos is null or p_monto_centavos < 1 or p_monto_centavos > 100000000 then
    raise exception 'Monto inválido';
  end if;

  insert into public.caja_consumos (club_id, noche_id, sesion_id, mesa_id, cuenta_id, reservation_id, rp_id,
                                    monto_centavos, concepto, registrado_por)
  values (v_sesion.club_id, v_sesion.noche_id, v_sesion.id, v_sesion.mesa_id, v_cuenta.id,
          v_cuenta.reservation_id, v_cuenta.rp_id, p_monto_centavos, nullif(trim(p_concepto), ''), auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.caja_anular_consumo(p_consumo_id uuid, p_motivo text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_consumo public.caja_consumos%rowtype;
begin
  select * into v_consumo from public.caja_consumos where id = p_consumo_id;
  if not found then
    raise exception 'Consumo no encontrado';
  end if;
  perform public.caja_sesion_para_escribir(v_consumo.sesion_id, 'abierta');
  -- Releer con la sesión ya bloqueada: dos anulaciones simultáneas no pasan.
  select * into v_consumo from public.caja_consumos where id = p_consumo_id for update;
  if not public.caja_tiene_permiso(v_consumo.club_id, 'anular') then
    raise exception 'No tienes permiso para anular';
  end if;
  if p_motivo is null or char_length(trim(p_motivo)) < 3 then
    raise exception 'Escribe el motivo de la anulación';
  end if;
  if v_consumo.anulado then
    raise exception 'El consumo ya estaba anulado';
  end if;

  update public.caja_consumos
  set anulado = true, anulado_por = auth.uid(), anulado_en = now(), motivo_anulacion = trim(p_motivo)
  where id = p_consumo_id;

  perform public.caja_evento(v_consumo.club_id, v_consumo.noche_id, v_consumo.sesion_id, 'anular_consumo',
    jsonb_build_object('consumo_id', p_consumo_id, 'monto_centavos', v_consumo.monto_centavos, 'motivo', trim(p_motivo)));
end;
$$;

create or replace function public.caja_registrar_pago(
  p_sesion_id uuid, p_cuenta_id uuid, p_metodo text, p_monto_centavos bigint, p_referencia text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sesion public.mesa_sesiones%rowtype;
  v_id uuid;
begin
  v_sesion := public.caja_sesion_para_escribir(p_sesion_id, 'abierta');
  if not public.caja_tiene_permiso(v_sesion.club_id, 'cobrar') then
    raise exception 'No tienes permiso para cobrar';
  end if;
  if p_metodo is null or p_metodo not in ('efectivo', 'tarjeta', 'otro') then
    raise exception 'Método de pago inválido';
  end if;
  if p_monto_centavos is null or p_monto_centavos < 1 or p_monto_centavos > 100000000 then
    raise exception 'Monto inválido';
  end if;
  if p_cuenta_id is not null
     and not exists (select 1 from public.mesa_cuentas where id = p_cuenta_id and sesion_id = p_sesion_id) then
    raise exception 'La cuenta no es de esta mesa';
  end if;

  insert into public.caja_pagos (club_id, noche_id, sesion_id, cuenta_id, metodo, monto_centavos, referencia, registrado_por)
  values (v_sesion.club_id, v_sesion.noche_id, v_sesion.id, p_cuenta_id, p_metodo, p_monto_centavos,
          nullif(trim(p_referencia), ''), auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.caja_anular_pago(p_pago_id uuid, p_motivo text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pago public.caja_pagos%rowtype;
begin
  select * into v_pago from public.caja_pagos where id = p_pago_id;
  if not found then
    raise exception 'Pago no encontrado';
  end if;
  perform public.caja_sesion_para_escribir(v_pago.sesion_id, 'abierta');
  select * into v_pago from public.caja_pagos where id = p_pago_id for update;
  if not public.caja_tiene_permiso(v_pago.club_id, 'anular') then
    raise exception 'No tienes permiso para anular';
  end if;
  if p_motivo is null or char_length(trim(p_motivo)) < 3 then
    raise exception 'Escribe el motivo de la anulación';
  end if;
  if v_pago.anulado then
    raise exception 'El pago ya estaba anulado';
  end if;

  update public.caja_pagos
  set anulado = true, anulado_por = auth.uid(), anulado_en = now(), motivo_anulacion = trim(p_motivo)
  where id = p_pago_id;

  perform public.caja_evento(v_pago.club_id, v_pago.noche_id, v_pago.sesion_id, 'anular_pago',
    jsonb_build_object('pago_id', p_pago_id, 'monto_centavos', v_pago.monto_centavos, 'metodo', v_pago.metodo, 'motivo', trim(p_motivo)));
end;
$$;


-- ----------------------------------------------------------------------------
-- BLOQUE 10 — Totales de una sesión (interno).
-- ----------------------------------------------------------------------------
create or replace function public.caja_totales_sesion(
  p_sesion_id uuid,
  out registrado bigint, out efectivo bigint, out tarjeta bigint, out otro bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce((select sum(monto_centavos) from public.caja_consumos
              where sesion_id = p_sesion_id and not anulado), 0)::bigint,
    coalesce((select sum(monto_centavos) from public.caja_pagos
              where sesion_id = p_sesion_id and not anulado and metodo = 'efectivo'), 0)::bigint,
    coalesce((select sum(monto_centavos) from public.caja_pagos
              where sesion_id = p_sesion_id and not anulado and metodo = 'tarjeta'), 0)::bigint,
    coalesce((select sum(monto_centavos) from public.caja_pagos
              where sesion_id = p_sesion_id and not anulado and metodo = 'otro'), 0)::bigint;
$$;


-- ----------------------------------------------------------------------------
-- BLOQUE 11 — Comisión de RP por cuenta (interno).
-- Una vez por cuenta, al cuadrar la mesa. Idempotente. Respeta la
-- configuración actual sin rediseñarla: pago_rp_modo, comision_tipo,
-- comision_monto, comision_desbloqueo_reservas y rp_comision_overrides.
-- Una reserva sin entrada confirmada nunca tiene cuenta, así que no genera
-- comisión ni cuenta para el desbloqueo: el RP no se penaliza, simplemente
-- no hay.
-- ----------------------------------------------------------------------------
create or replace function public.caja_liquidar_cuenta(p_cuenta_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cuenta public.mesa_cuentas%rowtype;
  v_res public.reservations%rowtype;
  v_club public.clubs%rowtype;
  v_fecha date;
  v_lunes date;
  v_base bigint;
  v_tipo text;
  v_monto numeric;
  v_desbloqueo int;
  v_conteo int;
  v_centavos bigint;
begin
  select * into v_cuenta from public.mesa_cuentas where id = p_cuenta_id for update;
  if not found or v_cuenta.liquidada_en is not null then
    return;
  end if;

  select coalesce(sum(monto_centavos), 0) into v_base
  from public.caja_consumos where cuenta_id = v_cuenta.id and not anulado;

  if v_base > 0 and v_cuenta.reservation_id is not null then
    select * into v_res from public.reservations where id = v_cuenta.reservation_id;
    select * into v_club from public.clubs where id = v_cuenta.club_id;
    -- La semana sale de la fecha operativa de la noche, que ya se calculó en
    -- la zona del antro: no hace falta volver a convertir zonas aquí.
    select n.fecha_operacion into v_fecha
    from public.mesa_sesiones s join public.caja_noches n on n.id = s.noche_id
    where s.id = v_cuenta.sesion_id;
    v_lunes := v_fecha - (extract(isodow from v_fecha)::int - 1);

    if v_res.source = 'rp' and v_cuenta.rp_id is not null and v_club.pago_rp_modo = 'reserva' then
      select o.comision_tipo, o.comision_monto, o.comision_desbloqueo_reservas
        into v_tipo, v_monto, v_desbloqueo
      from public.rp_comision_overrides o
      where o.club_id = v_club.id and o.rp_id = v_cuenta.rp_id;
      if not found then
        v_tipo := v_club.comision_tipo;
        v_monto := v_club.comision_monto;
        v_desbloqueo := v_club.comision_desbloqueo_reservas;
      end if;

      -- Un candado por RP y semana: dos cuadres simultáneos del mismo RP no
      -- leen el mismo conteo. Las comisiones anuladas no cuentan.
      perform pg_advisory_xact_lock(hashtextextended(v_cuenta.rp_id::text || '|' || v_lunes::text, 0));
      select count(*) into v_conteo
      from public.commissions c
      join public.reservations r on r.id = c.reservation_id
      where c.tipo = 'rp' and c.rp_id = v_cuenta.rp_id and r.club_id = v_club.id
        and c.status <> 'anulada'
        and r.fecha between v_lunes and v_lunes + 6;

      -- Misma fórmula de desbloqueo que la función actual (ver decisión 6).
      v_centavos := case
        when (v_conteo + 1) < coalesce(v_desbloqueo, 0) then 0
        when v_tipo = 'fijo' then round(coalesce(v_monto, 0) * 100)
        else round(v_base * coalesce(v_monto, 0) / 100)
      end;

      insert into public.commissions (reservation_id, rp_id, tipo, monto, status)
      values (v_res.id, v_cuenta.rp_id, 'rp', round(v_centavos / 100.0, 2), 'pendiente')
      on conflict (reservation_id) do nothing;
    end if;
    -- No hay bono de plataforma por reserva orgánica: las columnas
    -- clubs.bono_organica_* se conservan pero no se usan.

    -- Compatibilidad: el consumo total queda también en la reserva.
    update public.reservations set consumo_monto = round(v_base / 100.0, 2) where id = v_res.id;
  end if;

  update public.mesa_cuentas set liquidada_en = now() where id = v_cuenta.id;
end;
$$;


-- ----------------------------------------------------------------------------
-- BLOQUE 12 — Cerrar, reabrir y cuadrar mesa.
-- ----------------------------------------------------------------------------
create or replace function public.caja_cerrar_mesa(p_sesion_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sesion public.mesa_sesiones%rowtype;
  v_t record;
begin
  v_sesion := public.caja_sesion_para_escribir(p_sesion_id, 'abierta');
  if not public.caja_tiene_permiso(v_sesion.club_id, 'cerrar_mesa') then
    raise exception 'No tienes permiso para cerrar mesas';
  end if;

  select * into v_t from public.caja_totales_sesion(p_sesion_id);
  if v_t.registrado <> v_t.efectivo + v_t.tarjeta + v_t.otro then
    raise exception 'La mesa tiene saldo pendiente: consumido % centavos, cobrado % centavos',
      v_t.registrado, v_t.efectivo + v_t.tarjeta + v_t.otro;
  end if;

  update public.mesa_sesiones
  set estado = 'cerrada', cerrada_por = auth.uid(), cerrada_en = now()
  where id = p_sesion_id;

  perform public.caja_evento(v_sesion.club_id, v_sesion.noche_id, v_sesion.id, 'cerrar_mesa', to_jsonb(v_t));
end;
$$;

create or replace function public.caja_reabrir_mesa(p_sesion_id uuid, p_motivo text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sesion public.mesa_sesiones%rowtype;
begin
  v_sesion := public.caja_sesion_para_escribir(p_sesion_id, 'cerrada');
  if not public.caja_tiene_permiso(v_sesion.club_id, 'reabrir_mesa') then
    raise exception 'No tienes permiso para reabrir mesas';
  end if;
  if p_motivo is null or char_length(trim(p_motivo)) < 3 then
    raise exception 'Escribe el motivo de la reapertura';
  end if;

  begin
    update public.mesa_sesiones
    set estado = 'abierta', cerrada_por = null, cerrada_en = null
    where id = p_sesion_id;
  exception when unique_violation then
    raise exception 'La mesa ya tiene otra sesión abierta';
  end;

  perform public.caja_evento(v_sesion.club_id, v_sesion.noche_id, v_sesion.id, 'reabrir_mesa',
    jsonb_build_object('motivo', trim(p_motivo)));
end;
$$;

create or replace function public.caja_cuadrar_mesa(p_sesion_id uuid, p_notas text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sesion public.mesa_sesiones%rowtype;
  v_t record;
  v_cuenta uuid;
begin
  v_sesion := public.caja_sesion_para_escribir(p_sesion_id, 'cerrada');
  if not public.caja_tiene_permiso(v_sesion.club_id, 'cuadrar_mesa') then
    raise exception 'No tienes permiso para cuadrar mesas';
  end if;

  select * into v_t from public.caja_totales_sesion(p_sesion_id);

  insert into public.caja_cuadres (club_id, noche_id, sesion_id, tipo, registrado_centavos,
    cobrado_efectivo_centavos, cobrado_tarjeta_centavos, cobrado_otro_centavos,
    saldo_sin_cobrar_centavos, notas, hecho_por)
  values (v_sesion.club_id, v_sesion.noche_id, v_sesion.id, 'mesa', v_t.registrado,
    v_t.efectivo, v_t.tarjeta, v_t.otro,
    v_t.registrado - (v_t.efectivo + v_t.tarjeta + v_t.otro), nullif(trim(p_notas), ''), auth.uid());

  update public.mesa_sesiones
  set estado = 'cuadrada', cuadrada_por = auth.uid(), cuadrada_en = now()
  where id = p_sesion_id;

  for v_cuenta in select id from public.mesa_cuentas where sesion_id = p_sesion_id loop
    perform public.caja_liquidar_cuenta(v_cuenta);
  end loop;

  perform public.caja_evento(v_sesion.club_id, v_sesion.noche_id, v_sesion.id, 'cuadrar_mesa', to_jsonb(v_t));
end;
$$;


-- ----------------------------------------------------------------------------
-- BLOQUE 13 — Cuadre general y cierre de la noche.
-- ----------------------------------------------------------------------------
create or replace function public.caja_cerrar_noche(
  p_noche_id uuid,
  p_contado_efectivo_centavos bigint,
  p_contado_tarjeta_centavos bigint,
  p_contado_otro_centavos bigint,
  p_notas text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_noche public.caja_noches%rowtype;
  v_pendientes int;
  v_reg bigint;
  v_ef bigint;
  v_ta bigint;
  v_ot bigint;
begin
  select * into v_noche from public.caja_noches where id = p_noche_id for update;
  if not found then
    raise exception 'Noche no encontrada';
  end if;
  if v_noche.estado <> 'abierta' then
    raise exception 'La noche ya está cerrada';
  end if;
  if not public.caja_tiene_permiso(v_noche.club_id, 'cerrar_noche') then
    raise exception 'No tienes permiso para cerrar la noche';
  end if;
  if coalesce(p_contado_efectivo_centavos, -1) < 0
     or coalesce(p_contado_tarjeta_centavos, -1) < 0
     or coalesce(p_contado_otro_centavos, -1) < 0 then
    raise exception 'Captura el conteo de efectivo, tarjeta y otros (0 si no hubo)';
  end if;

  select count(*) into v_pendientes
  from public.mesa_sesiones where noche_id = p_noche_id and estado <> 'cuadrada';
  if v_pendientes > 0 then
    raise exception 'Faltan % mesas por cuadrar', v_pendientes;
  end if;

  select coalesce(sum(monto_centavos), 0) into v_reg
  from public.caja_consumos where noche_id = p_noche_id and not anulado;
  select coalesce(sum(monto_centavos) filter (where metodo = 'efectivo'), 0),
         coalesce(sum(monto_centavos) filter (where metodo = 'tarjeta'), 0),
         coalesce(sum(monto_centavos) filter (where metodo = 'otro'), 0)
    into v_ef, v_ta, v_ot
  from public.caja_pagos where noche_id = p_noche_id and not anulado;

  insert into public.caja_cuadres (club_id, noche_id, tipo, registrado_centavos,
    cobrado_efectivo_centavos, cobrado_tarjeta_centavos, cobrado_otro_centavos,
    saldo_sin_cobrar_centavos,
    contado_efectivo_centavos, contado_tarjeta_centavos, contado_otro_centavos,
    diferencia_centavos, notas, hecho_por)
  values (v_noche.club_id, p_noche_id, 'noche', v_reg, v_ef, v_ta, v_ot,
    v_reg - (v_ef + v_ta + v_ot),
    p_contado_efectivo_centavos, p_contado_tarjeta_centavos, p_contado_otro_centavos,
    (p_contado_efectivo_centavos + p_contado_tarjeta_centavos + p_contado_otro_centavos) - (v_ef + v_ta + v_ot),
    nullif(trim(p_notas), ''), auth.uid());

  update public.caja_noches
  set estado = 'cerrada', cerrada_por = auth.uid(), cerrada_en = now()
  where id = p_noche_id;

  perform public.caja_evento(v_noche.club_id, p_noche_id, null, 'cerrar_noche',
    jsonb_build_object('registrado', v_reg, 'efectivo', v_ef, 'tarjeta', v_ta, 'otro', v_ot));
end;
$$;


-- ----------------------------------------------------------------------------
-- BLOQUE 14 — Configurar casillas de permisos (dueño o admin).
-- ----------------------------------------------------------------------------
create or replace function public.caja_configurar_permiso(
  p_club_id uuid, p_permiso text, p_rol text, p_profile_id uuid, p_permitido boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (public.current_role_name() = 'admin' or public.club_es_dueno(p_club_id)) then
    raise exception 'Solo el dueño o el admin configuran permisos de caja';
  end if;
  if (p_rol is null) = (p_profile_id is null) then
    raise exception 'Indica un rol o una persona, no los dos';
  end if;
  if p_profile_id is not null and not exists (
       select 1 from public.profiles
       where id = p_profile_id and club_id = p_club_id and role in ('staff', 'gerente')) then
    raise exception 'La persona no es staff ni gerente de este antro';
  end if;

  if p_rol is not null then
    insert into public.caja_permisos (club_id, permiso, rol, permitido, actualizado_por)
    values (p_club_id, p_permiso, p_rol, p_permitido, auth.uid())
    on conflict (club_id, permiso, rol) where rol is not null
    do update set permitido = excluded.permitido, actualizado_por = auth.uid(), actualizado_en = now();
  else
    insert into public.caja_permisos (club_id, permiso, profile_id, permitido, actualizado_por)
    values (p_club_id, p_permiso, p_profile_id, p_permitido, auth.uid())
    on conflict (club_id, permiso, profile_id) where profile_id is not null
    do update set permitido = excluded.permitido, actualizado_por = auth.uid(), actualizado_en = now();
  end if;
end;
$$;


-- ----------------------------------------------------------------------------
-- BLOQUE 15 — Quién puede llamar qué.
-- Las internas no se exponen por la API; las de operación solo con sesión.
-- ----------------------------------------------------------------------------
revoke all on function public.caja_noche_actual(uuid) from public, anon, authenticated;
revoke all on function public.caja_evento(uuid, uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.caja_sesion_para_escribir(uuid, text) from public, anon, authenticated;
revoke all on function public.caja_totales_sesion(uuid) from public, anon, authenticated;
revoke all on function public.caja_liquidar_cuenta(uuid) from public, anon, authenticated;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.club_fecha_operacion(uuid, timestamptz)',
    'public.club_es_dueno(uuid)',
    'public.club_es_dueno_grupo(uuid)',
    'public.caja_puede_ver(uuid)',
    'public.caja_tiene_permiso(uuid, text)',
    'public.caja_abrir_mesa(uuid)',
    'public.caja_sentar_cliente(uuid, uuid, text, int)',
    'public.caja_registrar_consumo(uuid, bigint, text)',
    'public.caja_anular_consumo(uuid, text)',
    'public.caja_registrar_pago(uuid, uuid, text, bigint, text)',
    'public.caja_anular_pago(uuid, text)',
    'public.caja_cerrar_mesa(uuid)',
    'public.caja_reabrir_mesa(uuid, text)',
    'public.caja_cuadrar_mesa(uuid, text)',
    'public.caja_cerrar_noche(uuid, bigint, bigint, bigint, text)',
    'public.caja_configurar_permiso(uuid, text, text, uuid, boolean)']
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;


-- ============================================================================
-- CAMBIOS A LO QUE YA EXISTE (correr aparte, después de lo anterior)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- BLOQUE 17 — clubs: pasar la restrictiva de SELECT a puede_ver_club().
-- Hoy clubs_restrictiva_select_publicados tiene la regla escrita dentro de
-- la política, así que un dueño de grupo no vería los antros NO publicados de
-- su grupo. Este es el ÚNICO cambio de política que pide el grupo; después de
-- él, cualquier acceso nuevo se suma en puede_ver_club() sin tocar políticas.
-- club_photos no cambia: su restrictiva pregunta por clubs y hereda la regla.
-- La función la evalúa también el anónimo (la restrictiva es "to public").
-- Probar después con node scripts/probar-clubs-visibilidad.mjs.
-- ----------------------------------------------------------------------------
grant execute on function public.puede_ver_club(uuid) to anon, authenticated;
drop policy clubs_restrictiva_select_publicados on public.clubs;
-- El dueño se compara sobre la misma fila (no con una consulta): así un
-- INSERT ... RETURNING de su propio antro sigue pasando.
create policy clubs_restrictiva_select_publicados on public.clubs
  as restrictive for select to public
  using ((dueno_id is not null and dueno_id = (select auth.uid()))
         or (select public.puede_ver_club(id)));


-- ----------------------------------------------------------------------------
-- BLOQUE 18 — Reservas: "desde la noche en curso" en la zona del antro.
-- La noche operativa (corte 08:00) se escribe en línea: club_fecha_operacion
-- no tiene EXECUTE para anon. Así a la 1:00 a. m. se puede reservar para la
-- noche en curso, que es la que acepta la puerta.
-- La política actual (sql/2026-09-22-fugas-criticas.sql) usa la zona de
-- México fija. Con la zona del antro, un antro de Tijuana no rechaza una
-- reserva de "hoy" durante la hora en que México ya cambió de día.
-- Sin coalesce a propósito: si el anónimo no puede leer el antro (no está
-- publicado), la zona sale nula y la reserva se rechaza.
-- ----------------------------------------------------------------------------
drop policy reservations_insert_anonimo on public.reservations;
create policy reservations_insert_anonimo on public.reservations
  for insert to anon
  with check (
    club_id is not null
    and source = 'organica'
    and rp_id is null
    and cliente_id is null
    and status = 'pendiente'
    and consumo_monto is null
    and mesa_id is null
    and coalesce(se_retiro_sin_consumir, false) = false
    and personas between 1 and 20
    and fecha >= ((now() at time zone (select c.zona_horaria from public.clubs c where c.id = reservations.club_id)) - interval '8 hours')::date
  );

-- La reserva del cliente con sesión tenía la misma fecha fija de México.
drop policy reservations_insert_cliente_logueado on public.reservations;
create policy reservations_insert_cliente_logueado on public.reservations
  for insert to authenticated
  with check (
    club_id is not null
    and source = 'organica'
    and rp_id is null
    and cliente_id = (select auth.uid())
    and (select public.current_role_name()) = 'cliente'
    and status = 'pendiente'
    and consumo_monto is null
    and mesa_id is null
    and coalesce(se_retiro_sin_consumir, false) = false
    and personas between 1 and 20
    and fecha >= ((now() at time zone (select c.zona_horaria from public.clubs c where c.id = reservations.club_id)) - interval '8 hours')::date
  );


-- ----------------------------------------------------------------------------
-- BLOQUE 18B — Reserva de RP: solo en SU antro, desde la noche en curso,
-- naciendo limpia (pendiente, sin consumo ni mesa) y con el RP activo.
-- Antes un RP podía meter reservas en cualquier antro (incluso borradores),
-- con cualquier fecha y estado, y cobrar comisión en la caja de ese antro.
-- ----------------------------------------------------------------------------
drop policy reservations_insert_rp on public.reservations;
create policy reservations_insert_rp on public.reservations
  for insert to authenticated
  with check (
    source = 'rp'
    and rp_id = (select auth.uid())
    and cliente_id is null
    and (select public.current_role_name()) = 'rp'
    and club_id is not null
    and club_id = (select public.current_club_id())
    and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.activo)
    and status = 'pendiente'
    and consumo_monto is null
    and mesa_id is null
    and coalesce(se_retiro_sin_consumir, false) = false
    and personas between 1 and 20
    and fecha >= ((now() at time zone (select c.zona_horaria from public.clubs c where c.id = reservations.club_id)) - interval '8 hours')::date
  );


-- ----------------------------------------------------------------------------
-- BLOQUE 18C — Campos fijos de una reserva. Desde el navegador (anon y
-- authenticated) nadie fuera del admin cambia origen, RP, antro, cliente,
-- fecha ni QR de una reserva: así el staff no puede convertir una reserva
-- orgánica en una de RP para generarle comisión. Lo que la app sí cambia
-- (status, mesa_id, se_retiro_sin_consumir) sigue igual.
-- No es security definer: current_user es quien llama.
-- ----------------------------------------------------------------------------
create or replace function public.reservations_campos_fijos()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('anon', 'authenticated') or public.current_role_name() = 'admin' then
    return new;
  end if;
  if new.source     is distinct from old.source
     or new.rp_id      is distinct from old.rp_id
     or new.club_id    is distinct from old.club_id
     or new.cliente_id is distinct from old.cliente_id
     or new.fecha      is distinct from old.fecha
     or new.qr_code    is distinct from old.qr_code then
    raise exception 'El origen, RP, antro, cliente, fecha y QR de una reserva no se cambian';
  end if;
  return new;
end;
$$;
revoke all on function public.reservations_campos_fijos() from public, anon, authenticated;
create trigger reservations_campos_fijos
  before update on public.reservations
  for each row execute function public.reservations_campos_fijos();


-- ----------------------------------------------------------------------------
-- BLOQUE 18D — profiles.activo bajo candado. La caja y la nómina niegan
-- permisos a quien está dado de baja, pero cada quien podía reactivarse
-- solo y el staff podía dar de baja al gerente. Ahora: nadie cambia su
-- propio "activo"; el staff solo da de baja o reactiva RPs (lo que hace su
-- panel); gerente y dueño, a su personal; el admin, a todos.
-- (Reemplaza la función del trigger profiles_no_escalar, misma firma.)
-- ----------------------------------------------------------------------------
create or replace function public.profiles_bloquear_cambio_privilegios()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
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
  if new.activo is distinct from old.activo then
    if old.id = auth.uid() then
      raise exception 'No puedes cambiar tu propio estado activo.';
    end if;
    if public.current_role_name() = 'staff' and old.role <> 'rp' then
      raise exception 'El staff solo da de baja o reactiva RPs.';
    end if;
  end if;
  return new;
end
$function$;


-- ============================================================================
-- PUERTA Y NÓMINA (bloques 19 a 25)
-- Requieren el bloque 1C (columnas de puerta). Orden de despliegue:
--   1) bloques 19, 20, 22, 23 y 24 (funciones y columnas nuevas);
--   2) cambiar el código del panel de staff para usar puerta_escanear y
--      puerta_confirmar_entrada en lugar del UPDATE directo;
--   3) recién entonces el bloque 21 (candado), que rompe el UPDATE directo.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- BLOQUE 19 — Helpers de puerta y de nómina.
-- ----------------------------------------------------------------------------

-- Gerente del antro, dueño del antro o admin. Regla FIJA, no es casilla: la
-- usa la nómina (verla y marcarla pagada). El staff no ve sueldos.
create or replace function public.es_gerente_o_dueno(p_club_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rol text := public.current_role_name();
begin
  if auth.uid() is null then
    return false;
  end if;
  if v_rol = 'admin' or public.club_es_dueno(p_club_id) then
    return true;
  end if;
  return v_rol = 'gerente'
     and public.current_club_id() = p_club_id
     and not exists (select 1 from public.profiles p where p.id = auth.uid() and p.activo is false);
end;
$$;

-- ¿Llegó tarde? Nulo si el antro no tiene tolerancia (no se marca a nadie).
-- La tolerancia es hora local del antro; si es antes de las 08:00 se
-- entiende de la madrugada siguiente a la fecha de la reserva.
create or replace function public.puerta_es_tarde(p_club_id uuid, p_fecha date, p_momento timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when c.tolerancia_hora is null then null
    else p_momento > (
      (p_fecha + c.tolerancia_hora
        + case when c.tolerancia_hora < time '08:00' then interval '1 day' else interval '0' end)
      at time zone c.zona_horaria)
  end
  from public.clubs c
  where c.id = p_club_id;
$$;

-- Reserva bloqueada, del antro de quien llama, con permiso de puerta y de la
-- noche operativa en curso.
create or replace function public.puerta_reserva_para_escribir(p_reservation_id uuid)
returns public.reservations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_res public.reservations%rowtype;
begin
  select * into v_res from public.reservations where id = p_reservation_id for update;
  if not found or not public.caja_tiene_permiso(v_res.club_id, 'puerta') then
    -- Mismo mensaje para "no existe" y "no es tuyo": no se revela nada.
    raise exception 'Reserva no encontrada en tu antro';
  end if;
  if v_res.fecha <> public.club_fecha_operacion(v_res.club_id, now()) then
    raise exception 'La reserva es para el %, no para esta noche', v_res.fecha;
  end if;
  return v_res;
end;
$$;


-- ----------------------------------------------------------------------------
-- BLOQUE 20 — Puerta: escanear y Confirmar entrada.
-- ----------------------------------------------------------------------------

-- Escanear el QR: marca "en puerta" y devuelve lo que la puerta necesita ver
-- (sin teléfono ni consumo).
create or replace function public.puerta_escanear(p_qr text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_res public.reservations%rowtype;
begin
  select id into v_id from public.reservations where qr_code = trim(p_qr);
  if v_id is null then
    raise exception 'Reserva no encontrada en tu antro';
  end if;
  v_res := public.puerta_reserva_para_escribir(v_id);

  if coalesce(v_res.puerta_estado, case when v_res.status = 'usada' then 'entro' end)
     is not distinct from 'entro' then
    raise exception 'Esta reserva ya entró';
  end if;

  if v_res.puerta_estado is null then
    update public.reservations
    set puerta_estado = 'en_puerta', en_puerta_en = now(), en_puerta_por = auth.uid()
    where id = v_res.id
    returning * into v_res;
    perform public.caja_evento(v_res.club_id, null, null, 'puerta_escanear',
      jsonb_build_object('reservation_id', v_res.id));
  end if;

  return jsonb_build_object(
    'reservation_id', v_res.id,
    'cliente_nombre', v_res.cliente_nombre,
    'personas', v_res.personas,
    'source', v_res.source,
    'rp_nombre', (select p.nombre from public.profiles p where p.id = v_res.rp_id),
    'puerta_estado', v_res.puerta_estado);
end;
$$;

-- "Confirmar entrada": único camino al check-in. Guarda la hora real de
-- entrada. Si el antro no deja pasar a alguien, no se llama y ya.
create or replace function public.puerta_confirmar_entrada(p_reservation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_res public.reservations%rowtype;
begin
  v_res := public.puerta_reserva_para_escribir(p_reservation_id);
  if v_res.puerta_estado is distinct from 'en_puerta' then
    raise exception 'Primero escanea el QR';
  end if;

  update public.reservations
  set puerta_estado = 'entro',
      status = 'usada',
      entrada_en = now(),
      entrada_por = auth.uid(),
      llegada_tarde = public.puerta_es_tarde(v_res.club_id, v_res.fecha, now())
  where id = v_res.id;

  perform public.caja_evento(v_res.club_id, null, null, 'puerta_confirmar_entrada',
    jsonb_build_object('reservation_id', v_res.id));
end;
$$;


-- (El BLOQUE 21, candado de puerta, está en sql/2026-11-20-caja-candado-puerta.sql:
--  se aplica DESPUÉS de publicar el código que usa puerta_escanear y
--  puerta_confirmar_entrada; aplicado antes, rompe el check-in de la app vieja.)


-- ----------------------------------------------------------------------------
-- BLOQUE 22 — Nómina: quién y cuándo se marcó pagado.
-- ----------------------------------------------------------------------------
alter table public.commissions
  add column pagada_en  timestamptz,
  add column pagada_por uuid references public.profiles (id);

alter table public.rp_pagos_dia
  add column pagada_en  timestamptz,
  add column pagada_por uuid references public.profiles (id);


-- ----------------------------------------------------------------------------
-- BLOQUE 23 — Nómina por semana ISO y por RP (calculada en la base).
-- Semana = lunes a domingo (ISO 8601), igual que la del desbloqueo.
-- Una comisión cae en la semana de la NOCHE de su reserva
-- (reservations.fecha, que es fecha del antro), no en la de su created_at.
-- Un pago por día cae en la semana de su fecha de asistencia.
-- Estado: 'pagada' o pendiente (pendiente y validada cuentan como pendiente).
-- No hay bono de plataforma: solo commissions.tipo = 'rp'.
-- ----------------------------------------------------------------------------

-- Lunes de una semana ISO, validando que la semana exista en ese año.
create or replace function public.nomina_lunes_iso(p_anio int, p_semana int)
returns date
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_lunes date;
begin
  if p_anio is null or p_semana is null or p_anio not between 2020 and 2100 or p_semana not between 1 and 53 then
    raise exception 'Semana inválida';
  end if;
  v_lunes := to_date(p_anio::text || '-' || lpad(p_semana::text, 2, '0') || '-1', 'IYYY-IW-ID');
  if extract(isoyear from v_lunes)::int <> p_anio then
    raise exception 'El año % no tiene semana %', p_anio, p_semana;
  end if;
  return v_lunes;
end;
$$;

-- Núcleo (interno): una fila por RP del antro o con movimientos esa semana.
create or replace function public.nomina_semana_datos(p_club_id uuid, p_lunes date, p_rp_id uuid)
returns table (
  rp_id                       uuid,
  rp_nombre                   text,
  rp_activo                   boolean,
  reservas_entraron           int,
  comisiones                  int,
  comision_pendiente_centavos bigint,
  comision_pagada_centavos    bigint,
  dias_asistidos              int,
  dia_pendiente_centavos      bigint,
  dia_pagada_centavos         bigint,
  total_pendiente_centavos    bigint,
  total_pagado_centavos       bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with
  com as (
    select c.rp_id,
           count(*)::int as n,
           coalesce(sum(round(c.monto * 100)) filter (where c.status <> 'pagada'), 0)::bigint as pend,
           coalesce(sum(round(c.monto * 100)) filter (where c.status = 'pagada'), 0)::bigint as pag
    from public.commissions c
    join public.reservations r on r.id = c.reservation_id
    where c.tipo = 'rp' and r.club_id = p_club_id and c.status <> 'anulada'
      and r.fecha between p_lunes and p_lunes + 6
    group by c.rp_id
  ),
  dia as (
    select d.rp_id,
           count(*)::int as n,
           coalesce(sum(round(d.monto * 100)) filter (where d.status <> 'pagada'), 0)::bigint as pend,
           coalesce(sum(round(d.monto * 100)) filter (where d.status = 'pagada'), 0)::bigint as pag
    from public.rp_pagos_dia d
    where d.club_id = p_club_id and d.status <> 'anulada' and d.fecha between p_lunes and p_lunes + 6
    group by d.rp_id
  ),
  res as (
    select r.rp_id,
           count(*) filter (where coalesce(r.puerta_estado, case when r.status = 'usada' then 'entro' end)
                                  is not distinct from 'entro')::int as entraron
    from public.reservations r
    where r.club_id = p_club_id and r.source = 'rp' and r.rp_id is not null
      and r.fecha between p_lunes and p_lunes + 6
    group by r.rp_id
  ),
  rps as (
    select p.id from public.profiles p where p.role = 'rp' and p.club_id = p_club_id
    union select com.rp_id from com
    union select dia.rp_id from dia
    union select res.rp_id from res
  )
  select rps.id,
         p.nombre,
         coalesce(p.activo, true),
         coalesce(res.entraron, 0),
         coalesce(com.n, 0),
         coalesce(com.pend, 0),
         coalesce(com.pag, 0),
         coalesce(dia.n, 0),
         coalesce(dia.pend, 0),
         coalesce(dia.pag, 0),
         coalesce(com.pend, 0) + coalesce(dia.pend, 0),
         coalesce(com.pag, 0) + coalesce(dia.pag, 0)
  from rps
  left join public.profiles p on p.id = rps.id
  left join com on com.rp_id = rps.id
  left join dia on dia.rp_id = rps.id
  left join res on res.rp_id = rps.id
  where rps.id is not null
    and (p_rp_id is null or rps.id = p_rp_id)
  order by p.nombre;
$$;

-- Reporte del gerente / dueño (y lectura del dueño de grupo). Staff no: no
-- ve sueldos.
create or replace function public.nomina_semana(p_club_id uuid, p_anio int, p_semana int)
returns table (
  rp_id uuid, rp_nombre text, rp_activo boolean, reservas_entraron int,
  comisiones int, comision_pendiente_centavos bigint, comision_pagada_centavos bigint,
  dias_asistidos int, dia_pendiente_centavos bigint, dia_pagada_centavos bigint,
  total_pendiente_centavos bigint, total_pagado_centavos bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (public.es_gerente_o_dueno(p_club_id) or public.club_es_dueno_grupo(p_club_id)) then
    raise exception 'Solo el gerente o el dueño ven la nómina';
  end if;
  return query
    select * from public.nomina_semana_datos(p_club_id, public.nomina_lunes_iso(p_anio, p_semana), null);
end;
$$;

-- La misma cuenta para la pestaña Nómina del RP: solo su fila.
create or replace function public.nomina_semana_mia(p_anio int, p_semana int)
returns table (
  rp_id uuid, rp_nombre text, rp_activo boolean, reservas_entraron int,
  comisiones int, comision_pendiente_centavos bigint, comision_pagada_centavos bigint,
  dias_asistidos int, dia_pendiente_centavos bigint, dia_pagada_centavos bigint,
  total_pendiente_centavos bigint, total_pagado_centavos bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_club uuid := public.current_club_id();
begin
  if auth.uid() is null or public.current_role_name() is distinct from 'rp' or v_club is null then
    raise exception 'Solo para RPs';
  end if;
  return query
    select * from public.nomina_semana_datos(v_club, public.nomina_lunes_iso(p_anio, p_semana), auth.uid());
end;
$$;

-- Marcar pagada la semana de un RP (comisiones y pagos por día). Solo
-- gerente o dueño (o admin). Deja quién y cuándo, y bitácora.
create or replace function public.nomina_marcar_pagada(p_club_id uuid, p_rp_id uuid, p_anio int, p_semana int)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lunes date := public.nomina_lunes_iso(p_anio, p_semana);
  v_com int;
  v_dia int;
begin
  if not public.es_gerente_o_dueno(p_club_id) then
    raise exception 'Solo el gerente o el dueño marcan la nómina como pagada';
  end if;

  with marcadas as (
    update public.commissions c
    set status = 'pagada', pagada_en = now(), pagada_por = auth.uid(), updated_at = now()
    from public.reservations r
    where r.id = c.reservation_id
      and c.tipo = 'rp' and c.rp_id = p_rp_id and c.status not in ('pagada', 'anulada')
      and r.club_id = p_club_id and r.fecha between v_lunes and v_lunes + 6
    returning c.id
  )
  select count(*) into v_com from marcadas;

  with marcadas as (
    update public.rp_pagos_dia d
    set status = 'pagada', pagada_en = now(), pagada_por = auth.uid()
    where d.rp_id = p_rp_id and d.club_id = p_club_id and d.status not in ('pagada', 'anulada')
      and d.fecha between v_lunes and v_lunes + 6
    returning d.id
  )
  select count(*) into v_dia from marcadas;

  perform public.caja_evento(p_club_id, null, null, 'nomina_marcar_pagada',
    jsonb_build_object('rp_id', p_rp_id, 'anio', p_anio, 'semana', p_semana,
                       'comisiones', v_com, 'pagos_dia', v_dia));
  return jsonb_build_object('comisiones', v_com, 'pagos_dia', v_dia);
end;
$$;


-- ----------------------------------------------------------------------------
-- BLOQUE 24 — Quién puede llamar qué (puerta y nómina).
-- ----------------------------------------------------------------------------
revoke all on function public.puerta_reserva_para_escribir(uuid) from public, anon, authenticated;
revoke all on function public.nomina_semana_datos(uuid, date, uuid) from public, anon, authenticated;
revoke all on function public.puerta_es_tarde(uuid, date, timestamptz) from public, anon, authenticated;

-- La bitácora de nómina (cuándo se pagó a cada RP) no la ve el staff: no ve
-- sueldos.
create policy caja_eventos_restrictiva_nomina on public.caja_eventos
  as restrictive for select to public
  using (tipo not like 'nomina%'
         or (select public.es_gerente_o_dueno(club_id))
         or (select public.club_es_dueno_grupo(club_id)));

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.es_gerente_o_dueno(uuid)',
    'public.puerta_escanear(text)',
    'public.puerta_confirmar_entrada(uuid)',
    'public.nomina_lunes_iso(int, int)',
    'public.nomina_semana(uuid, int, int)',
    'public.nomina_semana_mia(int, int)',
    'public.nomina_marcar_pagada(uuid, uuid, int, int)']
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;

