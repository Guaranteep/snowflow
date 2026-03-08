# SnowFlow — Snow CLI 全自动工作流调度引擎

> 设计文档 v1.0 | 2026-03-07
> 灵感来源：FlowPilot（Claude Code 版）
> 目标平台：Snow CLI

---

## 一、项目定位

**一个文件，一句需求，全自动开发。**

SnowFlow 是 Snow CLI 的外挂式工作流引擎，单文件 `snowflow.js`，零运行时依赖（仅需 Node.js），复制到任何项目即可使用。

核心理念：
- 主 Agent 只当调度员（上下文 < 100 行），不亲自写代码
- 所有状态持久化到磁盘，不怕中断、不怕 compact
- 子 Agent 并行执行，自动 checkpoint + git commit
- 跨工作流长期记忆，越用越聪明

---

## 二、与 Snow CLI 的关系

```
SnowFlow 不修改 Snow CLI 源码，通过以下方式集成：

┌─────────────────────────────────────────────┐
│                 Snow CLI                     │
│  ┌─────────┐  ┌──────────┐  ┌────────────┐  │
│  │ Hooks   │  │ SubAgent │  │ SysPrompt  │  │
│  │ 系统    │  │ 16个代理  │  │ 协议注入    │  │
│  └────┬────┘  └────┬─────┘  └─────┬──────┘  │
│       │            │              │          │
└───────┼────────────┼──────────────┼──────────┘
        │            │              │
   ┌────▼────────────▼──────────────▼────┐
   │          snowflow.js                 │
   │  ┌──────┐ ┌──────┐ ┌──────┐ ┌────┐ │
   │  │拆解器│ │调度器│ │记忆库│ │进化│ │
   │  └──────┘ └──────┘ └──────┘ └────┘ │
   └──────────────┬──────────────────────┘
                  │
           .snowflow/ (磁盘持久化)
```

集成点：
| 集成方式 | 说明 |
|---------|------|
| Hooks 注入 | `snowflow init` 时自动注册 hooks（onSessionStart → resume, onSubAgentComplete → checkpoint 等） |
| System Prompt | 注入工作流协议到 system-prompt.json，告诉主 Agent 如何调用 snowflow 命令 |
| Sub-Agents 复用 | 直接使用 Snow CLI 已有的 16 个子代理，根据任务类型自动选择 |
| 文件系统 | 状态存在项目级 `.snowflow/` 目录，不污染 `.snow/` 全局配置 |

---

## 三、核心架构

### 3.1 四层记忆

| 层级 | 文件 | 谁读 | 内容 | 大小控制 |
|------|------|------|------|---------|
| L1 | progress.md | 主 Agent | 极简状态表：一行一个任务（ID/标题/状态/摘要） | < 100 行 |
| L2 | context/task-{id}.md | 子 Agent | 每个任务的详细产出、决策记录、修改文件列表 | 每个 < 2KB |
| L3 | context/summary.md | 子 Agent | 滚动摘要：技术栈、架构决策、已完成模块 | < 3KB |
| L4 | memory.json | 子 Agent | 跨工作流长期记忆：标签化知识条目（BM25 检索） | 自动压缩 |

**上下文膨胀解决方案**：
- 主 Agent 每次只读 progress.md（< 100 行），绝不读 task 详情
- 子 Agent 启动时注入：summary.md + 依赖任务的 context + 相关记忆
- 超过 10 个任务时，summary.md 自动压缩旧内容

### 3.2 任务生命周期

```
pending → active → done
           │
           ├─→ failed (重试 3 次后)
           │      │
           │      └─→ 依赖它的任务 → skipped
           │
           └─→ active (中断恢复时重置为 pending)
```

### 3.3 依赖图 (DAG)

