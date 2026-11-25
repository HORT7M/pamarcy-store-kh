"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Star, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/components/providers/i18n-provider";
import { BotProtectionWidget, HoneypotField, useBotProtection } from "@/components/security/bot-protection";
import { api, FetchError } from "@/lib/fetcher";
import { cn } from "@/lib/utils";

export function ReviewBox({ slug, canReview }: { slug: string; canReview: boolean }) {
  const { t } = useI18n();
  const router = useRouter();
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const bot = useBotProtection("review", { autoLoad: false });

  if (!canReview) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (bot.visible && !bot.ready) {
      toast.error(t("security.required"));
      return;
    }
    setBusy(true);
    try {
      await api(`/api/products/${slug}/reviews`, {
        method: "POST",
        body: { rating, comment, _bot: bot.getPayload() },
      });
      toast.success("Thank you for your review!");
      setComment("");
      router.refresh();
    } catch (err) {
      const fe = err as FetchError;
      bot.handleError(fe);
      toast.error(fe.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-2 border-t pt-3">
      <HoneypotField value={bot.hp} onChange={bot.setHp} />
      <div className="flex items-center gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" onClick={() => setRating(n)} aria-label={`${n} stars`}>
            <Star className={cn("size-4", n <= rating ? "fill-amber-400 text-amber-400" : "text-muted-foreground")} />
          </button>
        ))}
      </div>
      <Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Write a short review…" maxLength={500} className="text-xs" />
      <BotProtectionWidget bot={bot} compact />
      <Button type="submit" size="sm" disabled={busy || (bot.visible && bot.solving)}>
        {busy && <Loader2 className="animate-spin" />} Post review
      </Button>
    </form>
  );
}
