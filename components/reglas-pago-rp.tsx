"use client";

import { useEffect, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { ConfigRpAntro } from "@/components/config-rp/config-rp-antro";
import { OrigenConfigAntro } from "@/components/grupo/origen-config-antro";
import { mensajeParaUsuario, type ErrorBase } from "@/lib/errores-base";
import type {
  Club,
  ClubDiaTarifa,
  RpDiaTarifaOverride,
  RpComisionOverride,
} from "@/types";

interface RpListItem {
  id: string;
  nombre: string;
}

const SELECT_CLASSES =
  "h-11 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

interface ReglasPagoRPProps {
  club: Club;
  onUpdate: () => void | Promise<void>;
}

// Sección compartida (usada por /dueno/panel y por /staff/panel para
// gerente) para configurar cómo se le paga a los RPs de un antro: por
// reserva (comisión, patrón original) o por día de asistencia (tarifa por
// posición: 1er día asistido esa semana, 2do día, 3er día...).
export function ReglasPagoRP({ club, onUpdate }: ReglasPagoRPProps) {
  const [modo, setModo] = useState<"reserva" | "dia">(club.pago_rp_modo);
  const [modoSubmitting, setModoSubmitting] = useState(false);
  const [modoError, setModoError] = useState<string | null>(null);
  const [modoSaved, setModoSaved] = useState(false);
  // Para releer «del grupo / propio» tras un cambio aquí (versionOrigen) y
  // la configuración de RPs tras un cambio de origen (versionRp).
  const [versionOrigen, setVersionOrigen] = useState(0);
  const [versionRp, setVersionRp] = useState(0);
  // Nombre del grupo si bloqueó el modo de pago (y sus tarifas) para sus
  // antros: la base lo rechaza (P0001), así que aquí no se deja editar.
  const [bloqueoModo, setBloqueoModo] = useState<string | null>(null);

  const [tarifas, setTarifas] = useState<ClubDiaTarifa[]>([]);
  const [loadingTarifas, setLoadingTarifas] = useState(true);
  const [tarifaPosicion, setTarifaPosicion] = useState("");
  const [tarifaMonto, setTarifaMonto] = useState("");
  const [tarifaSubmitting, setTarifaSubmitting] = useState(false);
  const [tarifaError, setTarifaError] = useState<string | null>(null);
  const [tarifaBorrarError, setTarifaBorrarError] = useState<string | null>(null);
  const [deletingTarifaId, setDeletingTarifaId] = useState<string | null>(
    null,
  );

  const [rps, setRps] = useState<RpListItem[]>([]);
  const [loadingRps, setLoadingRps] = useState(true);
  const [selectedRpId, setSelectedRpId] = useState("");

  const [diaOverrides, setDiaOverrides] = useState<RpDiaTarifaOverride[]>([]);
  const [rpTarifaPosicion, setRpTarifaPosicion] = useState("");
  const [rpTarifaMonto, setRpTarifaMonto] = useState("");
  const [rpTarifaSubmitting, setRpTarifaSubmitting] = useState(false);
  const [rpTarifaError, setRpTarifaError] = useState<string | null>(null);
  const [deletingRpTarifaId, setDeletingRpTarifaId] = useState<string | null>(
    null,
  );

  const [comisionOverrides, setComisionOverrides] = useState<
    RpComisionOverride[]
  >([]);
  const [rpComisionTipo, setRpComisionTipo] = useState<"fijo" | "porcentaje">(
    "fijo",
  );
  const [rpComisionMonto, setRpComisionMonto] = useState("");
  const [rpComisionDesbloqueo, setRpComisionDesbloqueo] = useState("");
  const [rpComisionSubmitting, setRpComisionSubmitting] = useState(false);
  const [rpComisionError, setRpComisionError] = useState<string | null>(null);
  const [removingComisionOverride, setRemovingComisionOverride] =
    useState(false);

  useEffect(() => {
    setModo(club.pago_rp_modo);
  }, [club]);

  async function fetchTarifas() {
    setLoadingTarifas(true);
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("club_dia_tarifas")
        .select("*")
        .eq("club_id", club.id)
        .order("posicion", { ascending: true });

      if (error) throw error;
      setTarifas((data ?? []) as ClubDiaTarifa[]);
    } catch (err) {
      console.error("Error cargando tarifas por día:", err);
    } finally {
      setLoadingTarifas(false);
    }
  }

  useEffect(() => {
    fetchTarifas();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [club.id]);

  async function fetchRps() {
    setLoadingRps(true);
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("profiles")
        .select("id, nombre")
        .eq("club_id", club.id)
        .eq("role", "rp")
        .order("nombre", { ascending: true });

      if (error) throw error;
      setRps((data ?? []) as RpListItem[]);
    } catch (err) {
      console.error("Error cargando RPs:", err);
    } finally {
      setLoadingRps(false);
    }
  }

  async function fetchDiaOverrides() {
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("rp_dia_tarifa_overrides")
        .select("*")
        .eq("club_id", club.id)
        .order("posicion", { ascending: true });

      if (error) throw error;
      setDiaOverrides((data ?? []) as RpDiaTarifaOverride[]);
    } catch (err) {
      console.error("Error cargando tarifas personalizadas:", err);
    }
  }

  async function fetchComisionOverrides() {
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("rp_comision_overrides")
        .select("*")
        .eq("club_id", club.id);

      if (error) throw error;
      setComisionOverrides((data ?? []) as RpComisionOverride[]);
    } catch (err) {
      console.error("Error cargando comisiones personalizadas:", err);
    }
  }

  useEffect(() => {
    fetchRps();
    fetchDiaOverrides();
    fetchComisionOverrides();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [club.id]);

  useEffect(() => {
    setRpTarifaPosicion("");
    setRpTarifaMonto("");
    setRpTarifaError(null);

    const existente = comisionOverrides.find(
      (o) => o.rp_id === selectedRpId,
    );
    setRpComisionTipo(existente?.comision_tipo ?? club.comision_tipo);
    setRpComisionMonto(
      String(existente?.comision_monto ?? club.comision_monto),
    );
    setRpComisionDesbloqueo(
      String(
        existente?.comision_desbloqueo_reservas ??
          club.comision_desbloqueo_reservas,
      ),
    );
    setRpComisionError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRpId]);

  async function handleSaveModo() {
    setModoError(null);
    setModoSaved(false);
    setModoSubmitting(true);
    try {
      const supabase = createClient();
      const { error } = await supabase
        .from("clubs")
        .update({ pago_rp_modo: modo })
        .eq("id", club.id);

      if (error) throw error;

      await onUpdate();
      setModoSaved(true);
      setVersionOrigen((v) => v + 1);
    } catch (err) {
      console.error("Error guardando modo de pago:", err);
      // P0001 = aviso de la base (por ejemplo, el grupo lo bloqueó).
      setModoError(mensajeParaUsuario(err as ErrorBase, "No pudimos guardar. Intenta de nuevo."));
    } finally {
      setModoSubmitting(false);
    }
  }

  async function handleAddTarifa(e: FormEvent) {
    e.preventDefault();
    setTarifaError(null);

    if (!tarifaPosicion || !tarifaMonto) {
      setTarifaError("Completa día y monto.");
      return;
    }
    const posicionNum = Number(tarifaPosicion);
    const montoNum = Number(tarifaMonto);
    if (!Number.isInteger(posicionNum) || posicionNum < 1) {
      setTarifaError(
        "El día debe ser un número entero mayor a 0 (1 = primer día).",
      );
      return;
    }
    if (!Number.isFinite(montoNum) || montoNum < 0) {
      setTarifaError("El monto debe ser un número válido.");
      return;
    }

    setTarifaSubmitting(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.from("club_dia_tarifas").upsert(
        { club_id: club.id, posicion: posicionNum, monto: montoNum },
        { onConflict: "club_id,posicion" },
      );

      if (error) throw error;

      setTarifaPosicion("");
      setTarifaMonto("");
      await fetchTarifas();
      // Cambiar una tarifa vuelve «propio» el modo de pago si el antro seguía al grupo.
      setVersionOrigen((v) => v + 1);
    } catch (err) {
      console.error("Error guardando tarifa:", err);
      // P0001 = aviso de la base (por ejemplo, el grupo lo bloqueó).
      setTarifaError(mensajeParaUsuario(err as ErrorBase, "No pudimos guardar la tarifa. Intenta de nuevo."));
    } finally {
      setTarifaSubmitting(false);
    }
  }

  async function handleDeleteTarifa(tarifa: ClubDiaTarifa) {
    setTarifaBorrarError(null);
    setDeletingTarifaId(tarifa.id);
    try {
      const supabase = createClient();
      const { error } = await supabase
        .from("club_dia_tarifas")
        .delete()
        .eq("id", tarifa.id);

      if (error) throw error;

      setTarifas((prev) => prev.filter((t) => t.id !== tarifa.id));
      setVersionOrigen((v) => v + 1);
    } catch (err) {
      console.error("Error borrando tarifa:", err);
      setTarifaBorrarError(
        mensajeParaUsuario(err as ErrorBase, `No pudimos borrar la tarifa del día ${tarifa.posicion}. Intenta de nuevo.`),
      );
    } finally {
      setDeletingTarifaId(null);
    }
  }

  const rpTarifasSeleccionado = diaOverrides.filter(
    (o) => o.rp_id === selectedRpId,
  );
  const rpIdsConDiaOverride = new Set(diaOverrides.map((o) => o.rp_id));
  const rpIdsConComisionOverride = new Set(
    comisionOverrides.map((o) => o.rp_id),
  );
  const comisionOverrideSeleccionado = comisionOverrides.find(
    (o) => o.rp_id === selectedRpId,
  );

  async function handleAddRpTarifa(e: FormEvent) {
    e.preventDefault();
    setRpTarifaError(null);

    if (!selectedRpId) {
      setRpTarifaError("Selecciona un RP.");
      return;
    }
    if (!rpTarifaPosicion || !rpTarifaMonto) {
      setRpTarifaError("Completa día y monto.");
      return;
    }
    const posicionNum = Number(rpTarifaPosicion);
    const montoNum = Number(rpTarifaMonto);
    if (!Number.isInteger(posicionNum) || posicionNum < 1) {
      setRpTarifaError(
        "El día debe ser un número entero mayor a 0 (1 = primer día).",
      );
      return;
    }
    if (!Number.isFinite(montoNum) || montoNum < 0) {
      setRpTarifaError("El monto debe ser un número válido.");
      return;
    }

    setRpTarifaSubmitting(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.from("rp_dia_tarifa_overrides").upsert(
        {
          club_id: club.id,
          rp_id: selectedRpId,
          posicion: posicionNum,
          monto: montoNum,
        },
        { onConflict: "club_id,rp_id,posicion" },
      );

      if (error) throw error;

      setRpTarifaPosicion("");
      setRpTarifaMonto("");
      await fetchDiaOverrides();
    } catch (err) {
      console.error("Error guardando tarifa personalizada:", err);
      setRpTarifaError("No pudimos guardar la tarifa. Intenta de nuevo.");
    } finally {
      setRpTarifaSubmitting(false);
    }
  }

  async function handleDeleteRpTarifa(override: RpDiaTarifaOverride) {
    setDeletingRpTarifaId(override.id);
    try {
      const supabase = createClient();
      const { error } = await supabase
        .from("rp_dia_tarifa_overrides")
        .delete()
        .eq("id", override.id);

      if (error) throw error;

      setDiaOverrides((prev) => prev.filter((o) => o.id !== override.id));
    } catch (err) {
      console.error("Error borrando tarifa personalizada:", err);
    } finally {
      setDeletingRpTarifaId(null);
    }
  }

  async function handleSaveComisionOverride(e: FormEvent) {
    e.preventDefault();
    setRpComisionError(null);

    if (!selectedRpId) {
      setRpComisionError("Selecciona un RP.");
      return;
    }
    if (!rpComisionMonto || !rpComisionDesbloqueo) {
      setRpComisionError("Completa todos los campos.");
      return;
    }

    const montoNum = Number(rpComisionMonto);
    const desbloqueoNum = Number(rpComisionDesbloqueo);

    if (!Number.isFinite(montoNum) || montoNum < 0) {
      setRpComisionError("El monto de comisión debe ser un número válido.");
      return;
    }
    if (rpComisionTipo === "porcentaje" && montoNum > 100) {
      setRpComisionError("El porcentaje de comisión no puede ser mayor a 100.");
      return;
    }
    if (!Number.isInteger(desbloqueoNum) || desbloqueoNum < 0) {
      setRpComisionError(
        "Las reservas para desbloquear deben ser un número entero mayor o igual a 0.",
      );
      return;
    }

    setRpComisionSubmitting(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.from("rp_comision_overrides").upsert(
        {
          club_id: club.id,
          rp_id: selectedRpId,
          comision_tipo: rpComisionTipo,
          comision_monto: montoNum,
          comision_desbloqueo_reservas: desbloqueoNum,
        },
        { onConflict: "club_id,rp_id" },
      );

      if (error) throw error;

      await fetchComisionOverrides();
    } catch (err) {
      console.error("Error guardando comisión personalizada:", err);
      setRpComisionError("No pudimos guardar los cambios. Intenta de nuevo.");
    } finally {
      setRpComisionSubmitting(false);
    }
  }

  async function handleRemoveComisionOverride() {
    if (!comisionOverrideSeleccionado) return;
    setRemovingComisionOverride(true);
    try {
      const supabase = createClient();
      const { error } = await supabase
        .from("rp_comision_overrides")
        .delete()
        .eq("id", comisionOverrideSeleccionado.id);

      if (error) throw error;

      setComisionOverrides((prev) =>
        prev.filter((o) => o.id !== comisionOverrideSeleccionado.id),
      );
      setRpComisionTipo(club.comision_tipo);
      setRpComisionMonto(String(club.comision_monto));
      setRpComisionDesbloqueo(String(club.comision_desbloqueo_reservas));
    } catch (err) {
      console.error("Error quitando comisión personalizada:", err);
    } finally {
      setRemovingComisionOverride(false);
    }
  }

  return (
    <>
      {/* Solo si el antro está en un grupo: qué viene del grupo y qué es
          propio (sql/post-junta-2/12-config-grupo.sql). */}
      <OrigenConfigAntro
        clubId={club.id}
        version={versionOrigen}
        onCambio={() => {
          setVersionRp((v) => v + 1);
          void onUpdate();
        }}
        onBloqueos={(b) => setBloqueoModo(b.modo_pago ?? null)}
      />

      <Card>
        <CardContent className="flex flex-col gap-4 px-6 py-6">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pago_rp_modo">Modo de pago para RPs</Label>
            <select
              id="pago_rp_modo"
              className={SELECT_CLASSES}
              disabled={bloqueoModo !== null}
              value={modo}
              onChange={(e) =>
                setModo(e.target.value as "reserva" | "dia")
              }
            >
              <option value="reserva">Por reserva (comisión)</option>
              <option value="dia">Por día de asistencia</option>
            </select>
          </div>

          {bloqueoModo !== null && (
            <p className="text-sm break-words text-status-warn" role="status">
              El modo de pago y las tarifas por día los define el grupo «{bloqueoModo}» para todos sus antros. Pídele al dueño del grupo que los cambie.
            </p>
          )}
          {modoError && (
            <p className="text-sm text-destructive" role="alert">
              {modoError}
            </p>
          )}
          {modoSaved && !modoError && modo === club.pago_rp_modo && (
            <p className="text-sm text-muted-foreground">Modo guardado.</p>
          )}

          <Button
            type="button"
            size="sm"
            onClick={handleSaveModo}
            disabled={modoSubmitting || modo === club.pago_rp_modo || bloqueoModo !== null}
          >
            {modoSubmitting ? "Guardando..." : "Guardar modo de pago"}
          </Button>
        </CardContent>
      </Card>

      {/* Qué ven los RPs y regla de comisión del antro: con vigencia desde el
          lunes siguiente y bitácora (sql/post-junta/07-config-rp.sql). */}
      <ConfigRpAntro key={`config-rp-${versionRp}`} clubId={club.id} onGuardado={() => setVersionOrigen((v) => v + 1)} />

      {modo === "dia" && (
        <>
          <Card>
            <CardContent className="px-6 py-6">
              <form
                onSubmit={handleAddTarifa}
                className="flex flex-col gap-4 sm:flex-row sm:items-end"
              >
                <div className="flex flex-1 flex-col gap-1.5">
                  <Label htmlFor="tarifa_posicion">
                    Día (1 = primer día asistido esa semana)
                  </Label>
                  <Input
                    id="tarifa_posicion"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={tarifaPosicion}
                    onChange={(e) => setTarifaPosicion(e.target.value)}
                    disabled={bloqueoModo !== null}
                    required
                  />
                </div>
                <div className="flex flex-1 flex-col gap-1.5">
                  <Label htmlFor="tarifa_monto">Monto ($)</Label>
                  <Input
                    id="tarifa_monto"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    value={tarifaMonto}
                    onChange={(e) => setTarifaMonto(e.target.value)}
                    disabled={bloqueoModo !== null}
                    required
                  />
                </div>
                <Button type="submit" disabled={tarifaSubmitting || bloqueoModo !== null}>
                  {tarifaSubmitting ? "Guardando..." : "Guardar tarifa"}
                </Button>
              </form>
              {tarifaError && (
                <p className="mt-3 text-sm text-destructive" role="alert">
                  {tarifaError}
                </p>
              )}
              <p className="mt-3 text-xs text-muted-foreground">
                El conteo de días se reinicia cada semana (lunes a domingo) y
                solo cuentan días con asistencia confirmada. Si el RP asiste
                más días de los que tienen tarifa configurada, se repite la
                tarifa del último día configurado.
              </p>
            </CardContent>
          </Card>

          {loadingTarifas && (
            <p className="text-sm text-muted-foreground">Cargando...</p>
          )}
          {tarifaBorrarError && (
            <p className="text-sm break-words text-destructive" role="alert">
              {tarifaBorrarError}
            </p>
          )}
          {!loadingTarifas && tarifas.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No has configurado tarifas todavía.
            </p>
          )}
          {tarifas.length > 0 && (
            <div className="flex flex-col gap-2">
              {tarifas.map((t) => (
                <Card key={t.id}>
                  <CardContent className="flex items-center justify-between px-5 py-3 text-sm">
                    <span className="font-medium">Día {t.posicion}</span>
                    <div className="flex items-center gap-3">
                      <span className="text-muted-foreground">
                        ${t.monto}
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => handleDeleteTarifa(t)}
                        disabled={deletingTarifaId === t.id || bloqueoModo !== null}
                      >
                        {deletingTarifaId === t.id
                          ? "Borrando..."
                          : "Eliminar"}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      <Card>
        <CardContent className="flex flex-col gap-4 px-6 py-6">
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold">Sueldo individual por RP</h3>
            <p className="text-xs text-muted-foreground">
              Por defecto todos los RPs usan la regla del antro de arriba.
              Aquí puedes personalizarla para un RP en particular.
            </p>
          </div>

          {loadingRps && (
            <p className="text-sm text-muted-foreground">Cargando RPs...</p>
          )}
          {!loadingRps && rps.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Este antro todavía no tiene RPs.
            </p>
          )}

          {rps.length > 0 && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="rp_override_select">RP</Label>
                <select
                  id="rp_override_select"
                  className={SELECT_CLASSES}
                  value={selectedRpId}
                  onChange={(e) => setSelectedRpId(e.target.value)}
                >
                  <option value="">Selecciona un RP...</option>
                  {rps.map((rp) => (
                    <option key={rp.id} value={rp.id}>
                      {rp.nombre}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-2">
                {rps.map((rp) => {
                  const personalizado =
                    modo === "dia"
                      ? rpIdsConDiaOverride.has(rp.id)
                      : rpIdsConComisionOverride.has(rp.id);
                  return (
                    <div
                      key={rp.id}
                      className="flex items-center justify-between text-sm"
                    >
                      <span>{rp.nombre}</span>
                      <Badge variant={personalizado ? "default" : "outline"}>
                        {personalizado
                          ? "Personalizado"
                          : "Usa tarifa del antro"}
                      </Badge>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {selectedRpId && modo === "dia" && (
            <div className="flex flex-col gap-4 border-t border-border pt-4">
              <form
                onSubmit={handleAddRpTarifa}
                className="flex flex-col gap-4 sm:flex-row sm:items-end"
              >
                <div className="flex flex-1 flex-col gap-1.5">
                  <Label htmlFor="rp_tarifa_posicion">Día</Label>
                  <Input
                    id="rp_tarifa_posicion"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={rpTarifaPosicion}
                    onChange={(e) => setRpTarifaPosicion(e.target.value)}
                    required
                  />
                </div>
                <div className="flex flex-1 flex-col gap-1.5">
                  <Label htmlFor="rp_tarifa_monto">Monto ($)</Label>
                  <Input
                    id="rp_tarifa_monto"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    value={rpTarifaMonto}
                    onChange={(e) => setRpTarifaMonto(e.target.value)}
                    required
                  />
                </div>
                <Button type="submit" disabled={rpTarifaSubmitting}>
                  {rpTarifaSubmitting ? "Guardando..." : "Guardar"}
                </Button>
              </form>
              {rpTarifaError && (
                <p className="text-sm text-destructive" role="alert">
                  {rpTarifaError}
                </p>
              )}

              {rpTarifasSeleccionado.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Sin tarifas personalizadas — usa la del antro.
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {rpTarifasSeleccionado.map((o) => (
                    <div
                      key={o.id}
                      className="flex items-center justify-between text-sm"
                    >
                      <span className="font-medium">Día {o.posicion}</span>
                      <div className="flex items-center gap-3">
                        <span className="text-muted-foreground">
                          ${o.monto}
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => handleDeleteRpTarifa(o)}
                          disabled={deletingRpTarifaId === o.id}
                        >
                          {deletingRpTarifaId === o.id
                            ? "Borrando..."
                            : "Eliminar"}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {selectedRpId && modo === "reserva" && (
            <form
              onSubmit={handleSaveComisionOverride}
              className="flex flex-col gap-4 border-t border-border pt-4"
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="rp_comision_tipo">Tipo de comisión</Label>
                <select
                  id="rp_comision_tipo"
                  className={SELECT_CLASSES}
                  value={rpComisionTipo}
                  onChange={(e) =>
                    setRpComisionTipo(e.target.value as "fijo" | "porcentaje")
                  }
                >
                  <option value="fijo">Fijo</option>
                  <option value="porcentaje">Porcentaje del consumo</option>
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="rp_comision_monto">
                  {rpComisionTipo === "fijo"
                    ? "Monto de comisión ($)"
                    : "Comisión (% del consumo)"}
                </Label>
                <Input
                  id="rp_comision_monto"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={rpComisionTipo === "porcentaje" ? 100 : undefined}
                  value={rpComisionMonto}
                  onChange={(e) => setRpComisionMonto(e.target.value)}
                  required
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="rp_comision_desbloqueo">
                  Reservas necesarias para desbloquear esta semana
                </Label>
                <Input
                  id="rp_comision_desbloqueo"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  value={rpComisionDesbloqueo}
                  onChange={(e) => setRpComisionDesbloqueo(e.target.value)}
                  required
                />
              </div>
              {rpComisionError && (
                <p className="text-sm text-destructive" role="alert">
                  {rpComisionError}
                </p>
              )}
              <div className="flex gap-2">
                <Button
                  type="submit"
                  disabled={rpComisionSubmitting}
                  className="flex-1"
                >
                  {rpComisionSubmitting ? "Guardando..." : "Guardar"}
                </Button>
                {comisionOverrideSeleccionado && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={removingComisionOverride}
                    onClick={handleRemoveComisionOverride}
                  >
                    {removingComisionOverride
                      ? "Quitando..."
                      : "Quitar personalización"}
                  </Button>
                )}
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </>
  );
}
