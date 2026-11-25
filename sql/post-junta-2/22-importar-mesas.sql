-- ============================================================================
-- AntroApp — Importar mesas desde un CSV a un antro existente (B1a)
-- Fecha: 2026-11-25 (rama b-equipo, post-junta-2)
-- Estado: APLICADO Y PROBADO EN DEV. En producción NO.
-- Rollback: sql/post-junta-2/22-importar-mesas-rollback.sql
-- ANTES, en producción: sql/post-junta-2/22-importar-mesas-diagnostico.sql
--   (solo lectura). Si devuelve filas, hay mesas repetidas en algún antro y
--   el índice no se puede crear: este archivo se detiene con un aviso claro
--   y no cambia nada. Hay que renombrar (no borrar: puede haber reservas o
--   caja apuntando a ellas) las repetidas y volver a correrlo.
--
-- 1. Índice único por antro y nombre de mesa, sin importar mayúsculas ni
--    espacios de las orillas: (club_id, lower(btrim(numero))). Hoy se podían
--    crear dos mesas «5» en el mismo antro.
-- 2. mesas_importar(p_club_id, p_filas): alta o actualización de capacidad
--    por nombre, TODO O NADA, máximo 300 filas y 300 mesas por antro. Solo
--    el dueño de ese antro y el admin: la misma regla que la RLS de
--    club_tables (club_tables_insert_dueno). Nunca borra ni renombra: las
--    reservas, la caja y los consumos apuntan a las mesas.
--
-- La función autoriza con coalesce(…, false): una cuenta sin perfil, dada de
-- baja o con contraseña temporal (current_role_name() nulo) no pasa. No usa
-- current_club_id(), que falla si un dueño tiene dos antros: usa
-- club_es_dueno(p_club_id).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Índice único (con aviso si hay repetidas)
-- ---------------------------------------------------------------------------
do $$
declare
  v_grupos integer;
begin
  select count(*) into v_grupos
  from (select 1 from public.club_tables
        group by club_id, lower(btrim(numero)) having count(*) > 1) d;
  if v_grupos > 0 then
    raise exception 'Hay % nombres de mesa repetidos dentro de un mismo antro. Corre 22-importar-mesas-diagnostico.sql, renombra las repetidas y vuelve a intentar. No se cambió nada.', v_grupos;
  end if;
end;
$$;

create unique index club_tables_numero_unico on public.club_tables (club_id, lower(btrim(numero)));

-- ---------------------------------------------------------------------------
-- 2. Importar
--    p_filas: [ { linea?: int, numero: text, capacidad: int } ]
--    linea es solo para el mensaje de error («Línea 7: …»); si no viene, se
--    usa la posición. Devuelve { creadas, actualizadas, iguales, total }.
-- ---------------------------------------------------------------------------
create or replace function public.mesas_importar(p_club_id uuid, p_filas jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_rol        text := public.current_role_name();
  v_fila       jsonb;
  v_pos        integer := 0;
  v_linea      integer;
  v_numero     text;
  v_cap        jsonb;
  v_claves     text[] := '{}';
  v_numeros    text[] := '{}';
  v_caps       integer[] := '{}';
  v_existentes integer;
  v_nuevas     integer;
  v_creadas    integer;
  v_cambiadas  integer;
begin
  if auth.uid() is null or p_club_id is null
     or not coalesce(v_rol = 'admin' or public.club_es_dueno(p_club_id), false) then
    raise exception 'Solo el dueño del antro o el admin pueden importar mesas.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.clubs c where c.id = p_club_id) then
    raise exception 'El antro no existe.' using errcode = 'P0001';
  end if;
  if p_filas is null or jsonb_typeof(p_filas) <> 'array' or jsonb_array_length(p_filas) = 0 then
    raise exception 'No viene ninguna mesa.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_filas) > 300 then
    raise exception 'Máximo 300 mesas por importación (vienen %).', jsonb_array_length(p_filas) using errcode = 'P0001';
  end if;

  -- Una importación a la vez por antro (dos pestañas a la vez no se pisan).
  perform pg_advisory_xact_lock(hashtextextended('mesas_importar:' || p_club_id::text, 0));

  -- Se valida TODO antes de escribir nada.
  for v_fila in select value from jsonb_array_elements(p_filas) loop
    v_pos := v_pos + 1;
    v_linea := case when jsonb_typeof(v_fila -> 'linea') = 'number'
                     and (v_fila ->> 'linea') ~ '^\d{1,6}$' then (v_fila ->> 'linea')::integer
                    else v_pos end;
    if jsonb_typeof(v_fila) <> 'object' then
      raise exception 'Línea %: la fila no es válida.', v_linea using errcode = 'P0001';
    end if;
    v_numero := btrim(coalesce(v_fila ->> 'numero', ''));
    if not coalesce(char_length(v_numero) between 1 and 30 and v_numero !~ '[\r\n\t]', false) then
      raise exception 'Línea %: el nombre de la mesa va de 1 a 30 caracteres.', v_linea using errcode = 'P0001';
    end if;
    v_cap := v_fila -> 'capacidad';
    if not coalesce(jsonb_typeof(v_cap) = 'number' and (v_cap #>> '{}') ~ '^\d{1,3}$'
                    and (v_cap #>> '{}')::integer between 1 and 100, false) then
      raise exception 'Línea %: la capacidad es un número entero de 1 a 100.', v_linea using errcode = 'P0001';
    end if;
    if lower(v_numero) = any (v_claves) then
      raise exception 'Línea %: la mesa «%» viene repetida en el archivo.', v_linea, v_numero using errcode = 'P0001';
    end if;
    v_claves := v_claves || lower(v_numero);
    v_numeros := v_numeros || v_numero;
    v_caps := v_caps || (v_cap #>> '{}')::integer;
  end loop;

  select count(*) into v_existentes from public.club_tables t where t.club_id = p_club_id;
  select count(*) into v_nuevas
  from unnest(v_claves) k
  where not exists (select 1 from public.club_tables t where t.club_id = p_club_id and lower(btrim(t.numero)) = k);
  if v_existentes + v_nuevas > 300 then
    raise exception 'El antro quedaría con % mesas; el máximo es 300.', v_existentes + v_nuevas using errcode = 'P0001';
  end if;

  -- Alta o cambio de capacidad. A una mesa que ya existe NO se le cambia el
  -- nombre (se queda como estaba escrito); las que no vienen no se tocan.
  with escritas as (
    insert into public.club_tables (club_id, numero, capacidad)
    select p_club_id, n, c from unnest(v_numeros, v_caps) as x(n, c)
    on conflict (club_id, lower(btrim(numero)))
    do update set capacidad = excluded.capacidad
      where public.club_tables.capacidad is distinct from excluded.capacidad
    returning (xmax = 0) as nueva
  )
  select count(*) filter (where nueva), count(*) filter (where not nueva)
    into v_creadas, v_cambiadas
  from escritas;

  return jsonb_build_object(
    'creadas', v_creadas,
    'actualizadas', v_cambiadas,
    'iguales', cardinality(v_numeros) - v_creadas - v_cambiadas,
    'total', v_existentes + v_creadas);
end;
$$;

revoke all on function public.mesas_importar(uuid, jsonb) from public, anon;
grant execute on function public.mesas_importar(uuid, jsonb) to authenticated, service_role;

notify pgrst, 'reload schema';
