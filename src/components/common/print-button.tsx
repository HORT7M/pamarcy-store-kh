"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/providers/i18n-provider";

export function PrintButton({ label }: { label?: string }) {
  const { t } = useI18n();
  return <Button onClick={() => window.print()} variant="outline" size="sm"><Printer /> {label ?? t("common.printSavePdf")}</Button>;
}
