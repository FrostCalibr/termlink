import { describe, it, expect, beforeEach } from "vitest";
import {
  FrameDecoder,
  FrameError,
  encodeFrame,
  type Message,
} from "../../shared/protocol/framing.js";
import { HEADER_SIZE } from "../../shared/protocol/constants.js";

const MAX = 1024 * 1024;

function splitBuffer(buf: Buffer, at: number): [Buffer, Buffer] {
  return [buf.subarray(0, at), buf.subarray(at)];
}

describe("encodeFrame", () => {
  it("prefixes the JSON payload with a 4-byte big-endian length", () => {
    const msg: Message = { type: "ping" };
    const frame = encodeFrame(msg);
    expect(frame.readUInt32BE(0)).toBe(15); // {"type":"ping"}
    expect(frame.subarray(HEADER_SIZE).toString()).toBe('{"type":"ping"}');
  });
});

describe("FrameDecoder", () => {
  let decoder: FrameDecoder;

  beforeEach(() => {
    decoder = new FrameDecoder(MAX);
  });

  it("decodes one complete frame", () => {
    decoder.feed(encodeFrame({ type: "ping" }));
    expect(decoder.read()).toEqual({ type: "ping" });
    expect(decoder.read()).toBeNull();
  });

  it("handles an empty payload", () => {
    decoder.feed(Buffer.from("\0\0\0\0", "binary"));
    expect(() => decoder.read()).toThrow(FrameError);
  });

  it("handles a partial header", () => {
    const frame = encodeFrame({ type: "ping" });
    decoder.feed(frame.subarray(0, 2));
    expect(decoder.read()).toBeNull();
  });

  it("handles a header split across reads", () => {
    const frame = encodeFrame({ type: "ping" });
    const [a, b] = splitBuffer(frame.subarray(0, HEADER_SIZE), 3);
    decoder.feed(a);
    expect(decoder.read()).toBeNull();
    decoder.feed(b);
    decoder.feed(frame.subarray(HEADER_SIZE));
    expect(decoder.read()).toEqual({ type: "ping" });
  });

  it("handles a payload split across reads", () => {
    const frame = encodeFrame({ type: "ping" });
    const [head, tail] = splitBuffer(frame, HEADER_SIZE + 5);
    decoder.feed(head);
    expect(decoder.read()).toBeNull();
    decoder.feed(tail);
    expect(decoder.read()).toEqual({ type: "ping" });
  });

  it("decodes multiple frames from one read", () => {
    const a = encodeFrame({ type: "ping" });
    const b = encodeFrame({ type: "goodbye", reason: "done" });
    decoder.feed(Buffer.concat([a, b]));
    expect(decoder.read()).toEqual({ type: "ping" });
    expect(decoder.read()).toEqual({ type: "goodbye", reason: "done" });
    expect(decoder.read()).toBeNull();
  });

  it("handles multiple frames split across reads", () => {
    const a = encodeFrame({ type: "ping" });
    const b = encodeFrame({ type: "ping" });
    const all = Buffer.concat([a, b]);
    const [part1, part2] = splitBuffer(all, 5);
    decoder.feed(part1);
    expect(decoder.read()).toBeNull();
    decoder.feed(part2);
    expect(decoder.read()).toEqual({ type: "ping" });
    expect(decoder.read()).toEqual({ type: "ping" });
    expect(decoder.read()).toBeNull();
  });

  it("decodes a large valid frame", () => {
    const big = "x".repeat(100_000);
    decoder = new FrameDecoder(200_000);
    decoder.feed(encodeFrame({ type: "data", data: big }));
    const msg = decoder.read();
    expect(msg).toEqual({ type: "data", data: big });
  });

  it("decodes a binary frame carrying base64 data", () => {
    decoder.feed(encodeFrame({ type: "binary", data: "AQIDBQ==" }));
    const msg = decoder.read();
    expect(msg).toEqual({ type: "binary", data: "AQIDBQ==" });
  });

  it("rejects a binary frame with non-string data", () => {
    const header = Buffer.alloc(HEADER_SIZE);
    const payload = Buffer.from('{"type":"binary","data":123}', "utf-8");
    header.writeUInt32BE(payload.length, 0);
    decoder.feed(Buffer.concat([header, payload]));
    expect(() => decoder.read()).toThrow(FrameError);
  });

  it("rejects a binary frame before the wire on oversized length", () => {
    // The wire format is length-prefixed JSON, so base64 data is bounded by
    // maxFrameSize like every other message.
    const header = Buffer.alloc(HEADER_SIZE);
    header.writeUInt32BE(MAX + 1, 0);
    throwAt(decoder, header);
    expect(() => decoder.read()).toThrow(FrameError);
  });

  it("rejects invalid JSON", () => {
    const bad = JSON.stringify({ type: "ping" }).slice(0, 4);
    throwAt(decoder, bad);
    expect(() => decoder.read()).toThrow(FrameError);
  });

  it("rejects an oversized frame without buffering the payload", () => {
    const header = Buffer.alloc(HEADER_SIZE);
    header.writeUInt32BE(MAX + 100, 0);
    throwAt(decoder, header);
    expect(() => decoder.read()).toThrow(FrameError);
    expect(decoder.buffered).toBe(0);
  });

  it("rejects a frame with an absurd length field", () => {
    const header = Buffer.alloc(HEADER_SIZE);
    header.writeUInt32BE(0xffffffff, 0);
    throwAt(decoder, header);
    expect(() => decoder.read()).toThrow(FrameError);
  });

  it("recovers after reset", () => {
    const header = Buffer.alloc(HEADER_SIZE);
    header.writeUInt32BE(MAX + 1, 0);
    throwAt(decoder, header);
    try {
      decoder.read();
    } catch {
      decoder.reset();
    }
    decoder.feed(encodeFrame({ type: "ping" }));
    expect(decoder.read()).toEqual({ type: "ping" });
  });

  it("rejects JSON that does not match the message schema", () => {
    throwAt(decoder, JSON.stringify({ type: "nonsense", value: 1 }));
    expect(() => decoder.read()).toThrow(FrameError);
  });

  it("handles connection ending mid-frame", () => {
    const frame = encodeFrame({ type: "ping" });
    decoder.feed(frame.subarray(0, HEADER_SIZE + 3));
    expect(decoder.read()).toBeNull();
    // No data remaining; read() keeps returning null, never throws
    expect(decoder.read()).toBeNull();
    expect(decoder.buffered).toBeGreaterThan(0);
  });
});

/** Helper: throw raw bytes into the decoder, bypassing the schema
 * validator that catches JSON at read() time. */
function throwAt(decoder: FrameDecoder, bytes: string): void {
  const payload = Buffer.from(bytes, "utf-8");
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt32BE(payload.length, 0);
  decoder.feed(Buffer.concat([header, payload]));
}