/**
 * Hand-rolled `Content-Length` JSON-RPC framing for talking LSP over a child's stdio.
 * Zero dependencies. Works on BYTES (Buffer), never decoded strings, because
 * Content-Length is a BYTE count — decoding to utf-8 first would desync the framing on
 * any multibyte body. The reader is incremental: it tolerates a header or body split
 * across arbitrary stdout chunks.
 */

/** Encodes a JSON-RPC message as a `Content-Length`-framed buffer ready for stdin. */
export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
  return Buffer.concat([header, body]);
}

/**
 * Incremental reader: feed it raw stdout chunks; it returns every COMPLETE message that
 * has fully arrived so far. A partial header or partial body is buffered until the rest
 * comes. Malformed frames are resynced past rather than throwing (a hostile/buggy server
 * must not crash the host).
 */
export class JsonRpcReader {
  private buf: Buffer = Buffer.alloc(0);
  private static readonly SEP = Buffer.from('\r\n\r\n', 'ascii');

  append(chunk: Buffer): unknown[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: unknown[] = [];
    for (;;) {
      const sep = this.buf.indexOf(JsonRpcReader.SEP);
      if (sep === -1) break; // header not complete yet
      const header = this.buf.subarray(0, sep).toString('ascii');
      const m = /content-length:\s*(\d+)/i.exec(header);
      if (!m) {
        // No Content-Length in this header block — drop it and resync.
        this.buf = this.buf.subarray(sep + JsonRpcReader.SEP.length);
        continue;
      }
      const len = Number(m[1]);
      const bodyStart = sep + JsonRpcReader.SEP.length;
      if (this.buf.length < bodyStart + len) break; // body not fully arrived
      const body = this.buf.subarray(bodyStart, bodyStart + len);
      this.buf = this.buf.subarray(bodyStart + len);
      try {
        out.push(JSON.parse(body.toString('utf8')));
      } catch {
        // malformed body — skip it, keep parsing the rest
      }
    }
    return out;
  }
}