```json
{
  "tasks": [
    {"id": "T001", "title": "数据库 Schema", "type": "database", "deps": []},
    {"id": "T002", "title": "用户 API",      "type": "api",      "deps": ["T001"]},
    {"id": "T003", "title": "商品 API",      "type": "api",      "deps": ["T001"]},
    {"id": "T004", "title": "用户页面",       "type": "ui",       "deps": ["T002"]},
    {"id": "T005", "title": "商品页面",       "type": "ui",       "deps": ["T003"]}
  ]
}
```

调度结果：
```
Round 1: [T001]              ← 无依赖，先做
Round 2: [T002, T003]        ← T001 完成后，两个可并行
Round 3: [T004, T005]        ← T002/T003 各自完成后并行
```

### 3.4 任务类型 → 子代理映射

| 任务类型 | 首选子代理 | 备选 |
|---------|-----------|------|
| frontend | ui | general |
| backend | general | api |
| api | api | general |
| database | database | general |
| test | test | general |
| docs | doc | general |
| devops | devops | general |
| refactor | refactor | general |
| security | security | review |
| architecture | architecture | plan |
| general | general | — |

---

## 四、文件结构

```
项目根/
├── snowflow.js              ← 单文件引擎（目标 < 150KB）
└── .snowflow/               ← 工作流持久化目录
    ├── progress.md           ← L1: 极简状态表（主 Agent 只读这个）
    ├── tasks.json            ← 任务定义 + 依赖图 + 元数据
    ├── config.json           ← 工作流配置 + 进化参数
    ├── memory.json           ← L4: 长期记忆库
    ├── context/
    │   ├── summary.md        ← L3: 滚动摘要
    │   ├── task-T001.md      ← L2: 任务 T001 的详细产出
    │   ├── task-T002.md
    │   └── ...
    └── evolution/
        ├── snapshot-001.json ← 进化前快照
        └── history.json      ← 进化历史记录
```

---

## 五、命令设计

```bash
# ═══ 初始化 ═══
snowflow init [--force]
  # 1. 创建 .snowflow/ 目录
  # 2. 注入工作流协议到 Snow CLI 的 system-prompt
  # 3. 注册 hooks（onSessionStart, onSubAgentComplete 等）
  # 4. 提示用户描述需求或提供 tasks.md

# ═══ 任务管理 ═══
snowflow plan "<需求描述>"
  # 调用 LLM 拆解需求 → 生成 tasks.json + progress.md
  # 输出任务列表供用户确认

snowflow next
  # 返回下一个可执行任务 + 依赖上下文 + 相关记忆
  # 输出格式供主 Agent 直接派发子 Agent

snowflow next --batch
  # 返回所有当前可并行的任务（依赖已满足的）
  # 主 Agent 在同一轮批量派发多个子 Agent

snowflow checkpoint <id> [--status done|failed]
  # 记录任务完成/失败
  # 从 stdin 读取子 Agent 的产出摘要
  # 自动知识提取 → 存入 memory.json
  # 自动 git commit（可配置）
  # 更新 progress.md

snowflow add "<描述>" [--type frontend|backend|api|...]  [--after <id>]
  # 运行中追加新任务
  # 自动分析依赖关系插入 DAG

snowflow skip <id>
  # 手动跳过任务（级联跳过依赖它的后续任务）

# ═══ 流程控制 ═══
snowflow resume
  # 中断恢复：active 状态重置为 pending，从断点继续

snowflow status
  # 查看全局进度：完成数/总数/当前轮次/耗时

snowflow finish
  # 智能收尾：
  # 1. 检查是否所有任务完成
  # 2. 自动跑 build/test/lint（识别项目类型）
  # 3. 触发 Reflect + Experiment（进化）
  # 4. 生成最终总结

# ═══ 记忆系统 ═══
snowflow recall "<关键词>"
  # 检索长期记忆（BM25）

# ═══ 进化 ═══
snowflow evolve
  # 接收反思结果，应用进化参数

snowflow review
  # 对比进化前后指标，退化自动回滚
```

