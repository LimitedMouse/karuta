import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

// Exercise the actual Durable Object with in-memory storage and sockets.
const bundle = await build({
  entryPoints: ["worker/index.ts"], bundle: true, write: false, format: "esm", platform: "node",
  plugins: [{ name: "durable-object-test", setup(build) {
    build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "cloudflare", namespace: "mock" }));
    build.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents:
      "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" }));
  } }],
});
const { Room } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
async function fixture(count = 4, saved) {
  const sockets = [];
  let ready;
  const ctx = {
    blockConcurrencyWhile(fn) { ready = fn(); },
    getWebSockets(id) { return sockets.filter(ws => !id || ws.id === id); },
    storage: { async get() { return saved; }, async put() {}, async setAlarm() {}, async deleteAlarm() {} },
  };
  const room = new Room(ctx, {});
  await ready;
  room.state.code = "ABCDEF12";
  if (!saved) room.state.players = Array.from({ length: count }, (_, i) => ({
    id: `p${i}`, name: `Player ${i}`, role: "player", online: true, score: 0,
    ready: false, locked: false, skipped: false, leaveAt: 0,
  }));
  for (const p of room.state.players) {
    let attachment = { token: p.id, lastSeen: Date.now() };
    sockets.push({ id: p.id, readyState: 1, send() {}, close() { this.readyState = 3; },
      deserializeAttachment: () => attachment, serializeAttachment(a) { attachment = a; } });
  }
  room.state.host = "p0";
  const send = async (i, msg) => room.webSocketMessage(sockets[i], JSON.stringify(msg));
  const start = async () => {
    for (let i = 0; i < count; i++) await send(i, { type: "ready" });
    assert.equal(room.state.phase, "starting");
    room.state.startsAt = Date.now() - 1;
    room.state.deadline = Date.now() - 1;
    await room.alarm();
    assert.equal(room.state.phase, "playing");
  };
  return { room, send, start };
}

test("empty teams, player-created teams, permissions, capacity, and repeatable balanced shuffle", async () => {
  const { room, send } = await fixture(8);
  await send(0, {});
  await send(0, { type: 1 });
  await send(1, { type: "settings", mode: "teams" });
  assert.equal(room.state.mode, "solo");
  await send(0, { type: "settings", mode: "teams" });
  assert.equal(room.state.teams.length, 2);
  await send(0, { type: "team-create", empty: true });
  assert.equal(room.state.teams.length, 3);
  assert.equal(room.state.players[0].teamId, undefined);
  await send(1, { type: "team-create", empty: true });
  assert.equal(room.state.teams.length, 3);
  await send(1, { type: "team-create" });
  assert.equal(room.state.players[1].teamId, room.state.teams[3].id);
  await send(0, { type: "team-delete", teamId: room.state.teams[3].id });
  assert.equal(room.state.teams.length, 4);
  await send(0, { type: "team-delete", teamId: room.state.teams[2].id });
  assert.equal(room.state.teams.length, 3);
  for (let i = 0; i < 10; i++) {
    await send(0, { type: "team-shuffle" });
    const sizes = room.state.teams.map(t => room.state.players.filter(p => p.teamId === t.id).length).sort();
    assert.deepEqual(sizes, [2, 3, 3]);
  }
  const ids = room.state.players.map(p => p.teamId);
  await send(1, { type: "team-shuffle" });
  assert.deepEqual(room.state.players.map(p => p.teamId), ids);
  for (let i = 0; i < 8; i++) await send(0, { type: "team-create", empty: true });
  assert.equal(room.state.teams.length, 8);
});

