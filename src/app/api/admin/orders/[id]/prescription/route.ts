import { apiHandler, parseBody, parseParams } from "@/lib/api";
import { requireStaff } from "@/lib/auth/session";
import { idParamSchema, prescriptionReviewSchema } from "@/lib/validators";
import { reviewPrescription } from "@/lib/services/orders";

/** POST – pharmacist approves / rejects the prescription of an online order */
export const POST = apiHandler<{ id: string }>(async (req, { params }) => {
  const user = await requireStaff("prescriptions.review");
  const { id } = await parseParams(params, idParamSchema);
  const { approve, note } = await parseBody(req, prescriptionReviewSchema);
  return reviewPrescription(id, approve, note, user.id);
});
