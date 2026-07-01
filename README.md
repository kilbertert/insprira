# 灵感熔炉

本地自媒体工作台。

## 功能

- **热榜与趋势**：全网热点聚合；抖音 / 小红书 / 公众号 / AI 公众号 / AI B站 / AI 小红书 / AI 抖音 / AI 快手 / AI 视频号 / 短剧抖音 / 短剧公众号等 11 个源；7/14 天增长 / 稳定 / 冷却趋势
- **Skill 中心**：从 [redfox-community](https://github.com/redfox-community/skills) 拉取并热更新；LLM 自动分类（热点 / 帐号 / 信息源 / 创作 / 分析 / 检索 / 生成工具）；热点 Skill 可一键绑定为热榜 Tab
- **热榜动态 Tab**：默认只显示抖音 / 小红书 / 公众号 3 个基础 Tab，其余平台通过 Skill 绑定后动态创建，解绑即移除
- **选题生成**：基于本地热榜证据 + 公众号爆款搜索，调用 OpenAI 兼容 LLM 生成选题；可联网补全
- **账号追踪**：分组订阅、作品同步、公众号 / 抖音 / 小红书诊断、趋势图表（粉丝 / 红狐指数 / 评分 / 作品数）
- **知识库**：Obsidian / Notion 双源接入 + WeRss（we-mp-rss）公众号文章同步；成稿可一键导出
- **内容创作**：多平台改写（小红书 / 公众号 / 知乎 / 抖音 / 视频号 / 快手 / B站）、RedFox `gpt-image-2` 封面生成、违禁词检测
- **本地 Agent**：Codex / Claude Code / Kimi / OpenClaw / Hermes 子进程集成
- **CRON 调度**：内置每日热榜快照、缓存清理、WeRss 同步、账号追踪刷新等任务；支持自定义、拖拽排序
- **Docker 部署**：Dockerfile + Docker Compose，支持 linux/amd64 与 linux/arm64

## 启动

需 Node.js ≥ 20 或 Docker。**推荐用 Docker dev 工作流**——源码挂载 + `node --watch` 改代码即热重启。

### Docker dev（推荐）

```bash
cp .env.example .env
# 填写 .env
docker compose -f docker-compose.yaml -f docker-compose.dev.yaml up
```

数据落在 `./data/`（与生产编排一致）。改 `server.js` / `js/*` / `index.html` 等会自动重启或刷新。

### Docker 生产

```bash
cp .env.example .env
docker compose up -d
```

镜像：[`ghcr.io/coracoo/insprira`](https://github.com/coracoo/insprira/pkgs/container/insprira)

### 本地 npm（无 Docker 备选）

```bash
npm install
cp .env.example .env
npm run dev    # node --watch，热重启
# 或
npm start      # 一次性启动
```

数据默认落在 `./data/`（与 Docker 一致）。

## 配置

见 [`.env.example`](.env.example)。

## License

[AGPL-3.0](LICENSE)
