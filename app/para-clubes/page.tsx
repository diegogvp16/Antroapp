import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ThemeNoche } from "@/components/theme-noche";
import { FormularioContacto } from "@/components/para-clubes/formulario-contacto";
import { clubDemoPublico, paraClubesActiva, type ClubDemoPublico } from "@/lib/para-clubes";
import { legalesActivos } from "@/lib/legal/version";
import { textoCover } from "@/lib/cover";

// Página pública para dueños de antro. Detrás de una bandera de PLATAFORMA en
// la base (para_clubes_activa, sql/post-junta-3/50-para-clubes.sql), APAGADA
// por defecto: apagada (o sin el SQL) responde 404. Se pinta en el servidor en
// cada visita para que encender o apagar se note al momento.
//
// Regla del texto: SOLO lo que ya existe en la app. Cada afirmación tiene su
// archivo de respaldo en docs/post-junta-3/landing.md. Precios: «[por definir]».
export const dynamic = "force-dynamic";

const TITULO = "AntroApp para antros: reservas con QR, puerta, caja por mesa y RPs";
const DESCRIPCION =
  "Reservas con QR sin cobro a tus clientes, entrada por escaneo, caja por mesa y la nómina de tus RPs calculada en un solo lugar.";

// Apagada, la respuesta 404 no lleva nada de esta página (ni título ni Open
// Graph): solo los metadatos generales del sitio.
export async function generateMetadata(): Promise<Metadata> {
  if (!(await paraClubesActiva())) return {};
  return {
    title: TITULO,
    description: DESCRIPCION,
    alternates: { canonical: "/para-clubes" },
    openGraph: { title: TITULO, description: DESCRIPCION, type: "website", locale: "es_MX", siteName: "AntroApp", url: "/para-clubes" },
    twitter: { card: "summary", title: TITULO, description: DESCRIPCION },
  };
}

const PASOS: { titulo: string; texto: string }[] = [
  {
    titulo: "Tu cliente reserva",
    texto:
      "Elige noche y número de personas (de 1 a 20) con su nombre y teléfono; no necesita cuenta. Recibe un código QR que puede compartir por WhatsApp.",
  },
  {
    titulo: "Tu staff lo recibe en la puerta",
    texto:
      "Escanea el QR con el teléfono, ve la reserva y confirma la entrada. Si no pasa (vestimenta, edad), no se confirma: el QR no garantiza el acceso.",
  },
  {
    titulo: "La caja va por mesa",
    texto:
      "Cada mesa abre su cuenta, con uno o varios grupos en la noche. Se registran consumos y cobros; si algo se equivoca se anula con motivo, no se borra. Al final se cuadra la mesa.",
  },
  {
    titulo: "Tus RPs ven lo suyo",
    texto:
      "Cada RP crea reservas para sus clientes y ve en qué quedó cada una: consumió, llegó sin consumo, no llegó o por llegar. Registra su asistencia mostrando su propio QR.",
  },
  {
    titulo: "La nómina sale sola",
    texto:
      "Si pagas por reserva, la comisión nace al cuadrar la mesa, con lo que consumió esa cuenta; si pagas por día, con la asistencia confirmada. Tú la pagas en tu nómina; AntroApp la calcula para que tú y tus RPs tengan el mismo número.",
  },
];

const ROLES: { rol: string; texto: string }[] = [
  { rol: "Dueño", texto: "Ficha del antro y fotos, mesas, cuentas de tu equipo, reglas de pago de RPs y el resumen de tus noches." },
  { rol: "Gerente", texto: "Todo lo del staff, más las reglas de pago, la nómina de los RPs y el resumen de las noches." },
  { rol: "Staff", texto: "Puerta, caja por mesa, alta y baja de RPs, turnos y asistencia. No ve sueldos de nadie." },
  { rol: "RP", texto: "Sus reservas y en qué quedaron, su cuota de la semana, lo que va ganando y su QR de asistencia." },
];

