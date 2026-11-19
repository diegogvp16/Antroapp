-- ============================================================================
-- AntroApp — Cover informativo del antro
-- Fecha: 2026-11-20 (borrador del 12/11/2026)
-- Estado: APLICADO Y PROBADO EN DEV. En producción NO, hasta el pase del
-- bloque 6, con su rollback (sql/2026-11-20-cover-rollback.sql).
--
-- La app NO cobra nada a los clientes. No hay depósito, ni reembolso, ni
-- crédito, ni retención. El antro informa su cover (lo que cobra él en la
-- puerta, por su cuenta) y la app solo lo muestra.
--
--   clubs.cover_modo (por defecto 'oculto'):
--     'monto'     -> "Cover $X" (cover_monto obligatorio, > 0)
--     'libre'     -> "Entrada libre"
--     'consultar' -> "Cover: consultar con el antro"
--     'oculto'    -> no se muestra nada
--   clubs.cover_monto: nulo salvo en modo 'monto'.
--   clubs.deposito_monto NO se borra: queda sin usar, con default 0.
--
-- Permisos: no hacen falta GRANT nuevos (son columnas de clubs, que ya tiene
-- los suyos). El dueño edita su cover con la política de UPDATE que ya
-- tiene; los candados de clubs no miran estas columnas.
-- Se aplica completo en una transacción. Las verificaciones están en
-- scripts/dev/probar-caja.mjs (sección cover).
-- ============================================================================

-- 1. Columnas. Los antros existentes quedan en 'oculto' hasta que su dueño
--    o el admin configuren el cover.
alter table public.clubs
  add column cover_modo  text not null default 'oculto'
    constraint clubs_cover_modo_valido
      check (cover_modo in ('monto', 'libre', 'consultar', 'oculto')),
  add column cover_monto numeric(10, 2);

-- 2. Coherencia entre modo y monto: en 'monto' es obligatorio y mayor a 0
--    (tope $100,000); en cualquier otro modo va nulo, para que nunca se
--    muestre un monto viejo por error.
alter table public.clubs
  add constraint clubs_cover_monto_coherente check (
    case
      when cover_modo = 'monto' then cover_monto is not null and cover_monto > 0 and cover_monto <= 100000
      else cover_monto is null
    end
  );

-- 3. deposito_monto queda sin usar (no se borra). Los formularios ya no lo
--    mandan: los antros nuevos nacen con 0 en vez de 100.
comment on column public.clubs.deposito_monto is
  'SIN USO desde 2026-11. La app no cobra depósitos. Usar cover_modo / cover_monto. No borrar todavía.';
alter table public.clubs alter column deposito_monto set default 0;
