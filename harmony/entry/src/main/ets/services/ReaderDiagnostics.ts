// SPDX-License-Identifier: GPL-3.0-only
// 有界脱敏 Reader Kit 诊断记录：仅写事件阶段和错误码，不写书籍或设备信息。
import { common } from '@kit.AbilityKit';
import { fileIo, picker } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';

const FILE_NAME = 'reader-diagnostics.jsonl';
const MAX_LINES = 256;
const MAX_BYTES = 96 * 1024;

interface DiagnosticRecord {
  at: number;
  event: string;
  stage: string;
  code: number;
}

export function recordReaderDiagnostic(context: common.UIAbilityContext,
  event: string, stage: string, code?: number): void {
  try {
    const path = context.filesDir + '/' + FILE_NAME;
    const lines = readLines(path);
    const record: DiagnosticRecord = {
      at: Date.now(),
      event: safeLabel(event),
      stage: safeLabel(stage),
      code: typeof code === 'number' && Number.isFinite(code) ?
        Math.trunc(code) : 0
    };
    lines.push(JSON.stringify(record));
    while (lines.length > MAX_LINES ||
        byteLength(lines.join('\n')) > MAX_BYTES) {
      lines.shift();
    }
    writeText(path, lines.join('\n') + (lines.length > 0 ? '\n' : ''));
  } catch (error) {
    // Diagnostics must never block importing, reading, or transfer.
  }
}

export async function exportReaderDiagnostics(
  context: common.UIAbilityContext): Promise<boolean> {
  const source = context.filesDir + '/' + FILE_NAME;
  const lines = readLines(source);
  const content = lines.join('\n') + (lines.length > 0 ? '\n' : '');
  const pickerView = new picker.DocumentViewPicker(context);
  const options = new picker.DocumentSaveOptions();
  options.newFileNames = ['suyue-reader-diagnostics.jsonl'];
  options.fileSuffixChoices = ['JSON Lines|jsonl'];
  const uris = await pickerView.save(options);
  if (uris.length === 0) return false;
  const file = fileIo.openSync(uris[0], fileIo.OpenMode.READ_WRITE |
    fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
  try {
    fileIo.writeSync(file.fd, new util.TextEncoder().encode(content).buffer);
  } finally {
    fileIo.closeSync(file.fd);
  }
  return true;
}

function safeLabel(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 48);
}

function readLines(path: string): string[] {
  try {
    const file = fileIo.openSync(path, fileIo.OpenMode.READ_ONLY);
    try {
      const stat = fileIo.statSync(path);
      const buffer = new ArrayBuffer(Math.min(stat.size, MAX_BYTES));
      fileIo.readSync(file.fd, buffer);
      const text = new util.TextDecoder().decodeToString(new Uint8Array(buffer));
      return text.split('\n').filter((line) => line.length > 0)
        .slice(-MAX_LINES);
    } finally {
      fileIo.closeSync(file.fd);
    }
  } catch (error) {
    return [];
  }
}

function writeText(path: string, text: string): void {
  const file = fileIo.openSync(path, fileIo.OpenMode.READ_WRITE |
    fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
  try {
    fileIo.writeSync(file.fd, new util.TextEncoder().encode(text).buffer);
  } finally {
    fileIo.closeSync(file.fd);
  }
}

function byteLength(text: string): number {
  return new util.TextEncoder().encode(text).length;
}
