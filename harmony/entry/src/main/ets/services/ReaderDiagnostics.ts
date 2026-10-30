// SPDX-License-Identifier: GPL-3.0-only
// Bounded, privacy-preserving reader diagnostics; no book or device data.
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
  details?: DiagnosticDetails;
}

export interface DiagnosticDetails {
  fullScreen?: boolean;
  theme?: string;
  statusBarColor?: string;
  navigationBarColor?: string;
  statusBarLightIcon?: boolean;
  navigationBarLightIcon?: boolean;
  topInsetVp?: number;
  bottomInsetVp?: number;
  leftInsetVp?: number;
  rightInsetVp?: number;
  windowWidthVp?: number;
  windowHeightVp?: number;
  statusBarHeightVp?: number;
  cutoutCount?: number;
  cutoutGeometryAvailable?: boolean;
  cutoutRectsVp?: Array<{ left: number; top: number; right: number; bottom: number }>;
  readerXVp?: number;
  readerYVp?: number;
  readerWidthVp?: number;
  readerHeightVp?: number;
  readerXPx?: number;
  readerYPx?: number;
  readerWidthPx?: number;
  readerHeightPx?: number;
  pageViewportWidthPx?: number;
  pageViewportHeightPx?: number;
}

export function recordReaderDiagnostic(context: common.UIAbilityContext,
  event: string, stage: string, code?: number,
  details?: DiagnosticDetails): void {
  try {
    const path = context.filesDir + '/' + FILE_NAME;
    const lines = readLines(path);
    const record: DiagnosticRecord = {
      at: Date.now(),
      event: safeLabel(event),
      stage: safeLabel(stage),
      code: typeof code === 'number' && Number.isFinite(code) ?
        Math.trunc(code) : 0,
      details: safeDetails(details)
    };
    if (record.details === undefined) delete record.details;
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

function safeDetails(details: DiagnosticDetails | undefined):
  DiagnosticDetails | undefined {
  if (details === undefined) return undefined;
  const out: DiagnosticDetails = {};
  if (typeof details.fullScreen === 'boolean') {
    out.fullScreen = details.fullScreen;
  }
  if (details.theme === 'system' || details.theme === 'light' ||
      details.theme === 'dark') out.theme = details.theme;
  if (isSafeColor(details.statusBarColor)) {
    out.statusBarColor = details.statusBarColor;
  }
  if (isSafeColor(details.navigationBarColor)) {
    out.navigationBarColor = details.navigationBarColor;
  }
  if (typeof details.statusBarLightIcon === 'boolean') {
    out.statusBarLightIcon = details.statusBarLightIcon;
  }
  if (typeof details.navigationBarLightIcon === 'boolean') {
    out.navigationBarLightIcon = details.navigationBarLightIcon;
  }
  if (isSafeInset(details.topInsetVp)) {
    out.topInsetVp = Math.round(details.topInsetVp * 10) / 10;
  }
  if (isSafeInset(details.bottomInsetVp)) {
    out.bottomInsetVp = Math.round(details.bottomInsetVp * 10) / 10;
  }
  if (isSafeInset(details.leftInsetVp)) {
    out.leftInsetVp = Math.round(details.leftInsetVp * 10) / 10;
  }
  if (isSafeInset(details.rightInsetVp)) {
    out.rightInsetVp = Math.round(details.rightInsetVp * 10) / 10;
  }
  if (isSafeMetric(details.windowWidthVp)) out.windowWidthVp = roundMetric(details.windowWidthVp);
  if (isSafeMetric(details.windowHeightVp)) out.windowHeightVp = roundMetric(details.windowHeightVp);
  if (isSafeMetric(details.statusBarHeightVp)) out.statusBarHeightVp = roundMetric(details.statusBarHeightVp);
  if (typeof details.cutoutCount === 'number' &&
      Number.isInteger(details.cutoutCount) && details.cutoutCount >= 0) {
    out.cutoutCount = details.cutoutCount;
  }
  if (typeof details.cutoutGeometryAvailable === 'boolean') {
    out.cutoutGeometryAvailable = details.cutoutGeometryAvailable;
  }
  if (details.cutoutRectsVp !== undefined) {
    const rects: Array<{ left: number; top: number; right: number; bottom: number }> = [];
    for (let i = 0; i < details.cutoutRectsVp.length && i < 12; i++) {
      const rect = details.cutoutRectsVp[i];
      if (!isSafeMetric(rect.left) || !isSafeMetric(rect.top) ||
          !isSafeMetric(rect.right) || !isSafeMetric(rect.bottom)) continue;
      rects.push({ left: roundMetric(rect.left), top: roundMetric(rect.top),
        right: roundMetric(rect.right), bottom: roundMetric(rect.bottom) });
    }
    out.cutoutRectsVp = rects;
  }
  if (isSafeMetric(details.readerXVp)) out.readerXVp = roundMetric(details.readerXVp);
  if (isSafeMetric(details.readerYVp)) out.readerYVp = roundMetric(details.readerYVp);
  if (isSafeMetric(details.readerWidthVp)) out.readerWidthVp = roundMetric(details.readerWidthVp);
  if (isSafeMetric(details.readerHeightVp)) out.readerHeightVp = roundMetric(details.readerHeightVp);
  if (isSafeMetric(details.readerXPx)) out.readerXPx = roundMetric(details.readerXPx);
  if (isSafeMetric(details.readerYPx)) out.readerYPx = roundMetric(details.readerYPx);
  if (isSafeMetric(details.readerWidthPx)) out.readerWidthPx = roundMetric(details.readerWidthPx);
  if (isSafeMetric(details.readerHeightPx)) out.readerHeightPx = roundMetric(details.readerHeightPx);
  if (isSafeMetric(details.pageViewportWidthPx)) {
    out.pageViewportWidthPx = roundMetric(details.pageViewportWidthPx);
  }
  if (isSafeMetric(details.pageViewportHeightPx)) {
    out.pageViewportHeightPx = roundMetric(details.pageViewportHeightPx);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function isSafeColor(value: string | undefined): boolean {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value);
}

function isSafeInset(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isSafeMetric(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) &&
    Math.abs(value) <= 100000;
}

function roundMetric(value: number): number {
  return Math.round(value * 10) / 10;
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
