// SPDX-License-Identifier: GPL-3.0-only
// 手机侧传输模型：进度、传输 ID 与错误码。
// 错误码与 protocol v0 对齐。
import { BookMeta } from './BookModels';

export enum TransferState {
  IDLE = 'idle',
  CONNECTING = 'connecting',
  SENDING = 'sending',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
  CANCELLED = 'cancelled'
}

export interface TransferProgress {
  transferId: string;
  bookId: string;
  title: string;
  state: TransferState;
  // transferFile 回调上报的进度 0~100。
  percent: number;
  message: string;
  error?: string;
  phase?: string;
  sdkCode?: number;
}

export interface TargetDevice {
  // Wear Engine 设备标识（randomId），
  // 不从文件名或 MAC 拼出设备身份。
  randomId: string;
  name: string;
}

// 与 protocol README 的错误码表一致。
export type TransferErrorCode =
  | 'E_UNSUPPORTED_FORMAT'
  | 'E_DECODE'
  | 'E_SPACE'
  | 'E_TIMEOUT'
  | 'E_DIGEST_MISMATCH'
  | 'E_MISSING_CHUNKS'
  | 'E_DUPLICATE_TRANSFER'
  | 'E_CANCELLED'
  | 'E_PEER_UNAVAILABLE'
  // 单本互斥：已有传输在途（第二轮 P0-2）。
  | 'E_BUSY'
  | 'E_PROTOCOL'
  | 'E_CHAPTER_TOO_LARGE';

export function newTransferId(): string {
  // 16 字节随机十六进制；不依赖 crypto.getRandomValues
  // 在所有目标系统的可用性（待验证时用 Math.random
  // 兜底仅用于 UI 展示，正式环境应替换）。
  let id = '';
  const random = Math.random;
  for (let i = 0; i < 32; i++) {
    id += Math.floor(random() * 16).toString(16);
  }
  return id;
}

export function initialProgress(book: BookMeta,
  transferId: string): TransferProgress {
  return {
    transferId,
    bookId: book.bookId,
    title: book.title,
    state: TransferState.IDLE,
    percent: 0,
    message: '待发送'
  };
}
