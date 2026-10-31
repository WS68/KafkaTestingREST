import type { ReadonlyBytes } from '../record.js';

interface StrictTextDecoder {
  decode(input?: Uint8Array, options?: { stream?: boolean }): string;
}

interface StrictTextDecoderConstructor {
  new (label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }): StrictTextDecoder;
}

const textDecoderConstructor = (
  globalThis as typeof globalThis & { TextDecoder: StrictTextDecoderConstructor }
).TextDecoder;

/** Строго декодирует байты UTF-8 без подстановки символа замены. */
export function decodeStrictUtf8(bytes: ReadonlyBytes): string | undefined {
  try {
    const decoder = new textDecoderConstructor('utf-8', { fatal: true, ignoreBOM: false });
    return decoder.decode(bytes, { stream: false });
  } catch {
    return undefined;
  }
}
