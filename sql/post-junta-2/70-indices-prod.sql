-- ============================================================================
-- AntroApp — C7 (noche 3): índices que faltan, versión PRODUCCIÓN
-- Fecha: 2026-11-25. Origen: auditoría de rendimiento de solo lectura en dev
-- (EXPLAIN con enable_seqscan=off y pg_stat_statements): cada uno lo usa una
-- consulta real de la app o una política/función de RLS que hoy recorre la
-- tabla completa. Ninguno cambia datos ni permisos.
-- ============================================================================
-- En producción van con CONCURRENTLY para no bloquear escrituras en plena noche.
-- CONCURRENTLY no corre dentro de una transacción: en el SQL Editor pega y
-- corre UNA sentencia a la vez (no las selecciones todas juntas). Si una falla
-- a la mitad deja un índice INVALID: bórralo con su línea del rollback y
-- vuelve a correrla. Mejor fuera de horario de operación.
-- Verificación: select indexname from pg_indexes where schemaname='public'
--   and indexname in ('reservations_club_fecha', 'reservations_rp_fecha', 'reservations_cliente_creada', 'commissions_rp_tipo', 'caja_cuadres_noche', 'caja_eventos_club_hecho', 'profiles_club_role', 'rp_attendance_club_fecha', 'rp_schedule_club_fecha', 'rp_pagos_dia_club_fecha', 'rp_pagos_dia_rp_fecha', 'club_tables_club', 'club_photos_club_orden', 'clubs_dueno', 'grupo_miembros_profile', 'consumption_entries_reservation');

-- reservas de la noche de un antro (staff/panel, caja, firma, nómina, grupo, puerta)
create index concurrently if not exists reservations_club_fecha on public.reservations (club_id, fecha);

-- panel del RP, rp_mis_reservas, cuota
create index concurrently if not exists reservations_rp_fecha on public.reservations (rp_id, fecha) where rp_id is not null;

-- historial del cliente (/cliente/perfil)
create index concurrently if not exists reservations_cliente_creada on public.reservations (cliente_id, created_at desc) where cliente_id is not null;

-- rp_progreso_cuota y conteo semanal al cuadrar
create index concurrently if not exists commissions_rp_tipo on public.commissions (rp_id, tipo) where rp_id is not null;

-- cuadres de la noche (caja y firma)
create index concurrently if not exists caja_cuadres_noche on public.caja_cuadres (noche_id);

-- registro de actividad por antro y rango
create index concurrently if not exists caja_eventos_club_hecho on public.caja_eventos (club_id, hecho_en desc);

-- personal y RPs de un antro (políticas, nómina, grupo)
create index concurrently if not exists profiles_club_role on public.profiles (club_id, role) where club_id is not null;

-- asistencia de hoy por antro (panel de staff)
create index concurrently if not exists rp_attendance_club_fecha on public.rp_attendance (club_id, fecha);

-- turnos por antro (panel de staff)
create index concurrently if not exists rp_schedule_club_fecha on public.rp_schedule (club_id, fecha);

-- nómina y grupo en modo día
create index concurrently if not exists rp_pagos_dia_club_fecha on public.rp_pagos_dia (club_id, fecha);

-- nómina del RP en modo día
create index concurrently if not exists rp_pagos_dia_rp_fecha on public.rp_pagos_dia (rp_id, fecha);

-- mesas del antro (caja, firma, panel)
create index concurrently if not exists club_tables_club on public.club_tables (club_id);

-- galería del catálogo público y la ficha
create index concurrently if not exists club_photos_club_orden on public.club_photos (club_id, orden);

-- current_club_id() y panel del dueño
create index concurrently if not exists clubs_dueno on public.clubs (dueno_id) where dueno_id is not null;

-- club_es_dueno_grupo (se evalúa en políticas)
create index concurrently if not exists grupo_miembros_profile on public.grupo_miembros (profile_id);

-- modelo viejo: embed del dashboard del admin
create index concurrently if not exists consumption_entries_reservation on public.consumption_entries (reservation_id);