---

## 六、协议模板（注入 System Prompt）

以下协议在 `snowflow init` 时自动注入 Snow CLI 的系统提示词：

```markdown
## SnowFlow 工作流协议

你是工作流调度员。你的职责是调度任务，不要亲自写代码。

### 工作流程
1. 用户描述需求后，执行 `node snowflow.js plan "需求描述"`
2. 确认任务列表后，循环执行：
   a. `node snowflow.js next --batch` 获取可执行任务
   b. 为每个任务派发对应的子 Agent（根据任务 type 选择）
   c. 子 Agent 完成后，执行 `node snowflow.js checkpoint <id>`
3. 所有任务完成后，执行 `node snowflow.js finish`

### 调度规则
- 你只读 .snowflow/progress.md，不要读 task 详情文件
- 每次只处理 next 返回的任务，不要跳过或自己决定顺序
- 子 Agent 的产出通过 checkpoint 的 stdin 传入，你不需要转述
- 如果任务失败 3 次，跳过它并继续下一个

### 子 Agent 派发模板
派发子 Agent 时，使用以下上下文格式：
- 任务描述：{task.description}
- 依赖上下文：{由 next 命令提供}
- 相关记忆：{由 next 命令提供}
- 完成后执行：node snowflow.js checkpoint {task.id}
```

---

## 七、Hooks 集成方案

| Snow CLI Hook | SnowFlow 行为 | 实现方式 |
|---------------|--------------|---------|
| onSessionStart | 检测 .snowflow/ 是否存在，自动 resume | command: `node snowflow.js resume --silent` |
| onSubAgentComplete | 自动 checkpoint（提取 agent 产出） | command: `node snowflow.js auto-checkpoint` |
| beforeCompress | 保存当前上下文到 summary.md | command: `node snowflow.js save-context` |
| onStop | 暂停工作流，保存状态 | command: `node snowflow.js pause` |

Hooks 注册示例（`snowflow init` 自动写入）：
```json
// ~/.snow/hooks/onSessionStart.json 或 .snow/hooks/onSessionStart.json
{
  "onSessionStart": [
    {
      "description": "SnowFlow 自动恢复",
      "hooks": [
        {
          "type": "command",
          "command": "node snowflow.js resume --silent",
          "timeout": 5000,
          "enabled": true
        }
      ]
    }
  ]
}
```

---

## 八、实施阶段

### Phase 1：骨架 + 任务管理（能跑起来）

**目标**：能拆任务、能看进度、能手动推进

| # | 文件/模块 | 任务 | 输入 | 输出 |
|---|----------|------|------|------|
| 1.1 | `snowflow.js` 入口 | CLI 命令路由 + 参数解析 | process.argv | 调用对应模块 |
| 1.2 | `task-store` | 任务 CRUD + 状态流转 | tasks.json | 状态更新 |
| 1.3 | `progress-renderer` | 生成 progress.md | tasks.json | progress.md |
| 1.4 | `init` 命令 | 创建 .snowflow/ + 初始配置 | — | 目录结构 |
| 1.5 | `plan` 命令 | 需求 → 任务列表（先用模板，后接 LLM） | 需求字符串 | tasks.json |
| 1.6 | `next` 命令 | 依赖分析 → 返回可执行任务 | tasks.json | 任务 + 上下文 |
| 1.7 | `checkpoint` 命令 | 记录完成 + 更新进度 | task id + stdin | task-{id}.md |
| 1.8 | `status` 命令 | 显示全局进度 | tasks.json | 格式化输出 |
| 1.9 | `skip` 命令 | 跳过任务 + 级联跳过 | task id | 状态更新 |

**验收标准**：
- `snowflow init` 能创建目录结构
- `snowflow plan "做一个博客"` 能生成任务列表
- `snowflow next` 能返回正确的下一个任务
- `snowflow checkpoint T001` 能记录产出
- `snowflow status` 能显示进度
- 全程零外部依赖

