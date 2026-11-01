// SPDX-License-Identifier: GPL-3.0-only
// Imports user-selected TTF/OTF files into the app sandbox. The selected
// document URI is used only during the import and is never persisted.
import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';

export interface ImportedReaderFont {
  id: string;
  name: string;
  extension: string;
}

const MAX_FONT_BYTES = 32 * 1024 * 1024;
const COPY_WINDOW_BYTES = 64 * 1024;

export function readerFontFamily(fontId: string): string {
  return fontId === 'system' ? 'HarmonyOS Sans' : 'SuyueReader_' + fontId;
}

export class ReaderFontService {
  private context: common.UIAbilityContext;

  constructor(context: common.UIAbilityContext) {
    this.context = context;
  }

  async importFont(uri: string): Promise<ImportedReaderFont> {
    const extension = this.extensionOf(uri);
    if (!extension) throw new Error('请选择 TTF 或 OTF 字体文件');
    const name = this.displayName(uri, extension);
    const id = 'f_' + Date.now().toString(36) + '_' +
      Math.floor(Math.random() * 0xFFFFFF).toString(36);
    const directory = this.directory();
    try {
      fileIo.mkdirSync(directory, true);
    } catch (error) {
      if (!fileIo.accessSync(directory)) throw error;
    }
    const finalPath = directory + '/' + id + '.' + extension;
    const tempPath = finalPath + '.tmp';
    let inputFd = -1;
    let outputFd = -1;
    let copied = 0;
    const header = new Uint8Array(4);
    try {
      inputFd = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY).fd;
      outputFd = fileIo.openSync(tempPath,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE |
        fileIo.OpenMode.TRUNC).fd;
      for (;;) {
        const buffer = new Uint8Array(COPY_WINDOW_BYTES);
        const read = fileIo.readSync(inputFd, buffer.buffer,
          { offset: 0, length: buffer.length });
        if (read <= 0) break;
        copied += read;
        if (copied > MAX_FONT_BYTES) {
          throw new Error('字体文件超过 32 MiB');
        }
        const headerCount = Math.min(4 - Math.min(copied - read, 4), read);
        if (headerCount > 0) {
          const headerStart = Math.min(copied - read, 4);
          header.set(buffer.subarray(0, headerCount), headerStart);
        }
        const written = fileIo.writeSync(outputFd, buffer.buffer,
          { offset: 0, length: read });
        if (written !== read) throw new Error('字体文件复制不完整');
      }
      if (copied < 4 || !this.validHeader(header)) {
        throw new Error('字体文件格式无效或与扩展名不匹配');
      }
      fileIo.closeSync(inputFd);
      inputFd = -1;
      fileIo.closeSync(outputFd);
      outputFd = -1;
      fileIo.renameSync(tempPath, finalPath);
      return { id: id, name: name, extension: extension };
    } catch (error) {
      if (inputFd >= 0) fileIo.closeSync(inputFd);
      if (outputFd >= 0) fileIo.closeSync(outputFd);
      try { fileIo.unlinkSync(tempPath); } catch (cleanupError) {}
      try { fileIo.unlinkSync(finalPath); } catch (cleanupError) {}
      throw error;
    }
  }

  pathFor(font: ImportedReaderFont): string {
    return this.directory() + '/' + font.id + '.' + font.extension;
  }

  isAvailable(font: ImportedReaderFont): boolean {
    try {
      const path = this.pathFor(font);
      const stat = fileIo.statSync(path);
      return stat.size >= 4 && stat.size <= MAX_FONT_BYTES;
    } catch (error) {
      return false;
    }
  }

  private directory(): string {
    return this.context.filesDir + '/reader-fonts';
  }

  private extensionOf(uri: string): string {
    const path = decodeURIComponent(uri.split('?')[0]).toLowerCase();
    if (path.endsWith('.ttf')) return 'ttf';
    if (path.endsWith('.otf')) return 'otf';
    return '';
  }

  private displayName(uri: string, extension: string): string {
    const path = decodeURIComponent(uri.split('?')[0]);
    const parts = path.split('/');
    let name = parts[parts.length - 1] || '本地字体.' + extension;
    name = name.replace(/\.(ttf|otf)$/i, '').replace(/[\u0000-\u001f]/g, '');
    if (name.length > 48) name = name.substring(0, 48);
    return name.length > 0 ? name : '本地字体';
  }

  private validHeader(header: Uint8Array): boolean {
    const signature = String.fromCharCode(header[0], header[1],
      header[2], header[3]);
    return signature === '\u0000\u0001\u0000\u0000' ||
      signature === 'true' || signature === 'OTTO';
  }
}