const PAGO_RP: { modo: string; texto: string }[] = [
  { modo: "Por reserva", texto: "Monto fijo o porcentaje del consumo, con una cuota semanal: desde la reserva que tú digas, ya paga." },
  { modo: "Por día", texto: "Tarifa por día de asistencia confirmada, distinta para el 1.º, 2.º, 3.º… día de la semana." },
  { modo: "Por RP", texto: "Si no todos ganan igual, tarifas individuales; los demás siguen la regla del antro." },
];

const PREGUNTAS: { p: string; r: string }[] = [
  {
    p: "¿Le cobran algo a mis clientes?",
    r: "No. La app no cobra la reserva ni el cover. Si configuras un cover, solo se informa en la ficha del antro; lo cobras tú en la puerta como siempre.",
  },
  {
    p: "¿El QR garantiza la entrada?",
    r: "No. Apartar lugar no es lo mismo que entrar: conservas tu derecho de admisión, tu código de vestimenta y tu edad mínima. El staff ve la reserva y decide.",
  },
  {
    p: "¿Mis clientes necesitan descargar algo o crear una cuenta?",
    r: "No. Reservan desde el navegador con nombre y teléfono. Si crean una cuenta, además ven su historial de reservas.",
  },
  {
    p: "¿Quién les paga a los RPs?",
    r: "Tú, en tu nómina; el dinero no pasa por AntroApp. La app calcula y registra lo que gana cada RP según las reglas que pongas.",
  },
  {
    p: "¿Qué pasa si se va la señal en la caja?",
    r: "La caja avisa cuando no hay conexión, y cada cobro lleva una clave única: si el teléfono reintenta con mala señal, el cobro no se duplica.",
  },
  {
    p: "¿Se puede usar en el teléfono?",
    r: "Sí, está hecha para el teléfono. Staff, RPs y dueño pueden instalarla en la pantalla de inicio como una app.",
  },
  {
    p: "¿Cómo aparece mi antro en la app?",
    r: "Das de alta tu antro, llenas su ficha y subes un comprobante fiscal o licencia y una foto del local. Lo revisamos, y hasta que está verificado no se muestra al público.",
  },
  {
    p: "¿Cuánto cuesta?",
    r: "El precio está [por definir]. Déjanos tus datos y lo platicamos contigo.",
  },
];

