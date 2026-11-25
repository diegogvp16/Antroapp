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
  esquemaReglaComision,
  cambiosDePermisos,
  matrizPorDefecto,
  permisoPorDefecto,
  PERMISOS_CAJA_ALTA,
} from "../../lib/domain/alta-club.ts";
import { validarRegla } from "../../lib/domain/config-rp.ts";

let pasan = 0, fallan = 0;
function revisar(cond, texto) {
  if (cond) pasan++; else fallan++;
  console.log((cond ? "OK     " : "FALLA  ") + texto);
}

const base = () => ({
  datos: { nombre: "Club Prueba", direccion: "Calle 1, Centro", ciudad: "Guadalajara", zona_horaria: "America/Mexico_City", horario: "Jue a Sáb 10pm a 3am" },
  politicas: { cover_modo: "oculto", cover_monto: null, deposito_monto: 0, edad_minima: 18, codigo_vestimenta: "", tipo_musica: "", ambiente: "", tolerancia_hora: null },
  mesas: [{ numero: "1", capacidad: 8 }, { numero: "VIP 1", capacidad: 15 }],
  rp: { modo_pago: "reserva", regla: { tipo: "fijo", cuota: 0, porcentaje_bp: null, monto_centavos: 15000 }, visibilidad: "estado_monto", tarifas_dia: [] },
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

// 7. Reglas de comisión y RPs (sql/post-junta-2/10-alta-club-reglas.sql).
{
  const r = valida(base());
  const ids = new Map(cuentasNuevas(r.data).map((c, i) => [c.correo, "id" + i]));
  const p = payloadSql(r.data, ids, "11111111-1111-4111-8111-111111111111");
  revisar(p.rp?.modo_pago === "reserva" && p.rp.regla?.tipo === "fijo" && p.rp.regla.monto_centavos === 15000 && p.rp.visibilidad === "estado_monto", "el payload lleva la regla y lo que ven los RPs");
  revisar(Array.isArray(p.caja_permisos) && p.caja_permisos.length === 0, "sin permisos personalizados: lista vacía (valen los de la plataforma)");
  const sinRp = base(); delete sinRp.rp;
  revisar(!!mensajes(valida(sinRp)).rp, "el alta sin reglas de RPs se rechaza (no nace con las columnas viejas)");
}
{
  const x = base(); x.rp.regla = null;
  revisar(mensajes(valida(x))["rp.regla"] === "Configura la regla de comisión por reserva.", "pago por reserva sin regla se rechaza");
  x.rp = { modo_pago: "dia", regla: null, visibilidad: "estado", tarifas_dia: [] };
  revisar(mensajes(valida(x))["rp.tarifas_dia"] === "Escribe al menos la tarifa del día 1.", "pago por día sin tarifas se rechaza");
  x.rp.tarifas_dia = [30000, 30000, 50000];
  const r = valida(x);
  revisar(r.success, "pago por día con 3 tarifas y sin regla es válido");
  const p = payloadSql(r.data, new Map(cuentasNuevas(r.data).map((c, i) => [c.correo, "id" + i])), "11111111-1111-4111-8111-111111111111");
  revisar(JSON.stringify(p.rp.tarifas_dia) === JSON.stringify([{ posicion: 1, monto_centavos: 30000 }, { posicion: 2, monto_centavos: 30000 }, { posicion: 3, monto_centavos: 50000 }]), "las tarifas viajan con su día (1, 2, 3)");
  x.rp.tarifas_dia = [0];
  revisar(valida(x).success, "tarifa de $0 permitida (día sin pago)");
  x.rp.tarifas_dia = Array(8).fill(100);
  revisar(!!mensajes(valida(x))["rp.tarifas_dia"], "más de 7 tarifas se rechaza");
  x.rp.tarifas_dia = [Number.NaN];
  revisar(mensajes(valida(x))["rp.tarifas_dia.0"] === "Cada tarifa va de $0 a $100,000.", "tarifa vacía da mensaje en español en su fila");
  x.rp.tarifas_dia = [10_000_001];
  revisar(!valida(x).success, "tarifa arriba de $100,000 se rechaza");
  x.rp.tarifas_dia = [100.5];
  revisar(!valida(x).success, "tarifa con fracción de centavo se rechaza");
}
{
  const x = base(); x.rp.modo_pago = "semana";
  revisar(!!mensajes(valida(x))["rp.modo_pago"], "modo de pago desconocido se rechaza");
  x.rp.modo_pago = "reserva"; x.rp.visibilidad = "todo";
  revisar(!!mensajes(valida(x))["rp.visibilidad"], "visibilidad desconocida se rechaza");
}
// La misma regla que el editor del dueño (validarRegla) y la base (config_rp_cambiar_regla).
{
  const casos = [
    [{ tipo: "porcentaje", cuota: 0, porcentaje_bp: 1000, monto_centavos: null }, true],
    [{ tipo: "porcentaje", cuota: 0, porcentaje_bp: 0, monto_centavos: null }, false],
    [{ tipo: "porcentaje", cuota: 0, porcentaje_bp: 10001, monto_centavos: null }, false],
    [{ tipo: "porcentaje", cuota: 0, porcentaje_bp: null, monto_centavos: null }, false],
    [{ tipo: "fijo", cuota: 0, porcentaje_bp: null, monto_centavos: 1 }, true],
    [{ tipo: "fijo", cuota: 0, porcentaje_bp: null, monto_centavos: 0 }, false],
    [{ tipo: "fijo", cuota: 0, porcentaje_bp: null, monto_centavos: 10_000_000 }, true],
    [{ tipo: "fijo", cuota: 0, porcentaje_bp: null, monto_centavos: 10_000_001 }, false],
    [{ tipo: "cuota", cuota: 4, porcentaje_bp: null, monto_centavos: 20000 }, true],
    [{ tipo: "cuota", cuota: 0, porcentaje_bp: null, monto_centavos: 20000 }, false],
    [{ tipo: "cuota", cuota: 101, porcentaje_bp: null, monto_centavos: 20000 }, false],
    [{ tipo: "cuota", cuota: 100, porcentaje_bp: null, monto_centavos: null }, false],
  ];
  const coinciden = casos.every(([regla, esperado]) => esquemaReglaComision.safeParse(regla).success === esperado && (validarRegla(regla) === null) === esperado);
  revisar(coinciden, `regla: ${casos.length} casos dan lo mismo en el alta y en el editor del dueño`);
  const mismosMensajes = casos.filter(([, ok]) => !ok).every(([regla]) => {
    const r = esquemaReglaComision.safeParse(regla);
    return !r.success && r.error.issues[0].message === validarRegla(regla);
  });
  revisar(mismosMensajes, "y con los mismos mensajes de error");
  const n = esquemaReglaComision.safeParse({ tipo: "fijo", cuota: 9, porcentaje_bp: 500, monto_centavos: 15000 });
  revisar(n.success && n.data.cuota === 0 && n.data.porcentaje_bp === null, "lo que no usa el tipo se manda vacío (la tabla lo exige)");
  const t = esquemaReglaComision.safeParse({ tipo: "otro", cuota: 0, porcentaje_bp: null, monto_centavos: 100 });
  revisar(!t.success, "tipo de regla desconocido se rechaza");
}
// Permisos de caja por rol.
{
  const m = matrizPorDefecto();
  revisar(PERMISOS_CAJA_ALTA.length === 9 && Object.values(m.gerente).every(Boolean), "por defecto el gerente puede los 9 permisos");
  const staffSi = Object.entries(m.staff).filter(([, v]) => v).map(([k]) => k).sort().join(",");
  revisar(staffSi === "abrir_mesa,cerrar_mesa,cobrar,puerta,registrar_consumo", "por defecto el staff: puerta, abrir, consumo, cobrar y cerrar (igual que caja_tiene_permiso)");
  revisar(cambiosDePermisos(m).length === 0, "sin cambios no se manda nada");
  m.staff.cobrar = false; m.staff.anular = true; m.gerente.cerrar_noche = false;
  const c = cambiosDePermisos(m);
  revisar(c.length === 3 && c.some((x) => x.rol === "staff" && x.permiso === "cobrar" && x.permitido === false) && c.some((x) => x.rol === "gerente" && x.permiso === "cerrar_noche" && !x.permitido), "solo viajan las casillas que cambian");
  const x = base(); x.caja_permisos = c;
  revisar(valida(x).success, "alta con 3 permisos cambiados es válida");
  x.caja_permisos = [...c, c[0]];
  revisar(!valida(x).success, "permiso repetido se rechaza");
  x.caja_permisos = [{ permiso: "cobrar", rol: "rp", permitido: true }];
  revisar(!valida(x).success, "permisos para RP no existen");
  x.caja_permisos = [{ permiso: "borrar_todo", rol: "staff", permitido: true }];
  revisar(!valida(x).success, "permiso desconocido se rechaza");
  x.caja_permisos = [{ permiso: "cobrar", rol: "staff", permitido: "si" }];
  revisar(!valida(x).success, "«permitido» tiene que ser sí o no");
  revisar(permisoPorDefecto("staff", "cuadrar_mesa") === false && permisoPorDefecto("gerente", "cuadrar_mesa") === true, "cuadrar: el staff no, el gerente sí");
}

console.log(`\n${pasan} pasan, ${fallan} fallan`);
if (fallan) process.exitCode = 1;
