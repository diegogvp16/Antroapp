"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { Club } from "@/types";

export default function ClubDetailPage() {
  const params = useParams<{ clubId: string }>();
  const clubId = params.clubId;

  const [club, setClub] = useState<Club | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    async function fetchClub() {
      setLoading(true);
      setNotFound(false);
      try {
        const supabase = createClient();
        const { data, error } = await supabase
          .from("clubs")
          .select("*")
          .eq("id", clubId)
          .maybeSingle();

        if (error || !data) {
          setNotFound(true);
          setClub(null);
        } else {
          setClub(data as Club);
        }
      } catch (err) {
        console.error("Error cargando club:", err);
        setNotFound(true);
      } finally {
        setLoading(false);
      }
    }

    if (clubId) {
      fetchClub();
    } else {
      setLoading(false);
      setNotFound(true);
    }
  }, [clubId]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-zinc-50 px-6 py-16 dark:bg-black">
      <Card className="w-full max-w-sm overflow-hidden p-0">
        {loading ? (
          <CardContent className="px-6 py-10 text-center text-muted-foreground">
            Cargando...
          </CardContent>
        ) : notFound || !club ? (
          <>
            <CardHeader className="px-6 pt-5">
              <CardTitle>Antro no encontrado</CardTitle>
              <CardDescription>
                Este antro no existe o ya no está disponible.
              </CardDescription>
            </CardHeader>
            <CardContent className="px-6 pb-6">
              <Link
                href="/cliente"
                className="text-sm font-medium text-foreground underline underline-offset-4"
              >
                Volver al listado
              </Link>
            </CardContent>
          </>
        ) : (
          <>
            <div className="h-40 w-full bg-gradient-to-br from-fuchsia-600 via-purple-600 to-indigo-600" />
            <CardHeader className="px-6 pt-5">
              <CardTitle className="text-2xl">{club.nombre}</CardTitle>
              <CardDescription>{club.direccion}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 px-6 pb-6">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{club.horario}</span>
                <span className="font-semibold">
                  Depósito: ${club.deposito_monto}
                </span>
              </div>
              <Button
                render={<Link href={`/cliente/reservar?club=${club.id}`} />}
                nativeButton={false}
                size="lg"
                className="h-14 w-full text-base"
              >
                Reservar
              </Button>
            </CardContent>
          </>
        )}
      </Card>
    </div>
  );
}
