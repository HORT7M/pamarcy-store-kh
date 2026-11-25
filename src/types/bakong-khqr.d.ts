declare module "bakong-khqr" {
  export const khqrData: { currency: { usd: number; khr: number }; merchantType: Record<string, string> };
  export class IndividualInfo {
    constructor(bakongAccountID: string, merchantName: string, merchantCity: string, optional?: Record<string, unknown>);
  }
  export class MerchantInfo extends IndividualInfo {
    constructor(bakongAccountID: string, merchantName: string, merchantCity: string, merchantID: string, acquiringBank: string, optional?: Record<string, unknown>);
  }
  type KHQRResponse = { status: { code: number; errorCode: number | null; message: string | null }; data: { qr: string; md5: string } | null };
  export class BakongKHQR {
    generateIndividual(info: IndividualInfo): KHQRResponse;
    generateMerchant(info: MerchantInfo): KHQRResponse;
    static verify(qr: string): { isValid: boolean };
    static decode(qr: string): { data: Record<string, unknown> };
  }
}
