# SnowFlow v2.0

**一个文件，一句需求，全自动开发。**

SnowFlow 是 Snow CLI 的外挂式工作流调度引擎，单文件 `snowflow.js`，零运行时依赖（仅需 Node.js），全局安装后一条命令即可使用。

---

## ✨ 特性

- 🧠 **四层记忆** — progress.md → task context → summary → memory.json，主 Agent 上下文 < 100 行
- 📊 **DAG 依赖图** — 自动拓扑排序 + 并行任务调度
- 🔄 **自动 checkpoint** — 任务完成自动 git commit + 知识提取
- 🧬 **进化引擎** — 7 条进化规则 + 反思分析 + 时间维度分析 + 退化回滚
- 🔍 **BM25 检索** — 120+ 停用词 + camelCase 拆分 + 时间衰减
- 🛡️ **多重防护** — 循环检测 + 乒乓检测 + 全局熔断 + 心跳超时
- 🤖 **子代理匹配** — 11 种任务类型自动推荐最佳子代理
- 📋 **动态协议** — 根据项目类型和工作流阶段自动生成调度协议
- ⏸️ **暂停恢复** — 随时暂停/恢复工作流，支持上下文快照
- ⚙️ **运行时配置** — 9 项可调参数，CLI 实时修改
- 📦 **零依赖** — 单文件 ~115KB，仅用 Node.js 内置模块

---

## 🚀 快速开始

### 前置要求

- Node.js >= 14

### 安装

```bash
# 克隆仓库
git clone https://github.com/Guaranteep/snowflow.git
cd snowflow

# 全局安装（一次性操作）
npm link
```

安装完成后，`snowflow` 命令全局可用。

### 在项目中使用

```bash
cd 你的项目目录
snowflow init
```

`init` 会自动完成：

- 📁 创建 `.snowflow/` 工作流目录
- 📋 写入 `.snow/rules/snowflow.md`（Snow CLI 自动加载规则）
- 🔗 注册 Snow CLI hooks（自动恢复/checkpoint/上下文保存）
- 📄 生成工作流协议文件

### 30 秒上手

```bash
# 1. 初始化
snowflow init

# 2. 描述需求，自动拆解任务
snowflow plan "做一个博客系统"

# 3. 获取下一个任务
snowflow next

# 4. 任务完成后记录
snowflow checkpoint T001 --message "数据库设计完成"

# 5. 全部完成后收尾
snowflow finish
```

---

## 📖 命令参考（18 个命令）

### 核心工作流

#### init — 初始化

```bash
snowflow init [--force]
```

创建 `.snowflow/` 目录结构，生成动态工作流协议，注册 4 个 Snow CLI hooks。`--force` 强制重新初始化。

#### plan — 任务规划

```bash
snowflow plan "<需求描述>" [--force] [--import <file>]
```

- 根据需求描述自动拆解为任务列表（内置 5 个项目模板）
- `--force`：清空已有任务后重新规划
- `--import <file>`：从 Markdown 文件导入任务列表

导入格式：

```markdown
- [ ] T001: 设计数据库 (type: database, deps: )
- [ ] T002: 实现 API (type: backend, deps: T001)
- [ ] 编写测试
```

#### next — 获取任务

```bash
snowflow next [--batch] [--force]
```

返回下一个可执行任务 + 上下文信息 + 推荐子代理。

- 默认：返回 1 个任务并标记为 active
- `--batch`：返回所有可并行任务
- `--force`：跳过暂停/熔断检查强制获取
- 自动检查：心跳超时告警 → 暂停检查 → 熔断检查 → 获取任务

#### checkpoint — 任务打卡

```bash
snowflow checkpoint <id> [--status done|failed] [--message "摘要"]
```

记录任务完成或失败。完成时自动：提取知识 → git commit → 滚动摘要检查。

支持知识标签：

```bash
snowflow checkpoint T001 --message "[REMEMBER] 用了 PostgreSQL [DECISION] 微服务架构"
```

#### auto-checkpoint — 自动匹配打卡

```bash
snowflow auto-checkpoint ["<摘要>"] [--status done|failed]
```

自动匹配当前 active 任务（单任务直接匹配，多任务用 BM25 匹配最相关的）。

#### status — 查看进度

```bash
snowflow status [--json]
```

显示全局进度 + 可视化进度条 + 各状态任务统计。`--json` 输出 JSON 格式。

#### skip — 跳过任务

```bash
snowflow skip <id>
```

