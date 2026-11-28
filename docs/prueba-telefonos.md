# Prueba en teléfonos reales — lista para una noche

> Para Diego. Hasta hoy todo se probó con el Chromium de Playwright (cámara
> falsa y `setOffline`); **nada se ha probado en un teléfono físico**. Esta
> lista cubre lo que solo un teléfono real puede confirmar.
>
> - **Duración:** unas 2 horas con dos teléfonos.
> - **Dónde se prueba:** en el **Preview** de la rama (llaves y base de
>   **dev**), nunca en producción. En producción el escáner de respaldo y lo
>   del pase 3 todavía no existen.

## Antes de empezar (20 min)

1. **Preview de la rama:** Vercel → Deployments → el último de la rama (por
   ejemplo `post-junta-4`), estado *Ready*. Copia su URL.
   - Si Vercel pide iniciar sesión, es la protección de los Preview: entra con
     tu cuenta de Vercel.
2. **Datos de la noche en dev**, desde la computadora:
   ```bash
   node scripts/dev/sembrar-dev.mjs
   node scripts/demo-datos.mjs --env=.env.dev --si
   ```
   - Esto deja en dev la noche en curso con reservas por llegar.
   - Las contraseñas de `dev_staff@example.com`, `dev_gerente@example.com` y
     `dev_rp@example.com` quedan en `backups/dev-credenciales.json`.
   - `sembrar-dev` cambia las contraseñas: las sesiones abiertas de dev se caen.
3. **Escáner de respaldo:** entra al Preview como `dev_admin@example.com`,
   ve a **/admin/funciones** y enciende *Escáner de respaldo* solo para
   «Club Demo Dev».
   - Al terminar la prueba, **apágalo**.
4. **Teléfonos:**
   - **A — Android:** Chrome al día.
   - **B — iPhone:** Safari al día.
   - **Un tercero (o una computadora)** que muestre los QR: en el Preview
     abre **/cliente**, elige «Club Demo Dev» y aparta 5 reservas para esta
     noche sin cuenta. Usa un teléfono distinto en cada una, porque hay tope
     de 3 por teléfono, antro y noche. Al terminar, cada una abre su boleto
     (`/r/…`) con el QR y, con el escáner de respaldo encendido, con su
     código corto.
5. **Instalar la app** en A y B:
   - **Android:** abre el Preview en Chrome, entra como staff, menú ⋮ ›
     **Instalar app** (o **Agregar a pantalla principal**).
   - **iPhone:** abre el Preview en Safari › Compartir › **Agregar a pantalla
     de inicio**.
   - Abre la app desde el ícono, no desde el navegador.

Anota en cada casilla: ✔ (salió lo esperado), ✘ (no salió; escribe qué pasó y
la hora) o — (no se pudo probar). Una captura de pantalla de cada ✘ ayuda
mucho.

## Pruebas

### 1. Instalación y entrada

| # | Prueba | Resultado esperado | Android | iPhone |
|---|---|---|---|---|
| 1.1 | Abrir la app desde el ícono | Abre a pantalla completa, sin barra del navegador, en `/cliente/login` | ☐ | ☐ |
| 1.2 | Entrar como `dev_staff` | Sale «Panel de Club Demo Dev» con las reservas de esta noche | ☐ | ☐ |
| 1.3 | Cerrar la app (deslizar) y volver a abrirla | Sigue con la sesión abierta, sin pedir contraseña | ☐ | ☐ |

### 2. Escáner (puerta)

| # | Prueba | Resultado esperado | Android | iPhone |
|---|---|---|---|---|
| 2.1 | **Escanear QR** la primera vez | El teléfono pide permiso de cámara; al aceptar se ve la cámara trasera | ☐ | ☐ |
| 2.2 | Escanear un boleto con buena luz | En menos de 2 s sale nombre, personas y «RP: …» u «Orgánica» | ☐ | ☐ |
| 2.3 | **Poca luz**: luces apagadas y el teléfono que muestra el QR con el brillo al mínimo | Lo lee; si tarda más de 5 s, anota cuánto | ☐ | ☐ |
| 2.4 | **Linterna**: con poca luz, toca **Prender linterna** | Se prende la luz del teléfono y lee el QR. El botón **solo sale si el teléfono lo permite**: en iPhone puede no salir. Anota si salió | ☐ | ☐ |
| 2.5 | QR en pantalla rota o con reflejo (boleto en un teléfono con la pantalla inclinada contra una lámpara) | Lo lee, o se puede usar el código a mano (2.6) | ☐ | ☐ |
| 2.6 | **Código a mano**: escribe en «¿No lee el QR? Escribe el código del boleto» los 6 caracteres que salen debajo del QR y toca **Buscar** | Sale la misma reserva que con la cámara | ☐ | ☐ |
| 2.7 | **Confirmar entrada** | «¡Entrada confirmada!»; la reserva cambia en la lista del otro teléfono al tocar **Actualizar** | ☐ | ☐ |
| 2.8 | Escanear el mismo boleto otra vez | Avisa que ya había entrado; no la cuenta dos veces | ☐ | ☐ |

