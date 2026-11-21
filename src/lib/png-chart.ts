// Minimal PNG bar-chart renderer (no dependencies) used for chart images in Google Slides reports.
// Single series -> no legend; the slide text names the chart. Thin bars, recessive grid,
// bars anchored to the baseline with a small rounded top.

export type ChartOptions = { width?: number; height?: number; color?: string };

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const v = parseInt(m?.[1] ?? '4f46e5', 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function zlibCompress(data: Uint8Array): Promise<Uint8Array> {
  // CompressionStream('deflate') produces zlib-wrapped data, which is what PNG IDAT needs.
  const stream = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function renderBarChartPng(
  values: number[],
  opts: ChartOptions = {},
): Promise<Uint8Array> {
  const width = opts.width ?? 640;
  const height = opts.height ?? 260;
  const [br, bg, bb] = hexToRgb(opts.color ?? '#4f46e5');
  const rgb = new Uint8Array(width * height * 3).fill(255); // white background

  const set = (x: number, y: number, r: number, g: number, b: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 3;
    rgb[i] = r;
    rgb[i + 1] = g;
    rgb[i + 2] = b;
  };

  const pad = { top: 12, right: 12, bottom: 16, left: 12 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const baseY = pad.top + plotH;

  // Recessive grid: 3 light lines + darker baseline.
  for (let g = 1; g <= 3; g++) {
    const y = Math.round(pad.top + (plotH * g) / 4);
    for (let x = pad.left; x < pad.left + plotW; x++) set(x, y, 236, 239, 243);
  }
  for (let x = pad.left; x < pad.left + plotW; x++) set(x, baseY, 203, 213, 225);

  const max = Math.max(0, ...values);
  const n = Math.max(values.length, 1);
  const slot = plotW / n;
  const barW = Math.max(2, Math.floor(slot - Math.max(2, slot * 0.25))); // >= 2px gap between bars
  values.forEach((v, i) => {
    if (max <= 0 || v <= 0) return;
    const h = Math.max(1, Math.round((v / max) * (plotH - 4)));
    const x0 = Math.round(pad.left + i * slot + (slot - barW) / 2);
    const radius = Math.min(4, Math.floor(barW / 2), h);
    for (let y = baseY - h; y < baseY; y++) {
      const fromTop = y - (baseY - h);
      for (let x = x0; x < x0 + barW; x++) {
        // Round the two top corners.
        if (fromTop < radius) {
          const dx =
            x < x0 + radius
              ? x0 + radius - x - 0.5
              : x >= x0 + barW - radius
                ? x - (x0 + barW - radius) + 0.5
                : 0;
          const dy = radius - fromTop - 0.5;
          if (dx > 0 && dx * dx + dy * dy > radius * radius) continue;
        }
        set(x, y, br, bg, bb);
      }
    }
  });

  // PNG scanlines: filter byte 0 + RGB row.
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', await zlibCompress(raw)),
    chunk('IEND', new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
