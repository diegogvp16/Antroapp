-- ============================================================================
-- AntroApp — Cierre de las 4 fugas críticas de datos sin sesión
-- Fecha: 2026-09-22
-- Alcance: profiles, profiles_legacy, reservations (SELECT + INSERT)
--
-- NO PEGUES ESTE ARCHIVO COMPLETO DE UNA VEZ.
-- Va en 3 pasos: PASO 0 (diagnóstico) -> revisar salida -> PASO 1 y 2.
-- ============================================================================


-- ============================================================================
-- PASO 0 — DIAGNÓSTICO (solo lectura, no cambia nada)
-- Córrelo primero y revisa la salida antes de seguir.
-- ============================================================================

-- 0.a ¿Qué tablas tienen RLS activado?
select tablename,
       rowsecurity as rls_activo,
       (select count(*) from pg_policies p
        where p.schemaname = 'public' and p.tablename = t.tablename) as num_politicas
from pg_tables t
where schemaname = 'public'
order by rowsecurity, tablename;

-- 0.b Políticas actuales de las tablas que vamos a tocar.
select tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('profiles', 'profiles_legacy', 'reservations')
order by tablename, cmd, policyname;

-- 0.c CRÍTICO: los helpers deben ser SECURITY DEFINER.
-- Si no lo son, las políticas de profiles entrarían en recursión infinita
-- (la política de profiles llama a la función, la función lee profiles,
-- que vuelve a evaluar la política...). El PASO 1 aborta solo si no lo son.
select proname,
       prosecdef as es_security_definer,
       provolatile as volatilidad,   -- 's' = stable, esperado
       proconfig as search_path_fijo -- debería incluir search_path
from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('current_role_name', 'current_club_id');

-- 0.d Cuerpo de los helpers, para confirmar de dónde sacan rol y club.
select proname, pg_get_functiondef(oid) as definicion
from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('current_role_name', 'current_club_id');

-- 0.e ¿Hay GRANTs directos a anon que hagan inútil cualquier política?
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon', 'authenticated')
  and table_name in ('profiles', 'profiles_legacy', 'reservations')
order by table_name, grantee, privilege_type;


