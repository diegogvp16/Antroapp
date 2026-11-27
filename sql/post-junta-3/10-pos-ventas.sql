-- ============================================================================
-- AntroApp — Ventas del POS: importar, ligar a mesa y cuenta, y conciliar
-- con la caja (noche 4, bloque 1, rama n4-pos)
-- Fecha: 2026-11-27 (revisión 2). Estado: APLICADO Y PROBADO EN DEV. En
-- producción NO.
-- Rollback: sql/post-junta-3/10-pos-ventas-rollback.sql
-- Pruebas (dev): node scripts/dev/probar-pos.mjs y probar-pos-carga.mjs
-- Requiere: sql/post-junta-3/00-funciones-club.sql (bandera pos_ventas) y la
-- caja por mesa (caja_noches, mesa_sesiones, mesa_cuentas, caja_consumos).
--
-- Qué hace:
--   - pos_mapeos: mapeos de columnas guardados por antro (nombre + config).
--   - pos_importaciones: una fila por archivo importado (hash SHA-256 del
--     archivo: el mismo archivo no entra dos veces).
--   - pos_importacion_lineas: qué llaves de línea trajo cada archivo
--     (también las que se saltaron por repetidas). Deshacer un archivo
--     conserva las líneas que también trae otro archivo vigente.
--   - pos_ventas: una fila por línea de venta del POS, con su llave
--     (clave): la misma línea no entra dos veces aunque venga en otro
--     archivo. Ligada (o no) a mesa, noche, sesión y cuenta de la caja.
--   - Funciones para preparar (vista previa), importar (todo o nada),
--     deshacer, asignar o quitar cuenta, volver a ligar, conciliar por
--     noche y administrar los mapeos.
--
-- Lo que NO hace, a propósito: no crea caja_consumos ni toca totales de
-- caja, comisiones ni nómina. Las ventas del POS son un registro aparte,
-- solo para comparar. Si la caja se borra (limpieza de demo o de pruebas),
-- las ventas se quedan y solo pierden la liga (on delete set null).
--
-- Rendimiento: la validación y la liga son por conjuntos (una consulta para
-- todas las líneas), no línea por línea: 5,000 líneas en un antro de 50
-- mesas caben con holgura en los 8 s de statement_timeout de authenticated
-- (medido: scripts/dev/probar-pos-carga.mjs).
--
-- Quién: admin, dueño del antro, dueño del grupo del antro y gerente del
-- antro (activos, sin contraseña temporal). El staff puro, RP y cliente no.
-- Todo detrás de la bandera pos_ventas del antro (apagada por defecto).
-- Nadie toca las tablas directo por la API: solo por estas funciones.
-- ============================================================================
begin;

-- ----------------------------------------------------------------------------
-- 1. Tablas
-- ----------------------------------------------------------------------------
create table public.pos_mapeos (
  id              uuid primary key default gen_random_uuid(),
  club_id         uuid not null references public.clubs (id) on delete cascade,
  nombre          text not null check (char_length(btrim(nombre)) between 1 and 60),
  config          jsonb not null check (jsonb_typeof(config) = 'object' and pg_column_size(config) <= 8000),
  creado_por      uuid references public.profiles (id) on delete set null,
  creado_en       timestamptz not null default now(),
  actualizado_por uuid references public.profiles (id) on delete set null,
  actualizado_en  timestamptz not null default now()
);
create unique index pos_mapeos_nombre on public.pos_mapeos (club_id, lower(btrim(nombre)));

create table public.pos_importaciones (
  id                uuid primary key default gen_random_uuid(),
  club_id           uuid not null references public.clubs (id) on delete cascade,
  archivo_nombre    text not null check (char_length(archivo_nombre) between 1 and 200),
  archivo_hash      text not null check (archivo_hash ~ '^[0-9a-f]{64}$'),
  formato           text not null check (formato in ('csv', 'xlsx')),
  mapeo_id          uuid references public.pos_mapeos (id) on delete set null,
  lineas_archivo    int not null check (lineas_archivo >= 0),
  lineas_nuevas     int not null check (lineas_nuevas >= 0),
  lineas_repetidas  int not null check (lineas_repetidas >= 0),
  total_centavos    bigint not null,           -- suma de las líneas nuevas
  noches            date[] not null default '{}',  -- noches de las ventas del archivo
  importado_por     uuid references public.profiles (id) on delete set null,
  importado_en      timestamptz not null default now(),
  deshecha_por      uuid references public.profiles (id) on delete set null,
  deshecha_en       timestamptz,
  motivo_deshacer   text check (char_length(motivo_deshacer) <= 300),
  check ((deshecha_en is null) = (motivo_deshacer is null))
);
-- El mismo archivo no se importa dos veces (salvo que se haya deshecho).
create unique index pos_importaciones_hash on public.pos_importaciones (club_id, archivo_hash) where deshecha_en is null;
create index pos_importaciones_club on public.pos_importaciones (club_id, importado_en desc);

-- Llaves que trajo cada archivo (nuevas y repetidas). Al deshacer un
-- archivo, una línea que también trae otro archivo vigente pasa a ese.
create table public.pos_importacion_lineas (
  importacion_id  uuid not null references public.pos_importaciones (id) on delete cascade,
  club_id         uuid not null references public.clubs (id) on delete cascade,
  clave           text not null check (clave ~ '^[0-9a-f]{64}$'),
  primary key (importacion_id, clave)
);
create index pos_importacion_lineas_clave on public.pos_importacion_lineas (club_id, clave);

create table public.pos_ventas (
  id                        uuid primary key default gen_random_uuid(),
  club_id                   uuid not null references public.clubs (id) on delete cascade,
  importacion_id            uuid not null references public.pos_importaciones (id) on delete cascade,
  linea                     int not null check (linea >= 1),
  clave                     text not null check (clave ~ '^[0-9a-f]{64}$'),
  ticket                    text not null check (char_length(ticket) between 1 and 60),
  fecha_hora_local          timestamp not null,     -- como viene en el archivo (hora del antro)
  fecha_hora                timestamptz not null,   -- el mismo instante con la zona del antro
  fecha_operacion           date not null,          -- noche (corte 08:00, como club_fecha_operacion)
  mesa_texto                text check (char_length(mesa_texto) <= 60),
  cuenta_texto              text check (char_length(cuenta_texto) <= 60),
  producto                  text not null check (char_length(producto) between 1 and 120),
  cantidad                  numeric(12, 3) not null,
  precio_unitario_centavos  bigint check (precio_unitario_centavos between -100000000 and 100000000),
  total_centavos            bigint not null check (total_centavos between -100000000 and 100000000),
  metodo_pago               text check (char_length(metodo_pago) <= 40),
  mesero                    text check (char_length(mesero) <= 80),
  -- Ligas con la caja: si la caja se borra (limpieza de demo o de pruebas),
  -- la venta se queda y solo pierde la liga (pos_ventas_caja_borrada).
  mesa_id                   uuid references public.club_tables (id) on delete set null,
  noche_id                  uuid references public.caja_noches (id) on delete set null,
  sesion_id                 uuid references public.mesa_sesiones (id) on delete set null,
  cuenta_id                 uuid references public.mesa_cuentas (id) on delete set null,
  liga                      text not null check (liga in ('auto', 'manual', 'ninguna')),
  estado_liga               text not null check (estado_liga in (
                              'ligada', 'varias_cuentas', 'varias_sesiones', 'sin_cuenta', 'sin_sesion',
                              'sin_noche', 'mesa_desconocida', 'mesa_ambigua', 'sin_mesa', 'desligada',
                              'caja_borrada')),
  ligada_por                uuid references public.profiles (id) on delete set null,
  ligada_en                 timestamptz,
  check ((cuenta_id is not null) = (estado_liga = 'ligada')),
  check ((liga = 'ninguna') = (cuenta_id is null))
);
-- La misma línea no entra dos veces en el antro.
create unique index pos_ventas_clave on public.pos_ventas (club_id, clave);
create index pos_ventas_noche on public.pos_ventas (club_id, fecha_operacion);
create index pos_ventas_importacion on public.pos_ventas (importacion_id);
create index pos_ventas_cuenta on public.pos_ventas (cuenta_id) where cuenta_id is not null;
create index pos_ventas_sesion on public.pos_ventas (sesion_id) where sesion_id is not null;
create index pos_ventas_noche_id on public.pos_ventas (noche_id) where noche_id is not null;

