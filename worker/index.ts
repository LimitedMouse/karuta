import { DurableObject } from "cloudflare:workers";
import { matchesTpzNickname } from "./nickname";
import songs from "../src/songs.json";
import { MAX_PLAYERS, MAX_TEAMS, MIN_PLAYERS, type Mode, type Player, type RoomState, type Role } from "../src/shared";

interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  ASSETS: Fetcher;
}
interface Attachment { token: string; lastSeen: number }
const GRACE_MS = 15000;
const HEARTBEAT_MS = 90000;
const editable = (s: RoomState) => ["lobby", "finished", "starting"].includes(s.phase);
const empty = (): RoomState => ({
  code: "", host: "", players: [], phase: "lobby", duration: 30,
  mode: "solo", teams: [], teamResults: [],
  randomStart: false, audioOffset: 0,
  board: [], removed: [], round: 0, total: 12, deadline: 0, startsAt: 0,
  audio: null, answer: null, winner: null, showWorks: true, results: [],
});
function shuffled<T>(values: T[]) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(crypto.getRandomValues(new Uint32Array(1))[0] / 0x100000000 * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/rooms" && request.method === "POST") {
      const code = crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
      await env.ROOMS.get(env.ROOMS.idFromName(code)).init(code);
      return Response.json({ code });
    }
    const match = url.pathname.match(/^\/api\/rooms\/([A-F0-9]{8})(\/audio\/[a-f0-9-]{36})?$/);
    if (match) {
      if (!match[2]) {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
          return new Response("WebSocket required", { status: 426 });
        if (request.headers.get("Origin") !== url.origin)
          return new Response("Invalid origin", { status: 403 });
      }
      return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(request);
    }
    if (url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
    return env.ASSETS.fetch(request);
  },
};

