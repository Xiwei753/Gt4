// SPDX-License-Identifier: GPL-3.0-only
import { beginReceive, stopReceive } from './wear/WearReceiver';

export default {
  onCreate() {
    console.info('GT4 Reader: app created');
    // Keep the single Wear Engine subscription alive across route changes,
    // including cold-start resume directly into the reader.
    beginReceive();
  },
  onDestroy() {
    stopReceive();
    console.info('GT4 Reader: app destroyed');
  }
};
