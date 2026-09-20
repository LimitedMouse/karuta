import { Check, Plus, Shuffle, Trash2, UserPlus } from "lucide-react";
import { MAX_TEAMS, type Player, type RoomState } from "./shared";

const colors = ["#167e6c", "#b45d73", "#467cbb", "#a47b20", "#8a66ac", "#bd633f", "#508139", "#527d87"];

export function TeamRoster({ room, me, now, editable, connected, send }: {
  room: RoomState; me: string; now: number; editable: boolean; connected: boolean;
  send: (message: object) => void;
}) {
  const participants = room.players.filter(p => p.role === "player");
  const self = participants.find(p => p.id === me);
  const host = room.host === me;
  const unassigned = participants.filter(p => !room.teams.some(t => t.id === p.teamId));
  const visibleTeams = room.teams.filter(t => editable || participants.some(p => p.teamId === t.id) || room.teamResults.some(r => r.id === t.id));
  const member = (p: Player) => (
    <div className={"team-member " + (p.id === me ? "is-self" : "")} key={p.id}>
      <div className="team-member-name"><strong title={p.name}>{p.name}</strong>{p.id === me && <small>你</small>}</div>
      {editable && host ? <select aria-label={`分配 ${p.name}`} value={p.teamId || ""} disabled={!connected}
        onChange={e => send({ type: "team-join", playerId: p.id, teamId: e.target.value })}>
        <option value="">未入队</option>{room.teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select> : null}
      <span className={p.ready ? "member-ready" : ""}>{!p.online
        ? `离线 ${Math.max(0, Math.ceil((p.leaveAt - now) / 1000))}s`
        : editable ? p.ready ? "已准备" : p.id === room.host ? "房主" : "待准备"
          : p.skipped ? "已 SKIP" : p.locked ? "已锁定" : room.phase === "playing" ? "抢答中" : "等待中"}</span>
    </div>
  );
  return <div className={"team-roster " + (!editable ? "team-roster-playing" : "")}>
    {editable && <div className="team-toolbar">
      <span>{room.teams.length} / {MAX_TEAMS} 队 · {participants.length} 人</span>
      <div className="team-tools">
        {self && <button className="secondary" disabled={!connected || room.teams.length >= MAX_TEAMS}
          onClick={() => send({ type: "team-create" })}><Plus size={15} />新建并加入</button>}
        {host && <>
          <button className="icon" title="新增空队伍" disabled={!connected || room.teams.length >= MAX_TEAMS}
            onClick={() => send({ type: "team-create", empty: true })}><Plus size={18} /></button>
          <button className="secondary" disabled={!connected || room.teams.length < 2 || participants.length < 2}
            onClick={() => send({ type: "team-shuffle" })}><Shuffle size={15} />随机均分</button>
        </>}
      </div>
    </div>}
    {unassigned.length > 0 && <div className="unassigned"><span>未入队 · {unassigned.length}</span><div>{unassigned.map(member)}</div></div>}
    <div className="team-grid" style={{ "--team-columns": Math.min(4, visibleTeams.length) || 1 } as React.CSSProperties}>
      {visibleTeams.map(team => {
        const members = participants.filter(p => p.teamId === team.id);
        const mine = self?.teamId === team.id;
        return <div key={team.id} className={"team-group " + (mine ? "my-team" : "")}
          style={{ "--team-color": colors[team.color % colors.length] } as React.CSSProperties}>
          <div className="team-heading">
            <i />
            {editable ? <input key={team.name} title={team.name} aria-label={`队名 ${team.name}`} defaultValue={team.name} maxLength={16}
              readOnly={!connected || (!host && !mine)}
              onBlur={e => { if (e.target.value.trim() !== team.name) send({ type: "team-rename", teamId: team.id, name: e.target.value }); if (!e.target.value.trim()) e.target.value = team.name; }}
              onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }} />
              : <strong title={team.name}>{team.name}</strong>}
            {editable ? <span className="team-size">{members.length} 人</span> : <b className="team-score">{team.score}</b>}
            {editable && self && <button className="icon" title={mine ? "已加入" : `加入 ${team.name}`} disabled={!connected || mine}
              onClick={() => send({ type: "team-join", teamId: team.id })}>{mine ? <Check size={16} /> : <UserPlus size={16} />}</button>}
            {editable && host && !members.length && <button className="icon" title={`删除 ${team.name}`} disabled={!connected}
              onClick={() => send({ type: "team-delete", teamId: team.id })}><Trash2 size={15} /></button>}
          </div>
          {!editable && <div className={"team-round-status " + (team.locked ? "team-locked" : "")}>{team.locked ? "本轮已锁定" : mine ? "我的队伍" : `${members.length} 人`}</div>}
          <div className="team-members">{members.length ? members.map(member) : <span className="team-empty">{editable ? "空队伍" : "成员已离开"}</span>}</div>
        </div>;
      })}
    </div>
  </div>;
}
