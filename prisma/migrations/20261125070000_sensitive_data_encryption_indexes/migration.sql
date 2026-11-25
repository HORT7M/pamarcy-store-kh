-- AlterTable: store patient dateOfBirth as encrypted ISO YYYY-MM-DD text
ALTER TABLE "Customer" ALTER COLUMN "dateOfBirth" TYPE TEXT USING to_char("dateOfBirth", 'YYYY-MM-DD');

-- AlterTable: blind-index columns for encrypted Order contact lookup
ALTER TABLE "Order" ADD COLUMN     "emailHash" TEXT,
ADD COLUMN     "phoneHash" TEXT;

-- AlterTable: unique blind-index columns for encrypted User email/phone lookup
ALTER TABLE "User" ADD COLUMN     "emailHash" TEXT,
ADD COLUMN     "phoneHash" TEXT;

-- CreateIndex
CREATE INDEX "Order_phoneHash_idx" ON "Order"("phoneHash");

-- CreateIndex
CREATE INDEX "Order_emailHash_idx" ON "Order"("emailHash");

-- CreateIndex
CREATE UNIQUE INDEX "User_emailHash_key" ON "User"("emailHash");

-- CreateIndex
CREATE UNIQUE INDEX "User_phoneHash_key" ON "User"("phoneHash");
