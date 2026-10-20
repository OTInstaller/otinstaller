// Images in guides and docs: type checks by content, and removing metadata before they are served from
// the registry. Photos often carry GPS coordinates and camera serials in EXIF, which a guide about
// geolocation should not leak about its author.

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGES_BYTES = 50 * 1024 * 1024;

export type ImageKind = "png" | "jpeg" | "webp" | "svg";

export const CONTENT_TYPES: Record<ImageKind, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml" };

/** What the bytes are, whatever the file is called. */
export function sniff(b: Uint8Array): ImageKind | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "webp";
  const head = new TextDecoder().decode(b.subarray(0, 1024)).replace(/^﻿/, "").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return "svg";
  return null;
}

/** The kind a file name promises. */
export function kindForPath(path: string): ImageKind | null {
  const ext = path.toLowerCase().split(".").pop();
  return ext === "png" ? "png" : ext === "jpg" || ext === "jpeg" ? "jpeg" : ext === "webp" ? "webp" : ext === "svg" ? "svg" : null;
}

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** JPEG: drops APP1 (EXIF, XMP), APP13 (IPTC) and comment segments; keeps JFIF, ICC profiles and the image. */
export function stripJpeg(b: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) throw new Error("malformed JPEG");
    const marker = b[i + 1]!;
    if (marker === 0xda || marker === 0xd9) {
      parts.push(b.subarray(i)); // start of scan: the rest is image data
      return concat(parts);
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(b.subarray(i, i + 2));
      i += 2;
      continue;
    }
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    const end = i + 2 + len;
    if (len < 2 || end > b.length) throw new Error("malformed JPEG");
    if (marker !== 0xe1 && marker !== 0xed && marker !== 0xfe) parts.push(b.subarray(i, end));
    i = end;
  }
  throw new Error("malformed JPEG");
}

const PNG_DROP = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);

/** PNG: drops EXIF, text and timestamp chunks. */
export function stripPng(b: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 8;
  while (i + 12 <= b.length) {
    const len = view.getUint32(i);
    const type = ascii(b, i + 4, 4);
    const end = i + 12 + len;
    if (end > b.length) throw new Error("malformed PNG");
    if (!PNG_DROP.has(type)) parts.push(b.subarray(i, end));
    i = end;
    if (type === "IEND") return concat(parts);
  }
  throw new Error("malformed PNG");
}

/** WebP: drops the EXIF and XMP chunks and clears their flags in the VP8X header. */
export function stripWebp(b: Uint8Array): Uint8Array {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const chunks: Uint8Array[] = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const fourcc = ascii(b, i, 4);
    const size = view.getUint32(i + 4, true);
    const end = i + 8 + size + (size % 2);
    if (i + 8 + size > b.length) throw new Error("malformed WebP");
    if (fourcc !== "EXIF" && fourcc !== "XMP ") {
      const chunk = b.slice(i, Math.min(end, b.length));
      if (fourcc === "VP8X") chunk[8] = chunk[8]! & ~(0x08 | 0x04);
      chunks.push(chunk);
    }
    i = end;
  }
  const body = concat(chunks);
  const header = new Uint8Array(12);
  header.set(b.subarray(0, 12));
  new DataView(header.buffer).setUint32(4, body.length + 4, true);
  return concat([header, body]);
}

/**
 * SVG: removes scripts, foreignObject, event handlers, DOCTYPE/entity declarations and references to
 * anything but the image itself (#fragments and data:image URLs). Served with a sandboxing CSP as well.
 */
export function sanitizeSvg(text: string): string {
  return text
    .replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/gi, "")
    .replace(/<!ENTITY[\s\S]*?>/gi, "")
    .replace(/<script\b[\s\S]*?(<\/script\s*>|$)/gi, "")
    .replace(/<foreignObject\b[\s\S]*?(<\/foreignObject\s*>|$)/gi, "")
    .replace(/<(iframe|embed|object|audio|video|handler|listener)\b[\s\S]*?(<\/\1\s*>|\/>|$)/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+(xlink:)?href\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, _x, _q, d, s) => {
      const v = (d ?? s ?? "").trim();
      return v.startsWith("#") || /^data:image\/(png|jpeg|gif|webp);/i.test(v) ? m : "";
    })
    .replace(/url\(\s*(['"]?)(?!#|data:image\/)[^)]*\1\s*\)/gi, "none");
}

/** Removes metadata (or active content, for SVG); throws on bytes that do not parse as the kind. */
export function cleanImage(kind: ImageKind, b: Uint8Array): Uint8Array {
  switch (kind) {
    case "jpeg":
      return stripJpeg(b);
    case "png":
      return stripPng(b);
    case "webp":
      return stripWebp(b);
    case "svg":
      return new TextEncoder().encode(sanitizeSvg(new TextDecoder().decode(b)));
  }
}

/** Headers for serving an image: an SVG opened directly cannot run anything. */
export function imageHeaders(kind: ImageKind): Record<string, string> {
  return {
    "Content-Type": CONTENT_TYPES[kind],
    "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "public, max-age=31536000, immutable",
  };
}
