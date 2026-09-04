export class BoundedBodyRecorder {
  private readonly chunks: Buffer[] = [];
  bytes = 0;
  truncated = false;

  constructor(private readonly cap: number) {}

  record(chunk: unknown, encoding?: unknown): void {
    let buffer: Uint8Array;
    if (typeof chunk === "string") {
      const stringEncoding =
        typeof encoding === "string" && Buffer.isEncoding(encoding)
          ? encoding
          : "utf8";
      const size = Buffer.byteLength(chunk, stringEncoding);
      const remaining = this.cap - this.bytes;
      if (remaining === 0) {
        if (size > 0) this.truncated = true;
        return;
      }
      // Extra room lets an encoded character cross the retained byte boundary.
      // Converting an entire upload here would defeat bounded capture memory.
      const encoded = Buffer.alloc(Math.min(size, remaining + 4));
      const written = encoded.write(chunk, stringEncoding);
      buffer = encoded.subarray(0, written);
      if (size > remaining) this.truncated = true;
    } else if (chunk instanceof Uint8Array) {
      buffer = chunk;
    } else {
      return;
    }
    const length = Math.min(buffer.byteLength, this.cap - this.bytes);
    if (buffer.byteLength > length) this.truncated = true;
    if (length === 0) return;
    // Copy only retained bytes: application buffers may be reused after writing.
    this.chunks.push(Buffer.from(buffer.subarray(0, length)));
    this.bytes += length;
  }

  read(): string {
    // Streaming decode omits an unfinished final code point instead of inventing
    // a replacement character when the byte cap falls inside UTF8.
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    const text = decoder.decode(Buffer.concat(this.chunks, this.bytes), {
      stream: true,
    });
    if (decoder.decode() !== "") this.truncated = true;
    if (Buffer.byteLength(text, "utf8") <= this.cap) return text;
    // Invalid input bytes can expand into three-byte replacement characters.
    const bounded = Buffer.from(text).subarray(0, this.cap);
    this.truncated = true;
    return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bounded, {
      stream: true,
    });
  }
}
