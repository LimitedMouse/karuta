import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowRight,
  Check,
  Copy,
  Disc3,
  Eye,
  LogOut,
  Play,
  RotateCcw,
  SkipForward,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import songs from "./songs.json";
import { MAX_PLAYERS, MIN_PLAYERS, type RoomState, type Role } from "./shared";
import "./style.css";
import { TeamRoster } from "./TeamRoster";

const token = sessionStorage.getItem("karuta-token") || crypto.randomUUID();
sessionStorage.setItem("karuta-token", token);
const byId = new Map(songs.map((s) => [s.id, s]));
type Entry = { create: boolean; code: string; role: Role };

function App() {
  const [room, setRoom] = useState<RoomState | null>(null);
  const [name, setName] = useState(
    localStorage.getItem("karuta-name") || "玩家",
  );
  const [code, setCode] = useState(
    new URLSearchParams(location.search).get("room") || "",
  );
  const [tab, setTab] = useState<"play" | "library">("play");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [role, setRole] = useState<Role>("player");
  const [pendingEntry, setPendingEntry] = useState<Entry | null>(null);
  const [draftName, setDraftName] = useState("");
  const nicknameDialog = useRef<HTMLDialogElement>(null);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(60);
  const [now, setNow] = useState(Date.now());
  const [me, setMe] = useState("");
  const [latency, setLatency] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [audioStatus, setAudioStatus] = useState<"loading" | "ready" | "blocked" | "error">("ready");
  const [audioAttempt, setAudioAttempt] = useState(0);
  const [actionPending, setActionPending] = useState(false);
  const buffers = useRef(new Map<string, Promise<AudioBuffer>>());
  const socket = useRef<WebSocket | null>(null);
  const offset = useRef(0);
  const audio = useRef<AudioContext | null>(null);
  const source = useRef<AudioBufferSourceNode | null>(null);
  const introSource = useRef<AudioBufferSourceNode | null>(null);
  const gain = useRef<GainNode | null>(null);
  const leaveRequested = useRef(false);
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const joinRef = useRef<(value: string) => void>(() => {});
  const retries = useRef(0);
  const actionSent = useRef(false);
  const player = room?.players.find((p) => p.id === me);
  const participants = room?.players.filter((p) => p.role === "player") ?? [];
  const spectators = room?.players.filter((p) => p.role === "spectator") ?? [];
  const host = room?.host === me;
  const idle = !room || room.phase === "lobby" || room.phase === "finished";
  const editable = idle || room?.phase === "starting";
  const hideWorks = tab === "play" && !!room && !room.showWorks;
  const canGuess = connected && player?.role === "player" && !player.locked &&
    !actionPending && room?.phase === "playing" && now < room.deadline;
  const seconds = room
    ? Math.max(0, Math.ceil((room.deadline - now) / 1000))
    : 0;
  const answer = room?.answer ? byId.get(room.answer) : null;
  const winner = room?.results.find((p) => p.id === room.winner);
  const ranking = [...(room?.teamResults?.length ? room.teamResults : room?.results ?? [])].sort((a, b) => b.score - a.score);
  const winnerTeam = room?.teamResults?.find(t => t.id === winner?.teamId);
  const teamsValid = room?.mode !== "teams" || (participants.every(p => room.teams.some(t => t.id === p.teamId)) &&
    new Set(participants.map(p => p.teamId)).size >= 2);
  const topNames = ranking.filter(p => p.score === ranking[0]?.score).map(p => p.name);

  useEffect(() => {
    if (pendingEntry) nicknameDialog.current?.showModal();
    else nicknameDialog.current?.close();
  }, [pendingEntry]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() + offset.current), 100);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (gain.current) gain.current.gain.value = muted ? 0 : volume / 100;
  }, [muted, volume]);
  useEffect(() => {
    if (room?.phase === "starting" || (room?.phase === "countdown" && room.round === 1)) {
      setTab("play");
      window.scrollTo(0, 0);
    }
    source.current?.stop();
    source.current = null;
    introSource.current?.stop();
    introSource.current = null;
    setSelected(null);
    let cancelled = false;
    const controller = new AbortController();
    const ctx = audio.current;
    if (room && connected && ["starting", "countdown", "playing"].includes(room.phase)) {
      if (!ctx || ctx.state !== "running") {
        setAudioStatus("blocked");
      } else if (!room.audio) {
        setAudioStatus("error");
      } else {
        const url = room.audio;
        const startsAt = room.startsAt;
        const duration = room.duration;
        const audioOffset = room.audioOffset;
        setAudioStatus("loading");
        const load = (asset: string) => {
          let pending = buffers.current.get(asset);
          if (pending) return pending;
          // Decode during countdown; late joins seek to the shared server clock.
          pending = fetch(asset).then(async (response) => {
            if (!response.ok) throw new Error("Audio download failed");
            return ctx.decodeAudioData(await response.arrayBuffer());
          });
          buffers.current.set(asset, pending);
          if (buffers.current.size > 4) {
            buffers.current.delete(buffers.current.keys().next().value!);
          }
          pending.catch(() => buffers.current.delete(asset));
          return pending;
        };
        Promise.all([load(url), player?.tpzIntro ? load("/audio/tpz-intro.mp3") : null]).then(([buffer, intro]) => {
          if (cancelled) return;
          if (ctx.state !== "running") {
            setAudioStatus("blocked");
            return;
          }
          const elapsed = (Date.now() + offset.current - startsAt) / 1000;
          const introDuration = intro?.duration ?? 0;
          const clock = ctx.currentTime;
          // Anchor both clips to the round clock so phase changes and retries resume in place.
          if (intro && elapsed < introDuration && elapsed < duration) {
            const introSeek = Math.max(0, elapsed);
            const node = ctx.createBufferSource();
            node.buffer = intro;
            node.connect(gain.current!);
            node.start(clock + Math.max(0, -elapsed), introSeek,
              Math.min(introDuration, duration) - introSeek);
            introSource.current = node;
          }
          const played = Math.max(0, elapsed - introDuration);
          const seek = audioOffset + played;
          const remaining = Math.min(duration - Math.max(introDuration, elapsed), buffer.duration - seek);
          setAudioStatus("ready");
          if (remaining <= 0) return;
          const node = ctx.createBufferSource();
          node.buffer = buffer;
          node.connect(gain.current!);
          node.start(clock + Math.max(0, introDuration - elapsed), seek, remaining);
          source.current = node;
          setAudioStatus("ready");
        }).catch(() => {
          if (!cancelled) setAudioStatus("error");
        });
        ctx.addEventListener("statechange", () => {
          if (ctx.state !== "running") setAudioStatus("blocked");
        }, { signal: controller.signal });
      }
    } else setAudioStatus("ready");
    return () => {
      cancelled = true;
      controller.abort();
      source.current?.stop();
      source.current = null;
      introSource.current?.stop();
      introSource.current = null;
    };
  }, [room?.phase, room?.round, room?.audio, room?.startsAt, room?.duration, room?.audioOffset, player?.tpzIntro, audioAttempt, connected]);
  useEffect(() => {
    actionSent.current = false;
    setActionPending(false);
  }, [room?.round, room?.phase, connected]);
  useEffect(
    () => () => {
      leaveRequested.current = true;
      clearTimeout(retry.current);
      socket.current?.close();
      audio.current?.close();
    },
    [],
  );

  async function unlock() {
    if (!audio.current) {
      audio.current = new AudioContext();
      gain.current = audio.current.createGain();
      gain.current.connect(audio.current.destination);
      gain.current.gain.value = muted ? 0 : volume / 100;
    }
    await audio.current.resume();
  }
  function send(message: object) {
    if (socket.current?.readyState === WebSocket.OPEN)
      socket.current.send(JSON.stringify(message));
  }
  async function join(value: string, nickname = name, desiredRole = role, reconnecting = false) {
    value = value.trim().toUpperCase();
    if (!/^[A-F0-9]{8}$/.test(value)) {
      setError("请输入 8 位房间码");
      return;
    }
    setBusy(true);
    setConnected(false);
    if (!reconnecting) {
      setError("");
      retries.current = 0;
    }
    setStatus(reconnecting ? "重新连接中" : "连接中");
    leaveRequested.current = false;
    localStorage.setItem("karuta-name", nickname.trim());
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(token),
    );
    setMe(
      Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join(""),
    );
    if (leaveRequested.current) return;
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/rooms/${value}?token=${encodeURIComponent(token)}&name=${encodeURIComponent(nickname)}&role=${desiredRole}`);
    socket.current?.close();
    socket.current = ws;
    let opened = false;
    let clockSynced = false;
    let lastPong = Date.now();
    let heartbeat: ReturnType<typeof setInterval>;
    const connectionTimeout = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) ws.close();
    }, 10000);
    const ping = () => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: "ping", sent: Date.now() }));
    };
    const resume = () => {
      if (document.visibilityState === "visible") {
        lastPong = Date.now();
        ping();
      }
    };
    ws.onopen = () => {
      if (socket.current !== ws) return;
      clearTimeout(connectionTimeout);
      opened = true;
      retries.current = 0;
      setBusy(false);
      setConnected(true);
      setError("");
      setStatus("已连接");
      setCode(value);
      history.replaceState(null, "", `?room=${value}`);
      ping();
      document.addEventListener("visibilitychange", resume);
      heartbeat = setInterval(() => {
        if (document.visibilityState === "visible" && Date.now() - lastPong > 35000) {
          ws.close(4000, "Heartbeat timeout");
          return;
        }
        ping();
      }, 10000);
    };
    ws.onmessage = (event) => {
      if (socket.current !== ws) return;
      const data = JSON.parse(event.data);
      if (data.type === "state") {
        setRoom(data.state);
        if (!clockSynced) offset.current = data.now - Date.now();
      }
      if (data.type === "pong") {
        clockSynced = true;
        lastPong = Date.now();
        const rtt = Date.now() - data.sent;
        setLatency(rtt);
        offset.current = data.now - (Date.now() - rtt / 2);
      }
      if (data.type === "error") setError(data.message);
    };
    ws.onerror = () => {
      if (socket.current === ws && !reconnecting)
        setError("连接失败：请检查网络和房间码；参赛席位已满时可选择观战加入");
    };
    ws.onclose = (event) => {
      clearInterval(heartbeat);
      clearTimeout(connectionTimeout);
      document.removeEventListener("visibilitychange", resume);
      if (leaveRequested.current || socket.current !== ws) return;
      setBusy(false);
      setConnected(false);
      setStatus("已断开");
      if ((opened || reconnecting) && event.code !== 4001 && event.code !== 4002 && retries.current < 6) {
        retries.current++;
        setStatus("重新连接中");
        setBusy(true);
        retry.current = setTimeout(() => joinRef.current(value), Math.min(1000 * 2 ** (retries.current - 1), 5000));
      } else if (event.code === 4001) {
        setError("已在其他页面连接，请退出后重新加入");
      } else {
        setRoom(null);
        setError("未能连接房间，请检查网络和房间码后重新加入");
      }
    };
  }
  joinRef.current = value => { void join(value, name, player?.role ?? role, true); };
  async function enter(entry: Entry, nickname: string) {
    setBusy(true);
    setError("");
    setName(nickname.trim());
    localStorage.setItem("karuta-name", nickname.trim());
    try {
      await unlock().catch(() => setAudioStatus("blocked"));
      let value = entry.code;
      if (entry.create) {
        const response = await fetch("/api/rooms", { method: "POST" });
        if (!response.ok) throw new Error();
        value = ((await response.json()) as { code: string }).code;
      }
      await join(value, nickname.trim(), entry.role);
    } catch {
      setError("进入房间失败，请稍后重试");
      setBusy(false);
    }
  }
  function requestEntry(create: boolean) {
    if (busy) return;
    const entry: Entry = { create, code, role };
    if (!create && !/^[A-F0-9]{8}$/.test(code.trim().toUpperCase())) {
      setError("请输入 8 位房间码");
      return;
    }
    if (!name.trim() || name.trim() === "玩家") {
      setDraftName("");
      setPendingEntry(entry);
    } else void enter(entry, name);
  }
  function guess(card?: number) {
    if (!canGuess || actionSent.current || !room) return;
    actionSent.current = true;
    setActionPending(true);
    if (card !== undefined) setSelected(card);
    send(card === undefined ? { type: "skip", round: room.round } : { type: "guess", card, round: room.round });
  }
  function leave() {
    leaveRequested.current = true;
    clearTimeout(retry.current);
    send({ type: "leave" });
    socket.current?.close();
    socket.current = null;
    setRoom(null);
    setConnected(false);
    setBusy(false);
    setStatus("");
    setError("");
    history.replaceState(null, "", "/");
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(
        `${location.origin}/?room=${room!.code}`,
      );
      setStatus("邀请链接已复制");
      setTimeout(
        () => setStatus(socket.current?.readyState === 1 ? "已连接" : "已断开"),
        1800,
      );
    } catch {
      setError(`房间码：${room!.code}`);
    }
  }
  const displayed =
    room?.board.length && tab === "play"
      ? room.board.map((id) => byId.get(id)!)
      : songs;

  return (
    <>
      <header className="header">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            if (room) e.preventDefault();
          }}
        >
          <Disc3 size={26} />
          <strong>歌牌</strong>
          <span>KARUTA</span>
        </a>
        <nav>
          <button
            className={tab === "play" ? "active" : ""}
            onClick={() => setTab("play")}
          >
            对局
          </button>
          <button
            className={tab === "library" ? "active" : ""}
            disabled={!idle}
            onClick={() => setTab("library")}
          >
            曲库 <span>{songs.length}</span>
          </button>
        </nav>
        <span className="demo">DEMO 01</span>
      </header>
      <main className={tab === "play" && !idle ? "in-match" : ""}>
        {(tab === "library" || room) && (
          <div className="page-heading">
            <h1>{tab === "library" ? "曲库" : "对局室"}</h1>
          </div>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
            <button
              className="icon"
              title="关闭提示"
              onClick={() => setError("")}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {tab === "play" && !room && (
          <section className="entry">
            <label>
              昵称
              <input
                value={name}
                maxLength={16}
                onChange={(e) => setName(e.target.value)}
                aria-label="昵称"
              />
            </label>
            <div className="segments entry-role" aria-label="入房身份">
              <button className={role === "player" ? "selected" : ""} aria-pressed={role === "player"}
                onClick={() => setRole("player")} disabled={busy}>参赛</button>
              <button className={role === "spectator" ? "selected" : ""} aria-pressed={role === "spectator"}
                onClick={() => setRole("spectator")} disabled={busy}>观战</button>
            </div>
            <button
              className="primary"
              onClick={() => requestEntry(true)}
              disabled={busy}
            >
              <Play size={16} />
              创建房间
            </button>
            <span className="entry-divider" />
            <form
              onSubmit={(e) => {
                e.preventDefault();
                requestEntry(false);
              }}
            >
              <input
                aria-label="房间码"
                placeholder="输入房间码"
                value={code}
                maxLength={8}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
              />
              <button className="secondary" disabled={busy} type="submit">
                {role === "spectator" ? "观战" : "加入"}
                <ArrowRight size={17} />
              </button>
            </form>
          </section>
        )}
        {tab === "play" && room && (
          <>
            <section className="room-bar">
              <div className="room-code">
                <span>房间</span>
                <strong>{room.code}</strong>
                <button className="icon" title="复制邀请链接" onClick={copy}>
                  <Copy size={16} />
                </button>
              </div>
              <div className="room-members">
                <div className="segments room-role" aria-label="我的身份">
                  <button aria-pressed={player?.role === "player"} className={player?.role === "player" ? "selected" : ""}
                    disabled={!editable || !connected || (player?.role !== "player" && participants.length >= MAX_PLAYERS)}
                    onClick={() => send({ type: "role", role: "player" })}>参赛</button>
                  <button aria-pressed={player?.role === "spectator"} className={player?.role === "spectator" ? "selected" : ""}
                    disabled={!editable || !connected}
                    onClick={() => send({ type: "role", role: "spectator" })}>观战</button>
                </div>
                <span className="member-count">参赛 {participants.length} / {MAX_PLAYERS}</span>
                <details className="spectators">
                  <summary><Eye size={14} /> 观战 {spectators.length}</summary>
                  <div>{spectators.length ? spectators.map(p => (
                    <span key={p.id}>{p.name}{p.id === me ? "（你）" : ""}{!p.online ? ` · 离线 ${Math.max(0, Math.ceil((p.leaveAt - now) / 1000))}s` : ""}</span>
                  )) : <span>暂无观众</span>}</div>
                </details>
              </div>
              <span
                className={
                  "connection " + (!connected ? "offline" : "")
                }
              >
                <i />
                {status} <small>{latency} ms</small>
              </span>
              <button className="icon" title="退出房间" onClick={leave}>
                <LogOut size={18} />
              </button>
            </section>
            <div className="mode-bar">
              <div className="segments mode-switch" aria-label="比赛模式">
                {([['solo', '个人赛'], ['teams', '自由组队']] as const).map(([mode, label]) => <button key={mode}
                  className={room.mode === mode ? "selected" : ""} aria-pressed={room.mode === mode}
                  disabled={!editable || !host || !connected} onClick={() => send({ type: "settings", mode })}>{label}</button>)}
              </div>
              <span>{room.mode === "teams" ? "团队积分" : "个人积分"}</span>
            </div>
            <section className="match-bar">
              {room.mode === "teams" ? <TeamRoster room={room} me={me} now={now} editable={editable} connected={connected} send={send} /> : <div className="players">
                {Array.from({ length: MAX_PLAYERS }, (_, index) => {
                  const p = participants[index];
                  return (
                    <div
                      className={"player " + (p?.id === me ? "self " : "") + (!p ? "empty-seat" : p.ready ? "is-ready" : "")}
                      key={index}
                    >
                      <div className="avatar">
                        {p ? p.name.slice(0, 1) : "+"}
                      </div>
                      <div className="player-info">
                        <strong title={p?.name}>
                          <span>{p?.name || "等待加入"}</span>
                          {p?.id === me && <small>你</small>}
                        </strong>
                        <span>
                          {!p
                            ? "空位"
                            : !p.online
                              ? `离线 ${Math.max(0, Math.ceil((p.leaveAt - now) / 1000))}s`
                              : p.skipped && !idle
                                ? "已 SKIP"
                              : p.locked && !idle
                                ? "本轮已失误"
                                : p.ready
                                  ? "已准备"
                                  : p.id === room.host
                                    ? "房主"
                                    : "已加入"}
                        </span>
                      </div>
                      <b>{p?.score ?? "—"}</b>
                    </div>
                  );
                })}
              </div>}
            </section>
            <section className={"room-controls" + (!editable ? " compact-controls" : "")} aria-label="本局规则">
              {!editable && <div className="active-rules"><span>{room.duration}s</span><span>{room.total} 张</span><span>{room.randomStart ? "随机起点" : "从头播放"}</span><span>{room.showWorks ? "显示作品名" : "隐藏作品名"}</span></div>}
              <div className="settings">
                <div className="rule-field">
                <span className="rule-label">播放时长</span>
                <div className="segments" aria-label="播放时长">
                  {[30, 60].map((n) => (
                    <button
                      key={n}
                      disabled={!editable || !host || !connected || (room.randomStart && n === 60)}
                      className={room.duration === n ? "selected" : ""}
                      onClick={() => send({ type: "settings", duration: n })}
                    >
                      {n}s
                    </button>
                  ))}
                </div>
                </div>
                <label className="rule-field">
                <span className="rule-label">牌阵</span>
                <select
                  aria-label="牌数"
                  value={room.total}
                  disabled={!editable || !host || !connected}
                  onChange={(e) =>
                    send({ type: "settings", total: Number(e.target.value) })
                  }
                >
                  <option value={12}>12 张</option>
                  <option value={18}>18 张</option>
                  <option value={30}>30 张</option>
                </select>
                </label>
                <label className="rule-field rule-switch">
                  <span className="rule-label">播放起点 <small>0–10s</small></span>
                  <span className="switch-control"><span>随机起点</span>
                  <input type="checkbox" role="switch" aria-label="随机起点" checked={room.randomStart} disabled={!editable || !host || !connected}
                    onChange={e => send({ type: "settings", randomStart: e.target.checked })} />
                  </span>
                </label>
                <label className="rule-field rule-switch">
                  <span className="rule-label">卡面提示</span>
                  <span className="switch-control"><span>作品名</span>
                  <input type="checkbox" role="switch" aria-label="作品名" checked={room.showWorks} disabled={!editable || !host || !connected}
                    onChange={e => send({ type: "settings", showWorks: e.target.checked })} />
                  </span>
                </label>
              </div>
              <div className="room-action">
                <span className="ready-count">已准备 <b>{participants.filter(p => p.ready).length}</b> / {participants.length}</span>
                {editable ? (
                  player?.role === "player" ? (
                    <button
                      className={player?.ready ? "secondary" : "primary"}
                      disabled={!connected || (room.mode === "teams" && !room.teams.some(t => t.id === player.teamId))}
                      onClick={async () => {
                        await unlock().catch(() => setAudioStatus("blocked"));
                        send({ type: "ready" });
                      }}
                    >
                      <Check size={16} />
                      {player?.ready ? "取消准备" : "准备"}
                    </button>
                  ) : <span className="spectator-status"><Eye size={16} />正在观战</span>
                ) : (
                  host && (
                    <button
                      className="icon"
                      title="结束对局"
                      disabled={!connected}
                      onClick={() => {
                        if (window.confirm("结束当前对局并返回等待房间？")) send({ type: "reset" });
                      }}
                    >
                      <RotateCcw size={18} />
                    </button>
                  )
                )}
              </div>
            </section>
            <section
              className={"playback phase-" + room.phase}
              aria-live="polite"
            >
              <div className="playback-icon">
                <Disc3 size={28} />
              </div>
              <div className="track">
                <span>
                  {room.phase === "lobby"
                    ? "WAITING"
                    : room.phase === "countdown" || room.phase === "starting"
                      ? "GET READY"
                      : room.phase === "finished"
                        ? "RESULT"
                        : room.phase === "reveal"
                          ? "ANSWER"
                          : "NOW PLAYING"}
                </span>
                <h2>
                  {room.phase === "lobby"
                    ? participants.length < MIN_PLAYERS ? `等待 ${MIN_PLAYERS - participants.length} 位玩家加入` : !teamsValid ? "等待分组 · 至少两队参赛" : "等待玩家准备"
                    : room.phase === "starting"
                      ? "即将自动开始"
                    : room.phase === "countdown"
                      ? "准备抢牌"
                      : room.phase === "finished"
                        ? ranking.length ? topNames.length > 1 ? "并列获胜" : `${topNames[0]} 获胜` : "对局结束"
                        : room.phase === "reveal"
                          ? answer?.title
                          : audioStatus === "loading"
                            ? "音频加载中"
                            : audioStatus === "error"
                              ? "音频加载失败"
                              : audioStatus === "blocked"
                                ? "播放已暂停"
                                : "正在播放"}
                </h2>
                {room.phase === "reveal" && (
                  <p>
                    {answer?.work} · {room.answer !== null && !room.board.includes(room.answer) ? "空牌曲 · " : ""}{winner ? `${winnerTeam ? winnerTeam.name + " · " : ""}${winner.name} +1` : "无人得分"}
                  </p>
                )}
              </div>
              <div className="playback-end">
                {!idle && (
                  <strong className="timer">
                    {seconds.toString().padStart(2, "0")}
                    <small>s</small>
                  </strong>
                )}
                <div className="audio-tools">
                  {!idle && (audioStatus === "blocked" || audioStatus === "error") && (
                    <button className="icon" title="重试播放" onClick={async () => {
                      await unlock();
                      setAudioAttempt((value) => value + 1);
                    }}>
                      <Play size={18} />
                    </button>
                  )}
                  <button
                    className="icon"
                    title={muted ? "取消静音" : "静音"}
                    onClick={() => setMuted(!muted)}
                  >
                    {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
                  </button>
                  <input
                    type="range"
                    aria-label="音量"
                    min="0"
                    max="100"
                    value={volume}
                    onChange={(e) => setVolume(Number(e.target.value))}
                  />
                </div>
              </div>
              <div
                className="progress"
                style={{
                  width: `${room.phase === "playing" ? (seconds / room.duration) * 100 : 0}%`,
                }}
              />
            </section>
            {room.phase === "finished" && ranking.length > 0 && (
              <section className="results" aria-label="本局成绩">
                <h2>本局成绩</h2>
                <ol>{ranking.map(p => <li key={p.id}><span>{p.name}{"members" in p && <small className="result-members">{p.members.map(m => `${m.name} ${m.score > 0 ? "+" : ""}${m.score}`).join(" · ")}</small>}</span><strong>{p.score} 分</strong></li>)}</ol>
              </section>
            )}
          </>
        )}
        <div className={"board-area " + (tab === "play" && room?.board.length ? "match-board " : "") + (hideWorks ? "hide-works" : "")}
          style={{ "--board-rows": Math.ceil(displayed.length / 6), "--board-gap-total": `${(Math.ceil(displayed.length / 6) - 1) * 6}px` } as React.CSSProperties}>
        <div className="board-heading">
          <h2>
            {tab === "library"
              ? "全部曲目"
              : room?.board.length
                ? "牌阵"
                : "本期卡面"}
            <span>{displayed.length}</span>
          </h2>
          <div className="board-actions"><span>
            {tab === "play" && room && !idle
              ? `第 ${room.round} 轮 · 剩余 ${room.board.length - room.removed.length} 张`
              : `精选 ${songs.length} 首`}
          </span>
          {tab === "play" && room && !idle && <b className="board-timer" aria-label="本轮剩余秒数">{seconds}s</b>}
          {tab === "play" && room && !idle && player?.role === "player" && (
            <button className="secondary skip-button" title="放弃本轮，不扣分" disabled={!canGuess} onClick={() => guess()}>
              <SkipForward size={16} />{player.skipped ? "已 SKIP" : "SKIP"}
            </button>
          )}
          </div>
        </div>
        {tab === "library" && idle && selected !== null && (
          <section className="library-preview" aria-label="曲目试听">
            <div>
              <strong>{byId.get(selected)?.title}</strong>
              <span>{byId.get(selected)?.work}</span>
            </div>
            <audio key={selected} controls preload="metadata" src={byId.get(selected)?.audio ?? undefined} />
            <button className="icon" title="关闭试听" onClick={() => setSelected(null)}><X size={18} /></button>
          </section>
        )}
        <section
          className={"board " + (displayed.length === 12 ? "compact" : "")}
          aria-label="卡牌列表"
        >
          {displayed.map((song, index) => {
            const inGame = tab === "play" && room && !idle;
            const removed = inGame && room.removed.includes(song.id);
            const revealed =
              inGame && room.phase === "reveal" && room.answer === song.id;
            return (
              <button
                key={song.id}
                className={
                  "card " +
                  (removed ? "removed " : "") +
                  (revealed ? "revealed " : "") +
                  (selected === song.id ? "picked" : "")
                }
                aria-label={hideWorks ? `卡牌 ${song.id}` : `${song.id}. ${song.work}`}
                disabled={
                  !!inGame &&
                  (!canGuess || !!removed)
                }
                onClick={() => {
                  if (inGame) {
                    guess(song.id);
                  } else setSelected(selected === song.id ? null : song.id);
                }}
              >
                <div className="card-image">
                  <img
                    src={song.cover}
                    alt={hideWorks ? `卡牌 ${song.id}` : song.work}
                    width="336"
                    height="480"
                    loading={room?.board.length || index < 12 ? "eager" : "lazy"}
                    draggable={false}
                  />
                  <span className="card-number">
                    {String(song.id).padStart(2, "0")}
                  </span>
                  {removed && (
                    <span className="claimed">
                      <Check size={28} />
                    </span>
                  )}
                </div>
                {!hideWorks && <div className="card-caption">
                  <strong>{song.work}</strong>
                  {!inGame && (tab === "library" || selected === song.id) && (
                    <span>{song.title}</span>
                  )}
                </div>}
              </button>
            );
          })}
        </section>
        </div>
        <footer>
          <span>
            © 复旦沸点漫画社-第⑨动画研究室&amp;沸点技术组·风吟雨
          </span>
          <span>{songs.length} 首曲目 · {MIN_PLAYERS}–{MAX_PLAYERS} 位玩家</span>
        </footer>
      </main>
      <dialog ref={nicknameDialog} className="nickname-dialog" aria-labelledby="nickname-title" onCancel={() => setPendingEntry(null)}>
        <form onSubmit={e => {
          e.preventDefault();
          if (!draftName.trim() || draftName.trim() === "玩家" || !pendingEntry) return;
          const entry = pendingEntry;
          setPendingEntry(null);
          void enter(entry, draftName);
        }}>
          <h2 id="nickname-title">请输入你的昵称</h2>
          <input aria-label="新昵称" value={draftName} onChange={e => setDraftName(e.target.value)} maxLength={16} autoFocus required />
          <div className="dialog-actions">
            <button type="button" className="secondary" onClick={() => setPendingEntry(null)}>取消</button>
            <button type="submit" className="primary" disabled={!draftName.trim() || draftName.trim() === "玩家"}>确定并进入</button>
          </div>
        </form>
      </dialog>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
