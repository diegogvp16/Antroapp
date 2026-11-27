// Pruebas de dominio (sin base) de la lista negra / no-show y de los
// mensajes de WhatsApp: normalización de teléfonos, plantillas (validación y
// relleno), enlaces wa.me y conteo de no-shows.
//
//   node scripts/dev/probar-clientes-dominio.mjs
//
// Los módulos de lib/domain usan el alias "@/" de Next: aquí un gancho lo
// traduce a la raíz del proyecto (y agrega ".ts").
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
registerHooks({
  resolve(esp, ctx, siguiente) {
    if (esp.startsWith("@/")) {
      const ruta = path.join(RAIZ, esp.slice(2));
      return siguiente(pathToFileURL(/\.[cm]?[jt]s$/.test(ruta) ? ruta : ruta + ".ts").href, ctx);
    }
    return siguiente(esp, ctx);
  },
});
const wa = await import(pathToFileURL(path.join(RAIZ, "lib/domain/whatsapp.ts")).href);
const ln = await import(pathToFileURL(path.join(RAIZ, "lib/domain/lista-negra.ts")).href);

const res = [];
const nota = (t, ok, d = "") => { res.push(ok); console.log(`${ok ? "OK   " : "FALLA"}  ${t}${d ? "  — " + d : ""}`); };
const igual = (t, a, b) => nota(t, JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a));

// ---------- Teléfonos ----------
igual("10 dígitos", wa.normalizarTelefonoMx("5512345678"), "5512345678");
igual("con espacios y guiones", wa.normalizarTelefonoMx("55 1234-5678"), "5512345678");
igual("con paréntesis y puntos", wa.normalizarTelefonoMx("(55) 1234.5678"), "5512345678");
igual("+52", wa.normalizarTelefonoMx("+52 55 1234 5678"), "5512345678");
igual("+52 1 (celular viejo)", wa.normalizarTelefonoMx("+52 1 55 1234 5678"), "5512345678");
igual("521 pegado", wa.normalizarTelefonoMx("5215512345678"), "5512345678");
igual("letras mezcladas: solo los dígitos", wa.normalizarTelefonoMx("tel: 55-1234-5678 casa"), "5512345678");
igual("044 / 045 / 01 + 10", ["044 55 1234 5678", "045 55 1234 5678", "01 55 1234 5678"].map(wa.normalizarTelefonoMx), ["5512345678", "5512345678", "5512345678"]);
igual("extranjero (+1 212 555 1234): no es de México", wa.normalizarTelefonoMx("+1 212 555 1234"), null);
igual("dígitos de más (+52 1 331 999 8877 1): no es de México", wa.normalizarTelefonoMx("+52 1 331 999 8877 1"), null);
igual("clave de lista negra: extranjero completo", wa.claveTelefono("+1 212 555 1234"), "12125551234");
igual("clave de lista negra: dígitos de más, completos (no se recorta)", wa.claveTelefono("+52 1 331 999 8877 1"), "52133199988771");
igual("clave de lista negra: de México, 10", wa.claveTelefono("+52 1 33 1999 8877"), "3319998877");
igual("clave: menos de 8 o más de 15 dígitos, null", [wa.claveTelefono("1234567"), wa.claveTelefono("1".repeat(16))], [null, null]);
igual("extranjero: wa.me sin destinatario", wa.numeroWhatsApp("+1 212 555 1234"), null);
igual("menos de 10 dígitos: null", wa.normalizarTelefonoMx("1234567"), null);
igual("vacío / null: null", [wa.normalizarTelefonoMx(""), wa.normalizarTelefonoMx(null)], [null, null]);
igual("número para wa.me: 52 + 10", wa.numeroWhatsApp("+52 1 33 1234 5678"), "523312345678");
igual("sin teléfono: sin número", wa.numeroWhatsApp("12"), null);
igual("máscara ***1234", wa.mascaraTelefono("55 1234 5678"), "***5678");

