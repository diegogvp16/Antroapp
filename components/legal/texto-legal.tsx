import type { ReactNode } from "react";

// Muestra un documento legal escrito en Markdown sencillo (títulos con #,
// párrafos, listas con "-" o "1." y **negritas**). Solo lo que usan los
// borradores de docs/legal/; no es un Markdown completo.

type Bloque =
  | { tipo: "titulo"; nivel: 1 | 2 | 3; texto: string }
  | { tipo: "parrafo"; texto: string }
  | { tipo: "lista"; ordenada: boolean; items: string[] };

export function bloquesDe(md: string): Bloque[] {
  const bloques: Bloque[] = [];
  let parrafo: string[] = [];
  let lista: { ordenada: boolean; items: string[] } | null = null;
  const cerrar = () => {
    if (parrafo.length) bloques.push({ tipo: "parrafo", texto: parrafo.join(" ") });
    if (lista) bloques.push({ tipo: "lista", ...lista });
    parrafo = [];
    lista = null;
  };
  for (const cruda of md.replace(/\r/g, "").split("\n")) {
    const l = cruda.trim();
    const titulo = /^(#{1,3})\s+(.*)$/.exec(l);
    const vineta = /^-\s+(.*)$/.exec(l);
    const numero = /^\d+\.\s+(.*)$/.exec(l);
    if (!l || l === "---") {
      cerrar();
    } else if (titulo) {
      cerrar();
      bloques.push({ tipo: "titulo", nivel: titulo[1].length as 1 | 2 | 3, texto: titulo[2] });
    } else if (vineta || numero) {
      if (parrafo.length) {
        bloques.push({ tipo: "parrafo", texto: parrafo.join(" ") });
        parrafo = [];
      }
      const ordenada = !!numero;
      if (!lista || lista.ordenada !== ordenada) {
        if (lista) bloques.push({ tipo: "lista", ...lista });
        lista = { ordenada, items: [] };
      }
      lista.items.push((vineta ?? numero)![1]);
    } else if (lista && cruda.startsWith("  ")) {
      lista.items[lista.items.length - 1] += " " + l;
    } else {
      if (lista) {
        bloques.push({ tipo: "lista", ...lista });
        lista = null;
      }
      parrafo.push(l);
    }
  }
  cerrar();
  return bloques;
}

// **negritas** y `código` (este último como texto normal).
function enLinea(texto: string): ReactNode[] {
  return texto
    .replace(/`([^`]+)`/g, "$1")
    .split(/(\*\*[^*]+\*\*)/g)
    .filter(Boolean)
    .map((parte, i) => (parte.startsWith("**") && parte.endsWith("**") ? <strong key={i}>{parte.slice(2, -2)}</strong> : parte));
}

export function TextoLegal({ md, id }: { md: string; id?: string }) {
  return (
    <article id={id} className="flex flex-col gap-4 text-[15px] leading-relaxed text-foreground/90">
      {bloquesDe(md).map((b, i) => {
        if (b.tipo === "titulo") {
          if (b.nivel === 1) return <h1 key={i} className="text-3xl leading-tight text-balance text-foreground">{enLinea(b.texto)}</h1>;
          if (b.nivel === 2) return <h2 key={i} className="mt-4 text-xl text-balance text-foreground">{enLinea(b.texto)}</h2>;
          return <h3 key={i} className="mt-2 text-base font-semibold text-foreground">{enLinea(b.texto)}</h3>;
        }
        if (b.tipo === "lista") {
          const Lista = b.ordenada ? "ol" : "ul";
          return (
            <Lista key={i} className={`flex flex-col gap-1.5 pl-5 ${b.ordenada ? "list-decimal" : "list-disc"} marker:text-muted-foreground`}>
              {b.items.map((item, j) => (
                <li key={j}>{enLinea(item)}</li>
              ))}
            </Lista>
          );
        }
        return <p key={i} className="max-w-[68ch]">{enLinea(b.texto)}</p>;
      })}
    </article>
  );
}
