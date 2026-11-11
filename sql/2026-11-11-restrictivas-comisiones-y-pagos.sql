-- ============================================================================
-- AntroApp — Restrictivas de comisiones, pagos por día y documentos
-- Fecha: 2026-11-11
-- Estado: YA APLICADO en producción el 11/11/2026 (copia tal cual).
--
-- Qué hace cada política:
--   * commissions_restrictiva_insert: staff, gerente y dueño ya no fabrican
--     comisiones directo; fuera del admin solo se inserta el bono de
--     plataforma (orgánica, sin RP, pendiente). La comisión de RP solo nace
--     por registrar_comision_reserva().
--   * rp_pagos_dia_restrictiva_insert: nadie fuera del admin inserta pagos
--     por día directo; solo nacen por registrar_pago_dia().
--   * commissions_restrictiva_select_sin_staff: el staff ya no lee
--     comisiones (sueldos).
--   * verificacion_documentos_restrictiva_delete: el dueño ya no borra sus
--     documentos de verificación; solo el admin (o el service role).
--
-- Son RESTRICTIVAS: se aplican con AND sobre todas las demás, así que mandan
-- aunque sigan existiendo las permisivas viejas
-- (commissions_insert_club_staff, rp_pagos_dia_insert_club_staff y
-- verif_docs_delete).
--
-- Verificado el 11/11/2026 con sesiones reales y con los flujos de la UI
-- (check-in + consumo, bono orgánico, asistencia por QR y manual, nómina).
-- ============================================================================

begin;

create policy commissions_restrictiva_insert on public.commissions
  as restrictive for insert to public
  with check (
    (select public.current_role_name()) = 'admin'
    or (
      tipo = 'plataforma' and rp_id is null and status = 'pendiente'
      and exists (select 1 from public.reservations r
                  where r.id = reservation_id and r.source = 'organica')
    )
  );

create policy rp_pagos_dia_restrictiva_insert on public.rp_pagos_dia
  as restrictive for insert to public
  with check ((select public.current_role_name()) = 'admin');

create policy commissions_restrictiva_select_sin_staff on public.commissions
  as restrictive for select to public
  using ((select public.current_role_name()) is distinct from 'staff');

commit;

-- (se corrió aparte)
create policy verificacion_documentos_restrictiva_delete on public.verificacion_documentos
  as restrictive for delete to public
  using ((select public.current_role_name()) = 'admin');