-- ============================================================================
-- PASO 1 — PROFILES  (fuga #1 + escalada de privilegios)
--
-- Estado actual verificado: la tabla NO está protegida. Cualquiera, incluso
-- sin sesión, lee las 19 filas (nombre, teléfono, rol, club). Y cualquier
-- usuario autenticado puede hacer UPDATE de su propio `role` a 'admin'.
--
-- Lo que NO se debe romper (verificado leyendo el código):
--   * Todos los logins leen el rol del usuario recién autenticado.
--   * staff/gerente lista los RPs de su club, y busca un perfil por id al
--     escanear el QR de asistencia.
--   * dueño lista el personal de su club.
--   * staff da de baja RPs de su club (UPDATE de `activo`).
--   * signup de cliente y de dueño insertan su propio perfil.
-- ============================================================================

begin;

-- Guarda de seguridad: si los helpers no son SECURITY DEFINER, aborta todo
-- antes de dejar la tabla en un estado que rompa la app.
do $$
begin
  if not exists (
    select 1 from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname = 'current_club_id' and prosecdef
  ) or not exists (
    select 1 from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname = 'current_role_name' and prosecdef
  ) then
    raise exception 'ABORTADO: current_club_id() y current_role_name() deben ser SECURITY DEFINER o las políticas de profiles entran en recursión infinita. Revisa la salida del PASO 0.c y avísale a Claude antes de continuar.';
  end if;
end $$;

alter table public.profiles enable row level security;

-- Limpieza de políticas previas de profiles (si las hubiera).
do $$
declare p record;
begin
  for p in select policyname from pg_policies
           where schemaname = 'public' and tablename = 'profiles'
  loop
    execute format('drop policy if exists %I on public.profiles', p.policyname);
  end loop;
end $$;

-- SELECT ---------------------------------------------------------------------

-- Cada quien lee su propio perfil. Esto es lo que hace que sigan funcionando
-- los 3 logins y todas las pantallas que resuelven el rol al entrar.
create policy profiles_select_propio on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

-- Staff, gerente y dueño leen los perfiles de SU club (lista de RPs, personal,
-- y la búsqueda por id al escanear el QR de asistencia de un RP).
create policy profiles_select_mismo_club on public.profiles
  for select to authenticated
  using (
    club_id is not null
    and club_id = (select public.current_club_id())
    and (select public.current_role_name()) in ('staff', 'gerente', 'dueno')
  );

-- Admin lee todo (dashboard y alta de cuentas).
create policy profiles_select_admin on public.profiles
  for select to authenticated
  using ((select public.current_role_name()) = 'admin');

-- NOTA: no hay política para `anon`. A partir de aquí, sin sesión no se lee
-- ningún perfil. Ninguna pantalla pública los necesita.

-- INSERT ---------------------------------------------------------------------

-- Signup de cliente y de dueño: cada quien crea SU propio perfil y nada más.
-- El rol se limita a los que un desconocido puede auto-asignarse; staff,
-- gerente, rp y admin se crean por la ruta de servidor (service role, que
-- ignora RLS) o desde el panel de admin.
create policy profiles_insert_propio on public.profiles
  for insert to authenticated
  with check (
    id = (select auth.uid())
    and role in ('cliente', 'dueno')
  );

-- UPDATE ---------------------------------------------------------------------

-- Cada quien edita su propio perfil (nombre, teléfono).
create policy profiles_update_propio on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- Staff, gerente y dueño editan perfiles de su club (dar de baja / reactivar
-- RPs). El trigger de más abajo impide que esto sirva para tocar rol o club.
create policy profiles_update_mismo_club on public.profiles
  for update to authenticated
  using (
    club_id is not null
    and club_id = (select public.current_club_id())
    and (select public.current_role_name()) in ('staff', 'gerente', 'dueno')
  )
  with check (
    club_id is not null
    and club_id = (select public.current_club_id())
    and (select public.current_role_name()) in ('staff', 'gerente', 'dueno')
  );

create policy profiles_update_admin on public.profiles
  for update to authenticated
  using ((select public.current_role_name()) = 'admin')
  with check ((select public.current_role_name()) = 'admin');

-- Sin política de DELETE: nadie borra perfiles desde la app.

-- Anti-escalada de privilegios ------------------------------------------------
-- RLS no puede comparar el valor viejo contra el nuevo en un UPDATE, así que
-- el candado de `role` y `club_id` va en un trigger. Sin esto, la política
-- "edito mi propio perfil" seguiría permitiendo ponerse role = 'admin'.
create or replace function public.profiles_bloquear_cambio_privilegios()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- El service role (rutas de servidor) y los admin sí pueden cambiarlos.
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
end $$;

drop trigger if exists profiles_no_escalar on public.profiles;
create trigger profiles_no_escalar
  before update on public.profiles
  for each row execute function public.profiles_bloquear_cambio_privilegios();

commit;


-- ============================================================================
-- PASO 2 — PROFILES_LEGACY  (fuga #2)
--
-- Tabla archivada, sin uso en el código (0 referencias), con la columna
-- `password` en texto plano y hoy legible por cualquiera sin sesión.
--
-- ELIGE UNA DE LAS DOS OPCIONES. Ver recomendación en el reporte.
-- ============================================================================

-- ---- OPCIÓN A (recomendada): eliminarla ----------------------------------
-- Antes de borrar, guarda una copia fuera de la base si la necesitas.
-- Para revisar qué contiene:
--    select id, nombre, telefono, role, created_at from public.profiles_legacy;
-- (no incluyas la columna password en capturas ni la pegues en ningún lado)

-- drop table public.profiles_legacy;


-- ---- OPCIÓN B: conservarla pero cerrada por completo ----------------------
-- Nadie la lee por la API. Solo el service role y el SQL Editor.

-- begin;
-- alter table public.profiles_legacy enable row level security;
-- do $$
-- declare p record;
-- begin
--   for p in select policyname from pg_policies
--            where schemaname = 'public' and tablename = 'profiles_legacy'
--   loop
--     execute format('drop policy if exists %I on public.profiles_legacy', p.policyname);
--   end loop;
-- end $$;
-- -- Sin políticas + RLS activo = nadie pasa. Además quitamos los permisos
-- -- de tabla para que ni siquiera aparezca en la API.
-- revoke all on public.profiles_legacy from anon, authenticated;
-- -- Y como mínimo, deja de guardar contraseñas en claro:
-- alter table public.profiles_legacy drop column password;
-- commit;


-- ============================================================================
-- PASO 3 — RESERVATIONS  (fugas #3 y #4)
--
-- Estado actual verificado:
--   SELECT: cliente ve solo las suyas, staff/dueño solo las de su club,
--           admin todas. ESO YA FUNCIONA BIEN y no se toca.
--           El problema es `anon`: hoy ve las 26 reservas completas, con
--           nombre, teléfono y qr_code de cada cliente.
--   INSERT: el flujo anónimo funciona (decisión de producto), pero sin
--           ningún límite: se puede crear una reserva ya marcada como
--           'usada', con consumo_monto inflado, o sin club.
-- ============================================================================

begin;

-- 3.1 Quitar la lectura anónima -------------------------------------------
-- Busca la política que hoy deja leer todo sin sesión. Por el diagnóstico
-- del PASO 0.b sabrás su nombre exacto; estos son los nombres más probables.
-- Ajusta si el diagnóstico muestra otro.
drop policy if exists "reservations_select_publico" on public.reservations;
drop policy if exists "reservations_select_anon" on public.reservations;
drop policy if exists "Public read access" on public.reservations;
drop policy if exists "Enable read access for all users" on public.reservations;

-- 3.2 Acceso público al boleto, solo conociendo el código ------------------
-- RLS no distingue "filtró por qr_code" de "leyó toda la tabla": si le damos
-- SELECT a anon, puede listarlo todo. Por eso el boleto público pasa a ser
-- una función que recibe el código y devuelve UNA reserva.
-- Requiere un cambio de una línea en app/r/[codigo]/page.tsx (ver reporte).
create or replace function public.obtener_reserva_por_qr(p_qr text)
returns table (
  cliente_nombre text,
  fecha date,
  personas integer,
  status text,
  qr_code text,
  club_nombre text
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
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
$$;

-- Devuelve solo lo que el boleto necesita mostrar: NO expone el teléfono del
-- cliente, ni el consumo, ni cliente_id, ni rp_id.
revoke all on function public.obtener_reserva_por_qr(text) from public;
grant execute on function public.obtener_reserva_por_qr(text) to anon, authenticated;

-- 3.3 Acotar el INSERT anónimo --------------------------------------------
-- Se mantiene el flujo de reservar sin cuenta, pero la reserva tiene que
-- nacer limpia: pendiente, sin consumo, sin mesa, sin dueño y con club real.
drop policy if exists "reservations_insert_anon" on public.reservations;
drop policy if exists "reservations_insert_publico" on public.reservations;

create policy reservations_insert_anonimo on public.reservations
  for insert to anon
  with check (
    club_id is not null
    and source = 'organica'     -- un anónimo no puede atribuirse a un RP
    and rp_id is null
    and cliente_id is null
    and status = 'pendiente'    -- no puede nacer ya "usada"
    and consumo_monto is null   -- el consumo lo registra el staff
    and mesa_id is null
    and coalesce(se_retiro_sin_consumir, false) = false
    and personas between 1 and 20
    and fecha >= (now() at time zone 'America/Mexico_City')::date
  );

commit;


-- ============================================================================
-- PASO 4 — VERIFICACIÓN (córrelo después de aplicar)
-- ============================================================================

-- 4.1 Todas las tablas con RLS y con al menos una política:
select tablename, rowsecurity,
       (select count(*) from pg_policies p
        where p.schemaname = 'public' and p.tablename = t.tablename) as politicas
from pg_tables t
where schemaname = 'public'
order by rowsecurity, tablename;

-- 4.2 Nada debería quedar accesible para `anon` en estas tres tablas:
select tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public'
  and tablename in ('profiles', 'profiles_legacy', 'reservations')
  and 'anon' = any(roles)
order by tablename;
-- Esperado: solo reservations / INSERT.