### Phase 2：调度 + 并行 + Git

**目标**：能自动并行、能 checkpoint 自动 commit

| # | 模块 | 任务 |
|---|------|------|
| 2.1 | `scheduler` | DAG 拓扑排序 + 并行任务批量返回 |
| 2.2 | `next --batch` | 返回所有可并行任务 |
| 2.3 | `git-auto` | checkpoint 时自动 `git add + commit` |
| 2.4 | `resume` 命令 | 中断恢复（active → pending） |
| 2.5 | `add` 命令 | 运行中追加任务到 DAG |
| 2.6 | `verifier` | 自动识别项目类型，跑 build/test/lint |
| 2.7 | `finish` 命令 | 智能收尾（验证 + 总结 + 最终提交） |

**验收标准**：
- `next --batch` 能正确返回可并行的任务集
- checkpoint 后自动 git commit
- 中断后 resume 能从断点继续
- finish 能自动识别 Node/Python/Go/Rust 项目并跑验证

### Phase 3：记忆系统

**目标**：跨工作流记忆，子 Agent 越来越懂项目

| # | 模块 | 任务 |
|---|------|------|
| 3.1 | `memory-store` | memory.json 读写 + 标签管理 |
| 3.2 | `knowledge-extractor` | 从 checkpoint 摘要提取知识（规则引擎） |
| 3.3 | `bm25-search` | BM25 稀疏向量检索 + 中文分词 |
| 3.4 | `context-builder` | next 时拼装：summary + 依赖 context + 相关记忆 |
| 3.5 | `summary-roller` | 滚动摘要：超 10 个任务自动压缩 |
| 3.6 | `recall` 命令 | 手动查询记忆 |

**验收标准**：
- checkpoint 自动提取 `[REMEMBER]` `[DECISION]` `[ARCHITECTURE]` 标签知识
- next 时自动注入相关记忆到子 Agent 上下文
- recall 能按关键词检索历史知识
- summary.md 在任务超过 10 个时自动压缩

### Phase 4：进化引擎 + 防护

**目标**：每轮工作流结束自动反思优化

| # | 模块 | 任务 |
|---|------|------|
| 4.1 | `reflect` | 分析本轮成败模式（失败链、重试热点） |
| 4.2 | `experiment` | 自动调整 config 参数（并行度、重试次数） |
| 4.3 | `review-check` | 对比进化前后指标，退化自动回滚 |
| 4.4 | `loop-detector` | 循环检测（重复失败/乒乓/全局熔断） |
| 4.5 | `heartbeat` | 活跃任务超时告警（> 30 分钟） |
| 4.6 | `evolve` 命令 | 接收 LLM 反思结果并应用 |

**验收标准**：
- finish 触发自动反思，输出 findings
- 连续失败 3 次同类任务触发熔断
- 进化导致退化时自动回滚
- config.json 中的 hints 被注入到后续任务上下文

### Phase 5：Snow CLI 深度集成

**目标**：无缝集成，配置面板可管理

| # | 模块 | 任务 |
|---|------|------|
| 5.1 | `hooks-installer` | init 时自动注册 Snow CLI hooks |
| 5.2 | `protocol-injector` | 注入工作流协议到 system-prompt |
| 5.3 | `agent-matcher` | 根据任务 type 自动匹配最佳子代理 |
| 5.4 | `snow_config 面板` | 在配置面板添加 SnowFlow 管理页面 |
| 5.5 | `auto-checkpoint` | onSubAgentComplete 时自动 checkpoint |

**验收标准**：
- `snowflow init` 一键完成所有 Snow CLI 集成
- 子 Agent 完成时自动触发 checkpoint
- 配置面板能查看工作流状态和历史

---

## 九、技术要点

### 9.1 零依赖约束

