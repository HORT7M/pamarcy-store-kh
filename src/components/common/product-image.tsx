import Image from "next/image";
import { Pill } from "lucide-react";
import { cn } from "@/lib/utils";
import { safeImageSrc } from "@/lib/sanitize";

export function ProductImage({
  src,
  alt,
  className,
  sizes = "(max-width:768px) 50vw, 25vw",
  priority,
}: {
  src: string | null | undefined;
  alt: string;
  className?: string;
  sizes?: string;
  priority?: boolean;
}) {
  const safeSrc = safeImageSrc(src);
  if (!safeSrc) {
    return (
      <div className={cn("flex items-center justify-center bg-secondary", className)}>
        <Pill className="size-10 text-primary/40" />
      </div>
    );
  }
  return (
    <div className={cn("relative overflow-hidden bg-muted", className)}>
      <Image
        src={safeSrc}
        alt={alt}
        fill
        sizes={sizes}
        className="object-cover"
        priority={priority}
        unoptimized={safeSrc.startsWith("/api/")}
      />
    </div>
  );
}