const e1 = wa.enlaceWa("55 1234 5678", "Hola & adiós ñ");
nota("enlace directo a 52XXXXXXXXXX", e1.directo && e1.href === "https://wa.me/525512345678?text=Hola%20%26%20adi%C3%B3s%20%C3%B1", e1.href);
const eX = wa.enlaceWa("+1 212 555 1234", "Hola");
nota("extranjero: enlace genérico, no a un 52… inventado", !eX.directo && eX.href === "https://wa.me/?text=Hola", eX.href);
const e2 = wa.enlaceWa(null, "Hola");
nota("sin teléfono: compartir genérico", !e2.directo && e2.href === "https://wa.me/?text=Hola", e2.href);

// ---------- Plantillas ----------
for (const t of wa.TIPOS_PLANTILLA) {
  const v = wa.validarPlantilla(wa.PLANTILLAS_FABRICA[t]);
  nota(`texto de fábrica válido: ${t}`, v.ok, v.errores.join(" "));
}
nota("confirmación de fábrica avisa que el QR no garantiza la entrada", wa.PLANTILLAS_FABRICA.confirmacion.includes("no garantiza la entrada"));
const desconocida = wa.validarPlantilla("Hola {nombre}, {mesa} y {Nombre}");
igual("variables desconocidas se reportan", desconocida.desconocidas, ["mesa", "Nombre"]);
nota("…y no es válida", !desconocida.ok);
nota("llave suelta", !wa.validarPlantilla("Hola {nombre").ok && !wa.validarPlantilla("Hola nombre}").ok);
nota("doble llave {{nombre}}: suelta", !wa.validarPlantilla("Hola {{nombre}}").ok);
nota("llaves vacías {}: no válida", !wa.validarPlantilla("Hola {}").ok);
nota("vacío o solo espacios: no válida", !wa.validarPlantilla("   ").ok);
nota("1000 caracteres: válida", wa.validarPlantilla("a".repeat(1000)).ok);
const largo = wa.validarPlantilla("a".repeat(1001));
nota("1001 caracteres: no válida", !largo.ok && largo.largo === 1001, largo.errores.join(" "));
nota("todas las variables juntas: válida", wa.validarPlantilla(wa.VARIABLES_PLANTILLA.map((v) => `{${v}}`).join(" ")).ok);

