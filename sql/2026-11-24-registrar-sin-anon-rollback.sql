-- Rollback de sql/2026-11-24-registrar-sin-anon.sql: devuelve el permiso del
-- anónimo (REABRE el hueco crítico; solo si quitarlo rompiera algo).
grant execute on function public.registrar_comision_reserva(uuid, uuid, uuid, numeric, timestamptz, timestamptz) to anon;
grant execute on function public.registrar_pago_dia(uuid, uuid, uuid, date, timestamptz, timestamptz) to anon;