-- Cuando la caja borra la cuenta, el «on delete set null» deja la venta sin
-- cuenta: aquí se marca como «caja_borrada» (sin liga) para que los check
-- de arriba sigan valiendo. Corre antes de los check.
create function public.pos_ventas_caja_borrada()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.cuenta_id is not null and new.cuenta_id is null and new.estado_liga = 'ligada' then
    new.estado_liga := 'caja_borrada';
    new.liga := 'ninguna';
    new.ligada_por := null;
    new.ligada_en := null;
  end if;
  return new;
end;
$$;
revoke all on function public.pos_ventas_caja_borrada() from public, anon, authenticated;
create trigger pos_ventas_caja_borrada before update on public.pos_ventas
  for each row execute function public.pos_ventas_caja_borrada();

-- Sin acceso directo por la API (en producción lo nuevo nace abierto a anon
-- y authenticated: se quita explícito). Todo pasa por las funciones.
alter table public.pos_mapeos enable row level security;
alter table public.pos_importaciones enable row level security;
alter table public.pos_importacion_lineas enable row level security;
alter table public.pos_ventas enable row level security;
revoke all on public.pos_mapeos, public.pos_importaciones, public.pos_importacion_lineas, public.pos_ventas
  from public, anon, authenticated;
grant all on public.pos_mapeos, public.pos_importaciones, public.pos_importacion_lineas, public.pos_ventas to service_role;


-- ----------------------------------------------------------------------------
-- 2. Ayudantes internos (solo los llaman otras funciones de la base)
-- ----------------------------------------------------------------------------

-- ¿Quien llama puede usar las ventas del POS de este antro? Admin, dueño,
-- dueño del grupo o gerente del antro, con perfil activo y sin contraseña
-- temporal (current_role_name() nulo = no).
create function public.pos_puede_usar(p_club_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or p_club_id is null or public.current_role_name() is null then
    return false;
  end if;
  return coalesce(public.es_gerente_o_dueno(p_club_id), false)
      or coalesce(public.club_es_dueno_grupo(p_club_id), false);
end;
$$;
revoke all on function public.pos_puede_usar(uuid) from public, anon, authenticated;
grant execute on function public.pos_puede_usar(uuid) to service_role;

-- Autoriza (primero) y revisa la bandera del antro. Lanza el aviso si no.
create function public.pos_exigir(p_club_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not coalesce(public.pos_puede_usar(p_club_id), false) then
    raise exception 'Solo el gerente, el dueño o el admin de este antro pueden usar las ventas del POS.' using errcode = 'P0001';
  end if;
  if not coalesce(public.funcion_activa(p_club_id, 'pos_ventas'), false) then
    raise exception 'Esta función no está activa para este antro.' using errcode = 'P0001';
  end if;
end;
$$;
revoke all on function public.pos_exigir(uuid) from public, anon, authenticated;
grant execute on function public.pos_exigir(uuid) to service_role;

-- Llave de mesa tolerante: minúsculas, sin espacios de más, sin «mesa»,
-- «mesa no.», «no.», «#» ni «m» delante de un número, y sin ceros a la
-- izquierda («Mesa 05» = «5», «M-12» no se toca). Se usa solo si el texto
-- exacto (sin mayúsculas ni orillas) no encuentra mesa.
create function public.pos_clave_mesa(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(lower(btrim(coalesce(p, ''))), '\s+', ' ', 'g'),
          '^(mesa(\s*no\.?)?|no\.|#)\s*', ''),
        '^m\s*(?=\d)', ''),
      '^0+(?=\d)', ''),
    '');
$$;
revoke all on function public.pos_clave_mesa(text) from public, anon, authenticated;
grant execute on function public.pos_clave_mesa(text) to service_role;