整个引擎只使用 Node.js 内置模块：
- `fs` / `path` — 文件操作
- `child_process` — 执行 git 命令和验证命令
- `crypto` — 哈希（记忆去重、循环检测）

不依赖任何 npm 包。如果需要 LLM 增强功能（智能知识提取、进化反思），通过 `https` 模块直接调 API，无 key 时降级到规则引擎。

### 9.2 多语言项目识别

| 标志文件 | 项目类型 | Build 命令 | Test 命令 |
|---------|---------|-----------|----------|
| package.json | Node.js | npm run build | npm test |
| Cargo.toml | Rust | cargo build | cargo test |
| go.mod | Go | go build ./... | go test ./... |
| requirements.txt / pyproject.toml | Python | — | pytest |
| pom.xml | Java/Maven | mvn package | mvn test |
| build.gradle | Java/Gradle | gradle build | gradle test |
| Makefile | Make | make | make test |
| CMakeLists.txt | C/C++ | cmake --build . | ctest |

### 9.3 进化参数

```json
{
  "maxRetries": 3,
  "parallelLimit": 4,
  "checkpointAutoCommit": true,
  "hints": [
    "优先使用 TypeScript 而非 JavaScript",
    "数据库操作使用事务包裹"
  ],
  "evolution": {
    "generation": 1,
    "lastReflect": "2026-03-07T...",
    "successRate": 0.85
  }
}
```

### 9.4 循环检测三策略

| 策略 | 触发条件 | 行为 |
|------|---------|------|
| 重复失败 | 同一任务连续失败 N 次 | 标记 failed，级联跳过 |
| 乒乓检测 | A 修改被 B 回滚，又被 A 修改 | 警告注入到下一任务上下文 |
| 全局熔断 | 连续 M 个任务失败 | 暂停工作流，等待人工介入 |

---

## 十、与 FlowPilot 的差异

| 维度 | FlowPilot | SnowFlow |
|------|-----------|----------|
| 目标平台 | Claude Code | Snow CLI |
| 协议注入 | CLAUDE.md | system-prompt.json |
| 子代理调度 | Task 工具 | Snow 的 subagent-* |
| Hooks | CC 原生 hooks | Snow 的 hooks 系统 |
| 代理选择 | 3 种（frontend/backend/general）| 16 种专业代理 |
| 配置管理 | 无 UI | Snow Config 面板集成 |
| 构建方式 | TypeScript + rollup | 可选（单文件 JS 或 TypeScript 构建） |

**SnowFlow 的优势**：16 个专业子代理 vs FlowPilot 的 3 个，任务分配更精准。

---

## 十一、风险与应对

| 风险 | 影响 | 应对 |
|------|------|------|
| Snow CLI 子代理串行限制 | 无法真正并行 | batch 模式让主 Agent 在同一轮连续派发，利用 Snow CLI 已有的并发能力 |
| 上下文膨胀 | 主 Agent 变慢 | 严格执行四层记忆，主 Agent 只读 progress.md |
| LLM 拆解质量不稳定 | 任务粒度不合理 | 提供模板 + 人工确认环节 + 支持手动追加/调整 |
| 进化参数过拟合 | 越进化越差 | Review 阶段自动回滚 + 快照保护 |
| Hooks 时序冲突 | 多个 hook 同时触发 | 每个 hook 加超时保护 + 错误不阻塞主流程 |

---

## 十二、开发顺序建议

```
Phase 1（骨架）→ 能用了，手动推进
      ↓
Phase 2（调度）→ 能自动并行 + git commit
      ↓
Phase 3（记忆）→ 有长期记忆，越用越智能
      ↓
Phase 4（进化）→ 自我优化，完整体
      ↓
Phase 5（集成）→ 与 Snow CLI 无缝衔接
```

**建议先做 Phase 1 + Phase 2，就能投入使用了。** Phase 3-5 属于锦上添花。

---

*文档结束。新开工作区后，按此计划逐步实施。*
