import { describe, it, expect } from "vitest";
import { createTransport, BroadcastTransport, WebRTCTransport } from "../src/transport.js";

const make = (onMessage = () => {}) =>
  new BroadcastTransport({ selfId: "self", room: "r", onMessage });

describe("createTransport factory", () => {
  it("uses BroadcastChannel when no signaling URL is set", () => {
    const t = createTransport({ selfId: "a", room: "r" });
    expect(t).toBeInstanceOf(BroadcastTransport);
  });

  it("falls back to BroadcastChannel when WebRTC is unavailable (Node)", () => {
    // RTCPeerConnection is undefined in Node, so even with a signaling URL the
    // factory must degrade rather than construct an unusable WebRTC transport.
    const t = createTransport({ selfId: "a", room: "r", signalingUrl: "ws://x" });
    expect(t).toBeInstanceOf(BroadcastTransport);
  });
});

describe("message envelope (_stamp / _deliver)", () => {
  it("stamps outgoing messages with sender id and a message id", () => {
    const t = make();
    const msg = t._stamp({ type: "hello" });
    expect(msg._from).toBe("self");
    expect(typeof msg._mid).toBe("string");
  });

  it("delivers messages from other peers", () => {
    const got = [];
    const t = make((m) => got.push(m));
    t._deliver({ type: "hello", _from: "other" });
    expect(got).toHaveLength(1);
  });

  it("ignores the device's own echoed messages", () => {
    const got = [];
    const t = make((m) => got.push(m));
    t._deliver({ type: "hello", _from: "self" });
    expect(got).toHaveLength(0);
  });

  it("de-duplicates by message id", () => {
    const got = [];
    const t = make((m) => got.push(m));
    const dup = { type: "ping", _from: "other", _mid: "abc" };
    t._deliver(dup);
    t._deliver(dup);
    expect(got).toHaveLength(1);
  });

  it("honors unicast addressing via _to", () => {
    const got = [];
    const t = make((m) => got.push(m));
    t._deliver({ type: "x", _from: "other", _to: "someone-else" }); // not for us
    t._deliver({ type: "y", _from: "other", _to: "self" });         // for us
    expect(got.map((m) => m.type)).toEqual(["y"]);
  });
});

describe("WebRTC notify relay", () => {
  it("delivers a Worker-relayed notify and de-dupes against the P2P copy by _mid", () => {
    const got = [];
    const t = new WebRTCTransport({ selfId: "self", room: "r", signalingUrl: "ws://x", onMessage: (m) => got.push(m) });
    const relayed = { type: "notify", _from: "other", _mid: "mid-1", name: "report.pdf" };
    t._onSignal(relayed);            // arrives via the signaling socket
    t._onSignal({ ...relayed });     // same _mid arrives again via P2P
    expect(got).toHaveLength(1);
    expect(got[0].name).toBe("report.pdf");
  });
});