### 3. Sin señal y cambios de red

Para «sin señal» usa el **modo avión** (y apaga el WiFi si sigue prendido).
Para «3G»:

- **Android:** Ajustes › Redes móviles › Tipo de red preferido › **3G**, si el
  teléfono lo ofrece.
- **iPhone:** Ajustes › Desarrollador › **Network Link Conditioner** › 3G.
  Requiere el modo desarrollador.
- **Si no hay manera:** prueba en el lugar con peor señal que tengas, como un
  sótano o un estacionamiento. Es lo más parecido a un antro.

| # | Prueba | Resultado esperado | Android | iPhone |
|---|---|---|---|---|
| 3.1 | Con señal, abre el panel y espera 10 s | Debajo de **Escanear QR**: «Sin señal se puede escanear: copia de las HH:MM con N reservas por entrar» | ☐ | ☐ |
| 3.2 | **Modo avión** con el panel abierto. Escanea y toca **Confirmar entrada (sin señal)** | Queda «pendiente de enviar»; arriba «Puerta: 1 entradas pendientes de enviar» | ☐ | ☐ |
| 3.3 | Quita el modo avión | En menos de 30 s se envía sola y el aviso desaparece; en el otro teléfono (con **Actualizar**) sale como entrada | ☐ | ☐ |
| 3.4 | **Caja sin señal**: en una mesa abierta, modo avión, **Agregar consumo** | El botón dice **Guardar en el teléfono · $…**; arriba «1 movimientos por enviar» | ☐ | ☐ |
| 3.5 | Sin señal, intenta **Cerrar mesa** | El botón dice «Sin conexión» (cerrar y cuadrar necesitan señal) | ☐ | ☐ |
| 3.6 | Vuelve la señal | El consumo llega **una sola vez** (revísalo en la mesa desde el otro teléfono) | ☐ | ☐ |
| 3.7 | **Cambio de WiFi a datos**: con WiFi, captura un consumo y en ese momento apaga el WiFi (queda en datos) | Se guarda una vez: o llega directo, o queda pendiente y se envía solo. Nunca dos veces | ☐ | ☐ |
| 3.8 | **3G**: abre el panel y la caja, y captura dos consumos y un cobro | Funciona aunque tarde. Anota cuánto tarda en abrir la caja | ☐ | ☐ |
| 3.9 | Sin señal, **recarga** la app (o ábrela desde el ícono) | Sale la página sin conexión con el número de pendientes. No se pierden: se envían al volver la señal y abrir la caja | ☐ | ☐ |

### 4. Pantalla apagada y app en segundo plano

| # | Prueba | Resultado esperado | Android | iPhone |
|---|---|---|---|---|
| 4.1 | Deja un consumo pendiente sin señal. **Apaga la pantalla 2 min**, quita el modo avión con la pantalla apagada y enciéndela | Al volver a la app, el pendiente se envía solo (o con **Enviar ahora**) y llega una vez | ☐ | ☐ |
| 4.2 | Con la cámara del escáner abierta, apaga la pantalla 1 min y enciéndela | La cámara vuelve a leer, o basta con cerrar y abrir el escáner. Anota cuál | ☐ | ☐ |
| 4.3 | Con pendientes, cámbiate a WhatsApp 5 min y regresa | Los pendientes siguen ahí y se envían | ☐ | ☐ |
| 4.4 | Con pendientes, toca **Cerrar sesión** | La app avisa que hay algo sin enviar. En iPhone instalado, el aviso al cerrar la app puede no salir: anótalo | ☐ | ☐ |

### 5. RP

| # | Prueba | Resultado esperado | Android | iPhone |
|---|---|---|---|---|
| 5.1 | Instala la app del RP y entra como `dev_rp` | Se abre **/rp/panel** con sus 4 pestañas | ☐ | ☐ |
| 5.2 | En **Turnos**, el staff escanea su QR de asistencia con el otro teléfono | «¡Asistencia registrada!» (o el aviso de que no tiene turno hoy) | ☐ | ☐ |
| 5.3 | El RP aparta una reserva y comparte el boleto por WhatsApp | El enlace `/r/…` abre en el otro teléfono sin pedir cuenta y muestra el QR | ☐ | ☐ |

## Al terminar

1. En **/admin/funciones** apaga *Escáner de respaldo* para Club Demo Dev.
2. Quita el modo avión y regresa el tipo de red de cada teléfono.
3. Pasa los ✘ (con la hora) y sus capturas para revisarlos.

## Lo que esta prueba no cubre

- **La señal dentro de un antro lleno** (muchos teléfonos a la vez en la
  misma antena): solo se ve en el piloto (`docs/piloto-playbook.md`).
- **Escáner de asistencia del RP sin señal:** no existe (necesita señal).
- **Datos de producción:** el Preview usa la base de dev.