级联跳过该任务及所有依赖它的下游任务。

#### finish — 智能收尾

```bash
snowflow finish
```

依次执行：任务完成检查 → 项目验证（8 种项目类型）→ 反思分析（含时间维度）→ 自动进化（7 条规则）→ 生成总结 → git commit。

### 流程控制

#### pause — 暂停工作流

```bash
snowflow pause
```

暂停工作流，所有 active 任务回退为 pending。

#### resume — 恢复工作流

```bash
snowflow resume [--silent]
```

恢复暂停的工作流 + 将 active 任务重置为 pending。`--silent` 静默模式（用于 hooks 自动恢复）。

#### add — 追加任务

```bash
snowflow add "<描述>" [--type <type>] [--after <id,id>]
```

运行中追加新任务到 DAG。

#### reset-breaker — 重置熔断器

```bash
snowflow reset-breaker
```

连续失败触发熔断后，重置失败任务的重试计数。

### 记忆与配置

#### recall — 记忆管理

```bash
snowflow recall ["<关键词>"]     # 搜索记忆
snowflow recall --stats          # 记忆库统计
snowflow recall --clean          # 清理过期/低分记忆
snowflow recall --export         # 导出为 Markdown
```

BM25 检索长期记忆（120+ 停用词、camelCase 拆分、时间衰减）。

#### config — 配置管理

```bash
snowflow config                   # 查看当前配置
snowflow config set <key> <value> # 设置配置项
snowflow config reset             # 重置为默认配置
```

可配置项：

| 配置项                   | 默认值 | 说明                       |
| ------------------------ | ------ | -------------------------- |
| maxRetries               | 3      | 任务最大重试次数           |
| parallelLimit            | 4      | 并行任务上限               |
| checkpointAutoCommit     | true   | checkpoint 自动 git commit |
| heartbeatTimeoutMinutes  | 30     | 任务心跳超时（分钟）       |
| contextMaxSize           | 4000   | 上下文最大字符数           |
| summaryCompressThreshold | 10     | 摘要压缩触发阈值           |
| memoryHalfLifeDays       | 30     | 记忆时间衰减半衰期（天）   |

#### save-context — 上下文快照

```bash
snowflow save-context
```

输出当前工作流上下文快照（进度、活跃任务、摘要、关键记忆），用于长对话保存。

### 进化引擎

#### evolve — 应用进化

```bash
snowflow evolve
```

读取最新反思报告，自动调参（7 条规则 + hints 自清理 + 进化历史记录）。

#### review — 审查进化

```bash
snowflow review
```

多维度对比进化前后指标（成功率、重试次数、hints 变化），退化时自动回滚。

---

## 🏗️ 架构

### 四层记忆体系

| 层级 | 文件                   | 谁读     | 内容               | 大小       |
| ---- | ---------------------- | -------- | ------------------ | ---------- |
| L1   | `progress.md`          | 主 Agent | 极简状态表         | < 100 行   |
| L2   | `context/task-{id}.md` | 子 Agent | 每个任务的详细产出 | 每个 < 2KB |
| L3   | `context/summary.md`   | 子 Agent | 滚动摘要           | < 3KB      |
| L4   | `memory.json`          | 子 Agent | 跨工作流长期记忆   | 自动压缩   |

### 任务状态机

```
pending → active → done
           │
           ├─→ failed (重试 N 次后)
           │      └─→ 依赖它的任务 → skipped
           │
           ├─→ pause → pending (恢复后)
           │
           └─→ 中断恢复 → pending
```

### 任务类型 → 子代理映射

| 任务类型     | 首选子代理   | 备选    |
| ------------ | ------------ | ------- |
| frontend     | ui           | general |
| backend      | general      | api     |
| api          | api          | general |
| database     | database     | general |
| test         | test         | general |
| docs         | doc          | general |
| devops       | devops       | general |
| refactor     | refactor     | general |
| security     | security     | review  |
| architecture | architecture | plan    |
| general      | general      | —       |

### 目录结构

```
项目根/
├── snowflow.js              ← 单文件引擎（~115KB）
└── .snowflow/               ← 工作流持久化目录
    ├── progress.md           ← L1: 极简状态表
    ├── tasks.json            ← 任务定义 + 依赖图
    ├── config.json           ← 配置 + 进化参数
    ├── memory.json           ← L4: 长期记忆库
    ├── protocol.md           ← 动态工作流协议
    ├── summary-final.md      ← finish 生成的最终总结
    ├── memory-export.md      ← recall --export 导出
    ├── context/
    │   ├── summary.md        ← L3: 滚动摘要
    │   └── task-T001.md      ← L2: 任务详细产出
    └── evolution/
        ├── reflect-*.json    ← 反思报告（含时间分析）
        ├── snapshot-*.json   ← 进化前配置快照
        └── history.json      ← 进化历史记录
```

