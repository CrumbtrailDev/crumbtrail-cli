import { describe, it, expect } from "vitest";
import {
  collectFileSniffTasks,
  describeFilePartSync,
  detectSniffedType,
  parseGifDimensions,
  parseJpegDimensions,
  parsePngDimensions,
  parseWebpDimensions,
  sniffFile,
  validateDeclaredMimeType,
} from "../file-part";
import { extractFileExtension } from "../../utils";

/** Builds a `File`-like object backed by real bytes, for `slice().arrayBuffer()` sniffing. */
function fileFromBytes(
  bytes: number[],
  name = "upload.bin",
  type = "",
): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

function concat(...parts: number[][]): number[] {
  return parts.flat();
}

/** ASCII bytes for a fixture header string. */
function ascii(text: string): number[] {
  return Array.from(text, (c) => c.charCodeAt(0));
}

function uint32BE(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function uint16LE(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}

function uint24LE(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];
}

describe("detectSniffedType", () => {
  it("recognizes a PNG signature", () => {
    const head = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    expect(detectSniffedType(head)).toBe("image/png");
  });

  it("recognizes a JPEG signature", () => {
    const head = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    expect(detectSniffedType(head)).toBe("image/jpeg");
  });

  it("recognizes GIF87a and GIF89a", () => {
    expect(detectSniffedType(new Uint8Array(ascii("GIF87a")))).toBe("image/gif");
    expect(detectSniffedType(new Uint8Array(ascii("GIF89a")))).toBe("image/gif");
  });

  it("recognizes a WebP RIFF/WEBP container", () => {
    const head = new Uint8Array(concat(ascii("RIFF"), uint32BE(0), ascii("WEBP")));
    expect(detectSniffedType(head)).toBe("image/webp");
  });

  it("recognizes a PDF signature", () => {
    const head = new Uint8Array(ascii("%PDF-1.7"));
    expect(detectSniffedType(head)).toBe("application/pdf");
  });

  it("recognizes a ZIP local file header (covers docx/xlsx)", () => {
    expect(detectSniffedType(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(
      "application/zip",
    );
  });

  it("recognizes an empty ZIP archive end marker", () => {
    expect(detectSniffedType(new Uint8Array([0x50, 0x4b, 0x05, 0x06]))).toBe(
      "application/zip",
    );
  });

  it("recognizes an MP4 ftyp box", () => {
    const head = new Uint8Array(concat(uint32BE(24), ascii("ftypisom")));
    expect(detectSniffedType(head)).toBe("video/mp4");
  });

  it("reports plain text by absence of a NUL byte", () => {
    const head = new Uint8Array(ascii("hello, this is plain text"));
    expect(detectSniffedType(head)).toBe("text/plain");
  });

  it("reports nothing for an unrecognized binary blob", () => {
    const head = new Uint8Array([1, 2, 0, 3, 4, 0, 5]);
    expect(detectSniffedType(head)).toBeUndefined();
  });

  it("reports nothing for an empty slice", () => {
    expect(detectSniffedType(new Uint8Array(0))).toBeUndefined();
  });
});

describe("parsePngDimensions", () => {
  it("reads width and height from the IHDR chunk", () => {
    const head = new Uint8Array(
      concat(
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        uint32BE(13),
        ascii("IHDR"),
        uint32BE(1200),
        uint32BE(800),
      ),
    );
    expect(parsePngDimensions(head)).toEqual({ width: 1200, height: 800 });
  });

  it("returns undefined when the chunk is not IHDR", () => {
    const head = new Uint8Array(24);
    expect(parsePngDimensions(head)).toBeUndefined();
  });

  it("returns undefined for a truncated header", () => {
    expect(parsePngDimensions(new Uint8Array(10))).toBeUndefined();
  });
});

describe("parseGifDimensions", () => {
  it("reads little-endian width and height from the Logical Screen Descriptor", () => {
    const head = new Uint8Array(concat(ascii("GIF89a"), uint16LE(640), uint16LE(480)));
    expect(parseGifDimensions(head)).toEqual({ width: 640, height: 480 });
  });

  it("returns undefined for a truncated header", () => {
    expect(parseGifDimensions(new Uint8Array(4))).toBeUndefined();
  });
});

describe("parseWebpDimensions", () => {
  it("reads VP8X extended-format canvas dimensions (24 bit, minus one encoded)", () => {
    const head = new Uint8Array(
      concat(
        ascii("RIFF"),
        uint32BE(0),
        ascii("WEBP"),
        ascii("VP8X"),
        uint32BE(10),
        [0, 0, 0, 0], // flags + reserved
        uint24LE(1919), // width - 1  -> 1920
        uint24LE(1079), // height - 1 -> 1080
      ),
    );
    expect(parseWebpDimensions(head)).toEqual({ width: 1920, height: 1080 });
  });

  it("reads VP8L lossless bitstream dimensions (14 bit, minus one encoded)", () => {
    const width = 400;
    const height = 300;
    const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
    const b0 = bits & 0xff;
    const b1 = (bits >>> 8) & 0xff;
    const b2 = (bits >>> 16) & 0xff;
    const b3 = (bits >>> 24) & 0xff;
    const head = new Uint8Array(
      concat(
        ascii("RIFF"),
        uint32BE(0),
        ascii("WEBP"),
        ascii("VP8L"),
        uint32BE(5),
        [0x2f, b0, b1, b2, b3],
      ),
    );
    expect(parseWebpDimensions(head)).toEqual({ width: 400, height: 300 });
  });

  it("reads VP8 lossy keyframe dimensions (14 bit, direct)", () => {
    const width = 176;
    const height = 144;
    const head = new Uint8Array(
      concat(
        ascii("RIFF"),
        uint32BE(0),
        ascii("WEBP"),
        ascii("VP8 "),
        uint32BE(10),
        [0x10, 0x00, 0x00], // frame tag (key frame)
        [0x9d, 0x01, 0x2a], // start code
        uint16LE(width),
        uint16LE(height),
      ),
    );
    expect(parseWebpDimensions(head)).toEqual({ width, height });
  });

  it("returns undefined for an unrecognized chunk fourCC", () => {
    const head = new Uint8Array(concat(ascii("RIFF"), uint32BE(0), ascii("WEBP"), ascii("XXXX")));
    expect(parseWebpDimensions(head)).toBeUndefined();
  });
});

describe("parseJpegDimensions", () => {
  function jpegWithSof(marker: number, width: number, height: number, leadingApp1 = false): Uint8Array {
    const sofData = concat(
      [0, 11], // segment length: 2 (length) + 1 (precision) + 4 (dims) + 1 + 3 (one component) = 11
      [8], // precision
      [(height >> 8) & 0xff, height & 0xff],
      [(width >> 8) & 0xff, width & 0xff],
      [1, 0x11, 0], // one component
    );
    // Segment length INCLUDES its own 2 bytes: 2 (length) + 4 ("Exif") + 2 (padding) = 8.
    const app1 = leadingApp1
      ? concat([0xff, 0xe1], [0, 8], ascii("Exif"), [0, 0])
      : [];
    return new Uint8Array(
      concat(
        [0xff, 0xd8], // SOI
        app1,
        [0xff, marker],
        sofData,
      ),
    );
  }

  it("reads width/height from an SOF0 (baseline) segment", () => {
    expect(parseJpegDimensions(jpegWithSof(0xc0, 1024, 768))).toEqual({
      width: 1024,
      height: 768,
    });
  });

  it("reads width/height from an SOF2 (progressive) segment", () => {
    expect(parseJpegDimensions(jpegWithSof(0xc2, 640, 480))).toEqual({
      width: 640,
      height: 480,
    });
  });

  it("skips a leading APP1/Exif segment to find SOF0", () => {
    expect(parseJpegDimensions(jpegWithSof(0xc0, 300, 200, true))).toEqual({
      width: 300,
      height: 200,
    });
  });

  it("returns undefined when there is no SOI", () => {
    expect(parseJpegDimensions(new Uint8Array([0, 1, 2, 3]))).toBeUndefined();
  });

  it("returns undefined when SOS is hit before any SOF marker", () => {
    const bytes = new Uint8Array(concat([0xff, 0xd8], [0xff, 0xda], [0, 2]));
    expect(parseJpegDimensions(bytes)).toBeUndefined();
  });
});

describe("validateDeclaredMimeType", () => {
  it.each([
    "application/pdf",
    "image/png",
    "text/plain",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "image/svg+xml",
  ])("accepts %s", (type) => {
    expect(validateDeclaredMimeType(type)).toBe(type);
  });

  it.each([
    "",
    "notamime",
    "text/",
    "/plain",
    "text/plain; charset=utf-8",
    "text plain/x",
    "a".repeat(300) + "/x",
    "<script>/x",
    undefined,
    null,
    42,
  ])("rejects %j", (type) => {
    expect(validateDeclaredMimeType(type)).toBeUndefined();
  });
});

describe("extractFileExtension (the ext rule)", () => {
  it("lowercases an uppercase extension", () => {
    expect(extractFileExtension("REPORT.PDF")).toBe("pdf");
  });

  it("drops an overlong tail rather than truncating it", () => {
    expect(extractFileExtension("archive.tarballofstuff")).toBeUndefined();
  });

  it("reports nothing for a name with no dot", () => {
    expect(extractFileExtension("README")).toBeUndefined();
  });

  it("reports nothing for a dotfile (nothing before the dot)", () => {
    expect(extractFileExtension(".gitignore")).toBeUndefined();
  });

  it("keeps a short alphanumeric extension", () => {
    expect(extractFileExtension("invoice.pdf")).toBe("pdf");
    expect(extractFileExtension("archive.tar.gz")).toBe("gz");
  });

  it("drops a non-alphanumeric tail", () => {
    expect(extractFileExtension("weird.p f")).toBeUndefined();
  });
});

describe("describeFilePartSync", () => {
  it("computes ext, nameShape, and declaredType together", () => {
    const description = describeFilePartSync({
      name: "invoice.pdf",
      type: "application/pdf",
      size: 1234,
    });
    expect(description.ext).toBe("pdf");
    expect(description.declaredType).toBe("application/pdf");
    expect(description.nameShape).toBeDefined();
    expect(description.nameShape?.len).toBe("invoice.pdf".length);
  });

  it("drops declaredType when file.type fails the MIME grammar", () => {
    const description = describeFilePartSync({
      name: "invoice.pdf",
      type: "not a mime",
    });
    expect(description.declaredType).toBeUndefined();
  });

  it("omits every field for a nameless, typeless file", () => {
    const description = describeFilePartSync({});
    expect(description).toEqual({});
  });
});

describe("collectFileSniffTasks", () => {
  it("indexes multiple files under the same field name in append order", () => {
    const formData = new FormData();
    formData.append("sku", "ABC");
    formData.append("photos", fileFromBytes([1, 2, 3], "a.jpg"));
    formData.append("photos", fileFromBytes([4, 5, 6], "b.jpg"));
    formData.append("invoice", fileFromBytes([7, 8, 9], "c.pdf"));

    const tasks = collectFileSniffTasks(formData.entries());
    expect(tasks).toHaveLength(3);
    expect(tasks[0]).toMatchObject({ field: "photos", index: 0 });
    expect(tasks[1]).toMatchObject({ field: "photos", index: 1 });
    expect(tasks[2]).toMatchObject({ field: "invoice", index: 0 });
  });
});

describe("sniffFile", () => {
  it("detects type and dimensions for a PNG file, and discards the read afterward", async () => {
    const bytes = concat(
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      uint32BE(13),
      ascii("IHDR"),
      uint32BE(64),
      uint32BE(32),
      [0, 0, 0, 0, 0, 0, 0, 0, 0], // rest of the chunk + CRC, not needed
    );
    const result = await sniffFile(fileFromBytes(bytes, "pic.png"));
    expect(result).toEqual({ sniffedType: "image/png", width: 64, height: 32 });
  });

  it("reports a type with no dimensions for formats with no parser", () => {
    return sniffFile(fileFromBytes(ascii("%PDF-1.4"), "doc.pdf")).then((result) => {
      expect(result).toEqual({ sniffedType: "application/pdf" });
    });
  });

  it("returns an empty result for a file-like value with no slice method", async () => {
    const result = await sniffFile({ name: "x", size: 1 });
    expect(result).toEqual({});
  });
});