const datos = wa.datosDeReserva({
  cliente_nombre: "  Ana  María López ",
  antro: "Club Demo",
  fecha: "2026-11-25",
  personas: 1,
  horario: "22:00 a 04:00",
  qr_code: "antro-abc",
  origen: "https://antroapp.vercel.app/",
});
igual("datos: primer nombre", datos.nombre, "Ana");
igual("datos: fecha larga", datos.fecha, "miércoles 25 de noviembre");
igual("datos: 1 persona en singular", datos.personas, "1 persona");
igual("datos: enlace al boleto", datos.enlace_boleto, "https://antroapp.vercel.app/r/antro-abc");
igual(
  "relleno de variables",
  wa.renderPlantilla("Hola {nombre}, {antro} {fecha} {hora} {personas} {enlace_boleto}", datos),
  "Hola Ana, Club Demo miércoles 25 de noviembre 22:00 a 04:00 1 persona https://antroapp.vercel.app/r/antro-abc",
);
igual("variable sin dato queda vacía", wa.renderPlantilla("[{hora}]", { nombre: "x" }), "[]");
igual("nombre seguro: un enlace no entra", wa.nombreSeguro("https://phish.example/x Ana"), "");
igual("nombre seguro: letras con acento", [wa.nombreSeguro("  José  Pérez"), wa.nombreSeguro("Ñoño"), wa.nombreSeguro("Ana-María")], ["José", "Ñoño", ""]);
igual("nombre seguro: más de 30 letras, vacío", wa.nombreSeguro("a".repeat(31)), "");
igual("datos: nombre con enlace queda vacío", wa.datosDeReserva({ cliente_nombre: "www.phish.mx", antro: "X", fecha: null, personas: 2, origen: "https://x" }).nombre, "");
igual("sin nombre no queda «Hola ,»", wa.renderPlantilla("Hola {nombre}, ya quedó.", { nombre: "" }), "Hola, ya quedó.");
igual("variable desconocida no se toca", wa.renderPlantilla("{mesa} {nombre}", { nombre: "Ana" }), "{mesa} Ana");
nota("la confirmación de fábrica rellenada no deja variables", !/\{/.test(wa.renderPlantilla(wa.PLANTILLAS_FABRICA.confirmacion, datos)));
igual("plantilla propia gana a la de fábrica", wa.plantillaEfectiva("recordatorio", { recordatorio: "Propio {nombre}" }), "Propio {nombre}");
igual("propia vacía: la de fábrica", wa.plantillaEfectiva("no_show", { no_show: "  " }), wa.PLANTILLAS_FABRICA.no_show);
igual("mensajes por estado", ["por_llegar", "no_llego", "consumio", "llego_sin_consumo"].map(wa.tiposParaEstado),
  [["confirmacion", "recordatorio"], ["no_show"], [], []]);
nota("el aviso dice que abrir no envía nada", /no envía nada/.test(wa.AVISO_ENLACE_WA));

// ---------- No-show ----------
const hoy = "2026-11-27";
const base = { entro: false, consumoCentavos: 0, nocheCerrada: false, hoy };
igual("noche pasada sin entrar: no llegó", ln.estadoReserva({ ...base, fecha: "2026-11-26" }), "no_llego");
igual("esta noche sin cerrar: por llegar", ln.estadoReserva({ ...base, fecha: hoy }), "por_llegar");
igual("esta noche con caja cerrada: no llegó", ln.estadoReserva({ ...base, fecha: hoy, nocheCerrada: true }), "no_llego");
igual("entró sin consumo", ln.estadoReserva({ ...base, fecha: "2026-11-20", entro: true }), "llego_sin_consumo");
igual("consumió (aunque no marcaran entrada)", ln.estadoReserva({ ...base, fecha: "2026-11-20", consumoCentavos: 100 }), "consumio");
igual("noche futura: por llegar", ln.estadoReserva({ ...base, fecha: "2026-11-30" }), "por_llegar");
const cuenta = ln.contarNoShows([
  { ...base, telefono: "5511111111", fecha: "2026-11-26", verificada: true },
  { ...base, telefono: "5511111111", fecha: "2026-11-26" }, // misma noche: no suma
  { ...base, telefono: "5511111111", fecha: "2026-11-26" },
  { ...base, telefono: "5511111111", fecha: "2026-11-20" }, // sin cuenta: avisa, no cuenta
  { ...base, telefono: "5511111111", fecha: "2026-11-19", entro: true },
  { ...base, telefono: "5511111111", fecha: "2026-08-01" }, // fuera de la ventana
  { ...base, telefono: "5522222222", fecha: hoy }, // noche en curso
  { ...base, telefono: "5522222222", fecha: hoy, nocheCerrada: true },
  { ...base, telefono: null, fecha: "2026-11-26" },
], "2026-08-29");
igual("conteo por NOCHES distintas; para el automático solo con cuenta o RP", Object.fromEntries(cuenta),
  { "5511111111": { no_shows: 2, cuentan: 1 }, "5522222222": { no_shows: 1, cuentan: 0 } });
igual("política de fábrica sin bloqueo automático", ln.POLITICA_FABRICA, { avisar_desde: 2, ventana_dias: 90, bloquear_desde: null });
igual("política válida", ln.validarPolitica({ avisar_desde: 2, ventana_dias: 90, bloquear_desde: 3 }), []);
nota("bloqueo automático menor que el aviso: no", ln.validarPolitica({ avisar_desde: 3, ventana_dias: 90, bloquear_desde: 2 }).length === 1);
nota("ventana fuera de rango: no", ln.validarPolitica({ avisar_desde: 2, ventana_dias: 3, bloquear_desde: null }).length === 1);
nota("motivo corto: no", ln.validarMotivo(" ab ") !== null && ln.validarMotivo("Agresivo en la puerta") === null);
nota("mensaje al cliente neutro (sin 'bloque', sin 'lista', sin 'motivo')",
  !/bloque|lista|motivo|no-show/i.test(ln.MENSAJE_RECHAZO_CLIENTE));
nota("mensaje al RP sin motivo", !/motivo/i.test(ln.MENSAJE_RECHAZO_RP));
igual("texto de no-shows", [ln.textoNoShows(1, 90), ln.textoNoShows(3, 30)],
  ["1 noche sin llegar en los últimos 90 días", "3 noches sin llegar en los últimos 30 días"]);

const ok = res.filter(Boolean).length;
console.log(`\nResultado: ${ok}/${res.length}`);
process.exit(ok === res.length ? 0 : 1);
