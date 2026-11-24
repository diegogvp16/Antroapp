// Pruebas de lib/domain/alta-club.ts (reglas puras del alta de antros).
// No toca ninguna base: Node 24 carga el .ts directo (quita los tipos).
//
//   node scripts/dev/probar-alta-club-dominio.mjs

import {
  esquemaAltaClub,
  cuentasNuevas,
  payloadSql,
  generarMesas,
  leerListaPersonal,
  erroresPorCampo,
} from "../../lib/domain/alta-club.ts";

let pasan = 0, fallan = 0;
function revisar(cond, texto) {
  if (cond) pasan++; else fallan++;
  console.log((cond ? "OK     " : "FALLA  ") + texto);
}

const base = () => ({
  datos: { nombre: "Club Prueba", direccion: "Calle 1, Centro", ciudad: "Guadalajara", zona_horaria: "America/Mexico_City", horario: "Jue a Sáb 10pm a 3am" },
  politicas: { cover_modo: "oculto", cover_monto: null, deposito_monto: 0, edad_minima: 18, codigo_vestimenta: "", tipo_musica: "", ambiente: "", tolerancia_hora: null },
  mesas: [{ numero: "1", capacidad: 8 }, { numero: "VIP 1", capacidad: 15 }],
  dueno: { nombre: "Dueña Prueba", correo: "Duena@Example.com " },
  personal: [
    { nombre: "Gerente Uno", correo: "g1@example.com", rol: "gerente" },
    { nombre: "RP Uno", correo: "rp1@example.com", rol: "rp" },
  ],
  grupo: { modo: "ninguno" },
  publicar: false,
});
const valida = (x) => esquemaAltaClub.safeParse(x);
const mensajes = (r) => (r.success ? {} : erroresPorCampo(r.error));

// 1. Caso feliz y normalización.
{
  const r = valida(base());
  revisar(r.success, "alta completa válida");
  revisar(r.success && r.data.dueno.correo === "duena@example.com", "correo en minúsculas y sin espacios");
  const c = cuentasNuevas(r.data);
  revisar(c.length === 3 && c[0].rol === "dueno", "3 cuentas nuevas, primero el dueño");
  const ids = new Map(c.map((x, i) => [x.correo, `00000000-0000-4000-8000-00000000000${i}`]));
  const p = payloadSql(r.data, ids, "11111111-1111-4111-8111-111111111111");
  revisar(p.usuarios.length === 3 && p.usuarios.every((u) => u.id), "payload con id para cada cuenta");
  revisar(p.club.ambiente === null && p.club.tipo_musica === null, "textos vacíos van como null");
  revisar(p.grupo.modo === "ninguno", "sin grupo");
  revisar(p.alta_id === "11111111-1111-4111-8111-111111111111", "el payload lleva la clave de idempotencia");
}

// 2. Datos y políticas inválidos.
{
  const x = base(); x.datos.nombre = " "; x.datos.zona_horaria = "Europe/Madrid";
  const m = mensajes(valida(x));
  revisar(!!m["datos.nombre"] && !!m["datos.zona_horaria"], "nombre vacío y zona fuera de México se rechazan");
}
{
  const x = base(); x.politicas.cover_modo = "monto"; x.politicas.cover_monto = null;
  revisar(!!mensajes(valida(x))["politicas.cover_monto"], "cover en modo monto exige monto");
  x.politicas.cover_monto = 150.555;
  revisar(!!mensajes(valida(x))["politicas.cover_monto"], "cover con 3 decimales se rechaza");
  x.politicas.cover_monto = 350.5;
  revisar(valida(x).success, "cover 350.50 válido");
  x.politicas.cover_monto = 100001;
  revisar(!valida(x).success, "cover arriba de $100,000 se rechaza");
}
{
  const x = base(); x.politicas.cover_modo = "libre"; x.politicas.cover_monto = 100;
  revisar(!valida(x).success, "monto con modo «libre» se rechaza");
}
{
  const x = base(); x.politicas.edad_minima = 16;
  revisar(!!mensajes(valida(x))["politicas.edad_minima"], "edad mínima menor a 18 se rechaza");
  x.politicas.edad_minima = Number.NaN;
  revisar(mensajes(valida(x))["politicas.edad_minima"] === "La edad mínima es un número.", "edad NaN da mensaje en español");
  x.politicas.edad_minima = null;
  revisar(valida(x).success, "edad mínima opcional");
}
{
  const x = base(); x.politicas.tolerancia_hora = "25:00";
  revisar(!valida(x).success, "tolerancia 25:00 se rechaza");
  x.politicas.tolerancia_hora = "23:30";
  revisar(valida(x).success, "tolerancia 23:30 válida");
  x.politicas.deposito_monto = -1;
  revisar(!valida(x).success, "depósito negativo se rechaza");
}

