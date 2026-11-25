-- ============================================================================
-- AntroApp — Paso 2b del pase: el anónimo ya no ejecuta registrar_comision_reserva
--             ni registrar_pago_dia (hueco CRÍTICO vigente en producción)
-- Fecha: 2026-11-24 (rama pase-final)
-- Rollback: sql/2026-11-24-registrar-sin-anon-rollback.sql
--
-- En producción hoy ambas funciones son SECURITY DEFINER, el anónimo tiene
-- EXECUTE, y su autorización "if not (rol in (...) and ... or rol = 'admin')
-- then raise" da NULL para el anónimo y NO rechaza: cualquiera con la anon
-- key (pública) inserta comisiones y pagos por día saltándose RLS.
-- Demostrado en dev con un esquema idéntico al de producción (24/11/2026).
-- Esto quita solo el permiso del anónimo (el código usa una sesión de staff).
-- El paso 5 reemplaza las funciones; si algún día se revierte el paso 5, su
-- rollback vuelve a dar EXECUTE al anónimo: volver a correr ESTE archivo.
-- ============================================================================
revoke execute on function public.registrar_comision_reserva(uuid, uuid, uuid, numeric, timestamptz, timestamptz) from public, anon;
revoke execute on function public.registrar_pago_dia(uuid, uuid, uuid, date, timestamptz, timestamptz) from public, anon;
