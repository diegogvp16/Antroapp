# Guion de la junta del miércoles 25/11/2026

Demostración de 10 minutos para el **dueño de un grupo de varios antros**.
Preparado el 23/11/2026 sobre la rama `candidato-pase`.

## Dónde se hace la demo

| Si… | Se usa | Por qué |
|---|---|---|
| **El pase ya se hizo** (lunes 23 o martes 24) | Producción: **antroapp.vercel.app**, Club Demo | Es lo real. Las cuentas son las de Club Demo; las contraseñas están en `backups/2026-11-12-club-demo-credenciales.json`. |
| **El pase no se hizo** | La vista previa de `candidato-pase` (dev), Club Demo Dev | Producción todavía no tiene caja, `/grupo`, nómina nueva ni panel del RP nuevo. |

**El panel de grupo con 2 ciudades solo existe en dev** (Grupo Demo Dev:
Guadalajara y Tijuana). En producción hay un solo antro publicado y las
tablas de grupo llegan con el pase; armar ahí un segundo antro y un grupo
es una decisión tuya (ver "Producción el día de la junta"). Recomendación:
esa parte se muestra desde la vista previa, aunque el resto sea en producción.

### Cuentas

| Papel en la demo | Producción (después del pase) | Dev (vista previa) |
|---|---|---|
| Cliente | sin cuenta (reserva como invitado) | sin cuenta, o `dev_cliente` |
| RP | `demo_mariana` | `demo_mariana` |
| Staff (puerta y caja) | **falta crear una cuenta de staff en Club Demo** (ver checklist) | `dev_staff` |
| Gerente | `lolo.demo@example.com` (Lorena Olvera) | `dev_gerente` |
| Dueño de grupo | tu cuenta de dueño (un antro) | `dev_dueno` (2 antros, 2 ciudades) |

Contraseñas de dev: `backups/dev-credenciales.json`. Ninguna contraseña se
escribe en este documento.

**Dispositivos**: celular A (staff/gerente, con el escáner), celular B
(cliente y RP), laptop o tablet para `/grupo` en pantalla grande. Todos con
sesión **ya iniciada** antes de entrar (ver checklist).

## Guion (10 minutos)

| Min | Pantalla | Quién | Qué se ve | Qué decir |
|---|---|---|---|---|
| 0:00 | — | — | — | **Mensaje clave**: "Hoy no sabes, noche por noche y antro por antro, qué reserva trajo cada RP, si llegó y cuánto consumió. AntroApp lo junta en una pantalla, del QR de la puerta al cuadre de la mesa." |
| 0:30 | `/cliente` → ficha de Club Demo → Reservar | Cliente (celular B) | Ficha con fotos, horario, vestimenta, edad mínima; reserva en 3 campos sin crear cuenta; **boleto con QR** y el aviso "El QR aparta tu lugar, pero no garantiza la entrada". | "Al cliente no se le cobra nada; el antro conserva su derecho de admisión." Usar teléfono **0000000123** para que la limpieza de la demo la borre. |
| 1:30 | `/rp/panel` → Reservas | RP `demo_mariana` (celular B) | Sus reservas de la semana con estados: **Consumió · Llegó, sin consumo · No llegó · Por llegar**; la tarjeta de su **cuota** (en dev: alcanzada); crear una reserva y **Compartir por WhatsApp** (mensaje con fecha legible y el aviso del QR). | "El RP ve solo lo suyo y sabe al momento si su cliente llegó y consumió: deja de haber discusión de 'yo te traje gente'." |
| 3:00 | `/staff/panel` → **Escanear QR** | Staff (celular A) | Escanear el boleto del minuto 0:30 (celular B o papel) → ficha del cliente → **Confirmar entrada**. | "En la puerta no se escribe nada a mano; si la cámara falla, hay 'Confirmar entrada sin cámara'." |
| 4:00 | `/staff/caja` | Staff (celular A) | Mapa de **50 mesas** (en producción, las que tenga Club Demo) con su estado; abrir una mesa, **sentar** al cliente que acaba de entrar, **agregar consumo** con −/+, **cobrar**. | "Si se va la señal no se pierde nada ni se duplica: el botón dice 'Sin conexión' y al volver se guarda una vez. Dos meseros en la misma mesa no se pisan." |
| 5:30 | `/staff/caja` → la mesa → **Cuadrar mesa** | Gerente (celular A, otra sesión o la misma con gerente) | La mesa queda cuadrada y bloqueada; **ahí nace la comisión del RP**. Mesas con 2 y 3 grupos en la noche. | "Nada se borra: un error se anula con motivo y queda quién lo hizo. Lo cuadrado ya no se toca." |
| 6:30 | `/grupo` (laptop) | Dueño de grupo `dev_dueno` | **Total de 2 antros** y luego por ciudad (**Guadalajara** y **Tijuana**, cada antro en su propia hora): reservas, entraron, **consumieron** con su **% de conversión (noches cerradas)**, **consumo en caja** con lo que vino de reserva, ticket por cuenta, comisiones; abrir **Rendimiento por RP** (quién trae gente que sí consume). | "Esta es la vista del dueño del grupo: todos sus antros, en tiempo real, sin pedirle el corte a nadie." Cambiar a **Semana anterior** para ver la conversión con noches ya cerradas. |
| 8:00 | `/dueno/nomina` o `/staff/nomina` | Dueño / gerente | Nómina de RPs de la semana: lo que gana cada uno, estados pendiente → en revisión → validada → pagada, exportar CSV. | "La comisión la paga el antro en su nómina; AntroApp solo la calcula para que antro y RP tengan el mismo número." |
| 9:00 | Instalar la app | — | Menú del navegador → **Instalar app**: "Antro Staff", "Antro RP" y "Antro Dueño" abren directo en su panel, a pantalla completa. | Cierre: siguientes pasos (prueba en uno de sus antros) y preguntas. |