---

## 🧬 进化引擎

SnowFlow 在每轮工作流结束后自动反思和进化：

### 反思分析（6 维度）

1. **整体成功率** — done / total
2. **失败链分析** — 按类型聚集分析
3. **重试热点** — 高重试任务识别
4. **级联跳过** — 上游失败导致的跳过
5. **时间效率** — 平均耗时 + 按类型统计 + 异常任务识别
6. **改进建议** — 基于以上维度自动生成

### 进化规则（7 条）

| #   | 触发条件           | 行为                         |
| --- | ------------------ | ---------------------------- |
| 1   | 成功率 < 50%       | 增加 maxRetries（上限 5）    |
| 2   | 成功率 > 80%       | 降低 maxRetries（下限 2）    |
| 3   | 某类型失败聚集     | 追加 hints 提醒              |
| 4   | 重试热点 > 2       | 增加 parallelLimit（上限 6） |
| 5   | 某类型成功率 < 30% | 建议拆分该类型任务           |
| 6   | 平均耗时 > 60 分钟 | 建议降低任务粒度             |
| 7   | hints > 10 条      | 自动清理，保留最近 10 条     |

### 退化审查

- 多维度对比：成功率、重试次数、hints 变化
- 综合退化评分
- 退化时自动回滚到上一代配置快照

---

## 🛡️ 多重防护

| 策略     | 触发条件              | 行为                             |
| -------- | --------------------- | -------------------------------- |
| 重复失败 | 同一任务连续失败 N 次 | 标记 failed，级联跳过下游        |
| 乒乓检测 | 任务重试 ≥ 2 次仍循环 | 告警提示，建议 skip              |
| 全局熔断 | 连续 ≥ 3 个任务失败   | 阻断 next，需 reset-breaker 解除 |
| 心跳超时 | 任务活跃超过阈值      | 告警提示（默认 30 分钟）         |

---

## 🔌 Snow CLI 集成

`init` 自动注册 4 个 hooks：

| Hook 事件          | 触发命令          | 说明                 |
| ------------------ | ----------------- | -------------------- |
| onSessionStart     | `resume --silent` | 会话开始自动恢复     |
| onSubAgentComplete | `auto-checkpoint` | 子代理完成自动打卡   |
| beforeCompress     | `save-context`    | 上下文压缩前保存快照 |
| onStop             | `pause`           | 会话结束自动暂停     |

---

## 🔨 项目类型检测

`finish` 命令自动识别以下项目类型并执行验证：

| 标志文件         | 项目类型 | Build 命令      | Test 命令     |
| ---------------- | -------- | --------------- | ------------- |
| package.json     | Node.js  | npm run build   | npm test      |
| Cargo.toml       | Rust     | cargo build     | cargo test    |
| go.mod           | Go       | go build ./...  | go test ./... |
| requirements.txt | Python   | —               | pytest        |
| pom.xml          | Maven    | mvn package     | mvn test      |
| build.gradle     | Gradle   | gradle build    | gradle test   |
| Makefile         | Make     | make            | make test     |
| CMakeLists.txt   | CMake    | cmake --build . | ctest         |

动态协议还会根据检测到的项目类型自动注入构建/测试命令提示。

---

## 📝 知识提取

checkpoint 时支持以下标签自动提取知识到长期记忆库：

```
[REMEMBER] xxx      → 通用知识
[DECISION] xxx      → 技术决策
[ARCHITECTURE] xxx  → 架构决策
[IMPORTANT] xxx     → 重要信息
[NOTE] xxx          → 笔记
```

无标签时自动提取：高分句子（技术关键词密度）+ 技术栈 + 文件路径 + API 端点。

---

## 🙏 致谢

- [FlowPilot](https://github.com/6BNBN/FlowPilot) — 灵感来源，SnowFlow 的概念层约 85% 复刻自 FlowPilot（Claude Code 版）
- [Snow CLI](https://github.com/MayDay-wpf/snow-cli) — SnowFlow 的宿主调度平台

---

## 📄 License

MIT — 详见 [LICENSE](./LICENSE)
