import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

/* Integration test for the signalling protocol against the real dev server.
   Guards the bug where the desktop tray helper joined under the SAME id as the
   webview: the server then routed WebRTC signalling to whichever socket it
   found first — often the helper, which drops it — so peers never connected
   and every device appeared offline. Helpers now join as "listener". */

const PORT = 8899;
let proc;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect() {
  const ws = new WebSocket(`ws://localhost:${PORT}?room=testroom`);
  ws.inbox = [];
  ws.on("message", (raw) => { try { ws.inbox.push(JSON.parse(raw)); } catch { /* ignore */ } });
  return new Promise((res, rej) => { ws.on("open", () => res(ws)); ws.on("error", rej); });
}
const send = (ws, obj) => ws.send(JSON.stringify(obj));
const typesOf = (ws) => ws.inbox.map((m) => m.type);

beforeAll(async () => {
  proc = spawn(process.execPath, ["server/signaling.js"], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore"
  });
  await wait(700);   // let it bind
}, 15000);

afterAll(() => { if (proc) proc.kill(); });

describe("signalling: peers vs listeners", () => {
  it("keeps listeners out of the peer mesh but still delivers notify", async () => {
    const a = await connect();          // phone
    const b = await connect();          // desktop webview
    const helper = await connect();     // desktop tray helper

    send(a, { type: "join", room: "testroom", id: "deviceA" });
    await wait(150);

    // the desktop's helper joins under a distinct id AND the listener role
    send(helper, { type: "join", room: "testroom", id: "deviceB#helper", role: "listener" });
    await wait(150);

    send(b, { type: "join", room: "testroom", id: "deviceB" });
    await wait(250);

    // B's peer list must contain A only — never the helper
    const peersMsg = b.inbox.find((m) => m.type === "peers");
    expect(peersMsg).toBeTruthy();
    expect(peersMsg.peers).toContain("deviceA");
    expect(peersMsg.peers).not.toContain("deviceB#helper");

    // a listener is never announced as a peer
    expect(typesOf(helper)).not.toContain("peers");
    expect(a.inbox.filter((m) => m.type === "peer-joined").map((m) => m.id))
      .not.toContain("deviceB#helper");

    // THE REGRESSION: signalling addressed to deviceB must reach the webview
    send(a, { type: "signal", to: "deviceB", data: { sdp: { type: "offer" } } });
    await wait(250);
    const gotSignal = b.inbox.find((m) => m.type === "signal");
    expect(gotSignal).toBeTruthy();
    expect(gotSignal.from).toBe("deviceA");
    expect(typesOf(helper)).not.toContain("signal");

    // notify still fans out to the listener (that is its whole purpose)
    send(a, { type: "notify", name: "report.pdf", fromName: "Phone" });
    await wait(250);
    const helperNotify = helper.inbox.find((m) => m.type === "notify");
    expect(helperNotify).toBeTruthy();
    expect(helperNotify.name).toBe("report.pdf");
    expect(b.inbox.find((m) => m.type === "notify")).toBeTruthy();
    // the sender never notifies itself
    expect(typesOf(a)).not.toContain("notify");

    [a, b, helper].forEach((w) => w.close());
  }, 20000);
});
