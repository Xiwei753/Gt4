// SPDX-License-Identifier: GPL-3.0-only
// Bounded random-access reader for the normalized UTF-8 body used by both the
// phone pager and watch sync. It never decodes or retains an entire book.
import { fileIo } from '@kit.CoreFileKit';

export interface TextWindow {
  startByte: number;
  endByte: number;
  text: string;
}

interface DecodedText {
  text: string;
  byteLength: number;
}

function isContinuation(value: number): boolean {
  return (value & 0xc0) === 0x80;
}

function sequenceWidth(first: number): number {
  if (first < 0x80) return 1;
  if ((first & 0xe0) === 0xc0) return 2;
  if ((first & 0xf0) === 0xe0) return 3;
  if ((first & 0xf8) === 0xf0) return 4;
  return 1;
}

function decodeUtf8(bytes: Uint8Array, start: number,
  maxBytes: number): DecodedText {
  const parts: string[] = [];
  let cursor = start;
  const stopAt = Math.min(bytes.length, start + maxBytes);
  while (cursor < stopAt) {
    const first = bytes[cursor];
    const width = sequenceWidth(first);
    if (cursor + width > bytes.length) break;
    let codePoint = first;
    if (width === 2) {
      codePoint = ((first & 0x1f) << 6) | (bytes[cursor + 1] & 0x3f);
    } else if (width === 3) {
      codePoint = ((first & 0x0f) << 12) |
        ((bytes[cursor + 1] & 0x3f) << 6) |
        (bytes[cursor + 2] & 0x3f);
    } else if (width === 4) {
      codePoint = ((first & 0x07) << 18) |
        ((bytes[cursor + 1] & 0x3f) << 12) |
        ((bytes[cursor + 2] & 0x3f) << 6) |
        (bytes[cursor + 3] & 0x3f);
    }
    if (codePoint <= 0xffff) {
      parts.push(String.fromCharCode(codePoint));
    } else {
      const scalar = codePoint - 0x10000;
      parts.push(String.fromCharCode(0xd800 + (scalar >> 10),
        0xdc00 + (scalar & 0x3ff)));
    }
    cursor += width;
  }
  return { text: parts.join(''), byteLength: cursor - start };
}

export class NormalizedTextFile {
  readonly byteLength: number;
  private fd: number;
  private closed: boolean = false;
  private ioQueue: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.byteLength = fileIo.statSync(path).size;
    this.fd = fileIo.openSync(path, fileIo.OpenMode.READ_ONLY).fd;
  }

  async isUtf8Boundary(offset: number): Promise<boolean> {
    if (!Number.isInteger(offset) || offset < 0 || offset > this.byteLength) {
      return false;
    }
    if (offset === 0 || offset === this.byteLength) return true;
    const byte = await this.readBytesAt(offset, 1);
    return byte.length === 1 && !isContinuation(byte[0]);
  }

  async readWindow(startByte: number, maxBytes: number):
    Promise<TextWindow> {
    if (!Number.isInteger(startByte) || startByte < 0 ||
        startByte > this.byteLength || maxBytes < 1) {
      throw new Error('Invalid text window range');
    }
    const bytesToRead = Math.min(this.byteLength - startByte, maxBytes);
    const bytes = await this.readBytesAt(startByte, bytesToRead);
    const decoded = decodeUtf8(bytes, 0, maxBytes);
    return {
      startByte: startByte,
      endByte: startByte + decoded.byteLength,
      text: decoded.text
    };
  }

  async readWindowBefore(endByte: number, maxBytes: number):
    Promise<TextWindow> {
    if (!Number.isInteger(endByte) || endByte < 0 ||
        endByte > this.byteLength || !Number.isInteger(maxBytes) ||
        maxBytes < 1) {
      throw new Error('Invalid preceding text window range');
    }
    const boundedBytes = Math.min(maxBytes, 64 * 1024, endByte);
    if (boundedBytes === 0) {
      return { startByte: 0, endByte: 0, text: '' };
    }
    const rawStartByte = endByte - boundedBytes;
    const bytes = await this.readBytesAt(rawStartByte, boundedBytes);
    if (bytes.length !== boundedBytes) {
      throw new Error('Preceding text window ended before its byte boundary');
    }

    let leadingBytes = 0;
    while (leadingBytes < bytes.length && isContinuation(bytes[leadingBytes])) {
      leadingBytes++;
    }
    if (leadingBytes > 3) {
      throw new Error('Invalid UTF-8 preceding text window');
    }
    const startByte = rawStartByte + leadingBytes;
    const decoded = decodeUtf8(bytes, leadingBytes,
      bytes.length - leadingBytes);
    if (startByte + decoded.byteLength !== endByte) {
      throw new Error('Preceding text window does not end on a UTF-8 boundary');
    }
    return {
      startByte: startByte,
      endByte: endByte,
      text: decoded.text
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const fd = this.fd;
    this.ioQueue = this.ioQueue.then((): void => {
      fileIo.closeSync(fd);
    }).catch((): void => {});
  }

  private readBytesAt(startByte: number,
    length: number): Promise<Uint8Array> {
    if (this.closed) return Promise.reject(new Error('Text file is closed'));
    const fd = this.fd;
    const readTask = this.ioQueue.then(async (): Promise<Uint8Array> => {
      fileIo.lseek(fd, startByte, fileIo.WhenceType.SEEK_SET);
      const buffer = new ArrayBuffer(length);
      const count = await fileIo.read(fd, buffer,
        { offset: 0, length: length });
      return new Uint8Array(buffer, 0, count).slice();
    });
    this.ioQueue = readTask.then((): void => {}, (): void => {});
    return readTask;
  }
}
