# 歌牌 / KARUTA

听到旋律，抢下对应的动漫卡牌。一个支持多人实时对战、自由组队和观战的在线听歌抢牌网站。

## 功能

- **多人房间**：2–8 名玩家实时对战，支持观战和断线重连。
- **60 首精选曲目**：每局随机抽取 12、18 或 30 张动漫卡牌。
- **个人与团队模式**：自由创建、加入和重命名队伍，房主可调整分组、均衡随机分队。
- **同步播放**：服务端管理倒计时和回合进度，支持 30 / 60 秒限时及随机起点玩法。
- **干扰曲**：每 6 张牌加入 1 首不在牌面上的歌曲，考验判断力。
- **移动端适配**：固定卡牌位置，可选择显示作品名；提供曲库试听与赛后排名。

## 快速开始

需要 Node.js 22.18+ 和 npm。在项目目录执行：

```sh
npm ci
npm run dev
```

打开 <http://127.0.0.1:8787>。可使用不同浏览器或独立浏览器配置测试多人游戏。

`npm run dev` 会先构建前端，再启动本地 Cloudflare Worker。修改代码后重新运行该命令以更新前端构建。

## 怎么玩

1. 设置昵称，创建或加入房间，选择参赛或观战。
2. 房主设置牌数、回合时长、作品名提示及个人 / 团队模式。
3. 至少两名玩家在线并全部准备后，自动进入 10 秒开局倒计时；团队模式还要求所有玩家已分队，且至少两队有人。
4. 听歌并点击对应卡牌。服务端最先收到的正确抢答得 **+1 分**；答错 **−1 分**，本回合不能继续抢答。
5. 判断没有对应卡牌时可点击 **SKIP**，不扣分，但本回合不能再抢答。所有在线玩家均跳过或答错时，立即揭晓答案。
6. 全部回合结束后查看排名，支持并列获胜。

团队模式下，答错会锁定整个队伍本回合的抢答，SKIP 仅影响操作的玩家；团队总分决定胜负，同时记录个人贡献。比赛开始后新加入的玩家自动成为观众。检测到断线后保留 15 秒重连宽限期。

随机起点模式会为每轮统一选择 0–10 秒的音频偏移，回合限时固定为 30 秒。更完整的规则、音频同步、昵称彩蛋和重连行为见 [详细说明（英文）](docs/GAMEPLAY.md)。

## 技术栈

| 部分 | 技术 |
| --- | --- |
| 前端 | React 19、TypeScript、Vite、Lucide |
| 实时通信 | WebSocket |
| 服务端 | Cloudflare Workers、Durable Objects |
| 房间状态 | SQLite-backed Durable Object 存储、Alarms |
| 素材处理 | Python、Pillow、openpyxl、FFmpeg |

```text
src/                  页面、样式、共享类型与曲目数据
worker/               房间状态、对局逻辑与音频接口
public/audio/         游戏音频
public/covers/        卡牌封面
scripts/              封面及音频处理工具
tests/                昵称匹配与团队玩法测试
docs/                 详细玩法说明
index.xlsx            原始曲目表
wrangler.jsonc        Cloudflare 部署配置
```

## 常用命令

```sh
npm run build                      # TypeScript 检查与生产构建
npm run preview                    # 运行已构建的站点和本地 Worker
node --test tests/*.test.mjs        # 运行现有测试
npm run deploy                     # 构建并部署至 Cloudflare
```

## 部署到 Cloudflare

```sh
npx wrangler login
npm run deploy
```

在 `wrangler.jsonc` 中修改 `name` 可设置自己的 Worker 名称。部署会上传静态资源和服务端，并执行 Durable Object 的 SQLite 迁移；无需配置 R2、D1 或用户账号系统。部署成功后，Wrangler 会输出访问地址。

## 更新曲库与素材

现有 `src/songs.json`、`public/covers/` 和 `public/audio/` 可直接用于构建。原始图片目录 `img/` 和原始音乐目录 `music/` 不纳入版本管理。

如需重新生成封面，先准备 `index.xlsx` 和以曲目 ID 命名的 `img/` 图片，再执行：

```sh
python -m pip install openpyxl pillow
npm run assets
```

精选曲目 ID 位于 `scripts/prepare_assets.py`，封面输出为 336 × 480 WebP。音频处理工具会匹配曲名、验证源文件至少 60 秒，并输出经过响度归一化的 60 秒 MP3：

```sh
python -m pip install imageio-ffmpeg mutagen
python scripts/prepare_audio.py "path/to/music" --check-only
python scripts/prepare_audio.py "path/to/music"
npm run build
```

匹配及处理报告保存在 `output/audio-report.json`。昵称彩蛋使用 `public/audio/tpz-intro.mp3`，具体触发规则见详细说明。

