export type Phase = "lobby" | "starting" | "countdown" | "playing" | "reveal" | "finished";
export type Role = "player" | "spectator";
export type Mode = "solo" | "teams";
export interface Team {
  id: string;
  name: string;
  color: number;
  score: number;
  locked: boolean;
}
export interface PlayerResult {
  id: string;
  name: string;
  score: number;
  teamId?: string;
}
export interface TeamResult extends Team {
  members: PlayerResult[];
}
export interface Player {
  id: string;
  name: string;
  score: number;
  ready: boolean;
  online: boolean;
  locked: boolean;
  skipped: boolean;
  role: Role;
  leaveAt: number;
  tpzIntro?: boolean;
  teamId?: string;
}
export interface RoomState {
  code: string;
  host: string;
  players: Player[];
  mode: Mode;
  teams: Team[];
  teamResults: TeamResult[];
  phase: Phase;
  duration: 30 | 60;
  randomStart: boolean;
  audioOffset: number;
  board: number[];
  removed: number[];
  round: number;
  total: number;
  deadline: number;
  startsAt: number;
  audio: string | null;
  answer: number | null;
  winner: string | null;
  showWorks: boolean;
  results: PlayerResult[];
}
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
export const MAX_TEAMS = 8;
