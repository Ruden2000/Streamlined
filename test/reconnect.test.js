import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebRTCTransport } from "../src/transport.js";

/* Guards the bug where a signalling socket that dropped AFTER connecting was
   ignored entirely: the device stayed "linked" in the UI while being absent
   from its room, so paired devices showed each other as permanently Offline. */

let sockets;
class MockWS {
  constructor(url) {
    this.url = url;
    this.readyState = 0;           // CONNECTING
    this.sent = [];
    sockets.push(this);
  }
  send(d) { this.sent.push(d); }
  close() { this.readyState = 3; }
  // helpers
  fireOpen() { this.readyState = 1; this.onopen && this.onopen(); }
  fireClose() { this.readyState = 3; this.onclose && this.onclose(); }
}

function makeTransport(onLive) {
  return new WebRTCTransport({
    selfId: "me", room: "room1", signalingUrl: "wss://example.test",
    onLive, iceServers: []
  });
}

beforeEach(() => {
  sockets = [];
  vi.useFakeTimers();
  globalThis.WebSocket = MockWS;
});
afterEach(() => { vi.useRealTimers(); delete globalThis.WebSocket; });

describe("signalling reconnection", () => {
  it("joins the room once the socket opens", () => {
    const t = makeTransport();
    t.start();
    expect(sockets).toHaveLength(1);
    sockets[0].fireOpen();
    const join = JSON.parse(sockets[0].sent[0]);
    expect(join).toMatchObject({ type: "join", room: "room1", id: "me" });
    expect(t.isLive()).toBe(true);
    t.stop();
  });

  it("reconnects after the socket drops post-connection", () => {
    const live = [];
    const t = makeTransport((v) => live.push(v));
    t.start();
    sockets[0].fireOpen();
    expect(live).toEqual([true]);

    sockets[0].fireClose();               // OS suspend / network change
    expect(t.isLive()).toBe(false);
    expect(live).toEqual([true, false]);

    // Just past the first backoff step (~1s) — advancing far enough for a
    // second cycle would tear this socket down again before we open it.
    vi.advanceTimersByTime(1600);
    expect(sockets.length).toBeGreaterThan(1);

    sockets[sockets.length - 1].fireOpen();
    expect(t.isLive()).toBe(true);
    expect(live[live.length - 1]).toBe(true);
    t.stop();
  });

  it("resume() retries immediately instead of waiting out the backoff", () => {
    const t = makeTransport();
    t.start();
    sockets[0].fireOpen();
    sockets[0].fireClose();
    const afterDrop = sockets.length;

    t.resume();                            // app returned to the foreground
    expect(sockets.length).toBe(afterDrop + 1);
    t.stop();
  });

  it("stops retrying once stopped", () => {
    const t = makeTransport();
    t.start();
    sockets[0].fireOpen();
    sockets[0].fireClose();
    t.stop();
    const n = sockets.length;
    vi.advanceTimersByTime(60000);
    expect(sockets.length).toBe(n);        // no zombie reconnect loop
  });

  it("re-announces its identity on every reconnect", () => {
    const t = makeTransport();
    t.start();
    sockets[0].fireOpen();
    sockets[0].fireClose();
    vi.advanceTimersByTime(1600);
    const latest = sockets[sockets.length - 1];
    latest.fireOpen();
    expect(JSON.parse(latest.sent[0])).toMatchObject({ type: "join", id: "me" });
    t.stop();
  });
});
