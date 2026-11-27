-- ============================================================================
-- AntroApp — Revisión de RPs (antifraude), bloque 3 de la noche 4
-- Fecha: 2026-11-27. Rollback: sql/post-junta-3/30-antifraude-rps-rollback.sql
-- Pruebas (dev): node scripts/dev/probar-fraude-dominio.mjs
--                node scripts/dev/probar-fraude.mjs
--                node scripts/dev/probar-fraude-carga.mjs
--                node scripts/dev/probar-fraude-pantalla.mjs
-- Requiere: 00-funciones-club.sql (funcion_activa), pase 1 (caja por mesa,
-- grupos, es_gerente_o_dueno, club_es_dueno_grupo) y pgcrypto (extensions).
--
-- Qué hace:
--   - 3 reglas por antro (cliente repetido entre RPs, ráfaga de reservas,
--     consumo atípico), cada una con on/off y umbrales enteros con valor por
--     defecto y límites (fraude_catalogo). Sin fila propia: la regla está
--     encendida con los valores por defecto.
--   - La detección se calcula BAJO PEDIDO (fraude_detectar), como mucho una
--     vez cada 2 minutos por antro, con datos que ya existen: reservations y
--     la caja por mesa. NO agrega triggers ni redefine funciones existentes.
--   - Las alertas no se duplican: volver a buscar actualiza la evidencia de
--     las que siguen "Por revisar", marca las que ya no se cumplen
--     (ya_no_aplica_en) y no toca las ya revisadas.
--   - Revisión: revisar → descartada | confirmada (y reabrir), siempre con
--     nota; la bitácora guarda quién, cuándo, de, a, nota y la evidencia de
--     ese momento.
--   - Quién: gerente activo del antro, su dueño, el dueño de su grupo y el
--     admin. El staff puro y los RPs no ven nada (ni sobre sí mismos).
--   - Todo detrás de la bandera por antro 'antifraude' (apagada por defecto).
--   - Las tablas no se tocan por la API: todo pasa por estas funciones.
--   - Teléfonos: la evidencia y las notas solo llevan los 4 últimos dígitos
--     (******1234); el sujeto de "cliente repetido" es un HMAC con una clave
--     de la instalación que no se lee por la API.
-- ============================================================================
begin;

-- ---------------------------------------------------------------------------
-- Catálogo fijo: reglas, parámetros, valor por defecto y límites (enteros).
-- ---------------------------------------------------------------------------
create function public.fraude_catalogo()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'cliente_repetido', jsonb_build_object(
      'dias',    jsonb_build_object('etiqueta', 'Días hacia atrás', 'defecto', 30, 'min', 1, 'max', 180),
      'min_rps', jsonb_build_object('etiqueta', 'RPs distintos', 'defecto', 2, 'min', 2, 'max', 10)),
    'rafaga', jsonb_build_object(
      'min_reservas', jsonb_build_object('etiqueta', 'Reservas', 'defecto', 8, 'min', 3, 'max', 100),
      'minutos',      jsonb_build_object('etiqueta', 'Minutos', 'defecto', 10, 'min', 1, 'max', 240)),
    'consumo_atipico', jsonb_build_object(
      'pct_bajo',          jsonb_build_object('etiqueta', '% de la mediana (bajo)', 'defecto', 20, 'min', 1, 'max', 90),
      'min_cuentas_bajas', jsonb_build_object('etiqueta', 'Cuentas bajas por semana', 'defecto', 3, 'min', 1, 'max', 50),
      'factor_alto',       jsonb_build_object('etiqueta', 'Veces la mediana (alto)', 'defecto', 5, 'min', 2, 'max', 50),
      'muestra_minima',    jsonb_build_object('etiqueta', 'Cuentas mínimas para la mediana', 'defecto', 20, 'min', 5, 'max', 1000),
      'dias_referencia',   jsonb_build_object('etiqueta', 'Días de referencia', 'defecto', 60, 'min', 7, 'max', 365)));
$$;
revoke all on function public.fraude_catalogo() from public, anon;
grant execute on function public.fraude_catalogo() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------------
create table public.fraude_reglas (
  club_id      uuid not null references public.clubs (id) on delete cascade,
  regla        text not null check (regla in ('cliente_repetido', 'rafaga', 'consumo_atipico')),
  activa       boolean not null default true,
  parametros   jsonb not null default '{}'::jsonb,
  cambiado_por uuid references public.profiles (id) on delete set null,
  cambiado_en  timestamptz not null default now(),
  primary key (club_id, regla)
);

create table public.fraude_reglas_cambios (
  id        bigint generated always as identity primary key,
  club_id   uuid not null references public.clubs (id) on delete cascade,
  regla     text not null,
  antes     jsonb,                 -- null = estaba con los valores por defecto
  despues   jsonb not null,        -- {activa, parametros}
  hecho_por uuid references public.profiles (id) on delete set null,
  hecho_en  timestamptz not null default now()
);
create index fraude_reglas_cambios_club on public.fraude_reglas_cambios (club_id, hecho_en desc);

create table public.fraude_alertas (
  id              uuid primary key default gen_random_uuid(),
  club_id         uuid not null references public.clubs (id) on delete cascade,
  regla           text not null check (regla in ('cliente_repetido', 'rafaga', 'consumo_atipico')),
  sujeto          text not null,    -- clave estable del sujeto (nunca un teléfono en claro)
  ventana_inicio  date not null,    -- noche (o lunes de la semana) de la alerta
  ventana_fin     date not null,
  rp_id           uuid references public.profiles (id) on delete set null,
  rp_ids          uuid[] not null default '{}',
  resumen         text not null,
  evidencia       jsonb not null,
  estado          text not null default 'revisar' check (estado in ('revisar', 'descartada', 'confirmada')),
  creada_en       timestamptz not null default now(),
  actualizada_en  timestamptz not null default now(),
  ya_no_aplica_en timestamptz,      -- "Por revisar" que en una búsqueda posterior ya no se cumplió
  revisada_por    uuid references public.profiles (id) on delete set null,
  revisada_en     timestamptz,
  unique (club_id, regla, sujeto, ventana_inicio)
);
create index fraude_alertas_club_ventana on public.fraude_alertas (club_id, ventana_inicio desc);
-- Cliente repetido: una sola alerta por (teléfono, RP que llega), sin
-- importar la noche; una pareja descartada no vuelve a salir.
create unique index fraude_alertas_cliente_unica on public.fraude_alertas (club_id, regla, sujeto)
  where regla = 'cliente_repetido';

