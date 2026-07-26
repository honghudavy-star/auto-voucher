import test from "node:test";
import assert from "node:assert/strict";

import { saveState } from "../src/store.js";

test("状态保存失败会通知界面、拒绝调用方并允许后续保存继续", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalCustomEvent = globalThis.CustomEvent;
  const events = [];
  let requests = 0;

  globalThis.CustomEvent = class {
    constructor(type, options) {
      this.type = type;
      this.detail = options?.detail;
    }
  };
  globalThis.window = {
    dispatchEvent(event) {
      events.push(event);
    },
  };
  globalThis.fetch = async () => {
    requests += 1;
    if (requests === 1) {
      return {
        ok: false,
        status: 500,
        headers: { get: () => "REQ-SAVE-1" },
        json: async () => ({ error: "保存失败", correlationId: "REQ-SAVE-1" }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => "" },
      json: async () => ({ state: { version: 2 } }),
    };
  };

  try {
    await assert.rejects(
      saveState({ version: 2, auditLog: [], sourceDocuments: [], events: [], vouchers: [], exceptions: [], rules: [], connectors: [] }),
      /保存失败.*REQ-SAVE-1/,
    );
    await saveState({ version: 2, auditLog: [], sourceDocuments: [], events: [], vouchers: [], exceptions: [], rules: [], connectors: [] });
    assert.equal(requests, 2);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "auto-voucher:sync-error");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
    globalThis.CustomEvent = originalCustomEvent;
  }
});