### Qué datos se ven

Los números salen de `scripts/demo-datos.mjs`, que se vuelve a correr el día
de la junta (checklist). Al correrlo imprime el resumen por noche
("40 reservas, 27 con entrada, consumo $…"): **anotar esos números** en una
tarjeta; son los que deben verse en `/grupo` y en la caja. Referencia de la
corrida de hoy en dev (lunes 23/11): noche en curso 40 reservas, 27 con
entrada, consumo $160,700; semana anterior: jueves 28/18, viernes 31/21,
sábado 28/19.

En `/grupo`, **"Esta semana"** solo tiene la noche en curso (abierta): la
conversión sale "—" porque **solo se calcula con noches cerradas**. Para
mostrar el porcentaje, cambiar a **Semana anterior**. En dev, hoy, con el grupo de 2 antros: 95 reservas, 66 entraron (69 %), 66 consumieron (**69 % de conversión, noches cerradas**), consumo en caja $581,400 ($539,900 con reserva), ticket por cuenta $7,856.76, comisiones y pagos $14,974, 6 noches cerradas.

## Si preguntan…

**Precio.** "El precio está por definir. Queremos que lo pague el ahorro
que les genera; lo cerramos después de una prueba en uno de sus antros." No
dar cifras ni rangos.

**Seguridad y privacidad.**
- Cada antro ve solo lo suyo y cada persona solo lo de su rol. Lo cuida la base de datos (reglas por antro y por rol), no solo la pantalla.
- El staff no ve sueldos; el RP solo ve sus reservas.
- El boleto público no muestra el teléfono del cliente.
- En caja nada se borra: todo se anula con motivo y queda quién lo hizo y cuándo.
- La app no cobra nada al cliente final ni guarda tarjetas.
- El inicio de sesión tiene límite de intentos.
- Un RP o un staff dado de baja pierde el acceso al momento, aunque tenga la sesión abierta.
- No prometer certificaciones ni fechas de respaldo: "la infraestructura es Supabase (Postgres) y Vercel, y tenemos respaldos del proveedor".

**Algo que no existe.** Decir "eso no lo tenemos hoy; lo anoto" y anotarlo
en una lista visible. No improvisar ni enseñar ramas sin terminar. Lo que
**no** existe hoy:
- inventario y propinas (en desarrollo aparte: no se muestra);
- cobro con tarjeta dentro de la app;
- conexión con su punto de venta;
- alta masiva de RPs;
- un dueño con varios antros desde su propio panel (eso hoy se ve en `/grupo`);
- reportes por correo.

