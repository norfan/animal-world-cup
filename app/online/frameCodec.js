"use client";

const MAGIC = 0xac;
const VERSION = 1;

class BinaryWriter {
  constructor(size = 4096) {
    this.buffer = new ArrayBuffer(size);
    this.view = new DataView(this.buffer);
    this.offset = 0;
  }

  ensure(bytes) {
    if (this.offset + bytes <= this.buffer.byteLength) return;
    let size = this.buffer.byteLength;
    while (size < this.offset + bytes) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(new Uint8Array(this.buffer, 0, this.offset));
    this.buffer = next;
    this.view = new DataView(next);
  }

  write(method, bytes, value) {
    this.ensure(bytes);
    const at = this.offset;
    this.view[method](at, value);
    this.offset += bytes;
    return at;
  }

  setUint8(value) { return this.write("setUint8", 1, value); }
  setInt8(value) { return this.write("setInt8", 1, value); }
  setUint16(value) { return this.write("setUint16", 2, value); }
  setInt16(value) { return this.write("setInt16", 2, value); }
  setUint32(value) { return this.write("setUint32", 4, value >>> 0); }
  setFloat32(value) { return this.write("setFloat32", 4, Number(value) || 0); }
  setFlags(...values) {
    let flags = 0;
    for (let index = 0; index < values.length && index < 8; index += 1) {
      if (values[index]) flags |= 1 << index;
    }
    return this.setUint8(flags);
  }
  setNormal(value) { return this.setFloat32(value); }
  setVector2(value) { this.setFloat32(value.x); this.setFloat32(value.y); }
  setVector2Normal(value) { this.setFloat32(value.x); this.setFloat32(value.y); }
  setVector2Quantized16(scale, value) {
    this.setInt16(Math.round(value.x * scale));
    this.setInt16(Math.round(value.y * scale));
  }
  setVector3(value) { this.setFloat32(value.x); this.setFloat32(value.y); this.setFloat32(value.z); }
  setVector3Quantized16(scale, value) {
    this.setInt16(Math.round(value.x * scale));
    this.setInt16(Math.round(value.y * scale));
    this.setInt16(Math.round(value.z * scale));
  }
  setRotation16(value) {
    this.setFloat32(value.x);
    this.setFloat32(value.y);
    this.setFloat32(value.z);
    this.setFloat32(value.w);
  }
  finish() { return this.buffer.slice(0, this.offset); }
}

class BinaryReader {
  constructor(buffer) {
    this.buffer = buffer instanceof ArrayBuffer
      ? buffer
      : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    this.view = new DataView(this.buffer);
    this.offset = 0;
  }

  read(method, bytes) {
    if (this.offset + bytes > this.buffer.byteLength) throw new Error("online-frame-truncated");
    const value = this.view[method](this.offset);
    this.offset += bytes;
    return value;
  }

  getUint8() { return this.read("getUint8", 1); }
  getInt8() { return this.read("getInt8", 1); }
  getUint16() { return this.read("getUint16", 2); }
  getInt16() { return this.read("getInt16", 2); }
  getUint32() { return this.read("getUint32", 4); }
  getFloat32() { return this.read("getFloat32", 4); }
  getFlags() { return this.getUint8(); }
  getNormal() { return this.getFloat32(); }
  getVector2(target) { target.x = this.getFloat32(); target.y = this.getFloat32(); return target; }
  getVector2Normal(target) { return this.getVector2(target); }
  getVector2Quantized16(scale, target) {
    target.x = this.getInt16() / scale;
    target.y = this.getInt16() / scale;
    return target;
  }
  getVector3(target) {
    target.x = this.getFloat32();
    target.y = this.getFloat32();
    target.z = this.getFloat32();
    return target;
  }
  getVector3Quantized16(scale, target) {
    target.x = this.getInt16() / scale;
    target.y = this.getInt16() / scale;
    target.z = this.getInt16() / scale;
    return target;
  }
  getRotation16(target) {
    target.x = this.getFloat32();
    target.y = this.getFloat32();
    target.z = this.getFloat32();
    target.w = this.getFloat32();
    return target;
  }
}

function growFrame(frame, playerCount) {
  frame.redTeam._grow(playerCount);
  frame.blueTeam._grow(playerCount);
  return frame;
}

export function encodeMatchFrame(frame, sequence) {
  const writer = new BinaryWriter();
  writer.setUint8(MAGIC);
  writer.setUint8(VERSION);
  writer.setUint32(sequence);
  frame.pack(writer);
  return writer.finish();
}

export class RemoteFrameBuffer {
  constructor(playerCount = 7) {
    const Frame = window.require("net/frame").Frame;
    this.frames = Array.from({ length: 4 }, () => growFrame(new Frame(), playerCount));
    this.display = growFrame(new Frame(), playerCount);
    this.index = 0;
    this.previous = null;
    this.current = null;
    this.sequence = -1;
    this.deliveredSequence = -1;
    this.arrivedAt = 0;
    this.interval = 34;
  }

  push(buffer) {
    const reader = new BinaryReader(buffer);
    if (reader.getUint8() !== MAGIC || reader.getUint8() !== VERSION) return false;
    const sequence = reader.getUint32();
    if (sequence <= this.sequence) return false;
    const now = performance.now();
    if (this.arrivedAt) this.interval = Math.max(20, Math.min(80, now - this.arrivedAt));
    const frame = this.frames[this.index++ % this.frames.length];
    frame.clear();
    frame.unpack(reader);
    this.previous = this.current;
    this.current = frame;
    this.sequence = sequence;
    this.arrivedAt = now;
    return true;
  }

  reset() {
    this.previous = null;
    this.current = null;
    this.sequence = -1;
    this.deliveredSequence = -1;
    this.arrivedAt = 0;
    this.interval = 34;
  }

  read() {
    if (!this.current) return null;
    if (!this.previous) return this.current;
    const alpha = Math.max(0, Math.min(1, (performance.now() - this.arrivedAt) / this.interval));
    this.display.clear();
    this.display.interpolate(this.previous, this.current, alpha);
    if (this.deliveredSequence !== this.sequence && alpha >= 0.45) {
      this.display.merge(this.current);
      this.deliveredSequence = this.sequence;
    }
    return this.display;
  }
}