test("team changes cancel readiness; missing assignments and a single active team cannot start", async () => {
  const { room, send } = await fixture(2);
  await send(0, { type: "settings", mode: "teams" });
  await send(0, { type: "ready" });
  assert.equal(room.state.players[0].ready, false);
  for (let i = 0; i < 2; i++) await send(i, { type: "team-join", teamId: room.state.teams[0].id });
  for (let i = 0; i < 2; i++) await send(i, { type: "ready" });
  assert.equal(room.state.phase, "lobby");
  await send(1, { type: "team-join", teamId: room.state.teams[1].id });
  assert.ok(room.state.players.every(p => !p.ready));
  for (let i = 0; i < 2; i++) await send(i, { type: "ready" });
  assert.equal(room.state.phase, "starting");
  await send(0, { type: "team-shuffle" });
  assert.equal(room.state.phase, "lobby");
  assert.ok(room.state.players.every(p => !p.ready));
});

test("shared lock prevents duplicate penalties, preserves contribution and scores after leaving", async () => {
  const { room, send, start } = await fixture();
  await send(0, { type: "settings", mode: "teams" });
  const [a, b] = room.state.teams;
  for (let i = 0; i < 4; i++) await send(i, { type: "team-join", teamId: i < 2 ? a.id : b.id });
  await start();
  const round = room.state.round;
  await send(1, { type: "team-join", teamId: b.id });
  assert.equal(room.state.players[1].teamId, a.id);
  const wrong = room.state.board.find(id => id !== room.target);
  await Promise.all([send(0, { type: "guess", card: wrong, round }), send(1, { type: "guess", card: wrong, round })]);
  assert.equal(a.score, -1);
  assert.ok(room.state.players.slice(0, 2).every(p => p.locked));
  assert.equal(room.state.players[1].score, 0);
  await send(2, { type: "skip", round });
  assert.equal(room.state.players[3].locked, false);
  assert.equal(room.state.phase, "playing");
  await send(3, { type: "skip", round });
  assert.equal(room.state.phase, "reveal");
  await send(0, { type: "leave" });
  assert.equal(room.state.teamResults.find(t => t.id === a.id).score, -1);
  assert.equal(room.state.teamResults.find(t => t.id === a.id).members.find(p => p.id === "p0").score, -1);
  room.next();
  assert.equal(a.locked, false);
  assert.ok(room.state.players.every(p => !p.locked));
  await send(1, { type: "reset" });
  assert.equal(room.state.mode, "teams");
  assert.equal(room.state.teams.length, 2);
  assert.ok(room.state.teams.every(t => t.score === 0 && !t.locked));
});

test("correct team claim scores once and snapshots survive lobby renames", async () => {
  const { room, send, start } = await fixture();
  await send(0, { type: "settings", mode: "teams" });
  await send(0, { type: "team-shuffle" });
  await start();
  room.target = room.state.board[0];
  const winner = room.state.players[0];
  const team = room.state.teams.find(t => t.id === winner.teamId);
  await send(0, { type: "guess", card: room.target, round: room.state.round });
  assert.equal(team.score, 1);
  assert.equal(room.state.phase, "reveal");
  assert.equal(room.state.teamResults.find(t => t.id === team.id).members.find(p => p.id === winner.id).score, 1);
  room.queue = [];
  room.next();
  await send(0, { type: "team-rename", teamId: team.id, name: "New name" });
  assert.equal(team.name, "New name");
  assert.notEqual(room.state.teamResults.find(t => t.id === team.id).name, "New name");
});

test("legacy state defaults to solo and solo penalties remain individual", async () => {
  const { room, send, start } = await fixture(2);
  await start();
  await send(0, { type: "guess", card: room.state.board.find(id => id !== room.target), round: room.state.round });
  assert.equal(room.state.players[0].score, -1);
  assert.equal(room.state.players[1].locked, false);
  assert.deepEqual(room.state.teamResults, []);
  const legacy = structuredClone(room.state);
  delete legacy.mode; delete legacy.teams; delete legacy.teamResults;
  const restored = await fixture(2, { state: legacy, target: room.target, queue: room.queue });
  assert.equal(restored.room.state.mode, "solo");
  assert.deepEqual(restored.room.state.teams, []);
});
