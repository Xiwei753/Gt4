// SPDX-License-Identifier: GPL-3.0-only
// Bounded, privacy-preserving reader diagnostics; no book or device data.
import { common } from '@kit.AbilityKit';
import { fileIo, picker } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';

const FILE_NAME = 'reader-diagnostics.jsonl';
const MAX_LINES = 256;
const MAX_BYTES = 96 * 1024;
const FLUSH_DELAY_MS = 0;
const WRITE_RETRY_DELAY_MS = 150;

let pendingLines: string[] = [];
let diagnosticsPath: string = '';
let flushTimer: number = -1;
let flushPromise: Promise<void> | null = null;
let storedLines: string[] = [];
let storedPath: string = '';
let storedNeedsRewrite: boolean = false;
let writeRetryPending: boolean = false;
let nextFlushDelayMs: number = FLUSH_DELAY_MS;

interface DiagnosticRecord {
  at: number;
  event: string;
  stage: string;
  code: number;
  details?: DiagnosticDetails;
}

interface DiagnosticExportErrorCode {
  code?: number;
}

export type ReaderDiagnosticsExportStage =
  'picker' | 'open' | 'write' | 'close' | 'unknown';

export class ReaderDiagnosticsExportError extends Error {
  stage: ReaderDiagnosticsExportStage;
  code: number;

  constructor(stage: ReaderDiagnosticsExportStage, code: number) {
    super('Reader diagnostics export failed');
    this.stage = stage;
    this.code = code;
  }
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
  source?: string;
  reason?: string;
  hitRegion?: string;
  inputXVp?: number;
  inputYVp?: number;
  deltaXVp?: number;
  deltaYVp?: number;
  pageInForeground?: boolean;
  readerReady?: boolean;
  loading?: boolean;
  leaving?: boolean;
  catalogVisible?: boolean;
  settingsVisible?: boolean;
  volumeKeyPaging?: boolean;
  volumeUpRegistered?: boolean;
  volumeDownRegistered?: boolean;
  startByte?: number;
  endByte?: number;
  nextStartByte?: number;
  pageRequestId?: number;
  pageRequestCurrent?: boolean;
  pageTextChanged?: boolean;
  navigationIndicatorRectVp?: { left: number; top: number;
    right: number; bottom: number };
}

export function recordReaderDiagnostic(context: common.UIAbilityContext,
  event: string, stage: string, code?: number,
  details?: DiagnosticDetails): void {
  try {
    diagnosticsPath = context.filesDir + '/' + FILE_NAME;
    const record: DiagnosticRecord = {
      at: Date.now(),
      event: safeLabel(event),
      stage: safeLabel(stage),
      code: typeof code === 'number' && Number.isFinite(code) ?
        Math.trunc(code) : 0,
      details: safeDetails(details)
    };
    if (record.details === undefined) delete record.details;
    pendingLines.push(JSON.stringify(record));
    while (pendingLines.length > MAX_LINES) pendingLines.shift();
    scheduleFlush();
  } catch (error) {
    // Diagnostics must never block importing, reading, or transfer.
  }
}

function scheduleFlush(delayMs: number = FLUSH_DELAY_MS): void {
  if (flushTimer >= 0 || pendingLines.length === 0) return;
  flushTimer = setTimeout(() => {
    flushTimer = -1;
    flushDiagnosticQueue();
  }, delayMs);
}

function flushDiagnosticQueue(): Promise<void> {
  if (flushPromise !== null) return flushPromise;
  if (pendingLines.length === 0 || diagnosticsPath.length === 0) {
    return Promise.resolve();
  }
  flushPromise = writeQueuedLines().finally(() => {
    flushPromise = null;
    const delayMs = nextFlushDelayMs;
    nextFlushDelayMs = FLUSH_DELAY_MS;
    if (pendingLines.length > 0) scheduleFlush(delayMs);
  });
  return flushPromise;
}

