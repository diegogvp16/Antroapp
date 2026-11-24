// Mientras los documentos no los apruebe un abogado, las páginas lo dicen
// arriba de todo. Cuando haya versión aprobada, se quita este componente.
export function AvisoBorrador() {
  return (
    <p role="note" className="rounded-[5px] border border-status-warn/50 bg-status-warn/10 px-4 py-3 text-sm text-foreground">
      <strong>Borrador en revisión.</strong> Este documento todavía no ha sido revisado por un abogado y puede cambiar.
    </p>
  );
}