function DetallesDemo({ club }: { club: ClubDemoPublico }) {
  const cover = textoCover(club);
  const filas = [
    ["Ciudad", club.ciudad],
    ["Horario", club.horario],
    ["Ambiente", club.ambiente],
    ["Música", club.tipo_musica],
    ["Vestimenta", club.codigo_vestimenta],
    ["Edad mínima", club.edad_minima && club.edad_minima > 0 ? `${club.edad_minima}+ años` : null],
    ["Cover", cover],
  ].filter((f): f is [string, string] => typeof f[1] === "string" && f[1].trim() !== "");
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
      {filas.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-noche-muted">{k}</dt>
          <dd className="text-noche-text">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Seccion({ id, etiqueta, titulo, children }: { id: string; etiqueta: string; titulo: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-titulo`} className="scroll-mt-6 border-t border-border py-12 sm:py-16">
      <p className="text-xs font-medium uppercase tracking-[0.2em] text-noche-accent">{etiqueta}</p>
      <h2 id={`${id}-titulo`} className="mt-3 text-4xl leading-[1.05] sm:text-5xl">
        {titulo}
      </h2>
      <div className="mt-8">{children}</div>
    </section>
  );
}

export default async function ParaClubesPage() {
  if (!(await paraClubesActiva())) notFound();
  const demo = await clubDemoPublico();
  const legales = legalesActivos();

  const avisoPrivacidad = (
    <>
      Guardamos tu nombre, el de tu antro, la ciudad, tu correo, tu teléfono si lo escribes y tu mensaje, solo para
      contactarte sobre AntroApp. No te mandamos correos automáticos ni compartimos tus datos. Para evitar abuso
      guardamos hasta 7 días una huella de tu conexión y de tu correo (un código hecho con una clave secreta, no tu IP
      ni tu correo en claro). Si quieres que borremos tus datos, dínoslo cuando te contactemos.
      {legales && (
        <>
          {" "}
          Más detalle en el{" "}
          <Link href="/privacidad" className="text-noche-text underline underline-offset-4">
            Aviso de privacidad
          </Link>
          .
        </>
      )}
    </>
  );

  return (
    <ThemeNoche>
      <div className="mx-auto flex w-full max-w-5xl flex-col px-4 sm:px-8">
        <header className="flex min-h-16 items-center justify-between gap-4 pt-2">
          <Link href="/" className="inline-flex min-h-10 items-center font-display text-2xl">
            AntroApp
          </Link>
          <Link
            href="/dueno/login"
            className="inline-flex min-h-10 items-center px-1 text-sm text-noche-muted underline-offset-4 hover:text-noche-text hover:underline"
          >
            Ya tengo cuenta
          </Link>
        </header>

        <main>
          <div className="flex flex-col gap-6 pb-14 pt-10 sm:pb-20 sm:pt-16">
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-noche-accent">Para antros</p>
            <h1 className="max-w-3xl text-[2.75rem] leading-[0.98] sm:text-7xl">
              De la reserva a la nómina, <span className="italic text-noche-accent">en una sola noche.</span>
            </h1>
            <p className="max-w-xl text-base text-noche-muted sm:text-lg">
              AntroApp junta las reservas con QR, la puerta, la caja por mesa y el trabajo de tus RPs. Tus clientes
              no pagan nada por reservar.
            </p>
            <div className="flex flex-col gap-3 pt-2 sm:flex-row">
              <a
                href="#contacto"
                className="inline-flex h-12 items-center justify-center rounded-lg bg-primary px-6 text-base font-semibold text-primary-foreground transition-colors hover:bg-primary/85 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                Quiero que me contacten
              </a>
              <a
                href="#como-funciona"
                className="inline-flex h-12 items-center justify-center rounded-lg border border-border px-6 text-base text-noche-text transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                Ver cómo funciona
              </a>
            </div>
          </div>

          <Seccion id="como-funciona" etiqueta="Cómo funciona" titulo="Una noche, de principio a fin">
            <ol className="grid gap-x-10 gap-y-8 sm:grid-cols-2">
              {PASOS.map((p, i) => (
                <li key={p.titulo} className="grid grid-cols-[2.25rem_1fr] gap-x-3">
                  <span aria-hidden="true" className="font-display text-3xl leading-none text-noche-accent">
                    {i + 1}
                  </span>
                  <div className="flex flex-col gap-1.5">
                    <h3 className="text-lg font-semibold">{p.titulo}</h3>
                    <p className="text-sm leading-relaxed text-noche-muted">{p.texto}</p>
                  </div>
                </li>
              ))}
            </ol>
          </Seccion>

          <Seccion id="equipo" etiqueta="Tu equipo" titulo="Cada quien ve lo suyo">
            <ul className="grid gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-2">
              {ROLES.map((r) => (
                <li key={r.rol} className="flex flex-col gap-1.5 bg-noche-bg p-5">
                  <h3 className="font-display text-2xl">{r.rol}</h3>
                  <p className="text-sm leading-relaxed text-noche-muted">{r.texto}</p>
                </li>
              ))}
            </ul>
            <h3 className="mt-10 text-lg font-semibold">Cómo les pagas a tus RPs</h3>
            <ul className="mt-4 grid gap-6 sm:grid-cols-3">
              {PAGO_RP.map((m) => (
                <li key={m.modo} className="flex flex-col gap-1.5 border-l border-noche-accent/50 pl-4">
                  <p className="text-sm font-semibold text-noche-text">{m.modo}</p>
                  <p className="text-sm leading-relaxed text-noche-muted">{m.texto}</p>
                </li>
              ))}
            </ul>
            <p className="mt-8 max-w-2xl text-sm leading-relaxed text-noche-muted">
              Con las noches cerradas ves cuántas reservas terminaron en consumo y cómo le fue a cada RP, en el resumen
              de tus antros.
            </p>
          </Seccion>

          {demo && (
            <Seccion id="ejemplo" etiqueta="Antro de demostración" titulo={`Así se ve un antro: ${demo.nombre}`}>
              <div className="grid gap-8 sm:grid-cols-[1.3fr_1fr] sm:items-start">
                {demo.fotos.length > 0 ? (
                  <div className="grid grid-cols-3 gap-2">
                    {demo.fotos.map((f, i) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={f.url}
                        src={f.url}
                        alt={`Foto ${i + 1} de ${demo.nombre}`}
                        width={400}
                        height={500}
                        loading="lazy"
                        decoding="async"
                        className={
                          demo.fotos.length === 1
                            ? "col-span-3 aspect-[4/3] w-full rounded-md bg-muted object-cover"
                            : i === 0
                              ? "col-span-2 row-span-2 aspect-[4/5] h-full w-full rounded-md bg-muted object-cover"
                              : "aspect-[4/5] w-full rounded-md bg-muted object-cover"
                        }
                      />
                    ))}
                  </div>
                ) : null}
                <div className="flex flex-col gap-5">
                  <p className="text-sm leading-relaxed text-noche-muted">
                    Es el antro de demostración de AntroApp, con datos y fotos de ejemplo. Así muestra la app un antro
                    a tus clientes: fotos, horario, ambiente, música, vestimenta y edad mínima.
                  </p>
                  <DetallesDemo club={demo} />
                </div>
              </div>
            </Seccion>
          )}

          <Seccion id="precio" etiqueta="Precio" titulo="Claro desde el principio">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-2 rounded-md border border-noche-accent/40 bg-card p-5">
                <p className="text-sm text-noche-muted">Mensualidad por antro</p>
                <p className="font-display text-4xl">[por definir]</p>
                <p className="text-sm text-noche-muted">Lo platicamos contigo antes de empezar.</p>
              </div>
              <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-5">
                <p className="text-sm text-noche-muted">Para tus clientes</p>
                <p className="font-display text-4xl">Sin cobro</p>
                <p className="text-sm text-noche-muted">Reservar no les cuesta nada. El cover, si lo hay, lo cobras tú.</p>
              </div>
              <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-5">
                <p className="text-sm text-noche-muted">Comisiones de RPs</p>
                <p className="font-display text-4xl">En tu nómina</p>
                <p className="text-sm text-noche-muted">Las pagas tú; AntroApp solo las calcula.</p>
              </div>
            </div>
          </Seccion>

          <Seccion id="preguntas" etiqueta="Preguntas" titulo="Lo que nos preguntan">
            <div className="divide-y divide-border border-y border-border">
              {PREGUNTAS.map((q) => (
                <details key={q.p} className="group">
                  <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 py-3 text-base font-medium focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
                    {q.p}
                    <span aria-hidden="true" className="font-display text-2xl text-noche-accent transition-transform group-open:rotate-45">
                      +
                    </span>
                  </summary>
                  <p className="max-w-2xl pb-5 text-sm leading-relaxed text-noche-muted">{q.r}</p>
                </details>
              ))}
            </div>
          </Seccion>

          <Seccion id="contacto" etiqueta="Contacto" titulo="Platiquemos de tu antro">
            <div className="grid gap-8 sm:grid-cols-[1fr_1.6fr]">
              <p className="text-sm leading-relaxed text-noche-muted">
                Déjanos tus datos y te buscamos para enseñarte la app con tu antro en mente. Solo te pedimos lo
                necesario para contactarte.
              </p>
              <FormularioContacto avisoPrivacidad={avisoPrivacidad} />
            </div>
          </Seccion>
        </main>

        <footer className="flex flex-col gap-3 border-t border-border py-8 text-xs text-noche-muted sm:flex-row sm:items-center sm:justify-between">
          <p>AntroApp · Reservas y operación para antros en México</p>
          <nav aria-label="Enlaces" className="flex flex-wrap gap-x-5">
            <Link href="/" className="inline-flex min-h-10 items-center underline-offset-4 hover:underline">
              Inicio
            </Link>
            {legales && (
              <>
                <Link href="/terminos" className="inline-flex min-h-10 items-center underline-offset-4 hover:underline">
                  Términos
                </Link>
                <Link href="/privacidad" className="inline-flex min-h-10 items-center underline-offset-4 hover:underline">
                  Privacidad
                </Link>
              </>
            )}
          </nav>
        </footer>
      </div>
    </ThemeNoche>
  );
}