## Plan de contingencia

| Falla | Qué hacer (en orden) |
|---|---|
| **Internet del lugar** | 1) Compartir datos desde el celular B (hotspot) a la laptop y al celular A. 2) Mostrar que la caja dice **"Sin conexión · reconectando…"** y no pierde lo capturado: convertirlo en parte de la demo. 3) Si no hay datos en ningún lado: **plan B** (capturas y video). |
| **Login** | Las sesiones se inician la noche anterior y no se cierran. Si se cayó una: probar la cuenta en el otro celular. Si dice que hay demasiados intentos, esperar 15 min **o** entrar desde otro celular y otra red (el bloqueo es por correo e IP). Tener una segunda cuenta por rol (dev: `dev_gerente` también sirve para caja). |
| **Escáner del QR** | 1) Subir el brillo del celular que muestra el boleto al máximo. 2) Usar el **boleto impreso**. 3) "Cerrar escáner" → en la lista de la noche, **"Confirmar entrada sin cámara"** con el nombre del cliente. En la prueba de hoy leyó en ~2.3 s con luz normal, poca luz y muy oscuro (ver más abajo). |
| **Un celular** | Pasar ese papel al otro celular (con sesión ya iniciada en las dos cuentas) o a la laptop en modo celular (Chrome → F12 → vista de dispositivo, 390 px). |
| **Los datos demo se ven mal** (mesas vacías, números raros, noche equivocada) | Regenerarlos (abajo). Si no se puede en el momento, cambiar a la vista previa de dev o al plan B. |
| **Una pantalla da error** | No insistir: "Esto lo vemos después". Pasar al siguiente minuto del guion o al plan B. |

### Regenerar los datos demo en 2 minutos

Desde la laptop, en la carpeta del proyecto:

```bash
# DEV (vista previa): la noche de hoy, mesas extra
node scripts/demo-datos.mjs --env=.env.dev --si
node scripts/dev/mesas-extra.mjs

# PRODUCCIÓN (solo después del pase y después de las 08:00 del día):
node scripts/demo-datos.mjs --fecha=2026-11-25          # simula: revisar el resumen
node scripts/demo-datos.mjs --fecha=2026-11-25 --si     # escribe
```

`demo-datos` borra solo lo demo (reservas con teléfono 0000000… y lo de las
cuentas `demo_*`) y nunca borra cuentas. Antes de las 08:00 la noche
operativa todavía es la anterior: **no correrlo de madrugada** para la junta.

### Plan B: capturas y video

- **Video corto** (unos 60–90 s, sin escribir nada): `PLAYWRIGHT_DESDE=<carpeta>
  node scripts/dev/video-junta.mjs` recorre a 390 px la ficha, el boleto, el
  panel del RP, la caja, una mesa, `/grupo` y la nómina, y deja el `.webm` y
  las capturas en `screenshots-junta/`. Correrlo **la noche anterior**,
  después de regenerar los datos, y copiar la carpeta al celular y a la laptop.
- Capturas existentes de respaldo: `screenshots-temas/` (nómina y `/grupo`,
  oscuro), `screenshots-escaner/`, `screenshots-fase2/` (no mostrar),
  `screenshots-dashboards/`.

## Checklist

### La noche anterior (martes 24)

- [ ] Decidir dónde se hace la demo (producción si el pase ya se hizo; si no, la vista previa).
- [ ] Producción (si aplica):
  - [ ] Crear una cuenta de **staff** en Club Demo desde el panel del dueño.
  - [ ] Ajustar la ficha:
    - **horario a "Mié a Sáb 9pm a 3am"** (hoy dice "Jue a Sáb": la junta es miércoles);
    - edad mínima;
    - código de vestimenta;
    - música.
  - [ ] Revisar que Club Demo siga verificado y con suscripción.
