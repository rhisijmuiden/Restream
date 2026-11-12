import { generateSecret, generateURI, verify } from 'otplib';
import QRCode from 'qrcode';

export const newTotpSecret = () => generateSecret();

export async function totpQr(secret: string, label: string, issuer = 'Restream') {
  const uri = generateURI({ issuer, label, secret });
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 240, color: { dark: '#070A12', light: '#FFFFFF' } });
  return { uri, qr };
}

/** Verifies a 6 digit code with ±1 step tolerance. Returns the time step, or null. */
export async function verifyTotp(secret: string, code: string, afterTimeStep?: number | null): Promise<number | null> {
  const token = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(token)) return null;
  try {
    const res = await verify({
      secret,
      token,
      epochTolerance: 30,
      ...(afterTimeStep != null ? { afterTimeStep } : {}),
    });
    return res.valid ? (res as { timeStep: number }).timeStep : null;
  } catch {
    return null;
  }
}
