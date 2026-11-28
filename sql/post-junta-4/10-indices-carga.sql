-- ============================================================================
-- AntroApp — post-junta-4, prueba de carga: políticas de reservas y
-- comisiones que se calculan UNA vez por consulta (no por fila) y un índice
-- para las comisiones del mes en el panel del admin.
-- Fecha: 2026-11-28. Versión DEV (todo en una transacción):
--   node scripts/db/aplicar-dev.mjs sql/post-junta-4/10-indices-carga.sql
-- Rollback: sql/post-junta-4/10-indices-carga-rollback.sql
-- Producción: sql/post-junta-4/10-indices-carga-prod.sql (el índice con
-- CONCURRENTLY) y su rollback 10-indices-carga-prod-rollback.sql.
-- Evidencia (EXPLAIN ANALYZE como cada rol) y medidas: docs/prueba-carga.md
--   node scripts/dev/probar-carga-noche.mjs explicar [--volumen-anio] [--con=<este archivo>]
--
-- 1) Políticas. Seis políticas de SELECT llaman current_role_name(),
--    current_club_id() o auth.uid() "sueltas". Así Postgres las ejecuta POR
--    CADA FILA que revisa (current_role_name() lee profiles y el JWT).
--    Medido en dev con una noche de 500 reservas y un año de historia:
--      - puerta (/staff/panel, reservas de la noche): 20 ms → 1.5 ms
--      - caja (reservas con entrada): 18 ms → 1.7 ms
--      - admin, reservas de 30 días: 207 ms → 5 ms
--      - admin, comisiones de 30 días: 233 ms → 15 ms (con el índice)
--      - gerente, comisiones de la semana: 43 ms → 5 ms
--    El costo viejo crece con las filas de la ventana (todas las de todos
--    los antros en el caso del admin): ~30 µs por reserva y ~65 µs por
--    comisión.
--    El arreglo es el que ya usan las demás políticas del proyecto
--    (profiles, caja, grupos): envolver la llamada en (select …) para que
--    Postgres la calcule una vez por consulta (InitPlan). Las tres funciones
--    son STABLE y solo dependen de auth.uid() y del JWT, que no cambian
--    dentro de una consulta: el resultado es el mismo para cada fila,
--    incluido NULL (cuenta sin perfil, dada de baja o con contraseña
--    temporal). No cambia quién ve qué. ALTER POLICY conserva nombre, tipo
--    (permisiva), comando y roles (authenticated); solo cambia USING.
-- 2) Índice. El panel del admin pide las comisiones de los últimos 30 días
--    de TODOS los antros (created_at >= …). Sin índice recorre la tabla
--    completa, que crece con cada cuadre. (Las reservas de 30 días ya usan
--    reservations_club_fecha; no hace falta otro índice.)
-- ============================================================================
begin;

-- ---------- 1. Políticas ----------
alter policy reservations_select_admin on public.reservations
  using ((select public.current_role_name()) = 'admin'::text);

alter policy reservations_select_club_staff on public.reservations
  using (((select public.current_role_name()) = any (array['staff'::text, 'gerente'::text, 'dueno'::text]))
         and (club_id = (select public.current_club_id())));

alter policy reservations_select_cliente_own on public.reservations
  using (cliente_id = (select auth.uid()));

alter policy commissions_select_club_staff on public.commissions
  using (exists (
    select 1 from public.reservations r
    where r.id = commissions.reservation_id
      and ((((select public.current_role_name()) = any (array['staff'::text, 'gerente'::text, 'dueno'::text]))
            and (r.club_id = (select public.current_club_id())))
           or ((select public.current_role_name()) = 'admin'::text))));

alter policy commissions_select_rp_own on public.commissions
  using (rp_id = (select auth.uid()));

alter policy consumption_entries_select_club_staff on public.consumption_entries
  using (exists (
    select 1 from public.reservations r
    where r.id = consumption_entries.reservation_id
      and ((((select public.current_role_name()) = any (array['staff'::text, 'gerente'::text, 'dueno'::text]))
            and (r.club_id = (select public.current_club_id())))
           or ((select public.current_role_name()) = 'admin'::text))));

-- ---------- 2. Índice (panel del admin, comisiones de 30 días) ----------
create index if not exists commissions_created_at on public.commissions (created_at);

commit;

-- Verificación (6 políticas con "SELECT current_role_name()" / "SELECT auth.uid()" y 1 índice):
--   select tablename, policyname, qual from pg_policies
--    where schemaname = 'public' and policyname in ('reservations_select_admin', 'reservations_select_club_staff',
--          'reservations_select_cliente_own', 'commissions_select_club_staff', 'commissions_select_rp_own',
--          'consumption_entries_select_club_staff');
--   select indexname from pg_indexes where schemaname = 'public' and indexname = 'commissions_created_at';
