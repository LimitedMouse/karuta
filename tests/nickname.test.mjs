import assert from "node:assert/strict";
import test from "node:test";
import { matchesTpzNickname } from "../worker/nickname.ts";

test("matches consecutive TPZ after converting Chinese to pinyin initials", () => {
  for (const name of [
    "tpz 2.0", "TpZ232", "friend-TPZ-1",
    "\u7cd6\u76ae\u8d28", "\u56fe\u7247\u4e2d\u7684", "\u5929\u5e73\u5ea7",
    "\u7cd6P\u8d28", "T\u76aeZ",
  ]) {
    assert.equal(matchesTpzNickname(name), true, name);
  }
});

test("preserves separators and rejects unrelated initials", () => {
  for (const name of [
    "", "T-P-Z", "t p z", "t2pz", "ordinary",
    "\u7cd6 \u76ae\u8d28", "\u7cd6\u76ae2\u8d28", "\u56fe\u7247", "\u73a9\u5bb6",
  ]) {
    assert.equal(matchesTpzNickname(name), false, name);
  }
});