- [ ] Dev: `node scripts/demo-datos.mjs --env=.env.dev --si` y `node scripts/dev/mesas-extra.mjs` (deja la noche del martes; se repite el miércoles a las 08:00, abajo).
- [ ] Probar los **6 roles** (`PLAYWRIGHT_DESDE=<carpeta> node scripts/dev/recorrido-roles.mjs <url>`) y el humo (`node scripts/humo-produccion.mjs <url>`).
- [ ] Grabar el video de respaldo (`scripts/dev/video-junta.mjs`) y copiarlo al celular y a la laptop.
- [ ] **Iniciar sesión** en cada celular con su cuenta (A: staff y gerente; B: RP) y en la laptop (dueño de grupo). Instalar las apps (Antro Staff, Antro RP) desde el menú del navegador.
- [ ] Imprimir un boleto con QR (de una reserva demo de la noche de la junta) y llevar una copia en papel.
- [ ] Cargar los dos celulares al 100 % y llevar cargador y cable.

### La mañana de la junta (miércoles 25, **después de las 08:00**)

- [ ] Regenerar los datos de la noche:
  - producción: `--fecha=2026-11-25 --si`, si el pase ya se hizo;
  - dev: `--env=.env.dev --si` y `mesas-extra`.

  **Anotar el resumen que imprime.**
- [ ] Abrir cada pantalla del guion una vez, en el orden del guion, con la cuenta que toca.
- [ ] Probar el QR **en pantalla y en papel** con el escáner del celular A.
- [ ] Revisar la señal del lugar (si se puede, llegar 20 min antes); tener el hotspot listo en el celular B.
- [ ] Silenciar y **limpiar notificaciones** de los dos celulares (modo No molestar), brillo al máximo, rotación bloqueada en vertical.
- [ ] Cerrar pestañas y apps que no se van a usar; dejar abiertas las del guion.

## Escáner del QR (verificado en dev el 23/11/2026)

`PLAYWRIGHT_DESDE=<carpeta> node scripts/dev/probar-escaner.mjs` (9/9). Celular en vertical
(390×844), cámara simulada con el QR del boleto:

| Luz | Lee el QR | Confirmar entrada |
|---|---|---|
| Normal | sí, ~2.4 s | queda "entró" |
| Poca luz (gris sobre gris, con grano) | sí, ~2.3 s | queda "entró" |
| Muy oscuro (contraste muy bajo) | sí, ~2.3 s | queda "entró" |

Problemas y límites anotados:
- La cámara simulada **no reproduce** enfoque, reflejos ni movimiento de
  un celular real: hay que probar con el celular real (checklist).
- El escáner **no tiene botón de linterna**. Con poca luz real ayuda
  subir el brillo del boleto; si se quiere, se puede agregar después.
- El aviso "El QR no garantiza la entrada" se ve dentro de una caja con
  borde que parece un campo de texto (detalle visual menor).

## Producción el día de la junta (revisado el 23/11/2026, solo conteos)

`node scripts/db/conteos-prod.mjs` (solo lectura, sin datos personales):

| Qué | Producción | Dev | Qué hacer |
|---|---|---|---|
| Club Demo existe, verificado y con suscripción | sí | sí | — |
| Horario | "Jue a Sáb 9pm a 3am" | "Mié a Sáb 9pm a 3am" | Cambiarlo desde el panel del dueño (la junta es miércoles) |
| Edad mínima / vestimenta / música | vacías | llenas | Llenarlas desde el panel del dueño |
| Ubicación (lat/lng) | no | no | Opcional |
| Depósito informativo | $100 | $0 | Decidir si se muestra |
| Mesas | 29 (capacidad 392) | 50 | Suficiente; si quieres 50, el dueño las agrega desde su panel (`mesas-extra` no corre en producción) |
| Fotos | 3 (las de SIX GDL) | 3 | Faltan fotos propias de Club Demo |
| Gerente | 1 | 1 | — |
| Staff | **0** | 1 | **Crear una cuenta de staff** en Club Demo |
| RPs | 10 (los 6 `demo_*` activos y en Club Demo) | 6 | — |
| Reglas por RP / turnos fijos | 5 / 6 | igual | — |
| Reservas demo | 127, del 19 al 25/11 (corrida del 19/11) | se regeneran | `demo-datos --fecha=2026-11-25 --si` después del pase y de las 08:00 |
| Caja, nómina nueva, `/grupo`, cover | **no existen** | sí | Llegan con el pase |
| Antros publicados | 1 (una ciudad) | 2 (dos ciudades, grupo) | `/grupo` de 2 ciudades: mostrarlo en dev, o decidir crear en producción un segundo antro demo y un grupo después del pase |
