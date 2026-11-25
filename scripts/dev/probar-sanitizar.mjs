// Prueba del limpiador de datos personales (lib/domain/sanitizar.ts), sin base.
//   node scripts/dev/probar-sanitizar.mjs
import { sinDatosPersonales, rutaSinParametros } from "../../lib/domain/sanitizar.ts";

const casos = [
  ["correo", "fallo para ana.perez@gmail.com", "fallo para [correo]"],
  ["teléfono 10 dígitos", "tel 33 1234 5678", "tel [número]"],
  ["fecha no es teléfono", "noche 2026-11-25", "noche 2026-11-25"],
  ["QR del boleto en la ruta", "/r/antro-3f2b1c4d-1111-4222-8333-444455556666", "/r/antro-[qr]"],
  ["QR de asistencia", "escaneó rp-attendance-3f2b1c4d-1111-4222-8333-444455556666", "escaneó rp-attendance-[qr]"],
  ["fila completa de Postgres", "new row violates check constraint. Failing row contains (5, Ana, 3312345678, antro-x).", "new row violates check constraint. Failing row contains ([fila])."],
  ["token JWT", "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk", "Bearer [token]"],
  ["llave de Stripe", "sk_test_abc123", "[llave]"],
  ["id de antro se queda (no es personal)", "/cliente/0de70000-0000-4000-8000-000000000001", "/cliente/0de70000-0000-4000-8000-000000000001"],
];
let ok = 0;
for (const [nombre, entrada, esperado] of casos) {
  const salida = sinDatosPersonales(entrada);
  const bien = salida === esperado;
  if (bien) ok++;
  console.log(`${bien ? "OK   " : "FALLA"}  ${nombre}${bien ? "" : `  — obtuvo: ${salida}`}`);
}
const bienRuta = rutaSinParametros("/r/antro-x?tel=331234") === "/r/antro-x";
if (bienRuta) ok++;
console.log(`${bienRuta ? "OK   " : "FALLA"}  ruta sin parámetros`);
console.log(`\nResultado: ${ok}/${casos.length + 1}`);
process.exit(ok === casos.length + 1 ? 0 : 1);