create table public.fraude_alertas_cambios (
  id        bigint generated always as identity primary key,
  alerta_id uuid not null references public.fraude_alertas (id) on delete cascade,
  club_id   uuid not null references public.clubs (id) on delete cascade,
  de        text not null,
  a         text not null,
  nota      text not null,          -- ya enmascarada
  resumen   text not null,          -- lo que decía la alerta en ese momento
  evidencia jsonb not null,         -- la evidencia con la que se decidió
  hecho_por uuid references public.profiles (id) on delete set null,
  hecho_en  timestamptz not null default now()
);
create index fraude_alertas_cambios_alerta on public.fraude_alertas_cambios (alerta_id, hecho_en);

-- Última búsqueda por antro (límite de una cada 2 minutos y lo que encontró).
create table public.fraude_detecciones (
  club_id   uuid primary key references public.clubs (id) on delete cascade,
  hecho_en  timestamptz not null,
  hecho_por uuid references public.profiles (id) on delete set null,
  desde     date,
  hasta     date,
  resumen   jsonb
);

-- Clave de la instalación para el HMAC del teléfono. Solo la leen las
-- funciones (dueño postgres): ni anon, ni authenticated, ni service_role.
create table public.fraude_secreto (
  id    boolean primary key default true check (id),
  clave text not null
);
insert into public.fraude_secreto (clave) values (encode(extensions.gen_random_bytes(32), 'hex'));

-- Sin acceso directo por la API (en producción lo nuevo nace abierto a anon
-- y authenticated: se quita explícito). Todo pasa por las funciones.
alter table public.fraude_reglas enable row level security;
alter table public.fraude_reglas_cambios enable row level security;
alter table public.fraude_alertas enable row level security;
alter table public.fraude_alertas_cambios enable row level security;
alter table public.fraude_detecciones enable row level security;
alter table public.fraude_secreto enable row level security;
revoke all on public.fraude_reglas, public.fraude_reglas_cambios, public.fraude_alertas,
              public.fraude_alertas_cambios, public.fraude_detecciones
  from public, anon, authenticated;
grant all on public.fraude_reglas, public.fraude_reglas_cambios, public.fraude_alertas,
             public.fraude_alertas_cambios, public.fraude_detecciones
  to service_role;
revoke all on public.fraude_secreto from public, anon, authenticated, service_role;
revoke all on sequence public.fraude_reglas_cambios_id_seq, public.fraude_alertas_cambios_id_seq
  from public, anon, authenticated;
grant usage, select on sequence public.fraude_reglas_cambios_id_seq, public.fraude_alertas_cambios_id_seq
  to service_role;

-- ---------------------------------------------------------------------------
-- Ayudantes internos (no se llaman desde la API)
-- ---------------------------------------------------------------------------

-- Quién revisa a los RPs de un antro: el admin, su dueño, su gerente activo
-- (es_gerente_o_dueno) o el dueño de su grupo. El staff puro y el RP no.
create function public.fraude_puede_revisar(p_club_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    auth.uid() is not null
    and public.current_role_name() is not null
    and (coalesce(public.es_gerente_o_dueno(p_club_id), false)
         or coalesce(public.club_es_dueno_grupo(p_club_id), false)),
    false);
$$;
revoke all on function public.fraude_puede_revisar(uuid) from public, anon, authenticated;
grant execute on function public.fraude_puede_revisar(uuid) to service_role;

-- Autoriza primero y luego revisa la bandera. Un antro inexistente da el
-- mismo aviso que uno ajeno (no se adivina qué antros existen).
create function public.fraude_autorizar(p_club_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_club_id is null
     or not coalesce(public.fraude_puede_revisar(p_club_id), false)
     or not exists (select 1 from public.clubs c where c.id = p_club_id) then
    raise exception 'No tienes permiso para revisar a los RPs de este antro.' using errcode = 'P0001';
  end if;
  if not coalesce(public.funcion_activa(p_club_id, 'antifraude'), false) then
    raise exception 'Esta función no está activa para este antro.' using errcode = 'P0001';
  end if;
end;
$$;
revoke all on function public.fraude_autorizar(uuid) from public, anon, authenticated;
grant execute on function public.fraude_autorizar(uuid) to service_role;

-- Parámetros efectivos de una regla: los por defecto, encima los guardados.
create function public.fraude_parametros(p_club_id uuid, p_regla text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(k.key,
           coalesce(case when jsonb_typeof(r.parametros -> k.key) = 'number' then r.parametros -> k.key end,
                    k.value -> 'defecto')), '{}'::jsonb)
  from jsonb_each(public.fraude_catalogo() -> p_regla) k
  left join public.fraude_reglas r on r.club_id = p_club_id and r.regla = p_regla;
$$;
revoke all on function public.fraude_parametros(uuid, text) from public, anon, authenticated;
grant execute on function public.fraude_parametros(uuid, text) to service_role;

create function public.fraude_regla_activa(p_club_id uuid, p_regla text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select r.activa from public.fraude_reglas r where r.club_id = p_club_id and r.regla = p_regla), true);
$$;
revoke all on function public.fraude_regla_activa(uuid, text) from public, anon, authenticated;
grant execute on function public.fraude_regla_activa(uuid, text) to service_role;

-- Teléfono a 10 dígitos, tolerante a como lo teclean los RPs: se quedan
-- solo los dígitos y se quita el prefijo 52 / 521 / 044 / 045 / 01 / 1.
-- Lo que no da 10 dígitos es "ilegible" (se cuenta en el resumen).
-- Sin "set search_path" a propósito: así Postgres la mete dentro de la
-- consulta (inlining) y no paga una llamada por reserva. No es security
-- definer y solo usa funciones de pg_catalog, escritas con su esquema.
create function public.fraude_tel10(p text)
returns text
language sql
immutable
parallel safe
as $$
  select (pg_catalog.regexp_match(pg_catalog.regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g'),
                                  '^(?:521|044|045|52|01|1)?([0-9]{10})$'))[1];
$$;
revoke all on function public.fraude_tel10(text) from public, anon, authenticated;
grant execute on function public.fraude_tel10(text) to service_role;