-- Valida y normaliza las líneas que manda la pantalla. TODO o NADA: la
-- primera línea mala (en orden del archivo) detiene todo con «Línea N: …».
-- p_lineas: [ { linea, ticket, fecha_hora: 'AAAA-MM-DDTHH:MM[:SS]' (hora del
--   antro), mesa?, cuenta?, producto, cantidad?, precio_unitario_centavos?,
--   total_centavos, metodo_pago?, mesero?, cuenta_id? (asignación a mano) } ]
-- La llave (o_clave) sale de los campos de la venta más la ocurrencia:
-- dos líneas idénticas del mismo archivo son dos ventas (1.ª y 2.ª), y la
-- misma línea en otro archivo da la misma llave.
-- Todo por conjuntos (sin bucle por línea).
create function public.pos_leer_lineas(p_club_id uuid, p_lineas jsonb)
returns table (o_linea int, o_ticket text, o_local timestamp, o_instante timestamptz, o_fecha date,
               o_mesa text, o_cuenta text, o_producto text, o_cantidad numeric, o_precio bigint,
               o_total bigint, o_metodo text, o_mesero text, o_cuenta_id uuid, o_clave text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_zona   text;
  v_max    timestamp;
  v_error  text;
begin
  select c.zona_horaria into v_zona from public.clubs c where c.id = p_club_id;
  if v_zona is null then
    raise exception 'Ese antro no existe.' using errcode = 'P0001';
  end if;
  if p_lineas is null or jsonb_typeof(p_lineas) <> 'array' or jsonb_array_length(p_lineas) = 0 then
    raise exception 'El archivo no trae ventas.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_lineas) > 5000 then
    raise exception 'Máximo 5,000 líneas por importación (vienen %). Parte el archivo por noche.', jsonb_array_length(p_lineas) using errcode = 'P0001';
  end if;
  v_max := (now() at time zone v_zona) + interval '1 day';

  -- Primera línea con problema (las condiciones del CASE van en orden: un
  -- cast solo se evalúa si las anteriores ya revisaron el texto).
  with e as (
    select x.pos, x.v,
           case when jsonb_typeof(x.v) = 'object' and (x.v ->> 'linea') ~ '^[0-9]{1,7}$'
                     and jsonb_typeof(x.v -> 'linea') = 'number' then (x.v ->> 'linea')::int end as n
      from jsonb_array_elements(p_lineas) with ordinality as x(v, pos)
  ), fm as (
    select e.*, regexp_match(e.v ->> 'fecha_hora', '^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$') as fh
      from e
  ), f as (
    select fm.*,
           case when jsonb_typeof(fm.v -> 'ticket') not in ('string', 'null') then 'ticket'
                when jsonb_typeof(fm.v -> 'mesa') not in ('string', 'null') then 'mesa'
                when jsonb_typeof(fm.v -> 'cuenta') not in ('string', 'null') then 'cuenta'
                when jsonb_typeof(fm.v -> 'producto') not in ('string', 'null') then 'producto'
                when jsonb_typeof(fm.v -> 'metodo_pago') not in ('string', 'null') then 'metodo_pago'
                when jsonb_typeof(fm.v -> 'mesero') not in ('string', 'null') then 'mesero' end as no_texto,
           case when char_length(btrim(fm.v ->> 'ticket')) > 60 then 'ticket:60'
                when char_length(btrim(fm.v ->> 'mesa')) > 60 then 'mesa:60'
                when char_length(btrim(fm.v ->> 'cuenta')) > 60 then 'cuenta:60'
                when char_length(btrim(fm.v ->> 'producto')) > 120 then 'producto:120'
                when char_length(btrim(fm.v ->> 'metodo_pago')) > 40 then 'metodo_pago:40'
                when char_length(btrim(fm.v ->> 'mesero')) > 80 then 'mesero:80' end as largo,
           fm.fh[1]::int as a, fm.fh[2]::int as m, fm.fh[3]::int as d, fm.fh[4]::int as hh, fm.fh[5]::int as mi,
           coalesce(fm.fh[6]::int, 0) as ss
      from fm
  ), r as (
    select f.pos, case
      when jsonb_typeof(f.v) <> 'object' then format('Línea %s: no es una venta.', f.pos)
      when f.n is null or f.n < 1 then format('Venta %s: falta el número de línea.', f.pos)
      when f.no_texto is not null then format('Línea %s: «%s» debe ser texto.', f.n, f.no_texto)
      when f.largo is not null then format('Línea %s: «%s» tiene más de %s caracteres.', f.n, split_part(f.largo, ':', 1), split_part(f.largo, ':', 2))
      when btrim(coalesce(f.v ->> 'ticket', '')) = '' then format('Línea %s: falta el ticket o folio.', f.n)
      when btrim(coalesce(f.v ->> 'producto', '')) = '' then format('Línea %s: falta el producto.', f.n)
      when f.fh is null
        then format('Línea %s: falta la fecha y hora, o no tiene el formato AAAA-MM-DDTHH:MM.', f.n)
      -- (En SQL el orden de un OR no está garantizado: cada cast va en su
      -- propio WHEN, después del WHEN que revisa el texto.)
      when f.a < 2020 or f.a > 2999 or f.m < 1 or f.m > 12 or f.d < 1 or f.hh > 23 or f.mi > 59 or f.ss > 59
        then format('Línea %s: la fecha y hora «%s» no existe o está fuera de rango.', f.n, f.v ->> 'fecha_hora')
      when f.d > extract(day from (make_date(f.a, f.m, 1) + interval '1 month - 1 day'))
        then format('Línea %s: la fecha y hora «%s» no existe o está fuera de rango.', f.n, f.v ->> 'fecha_hora')
      when (f.v ->> 'fecha_hora')::timestamp > v_max
        then format('Línea %s: la fecha %s está fuera de rango (no se aceptan fechas futuras).', f.n, f.v ->> 'fecha_hora')
      when coalesce(jsonb_typeof(f.v -> 'total_centavos'), 'null') <> 'number' or coalesce(f.v ->> 'total_centavos', '') !~ '^-?[0-9]{1,9}$'
        then format('Línea %s: el total debe ser un entero en centavos de hasta $1,000,000.', f.n)
      when abs((f.v ->> 'total_centavos')::bigint) > 100000000
        then format('Línea %s: el total debe ser un entero en centavos de hasta $1,000,000.', f.n)
      when coalesce(jsonb_typeof(f.v -> 'precio_unitario_centavos'), 'null') not in ('null', 'number')
           or (jsonb_typeof(f.v -> 'precio_unitario_centavos') = 'number' and (f.v ->> 'precio_unitario_centavos') !~ '^-?[0-9]{1,9}$')
        then format('Línea %s: el precio unitario debe ser un entero en centavos.', f.n)
      when jsonb_typeof(f.v -> 'precio_unitario_centavos') = 'number' and abs((f.v ->> 'precio_unitario_centavos')::bigint) > 100000000
        then format('Línea %s: el precio unitario debe ser un entero en centavos.', f.n)
      when coalesce(jsonb_typeof(f.v -> 'cantidad'), 'null') not in ('null', 'number')
           or (jsonb_typeof(f.v -> 'cantidad') = 'number' and (f.v ->> 'cantidad') !~ '^-?[0-9]{1,6}(\.[0-9]{1,3})?$')
        then format('Línea %s: la cantidad debe ser un número con hasta 3 decimales.', f.n)
      when jsonb_typeof(f.v -> 'cantidad') = 'number' and ((f.v ->> 'cantidad')::numeric = 0 or abs((f.v ->> 'cantidad')::numeric) > 10000)
        then format('Línea %s: la cantidad va de -10,000 a 10,000 y no puede ser 0.', f.n)
      when coalesce(jsonb_typeof(f.v -> 'cuenta_id'), 'null') <> 'null'
           and (jsonb_typeof(f.v -> 'cuenta_id') <> 'string'
                or (f.v ->> 'cuenta_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
        then format('Línea %s: la cuenta elegida no es válida.', f.n)
      end as error
      from f
  )
  select r.error into v_error from r where r.error is not null order by r.pos limit 1;
  if v_error is not null then
    raise exception '%', v_error using errcode = 'P0001';
  end if;

  if exists (select 1 from jsonb_array_elements(p_lineas) e group by (e ->> 'linea') having count(*) > 1) then
    raise exception 'Hay números de línea repetidos en el archivo.' using errcode = 'P0001';
  end if;

  -- Ya validado: normalizar en una sola consulta. La noche es la misma
  -- cuenta que club_fecha_operacion (hora local del antro − 8 h).
  return query
  with l as (
    select (e ->> 'linea')::int as linea,
           regexp_replace(btrim(e ->> 'ticket'), '[\r\n\t]+', ' ', 'g') as ticket,
           (e ->> 'fecha_hora')::timestamp as loc,
           nullif(regexp_replace(btrim(coalesce(e ->> 'mesa', '')), '[\r\n\t]+', ' ', 'g'), '') as mesa,
           nullif(regexp_replace(btrim(coalesce(e ->> 'cuenta', '')), '[\r\n\t]+', ' ', 'g'), '') as cuenta,
           regexp_replace(btrim(e ->> 'producto'), '[\r\n\t]+', ' ', 'g') as producto,
           coalesce((e ->> 'cantidad')::numeric, 1)::numeric(12, 3) as cantidad,
           (e ->> 'precio_unitario_centavos')::bigint as precio,
           (e ->> 'total_centavos')::bigint as total,
           nullif(btrim(coalesce(e ->> 'metodo_pago', '')), '') as metodo,
           nullif(btrim(coalesce(e ->> 'mesero', '')), '') as mesero,
           (e ->> 'cuenta_id')::uuid as cuenta_id
      from jsonb_array_elements(p_lineas) e
  ), b as (
    select l.*, (l.loc at time zone v_zona) as instante,
           concat_ws(chr(31), l.ticket, to_char(l.loc, 'YYYY-MM-DD"T"HH24:MI:SS'), lower(coalesce(l.mesa, '')),
                     lower(coalesce(l.cuenta, '')), lower(l.producto), l.cantidad::text, l.total::text) as base
      from l
  ), o as (
    select b.*, row_number() over (partition by b.base order by b.linea) as oc from b
  )
  select o.linea, o.ticket, o.loc, o.instante,
         ((o.instante at time zone v_zona) - interval '8 hours')::date,
         o.mesa, o.cuenta, o.producto, o.cantidad, o.precio, o.total, o.metodo, o.mesero, o.cuenta_id,
         encode(sha256(convert_to(o.base || chr(31) || o.oc::text, 'UTF8')), 'hex')
    from o
   order by o.linea;
end;
$$;
revoke all on function public.pos_leer_lineas(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.pos_leer_lineas(uuid, jsonb) to service_role;

-- Cuentas candidatas (para elegir a mano) de unas sesiones.
create function public.pos_candidatos(p_sesiones uuid[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'cuenta_id', c.id, 'cliente_nombre', c.cliente_nombre, 'sesion_id', c.sesion_id,
           'mesa_numero', t.numero, 'creada_en', c.creada_en)
           order by s.abierta_en, c.creada_en), '[]'::jsonb)
    from public.mesa_cuentas c
    join public.mesa_sesiones s on s.id = c.sesion_id
    join public.club_tables t on t.id = s.mesa_id
   where c.sesion_id = any (p_sesiones);
$$;
revoke all on function public.pos_candidatos(uuid[]) from public, anon, authenticated;
grant execute on function public.pos_candidatos(uuid[]) to service_role;

-- Liga un lote de ventas con la caja, POR TICKET y por conjuntos.
-- p_items: [ { k (texto), ticket, fecha (noche), mesa, cuenta, instante } ]
-- Reglas (ver docs/pos.md):
--   1. Mesa: texto igual a club_tables.numero (sin mayúsculas ni orillas);
--      si no, con la llave tolerante pos_clave_mesa. Dos mesas = ambigua.
--   2. Noche: fecha (corte 08:00) → caja_noches del antro.
--   3. Las líneas se agrupan por ticket + noche + mesa + etiqueta de cuenta.
--      Sesión: la que cubre la hora de la PRIMERA y de la ÚLTIMA línea del
--      ticket, con tolerancia (15 min antes de abrir, 60 min después de
--      cerrar). Si alguna de las dos horas cae en dos sesiones (otra mesa
--      se abrió dentro de la tolerancia) o el ticket cae en sesiones
--      distintas: 'varias_sesiones' (se elige a mano). Ninguna: 'sin_sesion'.
--   4. Cuenta: si la sesión tiene una sola, esa; si no, la que se llame
--      igual que la «cuenta» del POS; si no, la única creada antes de la
--      primera línea (+15 min). Si siguen varias: 'varias_cuentas'.
-- Devuelve una fila por item: estado, mesa, noche, sesión, cuenta y, si no
-- quedó ligada, las cuentas candidatas.
create function public.pos_resolver_lote(p_club_id uuid, p_items jsonb)
returns table (o_k text, o_estado text, o_mesa_id uuid, o_mesa_numero text, o_noche_id uuid,
               o_sesion_id uuid, o_cuenta_id uuid, o_grupo text, o_candidatos jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  with it as (
    select x ->> 'k' as k, x ->> 'ticket' as ticket, (x ->> 'fecha')::date as fecha,
           nullif(btrim(coalesce(x ->> 'mesa', '')), '') as mesa,
           nullif(lower(btrim(coalesce(x ->> 'cuenta', ''))), '') as cuenta,
           (x ->> 'instante')::timestamptz as t
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
  ), mesas as materialized (
    select t.id, t.numero, lower(btrim(t.numero)) as k1, public.pos_clave_mesa(t.numero) as k2
      from public.club_tables t where t.club_id = p_club_id
  ), textos as (
    select distinct it.mesa from it where it.mesa is not null
  ), mt as (
    select x.mesa,
           coalesce((select array_agg(m.id) from mesas m where m.k1 = lower(x.mesa)),
                    (select array_agg(m.id) from mesas m where m.k2 = public.pos_clave_mesa(x.mesa))) as ids
      from textos x
  ), noches as (
    select n.id, n.fecha_operacion from public.caja_noches n
     where n.club_id = p_club_id and n.fecha_operacion in (select distinct it.fecha from it)
  ), lm as materialized (
    select it.k, it.ticket, it.fecha, it.cuenta, it.t,
           case when it.mesa is not null and cardinality(mt.ids) = 1 then mt.ids[1] end as mesa_id,
           case when it.mesa is null then 'sin_mesa' when mt.ids is null then 'mesa_desconocida'
                when cardinality(mt.ids) > 1 then 'mesa_ambigua' end as estado_mesa,
           n.id as noche_id
      from it
      left join mt on mt.mesa = it.mesa
      left join noches n on n.fecha_operacion = it.fecha
  ), lg as materialized (
    select lm.*, concat_ws(chr(31), lm.ticket, lm.fecha::text, lm.mesa_id::text, coalesce(lm.cuenta, '')) as gk
      from lm
  ), ses as materialized (
    select s.id, s.mesa_id, s.noche_id, s.abierta_en,
           case when s.estado = 'abierta' then 'infinity'::timestamptz
                else coalesce(s.cerrada_en, s.cuadrada_en, 'infinity'::timestamptz) end as fin
      from public.mesa_sesiones s
     where s.club_id = p_club_id and s.noche_id in (select n.id from noches n)
  ), g as (
    select lg.gk, min(lg.mesa_id::text)::uuid as mesa_id, min(lg.noche_id::text)::uuid as noche_id,
           min(lg.cuenta) as cuenta, min(lg.t) as t1, max(lg.t) as t2
      from lg
     where lg.estado_mesa is null and lg.noche_id is not null
     group by lg.gk
  ), gs as (
    select g.*,
           array(select s.id from ses s where s.mesa_id = g.mesa_id and s.noche_id = g.noche_id
                   and g.t1 >= s.abierta_en - interval '15 minutes' and g.t1 <= s.fin + interval '60 minutes'
                 order by s.abierta_en) as s1,
           array(select s.id from ses s where s.mesa_id = g.mesa_id and s.noche_id = g.noche_id
                   and g.t2 >= s.abierta_en - interval '15 minutes' and g.t2 <= s.fin + interval '60 minutes'
                 order by s.abierta_en) as s2,
           array(select s.id from ses s where s.mesa_id = g.mesa_id and s.noche_id = g.noche_id order by s.abierta_en) as todas
      from g
  ), gr as (
    select gs.*,
           case when cardinality(gs.s1) = 1 and gs.s1 = gs.s2 then gs.s1[1] end as sesion,
           case when cardinality(gs.s1) = 0 and cardinality(gs.s2) = 0 then 'sin_sesion'
                when cardinality(gs.s1) = 1 and gs.s1 = gs.s2 then null
                else 'varias_sesiones' end as est
      from gs
  ), gc as (
    select gr.*,
           (select array_agg(c.id order by c.creada_en) from public.mesa_cuentas c where c.sesion_id = gr.sesion) as cuentas,
           (select array_agg(c.id) from public.mesa_cuentas c
             where c.sesion_id = gr.sesion and gr.cuenta is not null and lower(btrim(c.cliente_nombre)) = gr.cuenta) as por_nombre,
           (select array_agg(c.id) from public.mesa_cuentas c
             where c.sesion_id = gr.sesion and c.creada_en <= gr.t1 + interval '15 minutes') as previas
      from gr
  ), gf as (
    select gc.gk, gc.sesion,
           case when gc.est is not null or gc.cuentas is null then null
                when cardinality(gc.cuentas) = 1 then gc.cuentas[1]
                when cardinality(gc.por_nombre) = 1 then gc.por_nombre[1]
                when cardinality(gc.previas) = 1 then gc.previas[1] end as cuenta_id,
           case when gc.est is not null then gc.est
                when gc.cuentas is null then 'sin_cuenta'
                when cardinality(gc.cuentas) = 1 or cardinality(gc.por_nombre) = 1 or cardinality(gc.previas) = 1 then 'ligada'
                else 'varias_cuentas' end as estado,
           case when gc.est = 'sin_sesion' then gc.todas
                when gc.est = 'varias_sesiones' then array(select distinct u from unnest(gc.s1 || gc.s2) u)
                else array[gc.sesion] end as cand
      from gc
  ), gj as (
    select gf.*, case when gf.cuenta_id is null then public.pos_candidatos(gf.cand) end as candidatos from gf
  )
  select lg.k,
         coalesce(lg.estado_mesa, case when lg.noche_id is null then 'sin_noche' end, gj.estado),
         lg.mesa_id, m.numero, lg.noche_id, gj.sesion, gj.cuenta_id,
         case when gj.candidatos is not null then left(md5(lg.gk), 16) end, gj.candidatos
    from lg
    left join gj on gj.gk = lg.gk and lg.estado_mesa is null and lg.noche_id is not null
    left join mesas m on m.id = lg.mesa_id;
$$;
revoke all on function public.pos_resolver_lote(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.pos_resolver_lote(uuid, jsonb) to service_role;


-- ----------------------------------------------------------------------------
-- 3. Funciones para la app
-- ----------------------------------------------------------------------------

-- Antros donde quien llama puede usar las ventas del POS y la bandera está
-- encendida, con la noche en curso de cada uno (en su zona horaria).
create function public.pos_mis_antros()
returns table (club_id uuid, nombre text, zona_horaria text, noche_en_curso date)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or public.current_role_name() is null then
    return;
  end if;
  return query
    select c.id, c.nombre, c.zona_horaria, public.club_fecha_operacion(c.id)
      from public.clubs c
     where coalesce(public.pos_puede_usar(c.id), false)
       and coalesce(public.funcion_activa(c.id, 'pos_ventas'), false)
     order by c.nombre;
end;
$$;
revoke all on function public.pos_mis_antros() from public, anon;
grant execute on function public.pos_mis_antros() to authenticated, service_role;

-- Mapeos guardados del antro.
create function public.pos_mapeos_lista(p_club_id uuid)
returns table (id uuid, nombre text, config jsonb, actualizado_en timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pos_exigir(p_club_id);
  return query
    select m.id, m.nombre, m.config, m.actualizado_en
      from public.pos_mapeos m
     where m.club_id = p_club_id
     order by m.actualizado_en desc;
end;
$$;
revoke all on function public.pos_mapeos_lista(uuid) from public, anon;
grant execute on function public.pos_mapeos_lista(uuid) to authenticated, service_role;

-- Guarda (o reemplaza, por nombre) un mapeo. config:
--   { columnas: { <campo>: <encabezado del archivo> },
--     formato_fecha?: 'dmy'|'mdy', formato_montos?: 'punto'|'coma' }
-- Campos: ticket, fecha (puede traer la hora), hora, mesa, cuenta, producto,
-- cantidad, precio_unitario, total, metodo_pago, mesero. Máximo 30 mapeos
-- por antro.
create function public.pos_mapeo_guardar(p_club_id uuid, p_nombre text, p_config jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id     uuid;
  v_nombre text := btrim(coalesce(p_nombre, ''));
  v_k      text;
  v_v      jsonb;
begin
  perform public.pos_exigir(p_club_id);
  if char_length(v_nombre) < 1 or char_length(v_nombre) > 60 then
    raise exception 'El nombre del mapeo va de 1 a 60 caracteres.' using errcode = 'P0001';
  end if;
  if p_config is null or jsonb_typeof(p_config) <> 'object' or pg_column_size(p_config) > 8000 then
    raise exception 'El mapeo no es válido.' using errcode = 'P0001';
  end if;
  if exists (select 1 from jsonb_object_keys(p_config) k where k not in ('columnas', 'formato_fecha', 'formato_montos')) then
    raise exception 'El mapeo trae datos que no se reconocen.' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_config -> 'columnas') is distinct from 'object' then
    raise exception 'El mapeo no dice qué columna es cada dato.' using errcode = 'P0001';
  end if;
  for v_k, v_v in select key, value from jsonb_each(p_config -> 'columnas') loop
    if v_k not in ('ticket', 'fecha', 'hora', 'mesa', 'cuenta', 'producto', 'cantidad',
                   'precio_unitario', 'total', 'metodo_pago', 'mesero') then
      raise exception 'El mapeo trae un dato que no existe: «%».', v_k using errcode = 'P0001';
    end if;
    if jsonb_typeof(v_v) <> 'string' or char_length(v_v #>> '{}') not between 1 and 120 then
      raise exception 'La columna de «%» no es válida.', v_k using errcode = 'P0001';
    end if;
  end loop;
  if p_config ? 'formato_fecha' and coalesce(p_config ->> 'formato_fecha', '') not in ('dmy', 'mdy') then
    raise exception 'El formato de fecha va «dmy» (día/mes/año) o «mdy» (mes/día/año).' using errcode = 'P0001';
  end if;
  if p_config ? 'formato_montos' and coalesce(p_config ->> 'formato_montos', '') not in ('punto', 'coma') then
    raise exception 'El formato de montos va «punto» (1,234.50) o «coma» (1.234,50).' using errcode = 'P0001';
  end if;

  -- Un candado por antro (bloque 9, C5 «D2»): sin él, dos gerentes que
  -- guardan a la vez un mapeo NUEVO con el mismo nombre chocaban en el índice
  -- único (el segundo veía «Eso ya está registrado») y el tope de 30 se podía
  -- rebasar. Con el candado el segundo espera y reemplaza al primero.
  perform pg_advisory_xact_lock(hashtextextended('pos_mapeo|' || p_club_id::text, 0));
  select m.id into v_id from public.pos_mapeos m
   where m.club_id = p_club_id and lower(btrim(m.nombre)) = lower(v_nombre)
   for update;
  if v_id is not null then
    update public.pos_mapeos
       set nombre = v_nombre, config = p_config, actualizado_por = auth.uid(), actualizado_en = now()
     where id = v_id;
    return v_id;
  end if;
  if (select count(*) from public.pos_mapeos m where m.club_id = p_club_id) >= 30 then
    raise exception 'Máximo 30 mapeos por antro: borra uno que ya no uses.' using errcode = 'P0001';
  end if;
  insert into public.pos_mapeos (club_id, nombre, config, creado_por, actualizado_por)
  values (p_club_id, v_nombre, p_config, auth.uid(), auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.pos_mapeo_guardar(uuid, text, jsonb) from public, anon;
grant execute on function public.pos_mapeo_guardar(uuid, text, jsonb) to authenticated, service_role;

create function public.pos_mapeo_borrar(p_mapeo_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_club uuid;
begin
  select m.club_id into v_club from public.pos_mapeos m where m.id = p_mapeo_id;
  -- Sin distinguir «no existe» de «no es tuyo».
  if v_club is null or not coalesce(public.pos_puede_usar(v_club), false) then
    raise exception 'Solo el gerente, el dueño o el admin de este antro pueden usar las ventas del POS.' using errcode = 'P0001';
  end if;
  perform public.pos_exigir(v_club);
  delete from public.pos_mapeos where id = p_mapeo_id;
end;
$$;
revoke all on function public.pos_mapeo_borrar(uuid) from public, anon;
grant execute on function public.pos_mapeo_borrar(uuid) to authenticated, service_role;

-- Vista previa: valida todo (los mismos errores que importar), dice qué
-- líneas ya estaban importadas y cómo se ligaría cada una. No escribe nada.
-- Devuelve { lineas: [ { linea, repetida, fecha_operacion, estado, mesa_id,
--   mesa_numero, sesion_id, cuenta_id, grupo } ], grupos: { grupo: [cuentas
--   candidatas] }, archivo_importado_en? }. Las candidatas van una vez por
--   grupo (ticket + noche + mesa), no por línea: la respuesta pesa menos.
create function public.pos_preparar(p_club_id uuid, p_lineas jsonb, p_archivo_hash text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_lineas jsonb;
  v_grupos jsonb;
  v_ya     timestamptz;
begin
  perform public.pos_exigir(p_club_id);
  with l as materialized (
    select * from public.pos_leer_lineas(p_club_id, p_lineas)
  ), r as materialized (
    select * from public.pos_resolver_lote(p_club_id, (
      select jsonb_agg(jsonb_build_object('k', l.o_linea::text, 'ticket', l.o_ticket, 'fecha', l.o_fecha,
                                          'mesa', l.o_mesa, 'cuenta', l.o_cuenta, 'instante', l.o_instante))
        from l))
  ), lin as (
    select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'linea', l.o_linea, 'repetida', v.id is not null, 'fecha_operacion', l.o_fecha,
             'estado', r.o_estado, 'mesa_id', r.o_mesa_id, 'mesa_numero', r.o_mesa_numero,
             'sesion_id', r.o_sesion_id, 'cuenta_id', r.o_cuenta_id, 'grupo', r.o_grupo))
             order by l.o_linea), '[]'::jsonb) as j
      from l
      join r on r.o_k = l.o_linea::text
      left join public.pos_ventas v on v.club_id = p_club_id and v.clave = l.o_clave
  ), gru as (
    select coalesce(jsonb_object_agg(x.o_grupo, x.o_candidatos), '{}'::jsonb) as j
      from (select distinct on (r.o_grupo) r.o_grupo, r.o_candidatos from r where r.o_grupo is not null) x
  )
  select lin.j, gru.j into v_lineas, v_grupos from lin, gru;
  if p_archivo_hash is not null then
    select i.importado_en into v_ya from public.pos_importaciones i
     where i.club_id = p_club_id and i.archivo_hash = p_archivo_hash and i.deshecha_en is null;
  end if;
  return jsonb_build_object('lineas', v_lineas, 'grupos', v_grupos, 'archivo_importado_en', v_ya);
end;
$$;
revoke all on function public.pos_preparar(uuid, jsonb, text) from public, anon;
grant execute on function public.pos_preparar(uuid, jsonb, text) to authenticated, service_role;

-- Importa TODO o NADA. Las líneas ya importadas (misma llave) se saltan y
-- se cuentan como repetidas; si todas lo son, no se crea nada. El mismo
-- archivo (hash) no entra dos veces. Una línea con cuenta_id queda ligada
-- a mano (la cuenta debe ser del antro y de la noche de la venta).
-- Devuelve { importacion_id, nuevas, repetidas, ligadas, sin_ligar, total_centavos }.
create function public.pos_importar(p_club_id uuid, p_archivo_nombre text, p_archivo_hash text, p_formato text,
                                    p_mapeo_id uuid, p_lineas jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id        uuid;
  v_ya        timestamptz;
  v_total     int;
  v_nuevas    int;
  v_suma      bigint;
  v_mala      int;
  v_ligadas   int;
begin
  perform public.pos_exigir(p_club_id);
  if char_length(btrim(coalesce(p_archivo_nombre, ''))) not between 1 and 200 then
    raise exception 'Falta el nombre del archivo.' using errcode = 'P0001';
  end if;
  if p_archivo_hash is null or p_archivo_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Falta la huella del archivo.' using errcode = 'P0001';
  end if;
  if p_formato is null or p_formato not in ('csv', 'xlsx') then
    raise exception 'El formato va «csv» o «xlsx».' using errcode = 'P0001';
  end if;
  if p_mapeo_id is not null and not exists (select 1 from public.pos_mapeos m where m.id = p_mapeo_id and m.club_id = p_club_id) then
    raise exception 'Ese mapeo no es de este antro.' using errcode = 'P0001';
  end if;

  -- Una importación (o un deshacer) a la vez por antro: conteos exactos.
  perform pg_advisory_xact_lock(hashtext('pos_importar:' || p_club_id::text));

  select i.importado_en into v_ya from public.pos_importaciones i
   where i.club_id = p_club_id and i.archivo_hash = p_archivo_hash and i.deshecha_en is null;
  if v_ya is not null then
    raise exception 'Este archivo ya se importó el % (hora del centro). No se agregó nada.',
      to_char(v_ya at time zone 'America/Mexico_City', 'DD/MM/YYYY HH24:MI') using errcode = 'P0001';
  end if;

  -- Líneas validadas, si ya existían y cómo se ligan (por conjuntos).
  create temporary table pos_tmp_lineas on commit drop as
  with l as materialized (
    select * from public.pos_leer_lineas(p_club_id, p_lineas)
  ), r as (
    select * from public.pos_resolver_lote(p_club_id, (
      select jsonb_agg(jsonb_build_object('k', l.o_linea::text, 'ticket', l.o_ticket, 'fecha', l.o_fecha,
                                          'mesa', l.o_mesa, 'cuenta', l.o_cuenta, 'instante', l.o_instante))
        from l))
  )
  select l.*, r.o_estado, r.o_mesa_id, r.o_noche_id, r.o_sesion_id, r.o_cuenta_id as o_cuenta_auto,
         exists (select 1 from public.pos_ventas v where v.club_id = p_club_id and v.clave = l.o_clave) as o_repetida
    from l join r on r.o_k = l.o_linea::text;

  select count(*)::int, count(*) filter (where not t.o_repetida)::int,
         coalesce(sum(t.o_total) filter (where not t.o_repetida), 0)::bigint
    into v_total, v_nuevas, v_suma
    from pg_temp.pos_tmp_lineas t;
  if v_nuevas = 0 then
    raise exception 'Todas las líneas de este archivo ya estaban importadas: no se agregó nada.' using errcode = 'P0001';
  end if;

  -- Cuentas elegidas a mano: del antro y de la noche de la venta.
  select t.o_linea into v_mala
    from pg_temp.pos_tmp_lineas t
    left join public.mesa_cuentas c on c.id = t.o_cuenta_id and c.club_id = p_club_id
    left join public.mesa_sesiones s on s.id = c.sesion_id
    left join public.caja_noches n on n.id = s.noche_id and n.club_id = p_club_id and n.fecha_operacion = t.o_fecha
   where t.o_cuenta_id is not null and n.id is null
   order by t.o_linea
   limit 1;
  if v_mala is not null then
    raise exception 'Línea %: la cuenta elegida no es de esa noche de este antro.', v_mala using errcode = 'P0001';
  end if;

  insert into public.pos_importaciones (club_id, archivo_nombre, archivo_hash, formato, mapeo_id,
                                        lineas_archivo, lineas_nuevas, lineas_repetidas, total_centavos, noches, importado_por)
  values (p_club_id, btrim(p_archivo_nombre), p_archivo_hash, p_formato, p_mapeo_id,
          v_total, v_nuevas, v_total - v_nuevas, v_suma,
          (select array_agg(distinct t.o_fecha order by t.o_fecha) from pg_temp.pos_tmp_lineas t), auth.uid())
  returning id into v_id;

  insert into public.pos_importacion_lineas (importacion_id, club_id, clave)
  select v_id, p_club_id, t.o_clave from pg_temp.pos_tmp_lineas t;

  insert into public.pos_ventas (club_id, importacion_id, linea, clave, ticket, fecha_hora_local, fecha_hora, fecha_operacion,
                                 mesa_texto, cuenta_texto, producto, cantidad, precio_unitario_centavos, total_centavos,
                                 metodo_pago, mesero, mesa_id, noche_id, sesion_id, cuenta_id, liga, estado_liga,
                                 ligada_por, ligada_en)
  select p_club_id, v_id, t.o_linea, t.o_clave, t.o_ticket, t.o_local, t.o_instante, t.o_fecha,
         t.o_mesa, t.o_cuenta, t.o_producto, t.o_cantidad, t.o_precio, t.o_total, t.o_metodo, t.o_mesero,
         case when t.o_cuenta_id is not null then s.mesa_id else t.o_mesa_id end,
         case when t.o_cuenta_id is not null then s.noche_id else t.o_noche_id end,
         case when t.o_cuenta_id is not null then s.id else t.o_sesion_id end,
         coalesce(t.o_cuenta_id, t.o_cuenta_auto),
         case when t.o_cuenta_id is not null then 'manual' when t.o_cuenta_auto is not null then 'auto' else 'ninguna' end,
         case when t.o_cuenta_id is not null then 'ligada' else t.o_estado end,
         case when t.o_cuenta_id is not null then auth.uid() end,
         case when coalesce(t.o_cuenta_id, t.o_cuenta_auto) is not null then now() end
    from pg_temp.pos_tmp_lineas t
    left join public.mesa_cuentas c on c.id = t.o_cuenta_id
    left join public.mesa_sesiones s on s.id = c.sesion_id
   where not t.o_repetida
   order by t.o_linea;

  select count(*) filter (where v.cuenta_id is not null)::int into v_ligadas
    from public.pos_ventas v where v.importacion_id = v_id;
  drop table pg_temp.pos_tmp_lineas;
  -- Tras una carga grande, estadísticas al día: sin ellas el planeador cree
  -- que las tablas están vacías y la siguiente consulta (historial, vista
  -- previa) puede tardar segundos. ANALYZE muestrea: cuesta poco y no bloquea
  -- lecturas ni escrituras.
  if v_total >= 200 then
    analyze public.pos_ventas, public.pos_importacion_lineas, public.pos_importaciones;
  end if;

  return jsonb_build_object('importacion_id', v_id, 'nuevas', v_nuevas, 'repetidas', v_total - v_nuevas,
                            'ligadas', v_ligadas, 'sin_ligar', v_nuevas - v_ligadas, 'total_centavos', v_suma);
exception
  when unique_violation then
    raise exception 'Este archivo o estas líneas se acaban de importar en otra sesión. No se agregó nada.' using errcode = 'P0001';
end;
$$;
revoke all on function public.pos_importar(uuid, text, text, text, uuid, jsonb) from public, anon;
grant execute on function public.pos_importar(uuid, text, text, text, uuid, jsonb) to authenticated, service_role;

-- Importaciones del antro (las 50 más recientes). lineas_propias: ventas
-- que se borrarían al deshacerla (las que no trae ningún otro archivo vigente).
create function public.pos_importaciones_lista(p_club_id uuid)
returns table (id uuid, archivo_nombre text, formato text, lineas_archivo int, lineas_nuevas int,
               lineas_repetidas int, lineas_propias int, total_centavos bigint, importado_en timestamptz,
               importado_por_nombre text, deshecha_en timestamptz, motivo_deshacer text, noches date[])
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pos_exigir(p_club_id);
  -- Por conjuntos (joins, sin subconsultas por venta): en cuántos archivos
  -- vigentes aparece cada llave; una venta es «propia» de su archivo si
  -- ningún otro vigente la trae (n = 1, el suyo).
  return query
    with imps as (
      select i.* from public.pos_importaciones i
       where i.club_id = p_club_id
       order by i.importado_en desc
       limit 50
    ), cuantas as (
      select il.clave, count(*) as n
        from public.pos_importacion_lineas il
        join public.pos_importaciones o on o.id = il.importacion_id and o.deshecha_en is null
       where il.club_id = p_club_id
       group by il.clave
    ), propias as (
      select v.importacion_id as iid, count(*) filter (where coalesce(c.n, 0) <= 1)::int as n
        from public.pos_ventas v
        left join cuantas c on c.clave = v.clave
       where v.club_id = p_club_id and v.importacion_id in (select imps.id from imps)
       group by v.importacion_id
    )
    select i.id, i.archivo_nombre, i.formato, i.lineas_archivo, i.lineas_nuevas, i.lineas_repetidas,
           coalesce(pr.n, 0), i.total_centavos, i.importado_en, p.nombre, i.deshecha_en, i.motivo_deshacer, i.noches
      from imps i
      left join propias pr on pr.iid = i.id
      left join public.profiles p on p.id = i.importado_por
     order by i.importado_en desc;
end;
$$;
revoke all on function public.pos_importaciones_lista(uuid) from public, anon;
grant execute on function public.pos_importaciones_lista(uuid) to authenticated, service_role;

-- Deshacer una importación (p. ej. se mapeó mal una columna). Sus ventas
-- que también trae otro archivo vigente pasan a ese archivo; las demás se
-- borran. La importación queda marcada con motivo y su archivo se puede
-- volver a importar. Toma el mismo candado que importar. No toca la caja.
-- Devuelve { borradas, conservadas }.
create function public.pos_importacion_deshacer(p_importacion_id uuid, p_motivo text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_club        uuid;
  v_deshecha    timestamptz;
  v_conservadas int;
  v_borradas    int;
begin
  select i.club_id into v_club from public.pos_importaciones i where i.id = p_importacion_id;
  if v_club is null or not coalesce(public.pos_puede_usar(v_club), false) then
    raise exception 'Solo el gerente, el dueño o el admin de este antro pueden usar las ventas del POS.' using errcode = 'P0001';
  end if;
  perform public.pos_exigir(v_club);
  if char_length(btrim(coalesce(p_motivo, ''))) not between 3 and 300 then
    raise exception 'Escribe el motivo (de 3 a 300 caracteres).' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtext('pos_importar:' || v_club::text));
  select i.deshecha_en into v_deshecha from public.pos_importaciones i where i.id = p_importacion_id for update;
  if v_deshecha is not null then
    raise exception 'Esa importación ya se deshizo.' using errcode = 'P0001';
  end if;

  -- Las que también trae otro archivo vigente pasan al más antiguo de ellos
  -- (por conjuntos: un join, no una subconsulta por venta).
  with mias as (
    select v.id, v.clave from public.pos_ventas v where v.importacion_id = p_importacion_id
  ), otra as (
    select distinct on (il.clave) il.clave, il.importacion_id
      from public.pos_importacion_lineas il
      join public.pos_importaciones i on i.id = il.importacion_id and i.deshecha_en is null
      join mias m on m.clave = il.clave
     where il.club_id = v_club and il.importacion_id <> p_importacion_id
     order by il.clave, i.importado_en, i.id
  )
  update public.pos_ventas v
     set importacion_id = otra.importacion_id
    from mias join otra on otra.clave = mias.clave
   where v.id = mias.id;
  get diagnostics v_conservadas = row_count;
  delete from public.pos_ventas where importacion_id = p_importacion_id;
  get diagnostics v_borradas = row_count;
  delete from public.pos_importacion_lineas where importacion_id = p_importacion_id;
  update public.pos_importaciones
     set deshecha_en = now(), deshecha_por = auth.uid(), motivo_deshacer = btrim(p_motivo)
   where id = p_importacion_id;
  if v_borradas + v_conservadas >= 200 then
    analyze public.pos_ventas, public.pos_importacion_lineas, public.pos_importaciones;
  end if;
  return jsonb_build_object('borradas', v_borradas, 'conservadas', v_conservadas);
end;
$$;
revoke all on function public.pos_importacion_deshacer(uuid, text) from public, anon;
grant execute on function public.pos_importacion_deshacer(uuid, text) to authenticated, service_role;

-- Asignar a mano (o reasignar) una cuenta a unas ventas de la misma noche.
-- Con p_cuenta_id nulo, les quita la cuenta («desligada»: «volver a ligar»
-- no la vuelve a poner sola). Devuelve cuántas cambió.
create function public.pos_asignar(p_club_id uuid, p_venta_ids uuid[], p_cuenta_id uuid)
returns int
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_fechas date[];
  v_n      int;
  v_sesion uuid;
  v_mesa   uuid;
  v_noche  uuid;
begin
  perform public.pos_exigir(p_club_id);
  if p_venta_ids is null or cardinality(p_venta_ids) = 0 or cardinality(p_venta_ids) > 1000 then
    raise exception 'Elige de 1 a 1,000 ventas.' using errcode = 'P0001';
  end if;
  select array_agg(distinct v.fecha_operacion), count(*)::int into v_fechas, v_n
    from public.pos_ventas v where v.id = any (p_venta_ids) and v.club_id = p_club_id;
  if v_n <> (select count(distinct x) from unnest(p_venta_ids) x) then
    raise exception 'Alguna de esas ventas no es de este antro.' using errcode = 'P0001';
  end if;
  if p_cuenta_id is null then
    update public.pos_ventas
       set cuenta_id = null, sesion_id = null, liga = 'ninguna', estado_liga = 'desligada',
           ligada_por = auth.uid(), ligada_en = now()
     where id = any (p_venta_ids) and club_id = p_club_id;
    get diagnostics v_n = row_count;
    return v_n;
  end if;
  if cardinality(v_fechas) <> 1 then
    raise exception 'Esas ventas son de noches distintas: asígnalas por separado.' using errcode = 'P0001';
  end if;
  select s.id, s.mesa_id, n.id into v_sesion, v_mesa, v_noche
    from public.mesa_cuentas c
    join public.mesa_sesiones s on s.id = c.sesion_id
    join public.caja_noches n on n.id = s.noche_id
   where c.id = p_cuenta_id and c.club_id = p_club_id and n.club_id = p_club_id and n.fecha_operacion = v_fechas[1];
  if v_sesion is null then
    raise exception 'Esa cuenta no es de esa noche de este antro.' using errcode = 'P0001';
  end if;
  update public.pos_ventas
     set cuenta_id = p_cuenta_id, sesion_id = v_sesion, mesa_id = v_mesa, noche_id = v_noche,
         liga = 'manual', estado_liga = 'ligada', ligada_por = auth.uid(), ligada_en = now()
   where id = any (p_venta_ids) and club_id = p_club_id;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.pos_asignar(uuid, uuid[], uuid) from public, anon;
grant execute on function public.pos_asignar(uuid, uuid[], uuid) to authenticated, service_role;

-- Volver a ligar las ventas de una noche que no se ligaron ni se quitaron a
-- mano (por si la caja cambió después de importar). Devuelve cuántas cambiaron.
create function public.pos_religar(p_club_id uuid, p_fecha date)
returns int
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_n int;
begin
  perform public.pos_exigir(p_club_id);
  if p_fecha is null then
    raise exception 'Elige la noche.' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtext('pos_importar:' || p_club_id::text));
  with r as (
    select * from public.pos_resolver_lote(p_club_id, (
      select jsonb_agg(jsonb_build_object('k', v.id::text, 'ticket', v.ticket, 'fecha', v.fecha_operacion,
                                          'mesa', v.mesa_texto, 'cuenta', v.cuenta_texto, 'instante', v.fecha_hora))
        from public.pos_ventas v
       where v.club_id = p_club_id and v.fecha_operacion = p_fecha and v.liga <> 'manual' and v.estado_liga <> 'desligada'))
  )
  update public.pos_ventas v
     set mesa_id = r.o_mesa_id, noche_id = r.o_noche_id, sesion_id = r.o_sesion_id, cuenta_id = r.o_cuenta_id,
         liga = case when r.o_cuenta_id is not null then 'auto' else 'ninguna' end,
         estado_liga = r.o_estado,
         ligada_en = case when r.o_cuenta_id is not null then now() end, ligada_por = null
    from r
   where v.id = r.o_k::uuid
     and (v.cuenta_id is distinct from r.o_cuenta_id or v.sesion_id is distinct from r.o_sesion_id
          or v.mesa_id is distinct from r.o_mesa_id or v.noche_id is distinct from r.o_noche_id
          or v.estado_liga is distinct from r.o_estado);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.pos_religar(uuid, date) from public, anon;
grant execute on function public.pos_religar(uuid, date) to authenticated, service_role;

-- Conciliación de una noche: por cuenta de la caja, consumo registrado en
-- caja (sin anulados) contra el total del POS ligado a esa cuenta. Además,
-- las ventas del POS sin cuenta: por sesión (nivel 'mesa_sin_cuenta') o
-- por mesa / texto de mesa (nivel 'sin_mesa'). Estados: coincide,
-- diferencia, solo_pos, solo_caja. Las cuentas sin consumo ni ventas no salen.
create function public.pos_conciliacion(p_club_id uuid, p_fecha date)
returns table (nivel text, mesa_id uuid, mesa_numero text, sesion_id uuid, sesion_abierta_en timestamptz,
               sesion_estado text, cuenta_id uuid, cliente_nombre text, caja_centavos bigint, pos_centavos bigint,
               pos_lineas int, pos_tickets int, estado text)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform public.pos_exigir(p_club_id);
  if p_fecha is null then
    raise exception 'Elige la noche.' using errcode = 'P0001';
  end if;
  return query
  with noche as (
    select n.id from public.caja_noches n where n.club_id = p_club_id and n.fecha_operacion = p_fecha
  ), cuentas as (
    select c.id as cid, c.cliente_nombre as cnombre, s.id as sid, s.abierta_en as sabierta, s.estado as sestado,
           s.mesa_id as mid, t.numero as mnum
      from public.mesa_cuentas c
      join public.mesa_sesiones s on s.id = c.sesion_id
      join public.club_tables t on t.id = s.mesa_id
     where s.noche_id in (select id from noche)
  ), caja as (
    select k.cuenta_id as cid, sum(k.monto_centavos)::bigint as total
      from public.caja_consumos k
     where k.noche_id in (select id from noche) and not k.anulado
     group by k.cuenta_id
  ), pos as (
    select v.* from public.pos_ventas v where v.club_id = p_club_id and v.fecha_operacion = p_fecha
  ), pos_cuenta as (
    select p.cuenta_id as cid, sum(p.total_centavos)::bigint as total, count(*)::int as lineas,
           count(distinct p.ticket)::int as tickets
      from pos p where p.cuenta_id is not null group by p.cuenta_id
  ), filas as (
    select 'cuenta'::text as f_nivel, c.mid, c.mnum, c.sid, c.sabierta, c.sestado, c.cid, c.cnombre,
           coalesce(k.total, 0)::bigint as f_caja, coalesce(pc.total, 0)::bigint as f_pos,
           coalesce(pc.lineas, 0) as f_lineas, coalesce(pc.tickets, 0) as f_tickets
      from cuentas c
      left join caja k on k.cid = c.cid
      left join pos_cuenta pc on pc.cid = c.cid
    union all
    select 'mesa_sin_cuenta', s.mesa_id, t.numero, s.id, s.abierta_en, s.estado, null::uuid, null::text,
           0::bigint, sum(p.total_centavos)::bigint, count(*)::int, count(distinct p.ticket)::int
      from pos p
      join public.mesa_sesiones s on s.id = p.sesion_id
      join public.club_tables t on t.id = s.mesa_id
     where p.cuenta_id is null
     group by s.mesa_id, t.numero, s.id, s.abierta_en, s.estado
    union all
    select 'sin_mesa', p.mesa_id, coalesce(t.numero, p.mesa_texto), null::uuid, null::timestamptz, null::text,
           null::uuid, null::text, 0::bigint, sum(p.total_centavos)::bigint, count(*)::int, count(distinct p.ticket)::int
      from pos p
      left join public.club_tables t on t.id = p.mesa_id
     where p.cuenta_id is null and p.sesion_id is null
     group by p.mesa_id, coalesce(t.numero, p.mesa_texto)
  )
  select f.f_nivel, f.mid, f.mnum, f.sid, f.sabierta, f.sestado, f.cid, f.cnombre, f.f_caja, f.f_pos,
         f.f_lineas, f.f_tickets,
         case when f.f_nivel <> 'cuenta' then 'solo_pos'
              when f.f_lineas = 0 then 'solo_caja'
              when f.f_caja = 0 then 'solo_pos'
              when f.f_caja = f.f_pos then 'coincide'
              else 'diferencia' end
    from filas f
   where f.f_caja <> 0 or f.f_lineas > 0
   order by f.mnum nulls last, f.sabierta nulls last, f.f_nivel, f.cnombre;
end;
$$;
revoke all on function public.pos_conciliacion(uuid, date) from public, anon;
grant execute on function public.pos_conciliacion(uuid, date) to authenticated, service_role;

-- Tickets del POS de una noche (ligados o no), para asignar, reasignar o
-- quitar la cuenta. Uno por ticket + mesa + cuenta + estado.
create function public.pos_tickets(p_club_id uuid, p_fecha date)
returns table (ticket text, mesa_texto text, mesa_id uuid, mesa_numero text, sesion_id uuid, cuenta_id uuid,
               cliente_nombre text, liga text, estado_liga text, total_centavos bigint, lineas int,
               venta_ids uuid[], primera timestamptz, ultima timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform public.pos_exigir(p_club_id);
  if p_fecha is null then
    raise exception 'Elige la noche.' using errcode = 'P0001';
  end if;
  return query
    select v.ticket, v.mesa_texto, v.mesa_id, t.numero, v.sesion_id, v.cuenta_id, c.cliente_nombre,
           v.liga, v.estado_liga, sum(v.total_centavos)::bigint, count(*)::int, array_agg(v.id order by v.linea),
           min(v.fecha_hora), max(v.fecha_hora)
      from public.pos_ventas v
      left join public.club_tables t on t.id = v.mesa_id
      left join public.mesa_cuentas c on c.id = v.cuenta_id
     where v.club_id = p_club_id and v.fecha_operacion = p_fecha
     group by v.ticket, v.mesa_texto, v.mesa_id, t.numero, v.sesion_id, v.cuenta_id, c.cliente_nombre, v.liga, v.estado_liga
     order by min(v.fecha_hora), v.ticket;
end;
$$;
revoke all on function public.pos_tickets(uuid, date) from public, anon;
grant execute on function public.pos_tickets(uuid, date) to authenticated, service_role;

-- Cuentas de la caja de una noche (para elegir a cuál va una venta).
create function public.pos_cuentas_noche(p_club_id uuid, p_fecha date)
returns table (cuenta_id uuid, cliente_nombre text, sesion_id uuid, mesa_id uuid, mesa_numero text,
               abierta_en timestamptz, cerrada_en timestamptz, creada_en timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform public.pos_exigir(p_club_id);
  if p_fecha is null then
    raise exception 'Elige la noche.' using errcode = 'P0001';
  end if;
  return query
    select c.id, c.cliente_nombre, s.id, s.mesa_id, t.numero, s.abierta_en, coalesce(s.cerrada_en, s.cuadrada_en), c.creada_en
      from public.mesa_cuentas c
      join public.mesa_sesiones s on s.id = c.sesion_id
      join public.club_tables t on t.id = s.mesa_id
      join public.caja_noches n on n.id = s.noche_id
     where n.club_id = p_club_id and n.fecha_operacion = p_fecha
     order by t.numero, s.abierta_en, c.creada_en;
end;
$$;
revoke all on function public.pos_cuentas_noche(uuid, date) from public, anon;
grant execute on function public.pos_cuentas_noche(uuid, date) to authenticated, service_role;

commit;
