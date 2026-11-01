const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64Character(value: number): string {
  return base64Alphabet[value] ?? '';
}

export function encodeBase64(bytes: Uint8Array): string {
  let result = '';

  for (let offset = 0; offset < bytes.length; offset += 3) {
    const first = bytes[offset] ?? 0;
    const second = bytes[offset + 1] ?? 0;
    const third = bytes[offset + 2] ?? 0;
    const hasSecond = offset + 1 < bytes.length;
    const hasThird = offset + 2 < bytes.length;

    result += base64Character(first >>> 2);
    result += base64Character(((first & 0x03) << 4) | (second >>> 4));
    result += hasSecond ? base64Character(((second & 0x0f) << 2) | (third >>> 6)) : '=';
    result += hasThird ? base64Character(third & 0x3f) : '=';
  }

  return result;
}
