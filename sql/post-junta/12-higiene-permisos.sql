-- ============================================================================
-- AntroApp — Higiene de permisos de funciones nuevas (auditoría de cierre)
-- Fecha: 2026-11-24 (rama post-junta)
-- Estado: APLICADO Y PROBADO EN DEV. En producción NO (va en el "pase 2").
-- Rollback: sql/post-junta/12-higiene-permisos-rollback.sql
--
-- La auditoría encontró que el anónimo podía ejecutar cinco funciones nuevas
-- (ayudantes sin datos y funciones de trigger). No exponían nada, pero no
-- tienen por qué estar abiertas: solo las usan otras funciones de la base y
-- los triggers (un trigger no necesita permiso de ejecución para dispararse).
-- ============================================================================
revoke all on function public.lunes_de(date) from public, anon, authenticated;
revoke all on function public.siguiente_corte(timestamptz, text) from public, anon, authenticated;
revoke all on function public.mensualidad_rango_status(text) from public, anon, authenticated;
revoke all on function public.aceptaciones_fecha_servidor() from public, anon, authenticated;
revoke all on function public.clubs_candado_suscripcion() from public, anon, authenticated;
