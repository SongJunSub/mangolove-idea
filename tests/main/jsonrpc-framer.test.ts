import { describe, it, expect } from 'vitest';
import { encodeMessage, JsonRpcReader } from '../../src/main/lsp/jsonrpc-framer';

describe('jsonrpc-framer', () => {
  it('encodeMessage uses the BYTE length, not the char length (multibyte body)', () => {
    const buf = encodeMessage({ s: '한글' }); // 한글 = 6 utf-8 bytes
    const text = buf.toString('utf8');
    const body = JSON.stringify({ s: '한글' });
    expect(text).toBe(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  });

  it('round-trips a single message', () => {
    const r = new JsonRpcReader();
    const msgs = r.append(encodeMessage({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
    expect(msgs).toEqual([{ jsonrpc: '2.0', id: 1, result: { ok: true } }]);
  });

  it('reassembles a message whose header AND body are split across chunks', () => {
    const full = encodeMessage({ id: 7, method: 'x' });
    const r = new JsonRpcReader();
    // split mid-header, then mid-body
    const a = full.subarray(0, 8);
    const b = full.subarray(8, 20);
    const c = full.subarray(20);
    expect(r.append(a)).toEqual([]);
    expect(r.append(b)).toEqual([]);
    expect(r.append(c)).toEqual([{ id: 7, method: 'x' }]);
  });

  it('does NOT corrupt a multibyte body split across a chunk boundary', () => {
    const full = encodeMessage({ text: 'café—한글' });
    const mid = Math.floor(full.length / 2);
    const r = new JsonRpcReader();
    r.append(full.subarray(0, mid));
    const msgs = r.append(full.subarray(mid));
    expect(msgs).toEqual([{ text: 'café—한글' }]);
  });

  it('returns multiple messages delivered in one chunk', () => {
    const r = new JsonRpcReader();
    const both = Buffer.concat([encodeMessage({ id: 1 }), encodeMessage({ id: 2 })]);
    expect(r.append(both)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('resyncs past a malformed (no Content-Length) header block', () => {
    const r = new JsonRpcReader();
    const junk = Buffer.from('Garbage: 1\r\n\r\n', 'ascii');
    const good = encodeMessage({ id: 9 });
    expect(r.append(Buffer.concat([junk, good]))).toEqual([{ id: 9 }]);
  });
});
