import { describe, expect, it } from 'vitest';
import { sniffImageType } from '../src/routes/agency';

const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(16).fill(0)]);
const ascii = (s: string) => [...s].map((ch) => ch.charCodeAt(0));

describe('sniffImageType', () => {
  it('detects PNG, JPEG and WebP from magic bytes', () => {
    expect(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png');
    expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffImageType(bytes(...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP')))).toBe(
      'image/webp',
    );
  });

  it('rejects SVG/HTML and other files even if renamed', () => {
    expect(sniffImageType(new TextEncoder().encode('<svg onload="alert(1)"></svg>'))).toBeNull();
    expect(sniffImageType(new TextEncoder().encode('<html><script>x</script>'))).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });
});