async function writeQueuedLines(): Promise<void> {
  const path = diagnosticsPath;
  const batch = pendingLines.splice(0, pendingLines.length);
  try {
    if (storedPath !== path) {
      const loaded = await readStoredLines(path);
      storedPath = path;
      storedLines = loaded.lines;
      storedNeedsRewrite = loaded.trimmed || loaded.readFailed;
    }

    const combined = storedLines.concat(batch);
    const retained = retainBoundedLines(combined);
    const rewrite = storedNeedsRewrite || retained.trimmed;
    if (rewrite) await replaceText(path, serializeLines(retained.lines));
    else await appendText(path, serializeLines(batch));
    storedLines = retained.lines;
    storedNeedsRewrite = false;
    writeRetryPending = false;
  } catch (error) {
    if (!writeRetryPending) {
      writeRetryPending = true;
      pendingLines = batch.concat(pendingLines).slice(-MAX_LINES);
      nextFlushDelayMs = WRITE_RETRY_DELAY_MS;
    } else {
      // Drop a batch only after its single best-effort retry also fails.
      writeRetryPending = false;
    }
  }
}

async function readStoredLines(path: string): Promise<{
  lines: string[]; trimmed: boolean; readFailed: boolean
}> {
  try {
    const content = await fileIo.readText(path);
    const lines = content.split('\n').filter((line) => line.length > 0);
    const retained = retainBoundedLines(lines);
    return { lines: retained.lines, trimmed: retained.trimmed,
      readFailed: false };
  } catch (error) {
    return { lines: [], trimmed: false, readFailed: true };
  }
}

function retainBoundedLines(lines: string[]): {
  lines: string[]; trimmed: boolean
} {
  const retained = lines.slice();
  let bytes = 0;
  for (let i = 0; i < retained.length; i++) {
    bytes += byteLength(retained[i]) + 1;
  }
  let trimmed = false;
  while (retained.length > MAX_LINES || bytes > MAX_BYTES) {
    const removed = retained.shift();
    if (removed !== undefined) bytes -= byteLength(removed) + 1;
    trimmed = true;
  }
  return { lines: retained, trimmed };
}

