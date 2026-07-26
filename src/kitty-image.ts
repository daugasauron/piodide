import type { ImageContent } from "@earendil-works/pi-ai";

import type { TermWriter } from "./termui.ts";

const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const MAX_DECODED_PIXELS = 20_000_000;
const MAX_TRANSMIT_WIDTH = 1600;
const MAX_TRANSMIT_HEIGHT = 1200;
const BASE64_CHUNK_SIZE = 4096;
const HORIZONTAL_MARGIN_CELLS = 2;

/**
 * Display an image through Ghostty's Kitty graphics protocol. The terminal
 * owns the placement, so images scroll with terminal output like native cells.
 */
export async function renderKittyImage(
  writer: TermWriter,
  content: ImageContent,
): Promise<void> {
  if (!content.mimeType.startsWith("image/")) {
    throw new Error(`Unsupported media type: ${content.mimeType}`);
  }

  const source = decodeBase64(content.data);
  if (source.byteLength === 0 || source.byteLength > MAX_SOURCE_BYTES) {
    throw new Error(`Image must be between 1 byte and ${MAX_SOURCE_BYTES / 1024 / 1024} MB.`);
  }

  const bitmap = await createImageBitmap(new Blob([source], { type: content.mimeType }));
  try {
    if (bitmap.width * bitmap.height > MAX_DECODED_PIXELS) {
      throw new Error("Decoded image is too large (20 megapixel limit).");
    }

    const placement = fitPlacement(bitmap.width, bitmap.height, writer);
    const png = await boundedPng(bitmap);
    const payload = encodeBase64(png);

    writer.ensureNewline();
    writer.writeln(
      `\x1b[2m  image ${bitmap.width}×${bitmap.height} · ${content.mimeType} · Kitty graphics\x1b[0m`,
    );
    writer.writeln("");
    writer.write(" ".repeat(HORIZONTAL_MARGIN_CELLS));
    for (let offset = 0; offset < payload.length; offset += BASE64_CHUNK_SIZE) {
      const chunk = payload.slice(offset, offset + BASE64_CHUNK_SIZE);
      const more = offset + BASE64_CHUNK_SIZE < payload.length ? 1 : 0;
      const controls =
        offset === 0
          ? `a=T,f=100,q=2,c=${placement.cols},r=${placement.rows},m=${more}`
          : `q=2,m=${more}`;
      writer.write(`\x1b_G${controls};${chunk}\x1b\\`);
    }
    // Direct placements move the cursor past their rectangle. Return to
    // column zero; the line reached below the placement becomes its bottom
    // margin before subsequent output.
    writer.writeln("");
  } finally {
    bitmap.close();
  }
}

export function deleteKittyImages(writer: TermWriter): void {
  writer.write("\x1b_Ga=d,d=A,q=2;\x1b\\");
}

function fitPlacement(
  width: number,
  height: number,
  writer: TermWriter,
): { cols: number; rows: number } {
  const maxCols = Math.max(1, Math.min(96, writer.cols - 4));
  const maxRows = Math.max(1, writer.rows - 6);
  let cols = Math.max(1, Math.min(maxCols, Math.ceil(width / 12)));
  let rows = Math.max(1, Math.round((height / width) * cols * 0.5));
  if (rows > maxRows) {
    cols = Math.max(1, Math.round(cols * (maxRows / rows)));
    rows = maxRows;
  }
  return { cols, rows };
}

async function boundedPng(bitmap: ImageBitmap): Promise<ArrayBuffer> {
  const scale = Math.min(
    1,
    MAX_TRANSMIT_WIDTH / bitmap.width,
    MAX_TRANSMIT_HEIGHT / bitmap.height,
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is unavailable.");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) => (value ? resolve(value) : reject(new Error("PNG encoding failed."))),
      "image/png",
    ),
  );
  return blob.arrayBuffer();
}

function decodeBase64(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let offset = 0; offset < binary.length; offset++) {
    bytes[offset] = binary.charCodeAt(offset);
  }
  return bytes;
}

function encodeBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const parts: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(parts.join(""));
}
