// SPDX-License-Identifier: GPL-3.0-only
// 手机侧传输模型：进度、传输 ID、重试状态与
// 错误码。错误码与 protocol v0 对齐。
import { BookMeta } from './BookModels';

export enum TransferState {
  IDLE = 'idle',
  CONNECTING = 'connecting',
  SENDING = 'sending',
  WAITING_RESULT = 'waiting_result',
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

// One user tap means one transmission attempt. Another tap is required after failure.
export const MAX_RETRY = 0;
// 回执超时：上传完成后等待手表 RESULT 的时间
// （第二轮 P0-3：不再把上传时长计入）。
export const RESULT_TIMEOUT_MS = 60000;
// 上传超时：设备检查 + HELLO + BOOK_META +
// 文件通道传输的总时长上限。
export const UPLOAD_TIMEOUT_MS = 300000;

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
