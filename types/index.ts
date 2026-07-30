export interface Profile {
  id: string;
  nombre: string;
  telefono: string | null;
  role: "cliente" | "rp" | "staff" | "gerente" | "admin" | "dueno";
  club_id: string | null;
  created_at: string;
  activo: boolean;
}

export interface Reservation {
  id: string;
  cliente_nombre: string;
  cliente_telefono: string;
  rp_id: string | null;
  club_id: string | null;
  source: "organica" | "rp";
  fecha: string;
  personas: number;
  status: "pendiente" | "confirmada" | "usada";
  qr_code: string;
  created_at: string;
  mesa_id: string | null;
  consumo_monto: number | null;
  cliente_id: string | null;
  se_retiro_sin_consumir: boolean | null;
}

export interface Club {
  id: string;
  nombre: string;
  direccion: string;
  horario: string;
  deposito_monto: number;
  dueno_id: string | null;
  suscripcion_activa: boolean;
  suscripcion_activada_en: string | null;
  comision_tipo: "fijo" | "porcentaje";
  comision_monto: number;
  comision_desbloqueo_reservas: number;
  bono_organica_tipo: "fijo" | "porcentaje";
  bono_organica_monto: number;
}

export interface ClubPhoto {
  id: string;
  club_id: string;
  url: string;
  storage_path: string;
  orden: number;
  created_at: string;
}

export interface ClubTable {
  id: string;
  club_id: string;
  numero: string;
  capacidad: number;
  created_at: string;
}

export interface ConsumptionEntry {
  id: string;
  reservation_id: string;
  monto: number;
  created_at: string;
}
