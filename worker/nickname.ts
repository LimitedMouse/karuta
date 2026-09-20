import { pinyin } from "pinyin-pro";

export function matchesTpzNickname(name: string): boolean {
  const initials = pinyin(name, {
    pattern: "first",
    type: "array",
    nonZh: "consecutive",
  }).join("");
  return /tpz/i.test(initials);
}