function serializeLines(lines: string[]): string {
  return lines.length > 0 ? lines.join('\n') + '\n' : '';
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
  if (isSafeLabel(details.source)) out.source = details.source;
  if (isSafeLabel(details.reason)) out.reason = details.reason;
  if (isSafeLabel(details.hitRegion)) out.hitRegion = details.hitRegion;
  if (isSafeMetric(details.inputXVp)) out.inputXVp = roundMetric(details.inputXVp);
  if (isSafeMetric(details.inputYVp)) out.inputYVp = roundMetric(details.inputYVp);
  if (isSafeMetric(details.deltaXVp)) out.deltaXVp = roundMetric(details.deltaXVp);
  if (isSafeMetric(details.deltaYVp)) out.deltaYVp = roundMetric(details.deltaYVp);
  if (typeof details.pageInForeground === 'boolean') {
    out.pageInForeground = details.pageInForeground;
  }
  if (typeof details.readerReady === 'boolean') out.readerReady = details.readerReady;
  if (typeof details.loading === 'boolean') out.loading = details.loading;
  if (typeof details.leaving === 'boolean') out.leaving = details.leaving;
  if (typeof details.catalogVisible === 'boolean') {
    out.catalogVisible = details.catalogVisible;
  }
  if (typeof details.settingsVisible === 'boolean') {
    out.settingsVisible = details.settingsVisible;
  }
  if (typeof details.volumeKeyPaging === 'boolean') {
    out.volumeKeyPaging = details.volumeKeyPaging;
  }
  if (typeof details.volumeUpRegistered === 'boolean') {
    out.volumeUpRegistered = details.volumeUpRegistered;
  }
  if (typeof details.volumeDownRegistered === 'boolean') {
    out.volumeDownRegistered = details.volumeDownRegistered;
  }
  if (isSafeByteOffset(details.startByte)) out.startByte = details.startByte;
  if (isSafeByteOffset(details.endByte)) out.endByte = details.endByte;
  if (isSafeByteOffset(details.nextStartByte)) {
    out.nextStartByte = details.nextStartByte;
  }
  if (isSafeByteOffset(details.pageRequestId)) {
    out.pageRequestId = details.pageRequestId;
  }
  if (typeof details.pageRequestCurrent === 'boolean') {
    out.pageRequestCurrent = details.pageRequestCurrent;
  }
  if (typeof details.pageTextChanged === 'boolean') {
    out.pageTextChanged = details.pageTextChanged;
  }
  if (details.navigationIndicatorRectVp !== undefined) {
    const rect = details.navigationIndicatorRectVp;
    if (isSafeMetric(rect.left) && isSafeMetric(rect.top) &&
        isSafeMetric(rect.right) && isSafeMetric(rect.bottom)) {
      out.navigationIndicatorRectVp = {
        left: roundMetric(rect.left), top: roundMetric(rect.top),
        right: roundMetric(rect.right), bottom: roundMetric(rect.bottom)
      };
    }
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

function isSafeByteOffset(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSafeLabel(value: string | undefined): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9._-]{1,48}$/.test(value);
}

function roundMetric(value: number): number {
  return Math.round(value * 10) / 10;
}

export async function exportReaderDiagnostics(
  context: common.UIAbilityContext): Promise<boolean> {
  const source = context.filesDir + '/' + FILE_NAME;
  if (flushTimer >= 0) {
    clearTimeout(flushTimer);
    flushTimer = -1;
  }
  while (pendingLines.length > 0 || flushPromise !== null) {
    await flushDiagnosticQueue();
  }
  let content = '';
  try {
    content = serializeLines((await readStoredLines(source)).lines);
  } catch (error) {
    // Export an empty diagnostic file if the log is not available.
  }
  const pickerView = new picker.DocumentViewPicker(context);
  const options = new picker.DocumentSaveOptions();
  options.newFileNames = ['suyue-reader-diagnostics.jsonl'];
  let uris: string[];
  try {
    uris = await pickerView.save(options);
  } catch (error) {
    throw new ReaderDiagnosticsExportError('picker', exportErrorCode(error));
  }
  if (uris.length === 0) return false;

  let file: fileIo.File;
  try {
    file = fileIo.openSync(uris[0], fileIo.OpenMode.READ_WRITE);
  } catch (error) {
    throw new ReaderDiagnosticsExportError('open', exportErrorCode(error));
  }

  let writeFailure: ReaderDiagnosticsExportError | null = null;
  const expectedBytes = byteLength(content);
  try {
    if (expectedBytes > 0) {
      const written = fileIo.writeSync(file.fd, content);
      if (written !== expectedBytes) {
        writeFailure = new ReaderDiagnosticsExportError('write', 0);
      }
    }
  } catch (error) {
    writeFailure = new ReaderDiagnosticsExportError('write',
      exportErrorCode(error));
  }

  let closeFailure: ReaderDiagnosticsExportError | null = null;
  try {
    fileIo.closeSync(file.fd);
  } catch (error) {
    closeFailure = new ReaderDiagnosticsExportError('close',
      exportErrorCode(error));
  }
  if (writeFailure !== null) throw writeFailure;
  if (closeFailure !== null) throw closeFailure;
  return true;
}

function exportErrorCode(error: Object): number {
  const value = error as DiagnosticExportErrorCode;
  return typeof value.code === 'number' && Number.isFinite(value.code) ?
    Math.trunc(value.code) : 0;
}

function safeLabel(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 48);
}

async function appendText(path: string, text: string): Promise<void> {
  const file = await fileIo.open(path, fileIo.OpenMode.WRITE_ONLY |
    fileIo.OpenMode.CREATE | fileIo.OpenMode.APPEND);
  try {
    await fileIo.write(file.fd, text);
  } finally {
    try {
      await fileIo.close(file.fd);
    } catch (error) {
      // Closing is best-effort after the write has completed.
    }
  }
}

async function replaceText(path: string, text: string): Promise<void> {
  const file = await fileIo.open(path, fileIo.OpenMode.WRITE_ONLY |
    fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
  try {
    if (text.length > 0) await fileIo.write(file.fd, text);
  } finally {
    try {
      await fileIo.close(file.fd);
    } catch (error) {
      // Closing is best-effort after the write has completed.
    }
  }
}

function byteLength(text: string): number {
  return new util.TextEncoder().encode(text).length;
}
