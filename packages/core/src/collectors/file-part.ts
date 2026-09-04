import { computeRedactedShape, type RedactedValueShape } from "../redaction";
import { extractFileExtension } from "../utils";
import type { EventBus } from "../event-bus";

/**
 * The parts of a `File`/`Blob` this module needs. Kept minimal (rather than
 * importing the DOM `File` type) so a FormData polyfill or a non-browser host
 * with its own File-like value still describes correctly.
 */
export interface FilePartLike {
  name?: string;
  type?: string;
  size?: number;
  slice?: (
    start?: number,
    end?: number,
    contentType?: string,
  ) => { arrayBuffer(): Promise<ArrayBuffer> };
}

export interface FileSniffTask {
  /** The FormData field name the file was appended under. */
  field: string;
  /** Position among values appended under that same field name. */
  index: number;
  file: FilePartLike;
}

/**
 * MIME grammar `type/subtype`, RFC 2045 token characters, bounded so a
 * declared type can never carry more than a type name.
 *
 * `file.type` is free text the page or the browser supplied — a page can set
 * `<input accept>` or construct a `File` with any string — so a wildcard
 * "trust it" reading would let arbitrary content ride through as a "MIME
 * type". Anything that is not exactly one bounded token, a slash, and one
 * bounded token is dropped rather than kept partially.
 */
const MIME_TOKEN_RE = "[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}";
const STRICT_MIME_RE = new RegExp(`^${MIME_TOKEN_RE}/${MIME_TOKEN_RE}$`);

export function validateDeclaredMimeType(
  type: unknown,
): string | undefined {
  if (typeof type !== "string") return undefined;
  if (type.length === 0 || type.length > 255) return undefined;
  return STRICT_MIME_RE.test(type) ? type : undefined;
}

/**
 * Finds every `File`/`Blob` value in a `FormData`, in append order, tagged
 * with the field name and its position among same-named entries.
 *
 * A separate pass from the one that builds the JSON body
 * (`utils.ts#readStructuredBody`) rather than a shared one: that pass must
 * stay dependency-free for the early-capture bundle, and it already produces
 * the body text this module never touches. Both passes iterate the same
 * `FormData` in the same order, so the index assigned here lines up with the
 * position an array-valued field takes in that JSON body.
 */
export function collectFileSniffTasks(
  formData: Iterable<[string, unknown]>,
): FileSniffTask[] {
  const seen = new Map<string, number>();
  const tasks: FileSniffTask[] = [];
  for (const [field, value] of formData) {
    if (typeof value === "string" || value == null) continue;
    const index = seen.get(field) ?? 0;
    seen.set(field, index + 1);
    tasks.push({ field, index, file: value as FilePartLike });
  }
  return tasks;
}

export interface FilePartSyncDescription {
  ext?: string;
  nameShape?: RedactedValueShape;
  declaredType?: string;
}

/**
 * Everything about a file part that is safe to compute without reading its
 * bytes: the extension, the shape of its name, and its declared (but
 * grammar-validated) MIME type. None of this rides inside the request body's
 * JSON text — that text goes through the same free-text redaction as every
 * other string in a body, and a MIME type's `/` fails the enum-shaped keep
 * rule that lets an ordinary short value survive. These fields are already
 * shape-only or grammar-validated, so they are emitted on their own rather
 * than laundered through a redactor built for content it is not.
 */
export function describeFilePartSync(
  file: FilePartLike,
): FilePartSyncDescription {
  const description: FilePartSyncDescription = {};
  if (typeof file.name === "string") {
    const ext = extractFileExtension(file.name);
    if (ext) description.ext = ext;
    if (file.name.length > 0) description.nameShape = computeRedactedShape(file.name);
  }
  const declaredType = validateDeclaredMimeType(file.type);
  if (declaredType) description.declaredType = declaredType;
  return description;
}

/** First N bytes of a magic-number table, matched at a fixed offset. */
function matchBytes(head: Uint8Array, offset: number, bytes: number[]): boolean {
  if (head.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (head[offset + i] !== bytes[i]) return false;
  }
  return true;
}

