import { apiHandler, parseQuery } from "@/lib/api";
import { searchProducts } from "@/lib/catalog";
import { productsQuerySchema } from "@/lib/validators";

/** GET /api/products – public catalogue search */
export const GET = apiHandler(async (req) => {
  const p = parseQuery(req, productsQuerySchema);
  return searchProducts({
    ...p,
    brand: p.brand ? p.brand.split(",").filter(Boolean) : undefined,
    inStock: p.inStock === "1",
  });
});