export class Room extends DurableObject<Env> {
  state = empty();
  target = 0;
  queue: number[] = [];
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<{ state: RoomState; target: number; queue?: number[] }>("game");
      if (saved) {
        this.state = { ...empty(), ...saved.state };
        this.target = saved.target;
        // Old in-progress rooms finish their existing board without adding new rounds.
        this.queue = saved.queue ?? shuffled(this.state.board.filter(id =>
          !this.state.removed.includes(id) && id !== this.target));
        delete (this.state as RoomState & { clue?: string }).clue;
        this.state.players = this.state.players.map(p => ({
          ...p, role: p.role ?? "player", skipped: p.skipped ?? false,
          leaveAt: p.online ? 0 : p.leaveAt || Date.now() + GRACE_MS,
        }));
        for (const player of this.state.players) {
          if (player.online && !ctx.getWebSockets(player.id).some(ws => ws.readyState === 1))
            this.disconnect(player);
        }
        if (!saved.state.results && this.state.phase !== "lobby") this.snapshotScores();
        if (this.state.audio?.startsWith("/audio/")) this.setAudio();
        for (const ws of ctx.getWebSockets()) {
          const a = ws.deserializeAttachment() as Attachment;
          if (!a.lastSeen) ws.serializeAttachment({ ...a, lastSeen: Date.now() });
        }
        await this.schedule();
      }
    });
  }
  participants() { return this.state.players.filter(p => p.role === "player"); }
  clearReady() {
    this.cancelStart();
    this.state.players.forEach(p => { p.ready = false; });
  }
  createTeam() {
    const color = Array.from({ length: MAX_TEAMS }, (_, i) => i)
      .find(i => !this.state.teams.some(t => t.color === i))!;
    const team = { id: crypto.randomUUID(), name: `${color + 1} 队`, color, score: 0, locked: false };
    this.state.teams.push(team);
    return team;
  }
  async init(code: string) {
    this.state.code = code;
    await this.save();
  }
  setAudio() {
    this.state.audio = `/api/rooms/${this.state.code}/audio/${crypto.randomUUID()}`;
  }
  snapshotScores() {
    this.state.results = this.participants().map(({ id, name, score, teamId }) => ({ id, name, score, teamId }));
    this.state.teamResults = this.state.mode === "teams"
      ? this.state.teams.filter(t => this.state.results.some(p => p.teamId === t.id))
        .map(t => ({ ...t, members: this.state.results.filter(p => p.teamId === t.id).map(p => ({ ...p })) }))
      : [];
  }
  electHost() {
    if (!this.participants().some(p => p.id === this.state.host && p.online))
      this.state.host = this.participants().find(p => p.online)?.id ?? "";
  }
  cancelStart() {
    if (this.state.phase !== "starting") return;
    this.queue = [];
    Object.assign(this.state, {
      phase: this.state.results.length ? "finished" : "lobby",
      deadline: 0, startsAt: 0, audio: null, audioOffset: 0, answer: null, winner: null,
      board: [], removed: [], round: 0,
    });
  }
  reconcile() {
    this.electHost();
    const s = this.state;
    if (!this.participants().length && !editable(s)) {
      s.phase = "finished";
      s.deadline = 0;
      s.audio = null;
    }
    if (editable(s)) {
      const players = this.participants();
      const grouped = s.mode === "solo" || (players.every(p => s.teams.some(t => t.id === p.teamId)) &&
        new Set(players.map(p => p.teamId)).size >= 2);
      const ready = grouped && players.length >= MIN_PLAYERS && players.every(p => p.online && p.ready);
      if (!ready) this.cancelStart();
      else if (s.phase !== "starting") {
        s.board = shuffled(songs.map(song => song.id)).slice(0, s.total);
        s.removed = [];
        s.round = 0;
        const normal = shuffled(s.board);
        const last = normal.pop()!;
        const outside = shuffled(songs.filter(song => !s.board.includes(song.id)).map(song => song.id))
          .slice(0, s.total / 6);
        // Keep a real card until the last round so every decoy is played with a nonempty board.
        this.queue = [...shuffled([...normal, ...outside]), last];
        this.next(10000);
        s.phase = "starting";
      }
    }
    if (s.phase === "playing") {
      const online = this.participants().filter(p => p.online);
      if (online.length && online.every(p => p.locked)) this.reveal();
    }
  }
  async schedule() {
    const times = [this.state.deadline, ...this.state.players.map(p => p.leaveAt)];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState === 1) {
        const a = ws.deserializeAttachment() as Attachment;
        if (this.state.players.some(p => p.id === a.token && p.online)) times.push(a.lastSeen + HEARTBEAT_MS);
      }
    }
    const next = Math.min(...times.filter(t => t > 0));
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, next));
    else await this.ctx.storage.deleteAlarm();
  }
  async save() {
    this.reconcile();
    await this.ctx.storage.put("game", { state: this.state, target: this.target, queue: this.queue });
    await this.schedule();
    const message = JSON.stringify({ type: "state", state: this.state, now: Date.now() });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(message); } catch { /* Closing sockets cannot receive broadcasts. */ }
    }
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!this.state.code) return new Response("Room not found", { status: 404 });
    if (url.pathname.includes("/audio/")) {
      if (request.method !== "GET" || url.pathname !== this.state.audio ||
          !["starting", "countdown", "playing"].includes(this.state.phase) ||
          Date.now() >= (this.state.phase === "playing" ? this.state.deadline : this.state.startsAt + this.state.duration * 1000))
        return new Response("Audio expired", { status: 404, headers: { "Cache-Control": "no-store" } });
      const song = songs.find(song => song.id === this.target)!;
      const response = await this.env.ASSETS.fetch(new Request(new URL(song.audio!, url.origin)));
      return new Response(response.body, { status: response.status, headers: {
        "Content-Type": "audio/mpeg", "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      } });
    }
    const secret = url.searchParams.get("token") || "";
    const name = (url.searchParams.get("name") || "").trim().slice(0, 16);
    if (!/^[a-f0-9-]{36}$/.test(secret)) return new Response("Invalid token", { status: 400 });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
    const token = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
    await this.expire();
    await this.save();
    let player = this.state.players.find(p => p.id === token);
    if (!player) {
      if (!name || name === "玩家") return new Response("Choose a nickname", { status: 400 });
      const role: Role = url.searchParams.get("role") === "spectator" ||
        !["lobby", "finished"].includes(this.state.phase) ? "spectator" : "player";
      if (role === "player" && this.participants().length >= MAX_PLAYERS) return new Response("Room full", { status: 409 });
      player = { id: token, name, role, score: 0, ready: false, online: true, locked: false, skipped: false, leaveAt: 0 };
      this.state.players.push(player);
      if (role === "player") this.clearReady();
    }
    for (const old of this.ctx.getWebSockets(token)) old.close(4001, "Reconnected elsewhere");
    player.online = true;
    player.leaveAt = 0;
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [token]);
    server.serializeAttachment({ token, lastSeen: Date.now() } satisfies Attachment);
    await this.save();
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string" || raw.length > 1024 || ws.readyState !== 1) return;
    let msg: { type: string; duration?: number; total?: number; card?: number; round?: number; sent?: number; role?: Role; showWorks?: boolean; randomStart?: boolean; mode?: Mode; teamId?: string; name?: string; empty?: boolean; playerId?: string };
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
    const a = ws.deserializeAttachment() as Attachment;
    const player = this.state.players.find(p => p.id === a.token);
    if (!player?.online) return;
    ws.serializeAttachment({ ...a, lastSeen: Date.now() });
    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", sent: msg.sent, now: Date.now() }));
      return;
    }
    const s = this.state;
    if (msg.type === "leave") {
      if (player.role === "player" && editable(s)) this.clearReady();
      s.players = s.players.filter(p => p.id !== player.id);
      ws.close(4002, "Left room");
    } else if (msg.type === "role" && editable(s) && (msg.role === "player" || msg.role === "spectator")) {
      if (msg.role === player.role) return;
      if (msg.role === "player" && this.participants().length >= MAX_PLAYERS) {
        ws.send(JSON.stringify({ type: "error", message: "参赛席位已满" }));
        return;
      }
      this.clearReady();
      player.role = msg.role;
      player.teamId = undefined;
      player.ready = false;
    } else if (msg.type.startsWith("team-") && editable(s) && s.mode === "teams" && player.role === "player") {
      if (msg.type === "team-create") {
        if (s.teams.length >= MAX_TEAMS || (msg.empty && player.id !== s.host)) return;
        this.clearReady();
        const team = this.createTeam();
        if (!msg.empty) player.teamId = team.id;
      } else if (msg.type === "team-join") {
        const member = msg.playerId && player.id === s.host
          ? this.participants().find(p => p.id === msg.playerId) : player;
        if (!member || (msg.playerId && msg.playerId !== player.id && player.id !== s.host) ||
            (msg.teamId !== "" && !s.teams.some(t => t.id === msg.teamId))) return;
        if (member.teamId === (msg.teamId || undefined)) return;
        this.clearReady();
        member.teamId = msg.teamId || undefined;
      } else if (msg.type === "team-shuffle" && player.id === s.host) {
        if (s.teams.length < 2) return;
        this.clearReady();
        const teams = shuffled(s.teams);
        shuffled(this.participants()).forEach((p, i) => { p.teamId = teams[i % teams.length].id; });
      } else if (msg.type === "team-delete" && player.id === s.host) {
        if (!s.teams.some(t => t.id === msg.teamId) || this.participants().some(p => p.teamId === msg.teamId)) return;
        this.clearReady();
        s.teams = s.teams.filter(t => t.id !== msg.teamId);
      } else if (msg.type === "team-rename") {
        const team = s.teams.find(t => t.id === msg.teamId);
        if (!team || (player.id !== s.host && player.teamId !== team.id) || typeof msg.name !== "string") return;
        const name = msg.name.trim().slice(0, 16);
        if (!name || name === team.name) return;
        this.clearReady();
        team.name = name;
      } else return;
    } else if (msg.type === "ready" && player.role === "player" && editable(s)) {
      if (s.mode === "teams" && !s.teams.some(t => t.id === player.teamId)) return;
      player.ready = !player.ready;
    } else if (msg.type === "settings" && player.id === s.host && editable(s)) {
      this.cancelStart();
      if (msg.mode === "solo" || msg.mode === "teams") {
        s.mode = msg.mode;
        if (s.mode === "teams" && !s.teams.length) {
          this.createTeam();
          this.createTeam();
        }
      }
      if (msg.duration === 30 || msg.duration === 60) s.duration = msg.duration;
      if (msg.total === 12 || msg.total === 18 || msg.total === 30) s.total = msg.total;
      if (typeof msg.showWorks === "boolean") s.showWorks = msg.showWorks;
      if (typeof msg.randomStart === "boolean") s.randomStart = msg.randomStart;
      if (s.randomStart) s.duration = 30;
      s.players.forEach(p => { p.ready = false; });
    } else if ((msg.type === "guess" || msg.type === "skip") && player.role === "player" &&
        s.phase === "playing" && msg.round === s.round && Date.now() < s.deadline && !player.locked) {
      const team = s.mode === "teams" ? s.teams.find(t => t.id === player.teamId) : undefined;
      if (s.mode === "teams" && (!team || team.locked)) return;
      if (msg.type === "skip") {
        player.skipped = true;
        player.locked = true;
      } else {
        if (!s.board.includes(msg.card!) || s.removed.includes(msg.card!)) return;
        if (msg.card === this.target) {
          player.score++;
          if (team) team.score++;
          s.winner = player.id;
          this.reveal();
        } else {
          player.score--;
          player.locked = true;
          if (team) {
            team.score--;
            team.locked = true;
            this.participants().filter(p => p.teamId === team.id).forEach(p => { p.locked = true; });
          }
        }
        const result = s.results.find(p => p.id === player.id);
        if (result) result.score = player.score;
        if (team) {
          const teamResult = s.teamResults.find(t => t.id === team.id);
          if (teamResult) {
            teamResult.score = team.score;
            const member = teamResult.members.find(p => p.id === player.id);
            if (member) member.score = player.score;
          }
        }
      }
    } else if (msg.type === "reset" && player.id === s.host) {
      this.queue = [];
      this.state = { ...empty(), code: s.code, host: s.host, duration: s.duration, total: s.total,
        randomStart: s.randomStart,
        mode: s.mode, teams: s.teams.map(t => ({ ...t, score: 0, locked: false })),
        showWorks: s.showWorks, players: s.players.map(p => ({ ...p, ready: false, score: 0, locked: false, skipped: false })) };
    } else return;
    await this.save();
  }
  next(delay = 3000) {
    const s = this.state;
    const target = this.queue.shift();
    if (target === undefined) {
      s.phase = "finished";
      s.audio = null;
      s.deadline = 0;
      s.players.forEach(p => { p.ready = false; });
      return;
    }
    this.target = target;
    s.audioOffset = s.randomStart
      ? Math.floor(crypto.getRandomValues(new Uint32Array(1))[0] / 0x100000000 * 11)
      : 0;
    s.round++;
    s.phase = "countdown";
    s.answer = null;
    s.winner = null;
    s.teams.forEach(t => { t.locked = false; });
    this.setAudio();
    s.players.forEach(p => {
      p.locked = false;
      p.skipped = false;
      p.tpzIntro = p.role === "player" && matchesTpzNickname(p.name) &&
        (s.round === 1 || crypto.getRandomValues(new Uint32Array(1))[0] / 0x100000000 < 0.2);
    });
    s.startsAt = Date.now() + delay;
    s.deadline = s.startsAt;
  }
  reveal() {
    const s = this.state;
    s.phase = "reveal";
    s.audio = null;
    s.answer = this.target;
    if (s.board.includes(this.target) && !s.removed.includes(this.target)) s.removed.push(this.target);
    s.deadline = Date.now() + 3500;
  }
  disconnect(player: Player) {
    if (!player.online) return;
    player.online = false;
    player.ready = false;
    if (editable(this.state)) this.clearReady();
    player.leaveAt = Date.now() + GRACE_MS;
  }
  async expire() {
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment;
      if (ws.readyState === 1 && now >= a.lastSeen + HEARTBEAT_MS) {
        const player = this.state.players.find(p => p.id === a.token);
        if (player) this.disconnect(player);
        ws.close(4000, "Heartbeat timeout");
      }
    }
    this.state.players = this.state.players.filter(p => !p.leaveAt || p.leaveAt > now);
    this.reconcile();
  }
  async alarm() {
    await this.expire();
    const s = this.state;
    if (s.deadline && Date.now() >= s.deadline) {
      if (s.phase === "starting" || s.phase === "countdown") {
        if (s.phase === "starting") {
          s.players.forEach(p => { p.score = 0; p.ready = false; });
          s.teams.forEach(t => { t.score = 0; t.locked = false; });
          this.snapshotScores();
        }
        s.phase = "playing";
        s.deadline = s.startsAt + s.duration * 1000;
      } else if (s.phase === "playing") this.reveal();
      else if (s.phase === "reveal") this.next();
    }
    await this.save();
  }
  async webSocketClose(ws: WebSocket) {
    ws.close(1000, "Connection closed");
    const { token } = ws.deserializeAttachment() as Attachment;
    if (this.ctx.getWebSockets(token).some(other => other !== ws && other.readyState === 1)) return;
    const player = this.state.players.find(p => p.id === token);
    if (player) this.disconnect(player);
    await this.save();
  }
  async webSocketError(ws: WebSocket) {
    ws.close(1011, "Connection error");
    await this.webSocketClose(ws);
  }
}
