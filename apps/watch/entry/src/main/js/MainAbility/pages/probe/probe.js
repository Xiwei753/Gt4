// SPDX-License-Identifier: GPL-3.0-only
// 文件自检页（issue #9 A6）：把 @system.file 每个操作的
// 真实结果（成功 / 错误码 / 无回调超时）显示在圆屏上，
// 供无 HiLog 的真机排查使用。只读展示，不写业务数据。
import router from '@system.router';
import { runFileProbe, formatProbe } from '../../storage/WatchFileProbe';

export default {
  data: {
    title: '文件自检',
    summary: '点击下方按钮开始',
    rows: [],
    running: false
  },
  onInit() {
    this.probeDone = false;
  },
  runProbe() {
    if (this.running) return;
    this.running = true;
    this.summary = '正在自检…';
    this.rows = [];
    runFileProbe((report) => {
      this.running = false;
      this.probeDone = true;
      this.summary = formatProbe(report);
      this.rows = report.map((r) => ({
        name: r.name,
        result: r.ok ? '通过' : '失败',
        detail: r.ok ? ((r.code ? r.code : '') + '') :
          ('code=' + r.code + (r.note ? ' ' + r.note : '')),
        ok: r.ok
      }));
    });
  },
  backToLibrary() {
    router.back();
  }
};
