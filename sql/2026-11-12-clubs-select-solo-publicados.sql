-- ============================================================================
-- AntroApp — clubs y club_photos: un antro no publicado es invisible por la API
-- Fecha: 2026-11-12
-- Estado: BORRADOR, NO APLICADO. Correr bloque por bloque en el SQL Editor.
--
-- Problema:
--   Hoy cualquier usuario con sesión (y cualquiera puede registrarse como
--   cliente) lee TODAS las filas de clubs por la API, incluidos borradores
--   como Panic Room. Y club_photos se lee incluso sin sesión, de cualquier
--   antro. La app filtra en pantalla, pero la base no.
--
-- Regla objetivo (SELECT):
--   Un antro se ve si
--       (estado_verificacion = 'verificado' and suscripcion_activa = true)
--     o quien consulta es admin
--     o es su dueño (dueno_id = auth.uid())
--     o es staff / gerente / RP de ese club (id = current_club_id()).
--   Una foto se ve si su antro se ve.
--
-- Cómo:
--   Con políticas RESTRICTIVAS (se aplican con AND sobre todas las
--   permisivas). No hace falta saber cómo se llaman las permisivas viejas de
--   los usuarios con sesión: aunque alguna diga "using (true)", la
--   restrictiva recorta el resultado a la regla. Es la misma lección que en
--   Storage (CLAUDE.md, sección 10).
--   Ojo: una restrictiva sola NO da acceso; sigue haciendo falta que alguna
--   permisiva deje pasar. Por eso clubs_select_anon_verificados (permisiva
--   del anónimo) se queda.
--
-- Lo que NO cubre:
--   Los archivos del bucket club-photos siguen siendo públicos: quien tenga
--   la URL exacta de una foto la puede abrir. Esto solo oculta las filas
--   (y con ellas las URLs) de los antros no publicados.
--
-- Prueba: node scripts/probar-clubs-visibilidad.mjs (5 sesiones: anónimo,
-- cliente, RP, dueño de otro club y admin; Panic Room solo lo ve el admin).
-- Correrla antes (para ver qué falla hoy) y después de aplicar los bloques.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- BLOQUE 0 — Ver lo que hay ANTES (solo lectura). Pega la salida a Claude.
-- ----------------------------------------------------------------------------
select tablename, policyname, permissive, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public' and tablename in ('clubs', 'club_photos')
order by tablename, cmd, policyname;


-- ----------------------------------------------------------------------------
-- BLOQUE 1 — Restrictiva de SELECT en clubs.
-- ----------------------------------------------------------------------------
create policy clubs_restrictiva_select_publicados on public.clubs
  as restrictive for select to public
  using (
    (estado_verificacion = 'verificado' and suscripcion_activa = true)
    or (select public.current_role_name()) = 'admin'
    or (dueno_id is not null and dueno_id = (select auth.uid()))
    or (
      (select public.current_role_name()) in ('staff', 'gerente', 'rp')
      and id = (select public.current_club_id())
    )
  );


-- ----------------------------------------------------------------------------
-- BLOQUE 2 — Restrictiva de SELECT en club_photos.
-- La subconsulta a clubs pasa por el RLS de clubs (incluida la restrictiva
-- del bloque 1), así que una foto se ve exactamente cuando su antro se ve.
-- Correr DESPUÉS del bloque 1.
-- ----------------------------------------------------------------------------
create policy club_photos_restrictiva_select_publicados on public.club_photos
  as restrictive for select to public
  using (
    exists (select 1 from public.clubs c where c.id = club_photos.club_id)
  );


-- ----------------------------------------------------------------------------
-- BLOQUE 3 — (OPCIONAL, limpieza) Borrar permisivas viejas de SELECT.
-- Con los bloques 1 y 2 ya no hacen daño, así que esto puede esperar.
-- NO correr a ciegas: los nombres reales salen del BLOQUE 0. Borrar solo
-- permisivas de SELECT abiertas (qual = 'true' o sin filtro por rol/club).
-- NO borrar:
--   * clubs_select_anon_verificados (es la única que deja ver al anónimo).
--   * políticas FOR ALL / UPDATE / INSERT / DELETE (las usan dueño y admin).
--   * la permisiva que deja leer club_photos a anon/authenticated, si es la
--     única de SELECT (sin ella nadie vería fotos, ni de antros publicados).
-- ----------------------------------------------------------------------------
-- drop policy if exists "<nombre de la permisiva abierta de clubs>"       on public.clubs;
-- drop policy if exists "<nombre de la permisiva abierta de club_photos>" on public.club_photos;


-- ----------------------------------------------------------------------------
-- BLOQUE 4 — Verificación (solo lectura).
-- ----------------------------------------------------------------------------

-- 4.1 Las dos restrictivas existen.
select tablename, policyname, permissive, cmd, roles
from pg_policies
where schemaname = 'public'
  and policyname in ('clubs_restrictiva_select_publicados',
                     'club_photos_restrictiva_select_publicados');
-- Esperado: 2 filas, permissive = 'RESTRICTIVE', cmd = 'SELECT'.

-- 4.2 Como anónimo: solo antros publicados y solo sus fotos.
begin;
set local role anon;
select nombre, estado_verificacion, suscripcion_activa from public.clubs;
select c.nombre as club_de_la_foto, count(*) as fotos
from public.club_photos p
left join public.clubs c on c.id = p.club_id
group by c.nombre;
-- Esperado: solo antros con verificado + suscripción activa; ninguna foto
-- con club_de_la_foto vacío (eso sería una foto de un antro oculto).
rollback;

-- 4.3 Como un cliente cualquiera (simula su sesión). Cambia el uuid por el
-- de un perfil con role = 'cliente'.
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '<uuid-de-un-cliente>', 'role', 'authenticated')::text, true);
select count(*) as panic_room_visible
from public.clubs where id = '8e433d37-ac56-407e-82a6-4e405d6d9fdc';
select count(*) as fotos_panic_room_visibles
from public.club_photos where club_id = '8e433d37-ac56-407e-82a6-4e405d6d9fdc';
-- Esperado: 0 y 0.
rollback;

-- La prueba completa con sesiones reales es el script de pruebas.
