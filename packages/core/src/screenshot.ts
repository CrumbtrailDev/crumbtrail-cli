/** MIME type accepted by the v1 report screenshot endpoint. */
export type ReportScreenshotMimeType = "image/png";

/** Options for {@link Crumbtrail.captureScreenshot}. */
export interface CaptureScreenshotOptions {
  /** The output MIME type. PNG is the only v1 format. */
  mimeType?: ReportScreenshotMimeType;
}

export const REPORT_SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;
export const REPORT_SCREENSHOT_MAX_EDGE = 4096;

const REPORT_SCREENSHOT_EXTENSION = "png";
const REPORT_SCREENSHOT_NAME = /^report-screenshot-[a-f0-9]{32}\.png$/u;
const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
/** True only for names minted by this SDK. */
export function isReportScreenshotArtifactName(name: string): boolean {
  return REPORT_SCREENSHOT_NAME.test(name);
}

/** Read PNG dimensions from its IHDR header without decoding pixels. */
export function reportScreenshotDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | undefined {
  if (
    bytes.length < 24 ||
    !PNG_SIGNATURE.every((value, i) => bytes[i] === value)
  )
    return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // A PNG's first chunk is IHDR. Refuse a different first chunk rather than
  // treating arbitrary bytes at offsets 16 and 20 as dimensions.
  if (
    view.getUint32(8) !== 13 ||
    bytes[12] !== 0x49 ||
    bytes[13] !== 0x48 ||
    bytes[14] !== 0x44 ||
    bytes[15] !== 0x52
  )
    return undefined;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0) return undefined;
  return { width, height };
}

/** Validate a PNG signature, IHDR header, and bounded dimensions. */
export function assertReportScreenshotDimensions(bytes: Uint8Array): void {
  const dimensions = reportScreenshotDimensions(bytes);
  if (!dimensions)
    throw new TypeError("captureScreenshot requires valid PNG bytes");
  if (
    dimensions.width > REPORT_SCREENSHOT_MAX_EDGE ||
    dimensions.height > REPORT_SCREENSHOT_MAX_EDGE
  )
    throw new RangeError(
      `captureScreenshot images cannot exceed ${REPORT_SCREENSHOT_MAX_EDGE} pixels on an edge`,
    );
}

/** Generate the opaque artifact name accepted by the Cloud blob route. */
export function generateReportScreenshotArtifactName(): string {
  const bytes = new Uint8Array(16);
  const getRandomValues = globalThis.crypto?.getRandomValues;
  if (typeof getRandomValues === "function") {
    try {
      getRandomValues.call(globalThis.crypto, bytes);
    } catch {
      fillRandomBytes(bytes);
    }
  } else {
    fillRandomBytes(bytes);
  }
  const suffix = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `report-screenshot-${suffix}.${REPORT_SCREENSHOT_EXTENSION}`;
}

function fillRandomBytes(bytes: Uint8Array): void {
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Math.floor(Math.random() * 256);
}

function isBlobSource(source: unknown): source is Blob {
  const constructor = (globalThis as { Blob?: typeof Blob }).Blob;
  return typeof constructor === "function" && source instanceof constructor;
}

function isCanvasSource(source: unknown): source is HTMLCanvasElement {
  const constructor = (
    globalThis as {
      HTMLCanvasElement?: typeof HTMLCanvasElement;
    }
  ).HTMLCanvasElement;
  return typeof constructor === "function" && source instanceof constructor;
}

/** Normalize a Blob MIME value for the strict Cloud content type contract. */
export function normalizeReportScreenshotMimeType(
  value: unknown,
): ReportScreenshotMimeType | undefined {
  if (typeof value !== "string") return undefined;
  const mime = value.split(";", 1)[0].trim().toLowerCase();
  return mime === "image/png" ? "image/png" : undefined;
}

/** Resolve and validate the caller's source, converting a canvas to PNG. */
export async function prepareReportScreenshot(
  source: Blob | HTMLCanvasElement,
  options?: CaptureScreenshotOptions,
): Promise<Blob> {
  const requestedMime = options?.mimeType ?? "image/png";
  if (requestedMime !== "image/png") {
    throw new TypeError("captureScreenshot only accepts image/png in v1");
  }

  let blob: Blob;
  if (isBlobSource(source)) {
    const sourceMime = normalizeReportScreenshotMimeType(source.type);
    if (!sourceMime)
      throw new TypeError(
        "captureScreenshot requires a Blob with MIME type image/png",
      );
    blob = source;
  } else if (isCanvasSource(source)) {
    if (
      source.width > REPORT_SCREENSHOT_MAX_EDGE ||
      source.height > REPORT_SCREENSHOT_MAX_EDGE
    )
      throw new RangeError(
        `captureScreenshot images cannot exceed ${REPORT_SCREENSHOT_MAX_EDGE} pixels on an edge`,
      );
    blob = await canvasToPng(source);
  } else {
    throw new TypeError(
      "captureScreenshot source must be a Blob or HTMLCanvasElement",
    );
  }

  if (blob.size > REPORT_SCREENSHOT_MAX_BYTES)
    throw new RangeError(
      `captureScreenshot images cannot exceed ${REPORT_SCREENSHOT_MAX_BYTES} bytes`,
    );
  const actualMime = normalizeReportScreenshotMimeType(blob.type);
  if (!actualMime)
    throw new TypeError("captureScreenshot output MIME type must be image/png");
  // Reading at most 5 MiB is bounded and lets the SDK reject a falsely typed
  // or oversized PNG before the request.
  assertReportScreenshotDimensions(new Uint8Array(await blob.arrayBuffer()));
  return blob;
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("captureScreenshot could not encode the canvas"));
          return;
        }
        const mime = normalizeReportScreenshotMimeType(blob.type);
        if (!mime) {
          reject(
            new TypeError(
              "captureScreenshot canvas output MIME type must be image/png",
            ),
          );
          return;
        }
        resolve(blob);
      }, "image/png");
    } catch (error) {
      reject(error);
    }
  });
}
