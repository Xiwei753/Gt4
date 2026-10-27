// SPDX-License-Identifier: GPL-3.0-only
// 表冠输入：把隐藏 slider 的旋转事件换算成翻页步进。
//
// 机制来源（MIT，见 third_party/NOTICE.md）：
//   Explore-In-HMOS-Wearable/sportwatch-how-to-use-crown
//   entry/src/main/js/MainAbility/pages/index.hml —— 放一个
//   1×1 透明的 <slider ref="crownProxy">；
//   index.js —— 用 this.$refs.crownProxy.rotation({focus:true})
//   抢占表冠焦点，旋转以 onchange 的 e.value 回调返回。
//   上游示例只用它做 0..6 的离散选择；本文件把它扩展成
//   可累积的翻页步进。
//
// 明确未验证的部分（不伪造“已支持”）：
//   1. GT4 46mm 真实固件是否产生旋转事件、`rotation()` 是否
//      被 Lite SDK 接受，只能靠真机日志确认；
//   2. 每页需要转多少格（STEPS_PER_PAGE）必须按真机手感标定。
//   本文件只负责换算，是否可用由阅读页在设备上实测后写入文档。

// 一个完整旋转行程（slider 的 max-min）映射到几格。
// 上游示例用 0..6（7 个档位）做选择，这里沿用同一档位数量，
// 并保留常量便于真机标定后调整。
export var CROWN_RANGE = 6;

// 积累多少格才翻一页。真机标定前先取 1（转 1 格翻 1 页）。
export var STEPS_PER_PAGE = 1;

// 把 slider 的绝对档位换算成相对翻页：
//   旋转会让 value 在 0..CROWN_RANGE 之间移动；
//   到达两端的反向旋转会被 clamp 丢掉，因此换算必须
//   基于「与上次档位之差的累积」，而不是绝对档位。
export function createCrownTracker(options) {
  var range = (options && options.range) ||
    CROWN_RANGE;
  var stepsPerPage = (options && options.stepsPerPage) ||
    STEPS_PER_PAGE;
  var lastValue = null;
  var accumulated = 0;
  var events = 0;
  return {
    // 返回本次应翻的页数：正数向后、负数向前，0 表示不够一格。
    push: function (value) {
      var next = Number(value);
      if (!isFinite(next)) return 0;
      next = Math.floor(next);
      events += 1;
      if (lastValue === null) {
        lastValue = next;
        return 0;
      }
      var delta = next - lastValue;
      lastValue = next;
      if (delta === 0) return 0;
      // 单次事件不可能是整程跳变（真机上若出现说明读数异常），
      // 丢弃该次以避免一次翻掉几十页。
      if (delta > range || delta < -range) return 0;
      accumulated += delta;
      var pages = 0;
      while (accumulated >= stepsPerPage) {
        accumulated -= stepsPerPage;
        pages += 1;
      }
      while (accumulated <= -stepsPerPage) {
        accumulated += stepsPerPage;
        pages -= 1;
      }
      return pages;
    },
    // 当前累计到多少格（未满一页的部分保留）。
    pending: function () {
      return accumulated;
    },
    // 是否真的收到过旋转事件：只有真机日志能证明。
    eventCount: function () {
      return events;
    },
    reset: function () {
      lastValue = null;
      accumulated = 0;
      events = 0;
    }
  };
}

// 阅读页是否启用表冠入口。隐藏 slider 已写入 reader.hml，
// 但**旋转事件在 GT4 真机上是否送达尚未验证**，所以这里返回
// 'unverified'：阅读页据此仍显示触屏翻页提示，不宣称表冠可用。
export function crownStatus() {
  return 'unverified';
}