function matchAscii(head: Uint8Array, offset: number, text: string): boolean {
  return matchBytes(
    head,
    offset,
    Array.from(text, (char) => char.charCodeAt(0)),
  );
}

function asciiAt(head: Uint8Array, offset: number, length: number): string {
  let text = "";
  for (let i = 0; i < length; i++) text += String.fromCharCode(head[offset + i] ?? 0);
  return text;
}

/**
 * File kind from its own bytes, not from whatever the upload declared.
 *
 * Only the families the plan names: the image formats a dimension parser
 * exists for, PDF, ZIP (covers docx/xlsx, which are ZIP containers), MP4,
 * and plain text by the absence of a NUL byte in the sampled window — a
 * binary format this table does not recognize is left unidentified rather
 * than guessed at.
 */
export function detectSniffedType(head: Uint8Array): string | undefined {
  if (matchBytes(head, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return "image/png";
  if (matchBytes(head, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (matchAscii(head, 0, "GIF87a") || matchAscii(head, 0, "GIF89a"))
    return "image/gif";
  if (matchAscii(head, 0, "RIFF") && matchAscii(head, 8, "WEBP"))
    return "image/webp";
  if (matchAscii(head, 0, "%PDF-")) return "application/pdf";
  if (
    matchBytes(head, 0, [0x50, 0x4b, 0x03, 0x04]) ||
    matchBytes(head, 0, [0x50, 0x4b, 0x05, 0x06]) ||
    matchBytes(head, 0, [0x50, 0x4b, 0x07, 0x08])
  )
    return "application/zip";
  if (matchAscii(head, 4, "ftyp")) return "video/mp4";
  if (head.length > 0 && !head.includes(0)) return "text/plain";
  return undefined;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

export interface FileDimensions {
  width: number;
  height: number;
}

/** PNG: an 8 byte signature, then the IHDR chunk carries width/height as big-endian uint32s. */
export function parsePngDimensions(head: Uint8Array): FileDimensions | undefined {
  if (head.length < 24 || !matchAscii(head, 12, "IHDR")) return undefined;
  const width = readUint32BE(head, 16);
  const height = readUint32BE(head, 20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/** GIF: a 6 byte header, then the Logical Screen Descriptor carries little-endian uint16s. */
export function parseGifDimensions(head: Uint8Array): FileDimensions | undefined {
  if (head.length < 10) return undefined;
  const width = head[6] | (head[7] << 8);
  const height = head[8] | (head[9] << 8);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * WebP: a RIFF/WEBP container around one of three chunk kinds, each of which
 * encodes width/height differently. `VP8X` (extended) stores 24-bit
 * width-1/height-1 fields; `VP8L` (lossless) packs 14-bit width-1/height-1
 * into its first bitstream bytes; `VP8 ` (lossy) is a raw VP8 keyframe with a
 * 3-byte start code before 14-bit width/height fields.
 */
export function parseWebpDimensions(head: Uint8Array): FileDimensions | undefined {
  if (head.length < 16) return undefined;
  const fourCC = asciiAt(head, 12, 4);
  if (fourCC === "VP8X") {
    if (head.length < 30) return undefined;
    return {
      width: readUint24LE(head, 24) + 1,
      height: readUint24LE(head, 27) + 1,
    };
  }
  if (fourCC === "VP8L") {
    if (head.length < 25 || head[20] !== 0x2f) return undefined;
    const bits =
      (head[21] | (head[22] << 8) | (head[23] << 16) | (head[24] << 24)) >>> 0;
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }
  if (fourCC === "VP8 ") {
    if (
      head.length < 30 ||
      head[23] !== 0x9d ||
      head[24] !== 0x01 ||
      head[25] !== 0x2a
    )
      return undefined;
    const width = (head[26] | (head[27] << 8)) & 0x3fff;
    const height = (head[28] | (head[29] << 8)) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  return undefined;
}

/**
 * JPEG: walks the marker segments after SOI looking for SOF0 (baseline) or
 * SOF2 (progressive), the two markers that carry width/height. Every other
 * segment — APP1/Exif above all, which routinely sits between SOI and SOF —
 * is skipped by its own declared length rather than assumed away, so a
 * leading Exif block does not hide the dimensions behind it.
 */
export function parseJpegDimensions(bytes: Uint8Array): FileDimensions | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    // Marker codes may be preceded by fill bytes (extra 0xFF).
    let markerOffset = offset + 1;
    while (bytes[markerOffset] === 0xff && markerOffset + 1 < bytes.length) {
      markerOffset++;
    }
    const marker = bytes[markerOffset];
    offset = markerOffset + 1;
    // Standalone markers carry no length: SOI, TEM, and the restart markers.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
    if (offset + 2 > bytes.length) return undefined;
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (marker === 0xc0 || marker === 0xc2) {
      if (offset + 7 > bytes.length) return undefined;
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    // SOS: the entropy-coded scan follows, with no further markers to find.
    if (marker === 0xda) return undefined;
    offset += segmentLength;
  }
  return undefined;
}

const SNIFF_HEAD_BYTES = 32;
const JPEG_SCAN_BYTES = 65_536;

export interface FileSniffResult {
  sniffedType?: string;
  width?: number;
  height?: number;
}

/**
 * Reads a bounded slice of the file, identifies its format from the bytes
 * (never from the declared name or MIME type), and for the formats a parser
 * exists for, its pixel dimensions. The slice is never retained: it is read,
 * inspected, and discarded within this function.
 */
export async function sniffFile(file: FilePartLike): Promise<FileSniffResult> {
  if (typeof file.slice !== "function") return {};
  let head: Uint8Array;
  try {
    head = new Uint8Array(await file.slice(0, SNIFF_HEAD_BYTES).arrayBuffer());
  } catch {
    return {};
  }
  const sniffedType = detectSniffedType(head);
  if (!sniffedType) return {};
  const result: FileSniffResult = { sniffedType };
  if (sniffedType === "image/png") Object.assign(result, parsePngDimensions(head));
  else if (sniffedType === "image/gif") Object.assign(result, parseGifDimensions(head));
  else if (sniffedType === "image/webp") Object.assign(result, parseWebpDimensions(head));
  else if (sniffedType === "image/jpeg") {
    try {
      const scan = new Uint8Array(
        await file.slice(0, JPEG_SCAN_BYTES).arrayBuffer(),
      );
      Object.assign(result, parseJpegDimensions(scan));
    } catch {
      // Dimensions omitted; the type from the 32 byte head still stands.
    }
  }
  return result;
}

/**
 * Describes every file part of a request's `FormData` with exactly one
 * `net.req.file` event each, without ever delaying the request that carries
 * it.
 *
 * The synchronous facts (extension, name shape, declared type) are computed
 * immediately — they cost no I/O. Byte sniffing does cost I/O
 * (`file.slice().arrayBuffer()` resolves on a microtask at best), so it is
 * kicked off here but never awaited: this function returns as soon as the
 * synchronous work is done, and the request dispatches right after, never
 * waiting on a single byte of its own upload being read back. The one event
 * per part is emitted from the sniff's promise continuation once it settles
 * — carrying the sync fields and the sniffed fields together — or, if the
 * sniff rejects or the file has no `slice`, carrying the sync fields alone.
 * `t` is the request's own start time, not the time the event happens to be
 * emitted, so it sorts beside its `net.req` even though it is written later.
 */
export function emitFilePartEvents(
  bus: EventBus,
  requestId: number,
  formData: Iterable<[string, unknown]>,
  requestTime: number,
): void {
  let tasks: FileSniffTask[];
  try {
    tasks = collectFileSniffTasks(formData);
  } catch {
    return;
  }
  for (const task of tasks) {
    let sync: FilePartSyncDescription;
    try {
      sync = describeFilePartSync(task.file);
    } catch {
      sync = {};
    }
    const emit = (sniffed: FileSniffResult) => {
      bus.emit({
        t: requestTime,
        k: "net.req.file",
        d: {
          id: requestId,
          field: task.field,
          index: task.index,
          ...sync,
          ...sniffed,
        },
      });
    };
    sniffFile(task.file)
      .then(emit)
      .catch(() => {
        // Sniffing is best effort. A read failure describes nothing further
        // than the synchronous facts, and must never surface as an error the
        // host application sees.
        emit({});
      });
  }
}
