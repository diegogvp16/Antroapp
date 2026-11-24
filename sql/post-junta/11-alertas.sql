-- ============================================================================
-- AntroApp — Registro de alertas por correo enviadas (monitoreo)
-- Fecha: 2026-11-24 (rama post-junta)
-- Estado: APLICADO Y PROBADO EN DEV. En producción NO (va en el "pase 2").
-- Rollback: sql/post-junta/11-alertas-rollback.sql
--
-- lib/alertas.ts manda como máximo una alerta de cada tipo por hora; aquí
-- queda cuándo se mandó. Solo el servidor (service_role) la usa. Sin datos
-- personales: solo el tipo y la hora.
-- ============================================================================
create table public.alertas_enviadas (
  id          bigint generated always as identity primary key,
  tipo        text not null check (char_length(tipo) between 1 and 80),
  enviado_en  timestamptz not null default now()
);
create index alertas_enviadas_tipo on public.alertas_enviadas (tipo, enviado_en desc);
alter table public.alertas_enviadas enable row level security;
revoke all on public.alertas_enviadas from public, anon, authenticated;
grant all on public.alertas_enviadas to service_role;