-- "5512345678" -> "******5678".
create function public.fraude_enmascarar_tel(p_tel10 text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_tel10 is null or length(p_tel10) < 4 then null else '******' || right(p_tel10, 4) end;
$$;
revoke all on function public.fraude_enmascarar_tel(text) from public, anon, authenticated;
grant execute on function public.fraude_enmascarar_tel(text) to service_role;

-- En texto libre (notas): toda secuencia de 10 o más dígitos (con espacios,
-- guiones, puntos o paréntesis entre ellos) queda como ******1234.
create function public.fraude_enmascarar_texto(p text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := p;
  m text;
begin
  if p is null then
    return null;
  end if;
  for m in select (regexp_matches(p, '\+?[0-9](?:[ ().-]*[0-9]){9,}', 'g'))[1] loop
    v := replace(v, m, '******' || right(regexp_replace(m, '[^0-9]', '', 'g'), 4));
  end loop;
  return v;
end;
$$;
revoke all on function public.fraude_enmascarar_texto(text) from public, anon, authenticated;
grant execute on function public.fraude_enmascarar_texto(text) to service_role;

-- Nombre de un perfil SOLO si es del antro, su dueño o del grupo del antro
-- (p. ej. el dueño de grupo): nunca nombres de cuentas de otros antros. El
-- admin sale sin nombre ("Administración" en la pantalla).
create function public.fraude_nombre(p_club_id uuid, p_profile_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.nombre from public.profiles p
   where p.id = p_profile_id
     and (p.club_id = p_club_id
          or exists (select 1 from public.clubs c where c.id = p_club_id and c.dueno_id = p.id)
          or exists (select 1 from public.grupo_miembros m
                       join public.grupo_clubs gc on gc.grupo_id = m.grupo_id
                      where gc.club_id = p_club_id and m.profile_id = p.id));
$$;
revoke all on function public.fraude_nombre(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fraude_nombre(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Para la app
-- ---------------------------------------------------------------------------

-- Antros que quien llama puede revisar, con su bandera. Sin permiso (dado
-- de baja, contraseña temporal, otro rol) devuelve vacío: la pantalla
-- distingue "sin permiso" de "no está activa".
create function public.fraude_mis_antros()
returns table (club_id uuid, nombre text, zona_horaria text, activa boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.nombre, c.zona_horaria, coalesce(public.funcion_activa(c.id, 'antifraude'), false)
    from public.clubs c
   where auth.uid() is not null
     and coalesce(public.fraude_puede_revisar(c.id), false)
   order by c.nombre, c.id;
$$;
revoke all on function public.fraude_mis_antros() from public, anon;
grant execute on function public.fraude_mis_antros() to authenticated, service_role;

create function public.fraude_reglas_leer(p_club_id uuid)
returns table (regla text, activa boolean, parametros jsonb, limites jsonb, propia boolean,
               cambiado_en timestamptz, cambiado_por_nombre text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.fraude_autorizar(p_club_id);
  return query
    select k.key, public.fraude_regla_activa(p_club_id, k.key), public.fraude_parametros(p_club_id, k.key),
           k.value, r.club_id is not null, r.cambiado_en, public.fraude_nombre(p_club_id, r.cambiado_por)
      from jsonb_each(public.fraude_catalogo()) k
      left join public.fraude_reglas r on r.club_id = p_club_id and r.regla = k.key
     order by array_position(array['cliente_repetido', 'rafaga', 'consumo_atipico'], k.key);
end;
$$;
revoke all on function public.fraude_reglas_leer(uuid) from public, anon;
grant execute on function public.fraude_reglas_leer(uuid) to authenticated, service_role;

-- Guarda una regla: on/off y los umbrales que se manden (los demás se quedan
-- como estaban). Valida contra el catálogo y deja el cambio en la bitácora.
create function public.fraude_regla_guardar(p_club_id uuid, p_regla text, p_activa boolean, p_parametros jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cat jsonb := public.fraude_catalogo() -> p_regla;
  v_antes jsonb;
  v_nuevos jsonb;
  v_par record;
  v_lim jsonb;
  v_num numeric;
  v_activa boolean;
begin
  perform public.fraude_autorizar(p_club_id);
  if p_regla is null or v_cat is null then
    raise exception 'Esa regla no existe.' using errcode = 'P0001';
  end if;
  if p_parametros is not null and jsonb_typeof(p_parametros) <> 'object' then
    raise exception 'Los umbrales no son válidos.' using errcode = 'P0001';
  end if;

  v_nuevos := public.fraude_parametros(p_club_id, p_regla);
  for v_par in select key, value from jsonb_each(coalesce(p_parametros, '{}'::jsonb)) loop
    v_lim := v_cat -> v_par.key;
    if v_lim is null then
      raise exception 'Ese umbral no existe para esta regla.' using errcode = 'P0001';
    end if;
    if jsonb_typeof(v_par.value) <> 'number' then
      raise exception '«%» debe ser un número entero.', v_lim ->> 'etiqueta' using errcode = 'P0001';
    end if;
    v_num := (v_par.value #>> '{}')::numeric;
    if v_num <> trunc(v_num) then
      raise exception '«%» debe ser un número entero.', v_lim ->> 'etiqueta' using errcode = 'P0001';
    end if;
    if v_num < (v_lim ->> 'min')::numeric or v_num > (v_lim ->> 'max')::numeric then
      raise exception '«%» debe estar entre % y %.', v_lim ->> 'etiqueta', v_lim ->> 'min', v_lim ->> 'max'
        using errcode = 'P0001';
    end if;
    v_nuevos := v_nuevos || jsonb_build_object(v_par.key, v_num::bigint);
  end loop;

  select jsonb_build_object('activa', r.activa, 'parametros', public.fraude_parametros(p_club_id, p_regla))
    into v_antes
    from public.fraude_reglas r where r.club_id = p_club_id and r.regla = p_regla
    for update;
  v_activa := coalesce(p_activa, public.fraude_regla_activa(p_club_id, p_regla));

  if coalesce(v_antes, jsonb_build_object('activa', true, 'parametros', public.fraude_parametros(p_club_id, p_regla)))
     = jsonb_build_object('activa', v_activa, 'parametros', v_nuevos) then
    return;
  end if;

  insert into public.fraude_reglas (club_id, regla, activa, parametros, cambiado_por)
  values (p_club_id, p_regla, v_activa, v_nuevos, auth.uid())
  on conflict (club_id, regla) do update
    set activa = excluded.activa, parametros = excluded.parametros,
        cambiado_por = excluded.cambiado_por, cambiado_en = now();

  insert into public.fraude_reglas_cambios (club_id, regla, antes, despues, hecho_por)
  values (p_club_id, p_regla, v_antes, jsonb_build_object('activa', v_activa, 'parametros', v_nuevos), auth.uid());
end;
$$;
revoke all on function public.fraude_regla_guardar(uuid, text, boolean, jsonb) from public, anon;
grant execute on function public.fraude_regla_guardar(uuid, text, boolean, jsonb) to authenticated, service_role;

create function public.fraude_reglas_cambios_leer(p_club_id uuid, p_limite integer default 30)
returns table (id bigint, regla text, antes jsonb, despues jsonb, hecho_por_nombre text, hecho_en timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.fraude_autorizar(p_club_id);
  return query
    select c.id, c.regla, c.antes, c.despues, public.fraude_nombre(p_club_id, c.hecho_por), c.hecho_en
      from public.fraude_reglas_cambios c
     where c.club_id = p_club_id
     order by c.hecho_en desc, c.id desc
     limit greatest(1, least(coalesce(p_limite, 30), 200));
end;
$$;
revoke all on function public.fraude_reglas_cambios_leer(uuid, integer) from public, anon;
grant execute on function public.fraude_reglas_cambios_leer(uuid, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Detección bajo pedido. Para un antro y un rango de noches (máx. 63), una
-- vez cada 2 minutos por antro, evalúa las reglas encendidas y guarda las
-- alertas sin duplicar. Sin subconsultas por fila: ventanas y joins.
--
-- Definiciones exactas (también en docs/post-junta-3/fraude.md):
--   cliente_repetido  Teléfono a 10 dígitos (fraude_tel10). Una reserva de
--     RP es una "llegada" del RP X al teléfono si X no tenía otra reserva de
--     ese teléfono en los `dias` días anteriores. Hay alerta si en esa
--     llegada, contando las reservas de RP del teléfono con noche entre
--     "su noche - dias" y "su noche" (hasta esa reserva), hay al menos
--     min_rps RPs distintos. Una alerta por (teléfono, RP que llega): la
--     misma pareja no vuelve a salir (descartada o no) aunque siga
--     reservando; solo un RP nuevo hace otra alerta.
--   rafaga  Ventana: noche operativa en que se CREARON las reservas
--     (created_at, corte 08:00 en la zona del antro). Hay alerta para
--     (RP, noche) si en algún intervalo [t, t + minutos] de esa noche el RP
--     creó al menos min_reservas reservas (source = 'rp').
--   consumo_atipico  Ventana: semana. Mediana de la semana = mediana del
--     consumo (sin anulados) de TODAS las cuentas cuadradas del antro con
--     consumo > 0 cuyas noches caen en los dias_referencia días que terminan
--     el domingo de esa semana; solo si esa muestra tiene al menos
--     muestra_minima cuentas. Para cada RP, sus cuentas cuadradas con
--     consumo > 0 de esa semana: bajo si consumo < round(mediana × pct_bajo
--     / 100) (alerta con min_cuentas_bajas o más); alto si consumo >
--     mediana × factor_alto (alerta con 1 o más).
-- ---------------------------------------------------------------------------
create function public.fraude_detectar(p_club_id uuid, p_desde date, p_hasta date)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
-- Solo mientras corre esta función: sin ciclos anidados. Los CTE se estiman
-- en pocas filas y el planificador a veces cruzaba dos de 10 mil filas con
-- un ciclo anidado (cuadrático, más de 8 s); con hash/merge tarda < 3 s.
set enable_nestloop = off
as $$
declare
  v_zona text;
  v_lunes_desde date;
  v_lunes_hasta date;
  v_domingo_hasta date;
  v_p jsonb;
  v_n_det int;
  v_n_nuevas int;
  v_n_act int;
  v_n_ya_no int;
  v_res jsonb := '{}'::jsonb;
  v_avisos jsonb;
  v_i_desde timestamptz;
  v_i_hasta timestamptz;
  v_dias int;
  v_k int;
  v_min int;
  v_int interval;
  v_ult timestamptz;
  v_tels jsonb;
  v_resumen jsonb;
  v_clave text;
begin
  perform public.fraude_autorizar(p_club_id);
  if p_desde is null or p_hasta is null or p_desde > p_hasta then
    raise exception 'Elige un rango de noches válido.' using errcode = 'P0001';
  end if;
  if p_hasta - p_desde > 62 then
    raise exception 'El rango máximo es de 63 noches.' using errcode = 'P0001';
  end if;
  if p_hasta > public.club_fecha_operacion(p_club_id) + 1 then
    raise exception 'El rango no puede terminar después de mañana.' using errcode = 'P0001';
  end if;

  -- Una búsqueda por antro cada 2 minutos; dos a la vez se forman en fila.
  insert into public.fraude_detecciones (club_id, hecho_en) values (p_club_id, '-infinity')
  on conflict (club_id) do nothing;
  select d.hecho_en into v_ult from public.fraude_detecciones d where d.club_id = p_club_id for update;
  if v_ult > now() - interval '2 minutes' then
    raise exception 'Ya se buscaron alertas de este antro hace menos de 2 minutos. Intenta de nuevo en un momento.'
      using errcode = 'P0001';
  end if;

  select c.zona_horaria into v_zona from public.clubs c where c.id = p_club_id;
  v_lunes_desde := date_trunc('week', p_desde::timestamp)::date;
  v_lunes_hasta := date_trunc('week', p_hasta::timestamp)::date;
  v_domingo_hasta := v_lunes_hasta + 6;
  v_i_desde := (p_desde + time '08:00') at time zone v_zona;
  v_i_hasta := (p_hasta + 1 + time '08:00') at time zone v_zona;

  -- Teléfonos de reservas de RP del rango que no se pueden leer.
  select jsonb_build_object(
           'ilegibles', count(*) filter (where btrim(coalesce(r.cliente_telefono, '')) <> ''
                                           and public.fraude_tel10(r.cliente_telefono) is null),
           'sin_telefono', count(*) filter (where btrim(coalesce(r.cliente_telefono, '')) = ''))
    into v_tels
    from public.reservations r
   where r.club_id = p_club_id and r.source = 'rp' and r.fecha between p_desde and p_hasta;

  -- ---------------- cliente_repetido ----------------
  if public.fraude_regla_activa(p_club_id, 'cliente_repetido') then
    v_p := public.fraude_parametros(p_club_id, 'cliente_repetido');
    v_dias := (v_p ->> 'dias')::int;
    v_k := (v_p ->> 'min_rps')::int;
    -- Clave del HMAC (se lee una vez): sujeto = HMAC-SHA256(antro:teléfono),
    -- no se puede recalcular desde fuera de la base.
    select s.clave into v_clave from public.fraude_secreto s;
    with b as (
      select r.id, r.fecha, r.rp_id, r.created_at, coalesce(r.created_at, '-infinity'::timestamptz) as creada,
             r.status, p.nombre as rp_nombre, public.fraude_tel10(r.cliente_telefono) as tel
        from public.reservations r
        join public.profiles p on p.id = r.rp_id and p.club_id = p_club_id and p.role = 'rp'
       where r.club_id = p_club_id and r.source = 'rp'
         and r.fecha between p_desde - v_dias and p_hasta
    ), candidatos as (
      -- Solo teléfonos que en todo el periodo tienen min_rps RPs distintos.
      select b.tel from b where b.tel is not null group by b.tel having count(distinct b.rp_id) >= v_k
    ), bt as (
      select b.*, lag(b.fecha) over (partition by b.tel, b.rp_id order by b.fecha, b.creada, b.id) as previa_mismo_rp
        from b join candidatos c on c.tel = b.tel
    ), llegadas as (
      select * from bt
       where bt.fecha between p_desde and p_hasta
         and (bt.previa_mismo_rp is null or bt.fecha - bt.previa_mismo_rp > v_dias)
    ), det0 as (
      select e.id as llegada_id, e.tel, e.rp_id, e.fecha,
             count(distinct y.rp_id)::int as n_rps,
             array_agg(distinct y.rp_id order by y.rp_id) as rps,
             jsonb_agg(jsonb_build_object('reservation_id', y.id, 'fecha', y.fecha, 'rp_id', y.rp_id,
                                          'rp_nombre', y.rp_nombre, 'creada_en', y.created_at, 'status', y.status)
                       order by y.fecha, y.creada, y.id) as reservas
        from llegadas e
        join bt y on y.tel = e.tel and y.fecha between e.fecha - v_dias and e.fecha
                 and (y.fecha, y.creada, y.id) <= (e.fecha, e.creada, e.id)
       group by e.id, e.tel, e.rp_id, e.fecha
      having count(distinct y.rp_id) >= v_k
    ), det as (
      -- Una por (teléfono, RP que llega): la llegada más reciente del rango.
      select distinct on (d.tel, d.rp_id) d.*,
             'tel:' || encode(extensions.hmac(p_club_id::text || ':' || d.tel, v_clave, 'sha256'), 'hex') || ':' || d.rp_id as sujeto
        from det0 d
       order by d.tel, d.rp_id, d.fecha desc, d.llegada_id
    ), ins as (
      insert into public.fraude_alertas as a (club_id, regla, sujeto, ventana_inicio, ventana_fin, rp_id, rp_ids, resumen, evidencia)
      select p_club_id, 'cliente_repetido', det.sujeto, det.fecha, det.fecha, det.rp_id, det.rps,
             format('Cliente %s: llega un RP más (%s RPs distintos en %s días)',
                    public.fraude_enmascarar_tel(det.tel), det.n_rps, v_dias),
             jsonb_build_object('telefono', public.fraude_enmascarar_tel(det.tel), 'parametros', v_p,
                                'rp_nombre', (select p.nombre from public.profiles p where p.id = det.rp_id),
                                'rps_distintos', det.n_rps, 'reservas', det.reservas)
        from det
      on conflict (club_id, regla, sujeto) where regla = 'cliente_repetido' do update
        set ventana_inicio = excluded.ventana_inicio, ventana_fin = excluded.ventana_fin, rp_id = excluded.rp_id,
            rp_ids = excluded.rp_ids, resumen = excluded.resumen, evidencia = excluded.evidencia,
            actualizada_en = now(), ya_no_aplica_en = null
        where a.estado = 'revisar' and (a.evidencia is distinct from excluded.evidencia or a.ya_no_aplica_en is not null)
      returning (xmax::text = '0') as nueva
    ), ya_no as (
      update public.fraude_alertas a set ya_no_aplica_en = now()
       where a.club_id = p_club_id and a.regla = 'cliente_repetido' and a.estado = 'revisar'
         and a.ya_no_aplica_en is null and a.ventana_inicio between p_desde and p_hasta
         -- not in (subconsulta con hash), no not exists: con la estimación de
         -- 1 fila del CTE, not exists se vuelve un ciclo anidado cuadrático.
         and a.sujeto not in (select det.sujeto from det)
      returning 1
    )
    select (select count(*) from det), count(*) filter (where nueva), count(*) filter (where not nueva),
           (select count(*) from ya_no)
      into v_n_det, v_n_nuevas, v_n_act, v_n_ya_no from ins;
    v_res := v_res || jsonb_build_object('cliente_repetido', jsonb_build_object('activa', true,
      'detectadas', v_n_det, 'nuevas', v_n_nuevas, 'actualizadas', v_n_act, 'ya_no_aplican', v_n_ya_no));
  else
    v_res := v_res || jsonb_build_object('cliente_repetido', jsonb_build_object('activa', false));
  end if;

  -- ---------------- rafaga ----------------
  if public.fraude_regla_activa(p_club_id, 'rafaga') then
    v_p := public.fraude_parametros(p_club_id, 'rafaga');
    v_min := (v_p ->> 'min_reservas')::int;
    v_int := make_interval(mins => (v_p ->> 'minutos')::int);
    with r as (
      select x.id, x.rp_id, x.created_at, p.nombre as rp_nombre,
             ((x.created_at at time zone v_zona) - interval '8 hours')::date as noche
        from public.reservations x
        join public.profiles p on p.id = x.rp_id and p.club_id = p_club_id and p.role = 'rp'
       where x.club_id = p_club_id and x.source = 'rp' and x.created_at is not null
         and x.created_at >= v_i_desde and x.created_at < v_i_hasta
    ), c as (
      select r.*,
             count(*) over (partition by r.rp_id, r.noche order by r.created_at
                            range between current row and v_int following) as n,
             count(*) over (partition by r.rp_id, r.noche) as total_noche
        from r
    ), mejor as (
      select distinct on (c.rp_id, c.noche) c.rp_id, c.noche, c.rp_nombre, c.created_at as desde, c.n, c.total_noche
        from c where c.n >= v_min
       order by c.rp_id, c.noche, c.n desc, c.created_at, c.id
    ), det as (
      select m.rp_id, m.noche, m.rp_nombre, m.desde, m.n, m.total_noche,
             max(r.created_at) as hasta, jsonb_agg(r.id order by r.created_at, r.id) as ids
        from mejor m
        join r on r.rp_id = m.rp_id and r.noche = m.noche and r.created_at between m.desde and m.desde + v_int
       group by m.rp_id, m.noche, m.rp_nombre, m.desde, m.n, m.total_noche
    ), ins as (
      insert into public.fraude_alertas as a (club_id, regla, sujeto, ventana_inicio, ventana_fin, rp_id, rp_ids, resumen, evidencia)
      select p_club_id, 'rafaga', 'rp:' || det.rp_id, det.noche, det.noche, det.rp_id, array[det.rp_id],
             format('%s reservas creadas en %s min (de %s a %s)', det.n,
                    greatest(1, ceil(extract(epoch from det.hasta - det.desde) / 60))::int,
                    to_char(det.desde at time zone v_zona, 'HH24:MI'), to_char(det.hasta at time zone v_zona, 'HH24:MI')),
             jsonb_build_object('rp_nombre', det.rp_nombre, 'parametros', v_p, 'reservas', det.n,
                                'desde', det.desde, 'hasta', det.hasta, 'total_noche', det.total_noche,
                                'reservation_ids', det.ids)
        from det
      on conflict (club_id, regla, sujeto, ventana_inicio) do update
        set ventana_fin = excluded.ventana_fin, rp_id = excluded.rp_id, rp_ids = excluded.rp_ids,
            resumen = excluded.resumen, evidencia = excluded.evidencia, actualizada_en = now(), ya_no_aplica_en = null
        where a.estado = 'revisar' and (a.evidencia is distinct from excluded.evidencia or a.ya_no_aplica_en is not null)
      returning (xmax::text = '0') as nueva
    ), ya_no as (
      update public.fraude_alertas a set ya_no_aplica_en = now()
       where a.club_id = p_club_id and a.regla = 'rafaga' and a.estado = 'revisar'
         and a.ya_no_aplica_en is null and a.ventana_inicio between p_desde and p_hasta
         and (a.sujeto, a.ventana_inicio) not in (select 'rp:' || det.rp_id, det.noche from det)
      returning 1
    )
    select (select count(*) from det), count(*) filter (where nueva), count(*) filter (where not nueva),
           (select count(*) from ya_no)
      into v_n_det, v_n_nuevas, v_n_act, v_n_ya_no from ins;
    v_res := v_res || jsonb_build_object('rafaga', jsonb_build_object('activa', true,
      'detectadas', v_n_det, 'nuevas', v_n_nuevas, 'actualizadas', v_n_act, 'ya_no_aplican', v_n_ya_no));
  else
    v_res := v_res || jsonb_build_object('rafaga', jsonb_build_object('activa', false));
  end if;

  -- ---------------- consumo_atipico ----------------
  if public.fraude_regla_activa(p_club_id, 'consumo_atipico') then
    v_p := public.fraude_parametros(p_club_id, 'consumo_atipico');
    v_dias := (v_p ->> 'dias_referencia')::int;
    with cu0 as materialized (
      -- Cuentas cuadradas de las noches que hacen falta (índice caja_noches
      -- (club, fecha) y mesa_cuentas_sesion).
      select mc.id as cuenta_id, mc.rp_id, mc.reservation_id, n.fecha_operacion as fecha
        from public.caja_noches n
        join public.mesa_sesiones s on s.noche_id = n.id
        join public.mesa_cuentas mc on mc.sesion_id = s.id and mc.liquidada_en is not null
       where n.club_id = p_club_id
         and n.fecha_operacion between v_lunes_desde + 6 - (v_dias - 1) and v_domingo_hasta
    ), cu as materialized (
      -- Consumo por cuenta con el índice caja_consumos_cuenta (una búsqueda
      -- por cuenta). Un join + group by aquí puede volverse cuadrático si
      -- el planificador cree que caja_consumos es chica.
      select c.*, coalesce((select sum(cc.monto_centavos) from public.caja_consumos cc
                             where cc.cuenta_id = c.cuenta_id and not cc.anulado), 0)::bigint as consumo
        from cu0 c
    ), semanas as (
      select g::date as w from generate_series(v_lunes_desde::timestamp, v_lunes_hasta::timestamp, interval '1 week') g
    ), ref as materialized (
      -- materialized: una fila por semana, calculada UNA vez (si se mete en
      -- el join de abajo, el planificador puede recalcularla por cada cuenta).
      select s.w, count(c.cuenta_id)::int as muestra,
             -- Mediana de enteros: exacta en double; a numeric para redondear igual que la app.
             (percentile_cont(0.5) within group (order by c.consumo))::numeric as mediana
        from semanas s
        left join cu c on c.consumo > 0 and c.fecha between s.w + 6 - (v_dias - 1) and s.w + 6
       group by s.w
    ), rpc as materialized (
      select ref.w, ref.muestra, round(ref.mediana)::bigint as mediana_c,
             round(ref.mediana * (v_p ->> 'pct_bajo')::int / 100.0)::bigint as umbral_bajo,
             ref.mediana * (v_p ->> 'factor_alto')::int as umbral_alto,
             c.cuenta_id, c.rp_id, c.reservation_id, c.fecha, c.consumo, p.nombre as rp_nombre
        from ref
        join cu c on c.fecha between ref.w and ref.w + 6 and c.consumo > 0 and c.rp_id is not null
        join public.profiles p on p.id = c.rp_id and p.club_id = p_club_id and p.role = 'rp'
       where ref.muestra >= (v_p ->> 'muestra_minima')::int
    ), por_rp as (
      select rpc.w, rpc.rp_id, count(*)::int as n from rpc group by rpc.w, rpc.rp_id
    ), tipos as (
      select rpc.*, case when rpc.consumo < rpc.umbral_bajo then 'bajo'
                         when rpc.consumo > rpc.umbral_alto then 'alto' end as tipo
        from rpc
    ), det as (
      select t.w, t.rp_id, t.rp_nombre, t.tipo, t.muestra, t.mediana_c, t.umbral_bajo,
             ceil(t.umbral_alto)::bigint as umbral_alto_c, count(*)::int as n,
             'rp:' || t.rp_id || ':' || t.tipo as sujeto,
             jsonb_agg(jsonb_build_object('cuenta_id', t.cuenta_id, 'reservation_id', t.reservation_id,
                                          'fecha', t.fecha, 'consumo_centavos', t.consumo)
                       order by t.fecha, t.consumo, t.cuenta_id) as cuentas
        from tipos t
       where t.tipo is not null
       group by t.w, t.rp_id, t.rp_nombre, t.tipo, t.muestra, t.mediana_c, t.umbral_bajo, t.umbral_alto
      having (t.tipo = 'bajo' and count(*) >= (v_p ->> 'min_cuentas_bajas')::int) or t.tipo = 'alto'
    ), ins as (
      insert into public.fraude_alertas as a (club_id, regla, sujeto, ventana_inicio, ventana_fin, rp_id, rp_ids, resumen, evidencia)
      select p_club_id, 'consumo_atipico', det.sujeto, det.w, det.w + 6, det.rp_id, array[det.rp_id],
             case when det.tipo = 'bajo'
                  then format('%s cuentas con consumo menor a $%s (%s%% de la mediana del antro, $%s)', det.n,
                              to_char(det.umbral_bajo / 100.0, 'FM999,999,990.00'), v_p ->> 'pct_bajo',
                              to_char(det.mediana_c / 100.0, 'FM999,999,990.00'))
                  else format('%s cuenta(s) con consumo mayor a %s veces la mediana del antro ($%s)', det.n,
                              v_p ->> 'factor_alto', to_char(det.mediana_c / 100.0, 'FM999,999,990.00')) end,
             jsonb_build_object('tipo', det.tipo, 'rp_nombre', det.rp_nombre, 'parametros', v_p,
                                'mediana_centavos', det.mediana_c, 'muestra', det.muestra,
                                'umbral_centavos', case when det.tipo = 'bajo' then det.umbral_bajo else det.umbral_alto_c end,
                                'cuentas_rp_semana', (select pr.n from por_rp pr where pr.w = det.w and pr.rp_id = det.rp_id),
                                'cuentas', det.cuentas)
        from det
      on conflict (club_id, regla, sujeto, ventana_inicio) do update
        set ventana_fin = excluded.ventana_fin, rp_id = excluded.rp_id, rp_ids = excluded.rp_ids,
            resumen = excluded.resumen, evidencia = excluded.evidencia, actualizada_en = now(), ya_no_aplica_en = null
        where a.estado = 'revisar' and (a.evidencia is distinct from excluded.evidencia or a.ya_no_aplica_en is not null)
      returning (xmax::text = '0') as nueva
    ), ya_no as (
      update public.fraude_alertas a set ya_no_aplica_en = now()
       where a.club_id = p_club_id and a.regla = 'consumo_atipico' and a.estado = 'revisar'
         and a.ya_no_aplica_en is null and a.ventana_inicio between v_lunes_desde and v_lunes_hasta
         and (a.sujeto, a.ventana_inicio) not in (select det.sujeto, det.w from det)
      returning 1
    )
    select (select count(*) from det), count(*) filter (where nueva), count(*) filter (where not nueva),
           (select count(*) from ya_no),
           (select coalesce(jsonb_agg(jsonb_build_object('semana', ref.w, 'muestra', ref.muestra) order by ref.w), '[]'::jsonb)
              from ref where ref.muestra < (v_p ->> 'muestra_minima')::int)
      into v_n_det, v_n_nuevas, v_n_act, v_n_ya_no, v_avisos from ins;
    v_res := v_res || jsonb_build_object('consumo_atipico', jsonb_build_object('activa', true,
      'detectadas', v_n_det, 'nuevas', v_n_nuevas, 'actualizadas', v_n_act, 'ya_no_aplican', v_n_ya_no,
      'semanas_sin_muestra', v_avisos));
  else
    v_res := v_res || jsonb_build_object('consumo_atipico', jsonb_build_object('activa', false));
  end if;

  v_resumen := jsonb_build_object('desde', p_desde, 'hasta', p_hasta, 'telefonos', v_tels, 'reglas', v_res);
  update public.fraude_detecciones
     set hecho_en = now(), hecho_por = auth.uid(), desde = p_desde, hasta = p_hasta, resumen = v_resumen
   where club_id = p_club_id;
  return v_resumen;
end;
$$;
revoke all on function public.fraude_detectar(uuid, date, date) from public, anon;
grant execute on function public.fraude_detectar(uuid, date, date) to authenticated, service_role;

-- Última búsqueda del antro (para mostrarla al abrir, sin volver a buscar).
create function public.fraude_ultima_deteccion(p_club_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_d public.fraude_detecciones%rowtype;
begin
  perform public.fraude_autorizar(p_club_id);
  select * into v_d from public.fraude_detecciones where club_id = p_club_id and hecho_en > '-infinity';
  if not found then
    return null;
  end if;
  return jsonb_build_object('hecho_en', v_d.hecho_en, 'hecho_por_nombre', public.fraude_nombre(p_club_id, v_d.hecho_por),
                            'desde', v_d.desde, 'hasta', v_d.hasta, 'resumen', v_d.resumen,
                            'siguiente_en', v_d.hecho_en + interval '2 minutes');
end;
$$;
revoke all on function public.fraude_ultima_deteccion(uuid) from public, anon;
grant execute on function public.fraude_ultima_deteccion(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Revisión
-- ---------------------------------------------------------------------------
create function public.fraude_alertas_listar(
  p_club_id uuid, p_estado text default null, p_regla text default null, p_rp_id uuid default null,
  p_desde date default null, p_hasta date default null, p_limite integer default 100, p_desplazamiento integer default 0)
returns table (id uuid, regla text, estado text, ventana_inicio date, ventana_fin date, rp_id uuid,
               rp_nombre text, rp_nombres text[], resumen text, creada_en timestamptz,
               actualizada_en timestamptz, ya_no_aplica_en timestamptz, revisada_en timestamptz,
               revisada_por_nombre text, total bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.fraude_autorizar(p_club_id);
  if p_estado is not null and p_estado not in ('revisar', 'descartada', 'confirmada') then
    raise exception 'Ese estado no existe.' using errcode = 'P0001';
  end if;
  if p_regla is not null and (public.fraude_catalogo() -> p_regla) is null then
    raise exception 'Esa regla no existe.' using errcode = 'P0001';
  end if;
  return query
    select a.id, a.regla, a.estado, a.ventana_inicio, a.ventana_fin, a.rp_id,
           public.fraude_nombre(p_club_id, a.rp_id),
           coalesce((select array_agg(coalesce(public.fraude_nombre(p_club_id, u.x), 'RP') order by u.o)
                       from unnest(a.rp_ids) with ordinality u(x, o)), '{}'::text[]),
           a.resumen, a.creada_en, a.actualizada_en, a.ya_no_aplica_en, a.revisada_en,
           public.fraude_nombre(p_club_id, a.revisada_por),
           count(*) over ()
      from public.fraude_alertas a
     where a.club_id = p_club_id
       and (p_estado is null or a.estado = p_estado)
       and (p_regla is null or a.regla = p_regla)
       and (p_rp_id is null or p_rp_id = any (a.rp_ids))
       and (p_desde is null or a.ventana_fin >= p_desde)
       and (p_hasta is null or a.ventana_inicio <= p_hasta)
     order by a.ventana_inicio desc, a.creada_en desc, a.id
     limit greatest(1, least(coalesce(p_limite, 100), 200))
    offset greatest(0, coalesce(p_desplazamiento, 0));
end;
$$;
revoke all on function public.fraude_alertas_listar(uuid, text, text, uuid, date, date, integer, integer) from public, anon;
grant execute on function public.fraude_alertas_listar(uuid, text, text, uuid, date, date, integer, integer) to authenticated, service_role;

-- RPs que aparecen en las alertas del antro (para el filtro).
create function public.fraude_alertas_rps(p_club_id uuid)
returns table (rp_id uuid, nombre text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.fraude_autorizar(p_club_id);
  return query
    select distinct u.x, public.fraude_nombre(p_club_id, u.x)
      from public.fraude_alertas a cross join unnest(a.rp_ids) u(x)
     where a.club_id = p_club_id and public.fraude_nombre(p_club_id, u.x) is not null
     order by 2, 1;
end;
$$;
revoke all on function public.fraude_alertas_rps(uuid) from public, anon;
grant execute on function public.fraude_alertas_rps(uuid) to authenticated, service_role;

-- Detalle con evidencia y bitácora (con la evidencia de cada decisión).
-- Alerta inexistente o ajena: mismo aviso.
create function public.fraude_alerta_detalle(p_alerta_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_a public.fraude_alertas%rowtype;
begin
  select * into v_a from public.fraude_alertas where id = p_alerta_id;
  if not found or not coalesce(public.fraude_puede_revisar(v_a.club_id), false) then
    raise exception 'Esa alerta no existe o no es de tu antro.' using errcode = 'P0001';
  end if;
  perform public.fraude_autorizar(v_a.club_id);
  return jsonb_build_object(
    'id', v_a.id, 'club_id', v_a.club_id, 'regla', v_a.regla, 'estado', v_a.estado,
    'ventana_inicio', v_a.ventana_inicio, 'ventana_fin', v_a.ventana_fin,
    'rp_id', v_a.rp_id, 'rp_nombre', public.fraude_nombre(v_a.club_id, v_a.rp_id),
    'resumen', v_a.resumen, 'evidencia', v_a.evidencia,
    'creada_en', v_a.creada_en, 'actualizada_en', v_a.actualizada_en, 'ya_no_aplica_en', v_a.ya_no_aplica_en,
    'revisada_en', v_a.revisada_en, 'revisada_por_nombre', public.fraude_nombre(v_a.club_id, v_a.revisada_por),
    'cambios', coalesce((
      select jsonb_agg(jsonb_build_object('de', c.de, 'a', c.a, 'nota', c.nota, 'resumen', c.resumen,
                                          'evidencia', c.evidencia,
                                          'hecho_por_nombre', public.fraude_nombre(v_a.club_id, c.hecho_por),
                                          'hecho_en', c.hecho_en) order by c.hecho_en, c.id)
        from public.fraude_alertas_cambios c where c.alerta_id = v_a.id), '[]'::jsonb));
end;
$$;
revoke all on function public.fraude_alerta_detalle(uuid) from public, anon;
grant execute on function public.fraude_alerta_detalle(uuid) to authenticated, service_role;

-- revisar → descartada | confirmada, o reabrir (→ revisar). Nota obligatoria
-- (se guarda enmascarada) y foto de la evidencia de ese momento.
create function public.fraude_alerta_cambiar(p_alerta_id uuid, p_estado text, p_nota text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_a public.fraude_alertas%rowtype;
  v_nota text := btrim(coalesce(p_nota, ''));
begin
  select * into v_a from public.fraude_alertas where id = p_alerta_id for update;
  if not found or not coalesce(public.fraude_puede_revisar(v_a.club_id), false) then
    raise exception 'Esa alerta no existe o no es de tu antro.' using errcode = 'P0001';
  end if;
  perform public.fraude_autorizar(v_a.club_id);
  if p_estado is null or p_estado not in ('revisar', 'descartada', 'confirmada') then
    raise exception 'Ese estado no existe.' using errcode = 'P0001';
  end if;
  if char_length(v_nota) < 5 then
    raise exception 'Escribe una nota de al menos 5 caracteres.' using errcode = 'P0001';
  end if;
  if char_length(v_nota) > 1000 then
    raise exception 'La nota no puede pasar de 1000 caracteres.' using errcode = 'P0001';
  end if;
  if v_a.estado = p_estado then
    raise exception 'La alerta ya está en ese estado.' using errcode = 'P0001';
  end if;
  if not coalesce((v_a.estado = 'revisar' and p_estado in ('descartada', 'confirmada'))
                  or (v_a.estado in ('descartada', 'confirmada') and p_estado = 'revisar'), false) then
    raise exception 'Primero vuelve a poner la alerta en revisión.' using errcode = 'P0001';
  end if;

  update public.fraude_alertas
     set estado = p_estado,
         revisada_por = case when p_estado = 'revisar' then null else auth.uid() end,
         revisada_en = case when p_estado = 'revisar' then null else now() end
   where id = v_a.id;
  insert into public.fraude_alertas_cambios (alerta_id, club_id, de, a, nota, resumen, evidencia, hecho_por)
  values (v_a.id, v_a.club_id, v_a.estado, p_estado, public.fraude_enmascarar_texto(v_nota),
          v_a.resumen, v_a.evidencia, auth.uid());
end;
$$;
revoke all on function public.fraude_alerta_cambiar(uuid, text, text) from public, anon;
grant execute on function public.fraude_alerta_cambiar(uuid, text, text) to authenticated, service_role;

commit;