// 3. Mesas.
{
  const x = base(); x.mesas.push({ numero: "vip 1", capacidad: 4 });
  const m = mensajes(valida(x));
  revisar(!!m["mesas.2.numero"], "mesa repetida (sin importar mayúsculas) se marca en su fila");
  x.mesas = [{ numero: "1", capacidad: 0 }];
  revisar(!!mensajes(valida(x))["mesas.0.capacidad"], "capacidad 0 se rechaza");
  x.mesas = [{ numero: "1", capacidad: Number.NaN }];
  revisar(mensajes(valida(x))["mesas.0.capacidad"] === "Escribe cuántas personas caben.", "capacidad vacía da mensaje en español");
  x.mesas = Array.from({ length: 301 }, (_, i) => ({ numero: String(i + 1), capacidad: 4 }));
  revisar(!valida(x).success, "más de 300 mesas se rechaza");
  x.mesas = [];
  revisar(valida(x).success, "se puede dar de alta sin mesas");
}
{
  const g = generarMesas([{ numero: "VIP 1", capacidad: 10 }], 3, "VIP", 12);
  revisar(g.map((m) => m.numero).join(",") === "VIP 2,VIP 3,VIP 4", "generar salta los nombres que ya existen");
  revisar(g.every((m) => m.capacidad === 12), "generar usa la capacidad dada");
  revisar(generarMesas([], 5, "", 8).map((m) => m.numero).join(",") === "1,2,3,4,5", "generar sin prefijo: 1..5");
  revisar(generarMesas(Array.from({ length: 299 }, (_, i) => ({ numero: "x" + i, capacidad: 1 })), 10, "", 1).length === 1, "generar no pasa del máximo");
}

// 4. Equipo y correos.
{
  const x = base(); x.personal.push({ nombre: "Otro", correo: "G1@example.com", rol: "staff" });
  const r = valida(x);
  revisar(!r.success && r.error.issues.some((i) => i.message.includes("dos veces")), "correo repetido entre personas se rechaza");
}
{
  const x = base(); x.personal[0].correo = "no-es-correo";
  revisar(!!mensajes(valida(x))["personal.0.correo"], "correo inválido marcado en su fila");
  x.personal[0].correo = "g1@example.com"; x.personal[0].rol = "admin";
  revisar(!valida(x).success, "rol admin no se puede crear desde el alta");
  x.personal[0].rol = "dueno";
  revisar(!valida(x).success, "rol dueño no va en la lista de personal");
}
{
  const { filas, errores } = leerListaPersonal("Ana López, ana@example.com\nluis@example.com; Luis Pérez\n\nsin correo\nBeto\tbeto@\n", "rp");
  revisar(filas.length === 2 && filas[1].nombre === "Luis Pérez" && filas.every((f) => f.rol === "rp"), "lista pegada: 2 válidas, nombre y correo en cualquier orden");
  revisar(errores.length === 2 && errores[0].startsWith("Línea 4") && errores[1].startsWith("Línea 5"), "lista pegada: errores con número de línea");
}

// 5. Grupo.
{
  const x = base(); x.grupo = { modo: "nuevo", nombre: "Grupo Prueba", dueno_grupo: "dueno_antro", cuenta: null };
  const r = valida(x);
  revisar(r.success, "grupo nuevo con el dueño del antro");
  const ids = new Map(cuentasNuevas(r.data).map((c, i) => [c.correo, "id" + i]));
  revisar(payloadSql(r.data, ids, "11111111-1111-4111-8111-111111111111").grupo.dueno_antro_es_dueno_grupo === true, "payload marca al dueño como dueño del grupo");
  x.dueno = null;
  revisar(!!mensajes(valida(x))["grupo.dueno_grupo"], "dueño del antro como dueño de grupo exige dueño");
}
{
  const x = base(); x.grupo = { modo: "nuevo", nombre: "G", dueno_grupo: "cuenta_nueva", cuenta: { nombre: "Dueño Grupo", correo: "grupo@example.com" } };
  revisar(!!mensajes(valida(x))["grupo.nombre"], "nombre de grupo de 1 letra se rechaza");
  x.grupo.nombre = "Grupo Bien";
  const r = valida(x);
  revisar(r.success && cuentasNuevas(r.data).some((c) => c.rol === "dueno_grupo"), "cuenta nueva de dueño de grupo");
  x.grupo.cuenta.correo = "duena@example.com";
  revisar(!valida(x).success, "dueño de grupo con el mismo correo que el dueño se rechaza");
}
{
  const x = base(); x.grupo = { modo: "existente", grupo_id: "no-uuid", dueno_grupo: "ninguno", cuenta: null };
  revisar(!!mensajes(valida(x))["grupo.grupo_id"], "grupo existente exige un id válido");
  x.grupo.grupo_id = "0de70000-0000-4000-8000-000000000009";
  revisar(valida(x).success, "grupo existente sin cambiar dueños");
}

// 6. Entradas hostiles.
{
  revisar(!valida(null).success && !valida("x").success && !valida({}).success, "cuerpo vacío o no objeto se rechaza");
  const x = base(); x.personal = Array.from({ length: 401 }, (_, i) => ({ nombre: "RP " + i, correo: `rp${i}@example.com`, rol: "rp" }));
  revisar(!valida(x).success, "más de 400 personas se rechaza");
  x.personal = x.personal.slice(0, 400);
  revisar(!valida(x).success && mensajes(valida(x)).personal?.includes("contando dueños"), "400 personas + dueño = 401 cuentas: se rechaza");
  x.personal = x.personal.slice(0, 399);
  revisar(valida(x).success, "399 personas + dueño = 400 cuentas: válido");
  const y = base(); y.club_id = "otro"; y.datos.estado_verificacion = "verificado";
  const r = valida(y);
  revisar(r.success && !("club_id" in r.data) && !("estado_verificacion" in r.data.datos), "campos extra se descartan");
}

console.log(`\n${pasan} pasan, ${fallan} fallan`);
if (fallan) process.exitCode = 1;
