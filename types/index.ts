export interface Profile {
  id: string;
  nombre: string;
  telefono: string | null;
  role: "cliente" | "rp" | "staff" | "gerente" | "admin";
  club_id: string | null;
  created_at: string;
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
}

export interface Club {
  id: string;
  nombre: string;
  direccion: string;
  horario: string;
  deposito_monto: number;
}
