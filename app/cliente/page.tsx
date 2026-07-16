import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function ClientePage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-zinc-50 px-6 py-16 dark:bg-black">
      <Card className="w-full max-w-sm overflow-hidden p-0">
        <div className="h-40 w-full bg-gradient-to-br from-fuchsia-600 via-purple-600 to-indigo-600" />
        <CardHeader className="px-6 pt-5">
          <CardTitle className="text-2xl">Antro Demo</CardTitle>
          <CardDescription>
            Av. Siempre Viva 123, Col. Centro, CDMX
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 px-6 pb-6">
          <p className="text-sm text-muted-foreground">
            Abierto viernes y sábado, 10pm - 4am
          </p>
          <Button
            render={<Link href="/cliente/reservar" />}
            nativeButton={false}
            size="lg"
            className="h-14 w-full text-base"
          >
            Reservar
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
