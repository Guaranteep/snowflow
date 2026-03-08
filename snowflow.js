#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ═══ 常量定义 ═══
const SNOWFLOW_DIR = ".snowflow";
const TASKS_FILE = path.join(SNOWFLOW_DIR, "tasks.json");
const PROGRESS_FILE = path.join(SNOWFLOW_DIR, "progress.md");
const CONFIG_FILE = path.join(SNOWFLOW_DIR, "config.json");
const SUMMARY_FILE = path.join(SNOWFLOW_DIR, "context", "summary.md");
const CONTEXT_DIR = path.join(SNOWFLOW_DIR, "context");
const EVOLUTION_DIR = path.join(SNOWFLOW_DIR, "evolution");
const MEMORY_FILE = path.join(SNOWFLOW_DIR, "memory.json");

// 默认配置
const DEFAULT_CONFIG = {
  maxRetries: 3,
  parallelLimit: 4,
  checkpointAutoCommit: true,
  contextMaxSize: 4000, // 上下文最大字符数
  summaryCompressThreshold: 10, // 摘要压缩触发阈值
  memoryHalfLifeDays: 30, // 记忆半衰期（天）
  heartbeatTimeoutMinutes: 30, // 心跳超时阈值（分钟）
  hints: [],
  evolution: {
    generation: 1,
    lastReflect: null,
    successRate: 0,
  },
};

// 任务状态常量
const STATUS = {
  PENDING: "pending",
  ACTIVE: "active",
  DONE: "done",
  FAILED: "failed",
  SKIPPED: "skipped",
};

// 任务类型
const TASK_TYPES = [
  "frontend",
  "backend",
  "api",
  "database",
  "test",
  "docs",
  "devops",
  "refactor",
  "security",
  "architecture",
  "general",
];

// 状态 emoji 映射
const STATUS_EMOJI = {
  [STATUS.PENDING]: "⏳",
  [STATUS.ACTIVE]: "🔄",
  [STATUS.DONE]: "✅",
  [STATUS.FAILED]: "❌",
  [STATUS.SKIPPED]: "⏭️",
};

// 合法状态流转
const VALID_TRANSITIONS = {
  [STATUS.PENDING]: [STATUS.ACTIVE, STATUS.SKIPPED],
  [STATUS.ACTIVE]: [STATUS.DONE, STATUS.FAILED, STATUS.SKIPPED],
  [STATUS.DONE]: [STATUS.SKIPPED],
  [STATUS.FAILED]: [STATUS.SKIPPED],
  [STATUS.SKIPPED]: [],
};

// SnowFlow 规则文件模板（供 init 命令写入项目）
const SNOWFLOW_RULE_CONTENT = [
  "# SnowFlow 自动工作流调度规则",
  "",
  "你的项目中集成了 SnowFlow 工作流引擎。你必须在合适的时机自动使用它来管理复杂任务，用户不需要手动输入任何 SnowFlow 命令。",
  "",
  "## 何时启用 SnowFlow",
  "",
  "当用户的需求满足以下任一条件时，自动启用 SnowFlow：",
  "- 涉及 3 个以上文件的修改",
  "- 需要新建多个文件或组件",
  "- 涉及架构调整或复杂业务逻辑",
  "- 预计实施步骤超过 5 步",
  '- 用户明确说"帮我做一个 XXX"之类的大型需求',
  "",
  "对于简单修改（改个 bug、调个样式、改一行配置），直接做，不需要启动 SnowFlow。",
  "",
  "## 自动工作流程",
  "",
  "### 1. 自动初始化",
  "如果 `.snowflow/` 目录不存在，自动执行：",
  "```bash",
  "snowflow init",
  "```",
  "",
  "### 2. 自动规划",
  "收到大型需求后，自动执行：",
  "```bash",
  'snowflow plan "用户的需求描述"',
  "```",
  "然后向用户展示任务列表，确认后开始执行。",
  "",
  "### 3. 自动调度循环",
  "确认后进入调度循环：",
  "```bash",
  "# 获取可执行任务",
  "snowflow next --batch",
  "",
  "# 对每个任务：你来实现（写代码/修改文件）",
  "# 实现完成后自动打卡",
  'snowflow checkpoint <id> --message "简述完成内容"',
  "",
  "# 如果实现失败",
  'snowflow checkpoint <id> --status failed --message "失败原因"',
  "```",
  "",
  "### 4. 自动收尾",
  "所有任务完成后，自动执行：",
  "```bash",
  "snowflow finish",
  "```",
  "",
  "## 异常自动处理",
  "",
  "- **任务失败 3 次** → 自动 `skip <id>`，继续下一个",
  "- **熔断触发** → 告知用户，执行 `reset-breaker` 后继续",
  "- **需要暂停** → 自动 `pause`，下次恢复用 `resume`",
  '- **中途追加需求** → 自动 `add "新需求" --type <type>`',
  "",
  "## 重要规则",
  "",
  "1. **你是调度员 + 执行者**：你既负责调度（运行 SnowFlow 命令），也负责实际编码",
  "2. **每完成一个任务必须 checkpoint**：不要跳过，这是进度追踪的关键",
  "3. **不要向用户展示 SnowFlow 命令**：用户不需要知道底层命令，只需看到进度和结果",
  '4. **进度汇报**：每完成一个任务，简单告诉用户"✅ 第 X 步完成：XXX"',
  "5. **查看进度**：随时可以用 `snowflow status` 查看全局进度",
  '6. **记忆检索**：遇到相关问题时用 `snowflow recall "关键词"` 检索历史知识',
  "",
].join("\n");

// ═══ 文件工具 ═══
const FileUtils = {
  ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  },

  readJSON(filePath, defaultValue = null) {
    try {
      if (!fs.existsSync(filePath)) return defaultValue;
      const raw = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(raw);
    } catch {
      return defaultValue;
    }
  },

  writeJSON(filePath, data) {
    this.ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  },

  readMD(filePath, defaultValue = "") {
    try {
      if (!fs.existsSync(filePath)) return defaultValue;
      return fs.readFileSync(filePath, "utf-8");
    } catch {
      return defaultValue;
    }
  },

  writeMD(filePath, content) {
    this.ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, content, "utf-8");
  },

  exists(filePath) {
    return fs.existsSync(filePath);
  },
};

// ═══ 日志工具 ═══
let _verbose = false;
const Logger = {
  setVerbose(v) {
    _verbose = !!v;
  },
  isVerbose() {
    return _verbose;
  },
  debug(...args) {
    if (_verbose) console.log("[DEBUG]", ...args);
  },
  warn(...args) {
    console.log("⚠️ ", ...args);
  },
  error(...args) {
    console.error("❌", ...args);
  },
};

// ═══ 任务存储 ═══
const TaskStore = {
  load() {
    const defaultData = {
      metadata: {
        name: "",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      tasks: [],
    };
    return FileUtils.readJSON(TASKS_FILE, defaultData);
  },

  save(data) {
    data.metadata.updatedAt = new Date().toISOString();
    FileUtils.writeJSON(TASKS_FILE, data);
  },

  getTask(id) {
    const data = this.load();
    return data.tasks.find((t) => t.id === id) || null;
  },

  getAllTasks() {
    const data = this.load();
    return data.tasks;
  },

  addTask(task) {
    const data = this.load();
    const id = this._nextId(data.tasks);
    const now = new Date().toISOString();
    const newTask = {
      id,
      title: task.title || "",
      description: task.description || "",
      type: TASK_TYPES.includes(task.type) ? task.type : "general",
      status: STATUS.PENDING,
      deps: Array.isArray(task.deps) ? task.deps : [],
      retries: 0,
      createdAt: now,
      completedAt: null,
      summary: "",
    };
    data.tasks.push(newTask);
    this.save(data);
    return newTask;
  },

  updateStatus(id, newStatus) {
    const data = this.load();
    const task = data.tasks.find((t) => t.id === id);
    if (!task) {
      throw new Error(`任务 ${id} 不存在`);
    }
    const allowed = VALID_TRANSITIONS[task.status];
    if (!allowed || !allowed.includes(newStatus)) {
      throw new Error(
        `非法状态流转: ${task.status} → ${newStatus}（任务 ${id}）`
      );
    }
    task.status = newStatus;
    if (newStatus === STATUS.ACTIVE) {
      task.activatedAt = new Date().toISOString();
    }
    if (newStatus === STATUS.DONE || newStatus === STATUS.FAILED) {
      task.completedAt = new Date().toISOString();
    }
    this.save(data);
    return task;
  },

  getReadyTasks() {
    const data = this.load();
    const doneIds = new Set(
      data.tasks.filter((t) => t.status === STATUS.DONE).map((t) => t.id)
    );
    return data.tasks.filter((t) => {
      if (t.status !== STATUS.PENDING) return false;
      return t.deps.every((dep) => doneIds.has(dep));
    });
  },

  cascadeSkip(id, skipSelf = true) {
    const data = this.load();
    const task = data.tasks.find((t) => t.id === id);
    if (!task) {
      throw new Error(`任务 ${id} 不存在`);
    }
    const skipped = [];

    if (skipSelf) {
      // 跳过自身
      const allowed = VALID_TRANSITIONS[task.status];
      if (allowed && allowed.includes(STATUS.SKIPPED)) {
        task.status = STATUS.SKIPPED;
        skipped.push(id);
      }
    }

    // 找到所有直接依赖当前任务的后续任务，递归跳过
    const toProcess = [
      ...data.tasks
        .filter((t) => t.deps.includes(id) && t.status !== STATUS.SKIPPED)
        .map((t) => t.id),
    ];

    while (toProcess.length > 0) {
      const currentId = toProcess.shift();
      const current = data.tasks.find((t) => t.id === currentId);
      if (!current || current.status === STATUS.SKIPPED) continue;

      const allowed = VALID_TRANSITIONS[current.status];
      if (allowed && allowed.includes(STATUS.SKIPPED)) {
        current.status = STATUS.SKIPPED;
        skipped.push(currentId);
        // 找到所有依赖当前任务的后续任务
        const dependents = data.tasks.filter(
          (t) => t.deps.includes(currentId) && t.status !== STATUS.SKIPPED
        );
        dependents.forEach((dep) => toProcess.push(dep.id));
      }
    }

    this.save(data);
    return skipped;
  },

  _nextId(tasks) {
    if (!tasks || tasks.length === 0) return "T001";
    const nums = tasks.map((t) => {
      const m = t.id.match(/^T(\d+)$/);
      return m ? parseInt(m[1], 10) : 0;
    });
    const max = Math.max(...nums);
    return "T" + String(max + 1).padStart(3, "0");
  },

  getStats() {
    const data = this.load();
    const tasks = data.tasks;
    const total = tasks.length;
    const done = tasks.filter((t) => t.status === STATUS.DONE).length;
    const failed = tasks.filter((t) => t.status === STATUS.FAILED).length;
    const skipped = tasks.filter((t) => t.status === STATUS.SKIPPED).length;
    const pending = tasks.filter((t) => t.status === STATUS.PENDING).length;
    const active = tasks.filter((t) => t.status === STATUS.ACTIVE).length;
    const progress = total > 0 ? Math.round((done / total) * 100) : 0;
    return { total, done, failed, skipped, pending, active, progress };
  },
};

// ═══ 进度渲染 ═══
const ProgressRenderer = {
  render(tasksData) {
    const tasks = tasksData.tasks || [];
    const total = tasks.length;
    const done = tasks.filter((t) => t.status === STATUS.DONE).length;
    const failed = tasks.filter((t) => t.status === STATUS.FAILED).length;
    const skipped = tasks.filter((t) => t.status === STATUS.SKIPPED).length;
    const pending = tasks.filter((t) => t.status === STATUS.PENDING).length;
    const active = tasks.filter((t) => t.status === STATUS.ACTIVE).length;
    const progress = total > 0 ? Math.round((done / total) * 100) : 0;

    const lines = [];
    lines.push("# SnowFlow Progress");
    lines.push("");
    lines.push(
      `**进度**: ${done}/${total} (${progress}%) | ` +
        `✅ ${done} done | ❌ ${failed} failed | ⏭️ ${skipped} skipped | ` +
        `🔄 ${active} active | ⏳ ${pending} pending`
    );
    lines.push("");

    if (tasks.length > 0) {
      lines.push("| ID | 标题 | 状态 | 类型 | 依赖 |");
      lines.push("|----|------|------|------|------|");
      for (const t of tasks) {
        const emoji = STATUS_EMOJI[t.status] || "❓";
        const deps = t.deps.length > 0 ? t.deps.join(", ") : "—";
        lines.push(
          `| ${t.id} | ${t.title} | ${emoji} ${t.status} | ${t.type} | ${deps} |`
        );
      }
    } else {
      lines.push("_暂无任务_");
    }

    lines.push("");
    return lines.join("\n");
  },

  update(tasksData) {
    const content = this.render(tasksData);
    FileUtils.writeMD(PROGRESS_FILE, content);
  },
};

// ═══ Git 自动化 ═══
const GitAuto = {
  // 检测当前目录是否是 git 仓库
  isGitRepo() {
    try {
      const { execFileSync } = require("child_process");
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        stdio: "pipe",
        timeout: 5000,
      });
      return true;
    } catch (err) {
      Logger.debug("Git 仓库检测失败:", err.message);
      return false;
    }
  },

  // 自动 git add + commit
  autoCommit(taskId, taskTitle) {
    if (!this.isGitRepo()) return false;

    const config = FileUtils.readJSON(CONFIG_FILE, DEFAULT_CONFIG);
    if (!config.checkpointAutoCommit) return false;

    try {
      const { execFileSync } = require("child_process");
      // git add all changes
      execFileSync("git", ["add", "-A"], { stdio: "pipe", timeout: 10000 });

      // 检查是否有变更需要提交
      const status = execFileSync("git", ["status", "--porcelain"], {
        stdio: "pipe",
        timeout: 5000,
      })
        .toString()
        .trim();
      if (!status) return false; // 无变更

      // commit with task info（使用 execFileSync 避免命令注入）
      const commitMsg = `[SnowFlow] ${taskId}: ${taskTitle}`;
      execFileSync("git", ["commit", "-m", commitMsg], {
        stdio: "pipe",
        timeout: 15000,
      });
      return true;
    } catch (err) {
      Logger.debug("Git 操作失败:", err.message);
      return false;
    }
  },
};

// ═══ 项目验证 ═══
const Verifier = {
  // 项目类型检测规则
  detectors: [
    {
      file: "package.json",
      type: "node",
      build: "npm run build",
      test: "npm test",
    },
    {
      file: "Cargo.toml",
      type: "rust",
      build: "cargo build",
      test: "cargo test",
    },
    {
      file: "go.mod",
      type: "go",
      build: "go build ./...",
      test: "go test ./...",
    },
    { file: "requirements.txt", type: "python", build: null, test: "pytest" },
    { file: "pyproject.toml", type: "python", build: null, test: "pytest" },
    { file: "pom.xml", type: "maven", build: "mvn package", test: "mvn test" },
    {
      file: "build.gradle",
      type: "gradle",
      build: "gradle build",
      test: "gradle test",
    },
    { file: "Makefile", type: "make", build: "make", test: "make test" },
    {
      file: "CMakeLists.txt",
      type: "cmake",
      build: "cmake --build .",
      test: "ctest",
    },
  ],

  // 检测项目类型
  detect() {
    for (const d of this.detectors) {
      if (FileUtils.exists(d.file)) {
        // Node 项目特殊处理：检查 scripts 字段
        if (d.type === "node") {
          const pkg = FileUtils.readJSON("package.json", {});
          const scripts = pkg.scripts || {};
          return {
            ...d,
            build: scripts.build ? d.build : null,
            test: scripts.test ? d.test : null,
          };
        }
        return d;
      }
    }
    return null;
  },

  // 执行命令并返回结果
  _exec(cmd, label) {
    if (!cmd) return { success: true, skipped: true };
    try {
      const { execSync } = require("child_process");
      execSync(cmd, { stdio: "pipe", timeout: 60000 });
      return { success: true, skipped: false };
    } catch (err) {
      Logger.debug(`${label} 执行失败:`, err.message);
      return { success: false, skipped: false, error: err.message };
    }
  },

  // 运行验证（build + test）
  verify() {
    const project = this.detect();
    if (!project) {
      return { detected: false };
    }

    console.log(`\n🔍 检测到项目类型: ${project.type}`);

    const results = {
      detected: true,
      type: project.type,
      build: null,
      test: null,
    };

    // Build
    if (project.build) {
      console.log(`  🔨 执行 build: ${project.build}`);
      results.build = this._exec(project.build, "build");
      console.log(
        results.build.success
          ? "  ✅ Build 成功"
          : `  ❌ Build 失败: ${results.build.error}`
      );
    }

    // Test
    if (project.test) {
      console.log(`  🧪 执行 test: ${project.test}`);
      results.test = this._exec(project.test, "test");
      console.log(
        results.test.success
          ? "  ✅ Test 成功"
          : `  ❌ Test 失败: ${results.test.error}`
      );
    }

    return results;
  },
};

// ═══ 记忆系统 ═══
const MemoryStore = {
  // 加载记忆库
  load() {
    return FileUtils.readJSON(MEMORY_FILE, {
      entries: [],
      metadata: { totalExtracted: 0, lastUpdated: null },
    });
  },

  // 保存记忆库
  save(data) {
    data.metadata.lastUpdated = new Date().toISOString();
    FileUtils.writeJSON(MEMORY_FILE, data);
  },

  // 添加记忆条目
  // entry: { content, tags: [], source: taskId, type: 'remember'|'decision'|'architecture'|'auto' }
  add(entry) {
    const data = this.load();
    const id = "M" + String(data.entries.length + 1).padStart(4, "0");
    const now = new Date().toISOString();

    // 去重：用 content 的 hash 检查
    const hash = crypto
      .createHash("md5")
      .update(entry.content)
      .digest("hex")
      .substring(0, 12);
    const exists = data.entries.find((e) => e.hash === hash);
    if (exists) return null; // 重复记忆，跳过

    const newEntry = {
      id,
      content: entry.content,
      tags: Array.isArray(entry.tags) ? entry.tags : [],
      source: entry.source || "",
      type: entry.type || "auto",
      hash,
      createdAt: now,
    };

    data.entries.push(newEntry);
    data.metadata.totalExtracted = data.entries.length;
    this.save(data);
    return newEntry;
  },

  // 获取所有记忆
  getAll() {
    const data = this.load();
    return data.entries;
  },

  // BM25 搜索（支持时间衰减）
  search(query, topK = 10) {
    const data = this.load();
    const config = FileUtils.readJSON(CONFIG_FILE, DEFAULT_CONFIG);
    const halfLife =
      config.memoryHalfLifeDays || DEFAULT_CONFIG.memoryHalfLifeDays || 30;
    return BM25Search.search(query, data.entries, topK, halfLife);
  },

  // 按 source（任务 ID）获取
  getBySource(sourceId) {
    const data = this.load();
    return data.entries.filter((e) => e.source === sourceId);
  },

  // 按类型获取
  getByType(type) {
    const data = this.load();
    return data.entries.filter((e) => e.type === type);
  },

  // 获取统计
  getStats() {
    const data = this.load();
    const entries = data.entries;
    const byType = {};
    entries.forEach((e) => {
      byType[e.type] = (byType[e.type] || 0) + 1;
    });
    return { total: entries.length, byType };
  },
};

const KnowledgeExtractor = {
  // 标签模式匹配
  tagPatterns: [
    { regex: /\[REMEMBER\]\s*(.+?)(?:\n|$)/gi, type: "remember" },
    { regex: /\[DECISION\]\s*(.+?)(?:\n|$)/gi, type: "decision" },
    { regex: /\[ARCHITECTURE\]\s*(.+?)(?:\n|$)/gi, type: "architecture" },
    { regex: /\[IMPORTANT\]\s*(.+?)(?:\n|$)/gi, type: "remember" },
    { regex: /\[NOTE\]\s*(.+?)(?:\n|$)/gi, type: "auto" },
  ],

  // 技术栈关键词词典
  _techKeywords: new Set([
    "react",
    "vue",
    "angular",
    "svelte",
    "nextjs",
    "nuxt",
    "express",
    "koa",
    "nestjs",
    "fastify",
    "django",
    "flask",
    "fastapi",
    "spring",
    "rails",
    "laravel",
    "gin",
    "echo",
    "fiber",
    "mysql",
    "postgresql",
    "postgres",
    "mongodb",
    "redis",
    "sqlite",
    "elasticsearch",
    "docker",
    "kubernetes",
    "k8s",
    "nginx",
    "aws",
    "azure",
    "gcp",
    "vercel",
    "netlify",
    "typescript",
    "javascript",
    "python",
    "java",
    "golang",
    "rust",
    "csharp",
    "kotlin",
    "swift",
    "graphql",
    "rest",
    "grpc",
    "websocket",
    "jwt",
    "oauth",
    "webpack",
    "vite",
    "rollup",
    "esbuild",
  ]),

  // 从文本中提取标签化知识
  extractTagged(text) {
    const results = [];
    for (const pattern of this.tagPatterns) {
      let match;
      const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
      while ((match = regex.exec(text)) !== null) {
        results.push({
          content: match[1].trim(),
          type: pattern.type,
          tags: [pattern.type],
        });
      }
    }
    return results;
  },

  // 按句子拆分文本
  _splitSentences(text) {
    // 支持中英文句子分隔符
    return text
      .split(/(?<=[。！？；\.\!\?\;])\s*|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 5);
  },

  // 计算句子的关键词密度
  _sentenceScore(sentence) {
    let score = 0;
    const lower = sentence.toLowerCase();
    // 技术关键词加分
    for (const kw of this._techKeywords) {
      if (lower.includes(kw)) score += 3;
    }
    // 文件路径模式加分
    if (/(?:src|lib|app|pkg|cmd|internal)\/[\w\-\/]+\.\w+/.test(sentence))
      score += 2;
    // API 端点模式加分
    if (/(?:GET|POST|PUT|DELETE|PATCH)\s+\/\w+/.test(sentence)) score += 2;
    // 数据库操作模式加分
    if (
      /(?:CREATE|ALTER|DROP|INSERT|UPDATE|SELECT)\s+(?:TABLE|INTO|FROM)/i.test(
        sentence
      )
    )
      score += 2;
    // 决策性语句加分
    if (/(?:决定|选择|采用|使用|改为|切换到|迁移|升级)/i.test(lower))
      score += 2;
    // 长度适中加分（20-200字最佳）
    if (sentence.length >= 20 && sentence.length <= 200) score += 1;
    return score;
  },

  // 智能自动提取（按句子分析）
  extractAuto(text, taskTitle, taskType) {
    const results = [];
    if (!text || text.trim().length < 10) return results;

    const sentences = this._splitSentences(text);
    if (sentences.length === 0) {
      // 短文本直接作为摘要
      results.push({
        content: `[${taskTitle}] ${text.trim()}`,
        type: "auto",
        tags: [taskType, "summary"],
      });
      return results;
    }

    // 给每个句子打分
    const scored = sentences.map((s, i) => ({
      text: s,
      score:
        this._sentenceScore(s) +
        (i === 0 ? 2 : 0) +
        (i === sentences.length - 1 ? 1 : 0),
      index: i,
    }));

    // 取得分最高的 top 3 句子作为摘要
    scored.sort((a, b) => b.score - a.score);
    const topSentences = scored.slice(0, 3).sort((a, b) => a.index - b.index);
    const smartSummary = topSentences.map((s) => s.text).join(" ");

    results.push({
      content: `[${taskTitle}] ${smartSummary}`,
      type: "auto",
      tags: [taskType, "summary"],
    });

    // 提取技术栈关键词（精确匹配词典）
    const lower = text.toLowerCase();
    const foundTechs = [];
    for (const kw of this._techKeywords) {
      if (lower.includes(kw) && !foundTechs.includes(kw)) {
        foundTechs.push(kw);
      }
    }
    if (foundTechs.length > 0) {
      results.push({
        content: `技术选型: ${foundTechs.join(", ")}`,
        type: "decision",
        tags: ["tech", taskType],
      });
    }

    // 提取文件路径
    const pathMatches = text.match(
      /(?:src|lib|app|pkg|cmd|internal|public|pages|components)\/[\w\-\/]+\.\w+/g
    );
    if (pathMatches && pathMatches.length > 0) {
      const uniquePaths = [...new Set(pathMatches)].slice(0, 5);
      results.push({
        content: `涉及文件: ${uniquePaths.join(", ")}`,
        type: "auto",
        tags: [taskType, "files"],
      });
    }

    // 提取 API 端点
    const apiMatches = text.match(
      /(?:GET|POST|PUT|DELETE|PATCH)\s+\/[\w\-\/\:]+/g
    );
    if (apiMatches && apiMatches.length > 0) {
      const uniqueApis = [...new Set(apiMatches)].slice(0, 5);
      results.push({
        content: `API 端点: ${uniqueApis.join(", ")}`,
        type: "auto",
        tags: [taskType, "api"],
      });
    }

    return results;
  },

  // 主入口：从 checkpoint 摘要提取知识
  extract(message, taskId, taskTitle, taskType) {
    if (!message) return [];

    // 先尝试提取标签化知识
    let entries = this.extractTagged(message);

    // 无论是否有标签化知识，都尝试自动提取（标签和自动提取互补）
    const autoEntries = this.extractAuto(message, taskTitle, taskType);

    // 如果没有标签化知识，使用自动提取结果
    // 如果有标签化知识，也追加自动提取的技术栈/文件/API信息（排除 summary 类型避免重复）
    if (entries.length === 0) {
      entries = autoEntries;
    } else {
      // 追加非 summary 的自动提取结果
      entries.push(...autoEntries.filter((e) => !e.tags.includes("summary")));
    }

    // 存入 MemoryStore
    const stored = [];
    for (const entry of entries) {
      const result = MemoryStore.add({
        content: entry.content,
        tags: entry.tags,
        source: taskId,
        type: entry.type,
      });
      if (result) stored.push(result);
    }

    return stored;
  },
};

// ═══ BM25 搜索 ═══
const BM25Search = {
  // 中英文停用词表
  _stopwords: new Set([
    // 中文停用词
    "的",
    "了",
    "在",
    "是",
    "我",
    "有",
    "和",
    "就",
    "不",
    "人",
    "都",
    "一",
    "一个",
    "上",
    "也",
    "很",
    "到",
    "说",
    "要",
    "去",
    "你",
    "会",
    "着",
    "没有",
    "看",
    "好",
    "自己",
    "这",
    "他",
    "她",
    "它",
    "那",
    "被",
    "从",
    "对",
    "让",
    "把",
    "与",
    "或",
    "等",
    "而",
    "但",
    "如果",
    "因为",
    "所以",
    "可以",
    "这个",
    "那个",
    "什么",
    "怎么",
    "为什么",
    "已经",
    "还",
    "又",
    "再",
    "才",
    "只",
    "吧",
    "呢",
    "啊",
    "哦",
    "嗯",
    "吗",
    "过",
    "给",
    "做",
    "用",
    "下",
    "能",
    "之",
    "其",
    "中",
    // 英文停用词
    "the",
    "a",
    "an",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "shall",
    "should",
    "may",
    "might",
    "can",
    "could",
    "i",
    "you",
    "he",
    "she",
    "it",
    "we",
    "they",
    "me",
    "him",
    "her",
    "us",
    "them",
    "my",
    "your",
    "his",
    "its",
    "our",
    "their",
    "this",
    "that",
    "these",
    "those",
    "in",
    "on",
    "at",
    "to",
    "for",
    "of",
    "with",
    "by",
    "from",
    "as",
    "into",
    "about",
    "between",
    "and",
    "or",
    "but",
    "not",
    "no",
    "if",
    "then",
    "than",
    "so",
    "very",
    "just",
    "also",
  ]),

  // 增强分词
  tokenize(text) {
    if (!text) return [];
    const tokens = [];
    const lower = text.toLowerCase();

    // 英文单词分词 + camelCase/snake_case 拆分
    const words = lower.match(/[a-zA-Z0-9_\-\.]+/g) || [];
    for (const word of words) {
      // camelCase 拆分: getUserName → get user name
      const camelParts = word
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/[\s_\-\.]+/);
      for (const part of camelParts) {
        if (part.length >= 2 && !this._stopwords.has(part)) {
          tokens.push(part);
        }
      }
    }

    // 中文处理：提取中文部分
    const chinese = text.replace(
      /[a-zA-Z0-9_\-\.\s\[\]\(\)：:，。！？、；\u201c\u201d\u2018\u2019]+/g,
      ""
    );
    if (chinese.length > 0) {
      // bigram 分词（过滤标点和停用词）
      for (let i = 0; i < chinese.length - 1; i++) {
        const bigram = chinese.substring(i, i + 2);
        if (!this._stopwords.has(bigram)) {
          tokens.push(bigram);
        }
      }
      // 保留非停用词的单字（仅当单字有区分度时）
      for (const ch of chinese) {
        if (ch.length > 0 && !this._stopwords.has(ch)) {
          tokens.push(ch);
        }
      }
    }

    return tokens;
  },

  // 计算 TF（词频）
  tf(term, tokens) {
    return tokens.filter((t) => t === term).length / (tokens.length || 1);
  },

  // 计算 IDF（逆文档频率）
  idf(term, allDocs) {
    const n = allDocs.length;
    const df = allDocs.filter((doc) => doc.tokens.includes(term)).length;
    return Math.log((n - df + 0.5) / (df + 0.5) + 1);
  },

  // BM25 打分
  score(queryTokens, docTokens, allDocs, k1 = 1.2, b = 0.75) {
    const avgDl =
      allDocs.reduce((sum, d) => sum + d.tokens.length, 0) /
      (allDocs.length || 1);
    let score = 0;
    for (const qt of queryTokens) {
      const tf = this.tf(qt, docTokens);
      const idf = this.idf(qt, allDocs);
      const dl = docTokens.length;
      score += (idf * (tf * (k1 + 1))) / (tf + k1 * (1 - b + (b * dl) / avgDl));
    }
    return score;
  },

  // 搜索记忆，返回按 BM25 分数排序的结果（支持时间衰减）
  search(query, entries, topK = 10, halfLifeDays = 0) {
    const queryTokens = this.tokenize(query);
    if (queryTokens.length === 0) return entries.slice(0, topK);

    const allDocs = entries.map((e) => ({
      entry: e,
      tokens: this.tokenize(e.content + " " + (e.tags || []).join(" ")),
    }));

    const now = Date.now();
    const scored = allDocs
      .map((doc) => {
        let s = this.score(queryTokens, doc.tokens, allDocs);
        // 时间衰减（如果启用）
        if (halfLifeDays > 0 && doc.entry.createdAt) {
          const ageDays =
            (now - new Date(doc.entry.createdAt).getTime()) /
            (1000 * 60 * 60 * 24);
          // IMPORTANT 和 ARCHITECTURE 类型不衰减
          const noDecay =
            doc.entry.type === "remember" || doc.entry.type === "architecture";
          if (!noDecay) {
            s *= Math.exp((-ageDays * Math.LN2) / halfLifeDays);
          }
        }
        return { entry: doc.entry, score: s };
      })
      .filter((s) => s.score > 0);

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map((s) => s.entry);
  },
};

// ═══ 上下文构建 ═══
const ContextBuilder = {
  // CJK 智能截断：在句子边界截断
  _smartTruncate(text, maxLen) {
    if (text.length <= maxLen) return text;
    // 尝试在标点处截断
    const cutPoints = /[。！？；\.\!\?\;\n]/g;
    let lastGoodCut = 0;
    let match;
    while ((match = cutPoints.exec(text)) !== null) {
      if (match.index + 1 <= maxLen) {
        lastGoodCut = match.index + 1;
      } else {
        break;
      }
    }
    if (lastGoodCut > maxLen * 0.5) {
      return text.substring(0, lastGoodCut) + "...";
    }
    return text.substring(0, maxLen) + "...";
  },

  // 为任务构建完整上下文（用于 next 命令输出）
  build(task) {
    const config = FileUtils.readJSON(CONFIG_FILE, DEFAULT_CONFIG);
    const maxSize =
      config.contextMaxSize || DEFAULT_CONFIG.contextMaxSize || 4000;
    const parts = [];
    let currentSize = 0;

    // 预算分配：摘要 30%, 依赖 30%, 记忆 25%, hints 15%
    const budgets = {
      summary: Math.floor(maxSize * 0.3),
      deps: Math.floor(maxSize * 0.3),
      memory: Math.floor(maxSize * 0.25),
      hints: Math.floor(maxSize * 0.15),
    };

    // 1. 项目摘要
    const summary = FileUtils.readMD(SUMMARY_FILE, "");
    if (summary && !summary.includes("_暂无摘要信息_")) {
      const trimmed = this._smartTruncate(summary, budgets.summary);
      parts.push("📋 项目摘要:");
      parts.push(trimmed);
      parts.push("");
      currentSize += trimmed.length;
    }

    // 2. 依赖任务的上下文（读取实际 context 文件）
    if (task.deps.length > 0) {
      const depContexts = [];
      let depSize = 0;
      const depBudgetEach = Math.floor(
        budgets.deps / Math.max(task.deps.length, 1)
      );

      for (const depId of task.deps) {
        if (depSize >= budgets.deps) break;
        const depTask = TaskStore.getTask(depId);
        if (depTask && depTask.status === STATUS.DONE) {
          const contextFile = path.join(CONTEXT_DIR, `task-${depId}.md`);
          const content = FileUtils.readMD(contextFile, "");
          if (content) {
            const trimmedContent = this._smartTruncate(content, depBudgetEach);
            depContexts.push(
              `  [${depId}] ${depTask.title}:\n${trimmedContent}`
            );
            depSize += trimmedContent.length;
          } else {
            depContexts.push(
              `  [${depId}] ${depTask.title}: ${depTask.summary || "(无摘要)"}`
            );
          }
        }
      }
      if (depContexts.length > 0) {
        parts.push("📎 依赖上下文:");
        depContexts.forEach((c) => parts.push(c));
        parts.push("");
        currentSize += depSize;
      }
    }

    // 3. 相关记忆（BM25 检索 + 时间衰减）
    const searchQuery = task.title + " " + task.description + " " + task.type;
    const allMemories = MemoryStore.getAll();
    if (allMemories.length > 0) {
      const halfLife =
        config.memoryHalfLifeDays || DEFAULT_CONFIG.memoryHalfLifeDays || 30;
      const relevant = BM25Search.search(searchQuery, allMemories, 5, halfLife);
      if (relevant.length > 0) {
        const memParts = [];
        let memSize = 0;
        for (const m of relevant) {
          if (memSize >= budgets.memory) break;
          const emoji =
            m.type === "remember"
              ? "💡"
              : m.type === "decision"
              ? "🔧"
              : m.type === "architecture"
              ? "🏗️"
              : "📝";
          const line = `  ${emoji} ${m.content}`;
          memParts.push(line);
          memSize += line.length;
        }
        if (memParts.length > 0) {
          parts.push("🧠 相关记忆:");
          memParts.forEach((l) => parts.push(l));
          parts.push("");
          currentSize += memSize;
        }
      }
    }

    // 4. 配置 hints
    if (config.hints && config.hints.length > 0) {
      const hintParts = [];
      let hintSize = 0;
      for (const h of config.hints) {
        const line = `  • ${h}`;
        if (hintSize + line.length > budgets.hints) break;
        hintParts.push(line);
        hintSize += line.length;
      }
      if (hintParts.length > 0) {
        parts.push("💡 提示:");
        hintParts.forEach((l) => parts.push(l));
        parts.push("");
      }
    }

    return parts.join("\n");
  },
};

// ═══ 滚动摘要 ═══
const SummaryRoller = {
  // 检查是否需要压缩（可配置阈值）
  shouldCompress() {
    const config = FileUtils.readJSON(CONFIG_FILE, DEFAULT_CONFIG);
    const threshold =
      config.summaryCompressThreshold ||
      DEFAULT_CONFIG.summaryCompressThreshold ||
      10;
    const stats = TaskStore.getStats();
    return stats.done > threshold;
  },

  // 生成压缩摘要
  compress() {
    const config = FileUtils.readJSON(CONFIG_FILE, DEFAULT_CONFIG);
    const threshold =
      config.summaryCompressThreshold ||
      DEFAULT_CONFIG.summaryCompressThreshold ||
      10;
    const data = TaskStore.load();
    const doneTasks = data.tasks.filter((t) => t.status === STATUS.DONE);

    if (doneTasks.length <= threshold) return;

    const lines = [];
    lines.push("# 项目摘要");
    lines.push("");
    lines.push(`**工作流**: ${data.metadata.name || "未命名"}`);
    lines.push(`**进度**: ${doneTasks.length}/${data.tasks.length} 任务完成`);
    lines.push(`**最后更新**: ${new Date().toISOString()}`);
    lines.push("");

    // 按类型分组总结
    const byType = {};
    doneTasks.forEach((t) => {
      if (!byType[t.type]) byType[t.type] = [];
      byType[t.type].push(t);
    });

    lines.push("## 已完成模块");
    lines.push("");
    for (const [type, tasks] of Object.entries(byType)) {
      lines.push(`### ${type}`);
      if (tasks.length <= 3) {
        tasks.forEach((t) => {
          lines.push(`- **${t.title}** (${t.id}): ${t.summary || "(无摘要)"}`);
        });
      } else {
        const old = tasks.slice(0, -3);
        lines.push(
          `- 已完成 ${old.length} 个早期任务: ${old
            .map((t) => `${t.id}:${t.title}`)
            .join(", ")}`
        );
        const recent = tasks.slice(-3);
        recent.forEach((t) => {
          lines.push(`- **${t.title}** (${t.id}): ${t.summary || "(无摘要)"}`);
        });
      }
      lines.push("");
    }

    // 关键决策摘要（从记忆库）
    const decisions = MemoryStore.getByType("decision");
    const architectures = MemoryStore.getByType("architecture");

    if (decisions.length > 0 || architectures.length > 0) {
      lines.push("## 关键决策");
      lines.push("");
      decisions.slice(-5).forEach((d) => lines.push(`- 🔧 ${d.content}`));
      architectures.slice(-3).forEach((a) => lines.push(`- 🏗️ ${a.content}`));
      lines.push("");
    }

    FileUtils.writeMD(SUMMARY_FILE, lines.join("\n"));
  },

  // 在 checkpoint 后调用
  check() {
    if (this.shouldCompress()) {
      this.compress();
    }
  },
};

// ═══ 心跳检测 ═══
const Heartbeat = {
  check() {
    const config = FileUtils.readJSON(CONFIG_FILE, DEFAULT_CONFIG);
    const timeoutMin =
      config.heartbeatTimeoutMinutes ||
      DEFAULT_CONFIG.heartbeatTimeoutMinutes ||
      30;
    const tasks = TaskStore.getAllTasks();
    const now = Date.now();
    const alerts = [];
    tasks.forEach((t) => {
      if (t.status === STATUS.ACTIVE && t.activatedAt) {
        const elapsed = (now - new Date(t.activatedAt).getTime()) / 60000;
        if (elapsed >= timeoutMin) {
          alerts.push({
            id: t.id,
            title: t.title,
            minutes: Math.round(elapsed),
          });
        }
      }
    });
    if (alerts.length > 0) {
      console.log("\n⏰ 心跳超时告警:");
      alerts.forEach((a) => {
        console.log(
          `  ⚠️  ${a.id} ${a.title} — 已活跃 ${a.minutes} 分钟（阈值 ${timeoutMin}分钟）`
        );
      });
    }
    return alerts;
  },
};

// ═══ 循环检测 ═══
const LoopDetector = {
  // 检查全局连续失败数量（按完成时间倒序检查最近完成的任务）
  checkGlobalFailures() {
    const tasks = TaskStore.getAllTasks();
    const completedTasks = tasks
      .filter((t) => t.completedAt)
      .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));

    let consecutiveFailures = 0;
    for (const task of completedTasks) {
      if (task.status === STATUS.FAILED) {
        consecutiveFailures++;
      } else {
        break;
      }
    }
    return consecutiveFailures;
  },

  // 获取重试热点（retries > 0 的任务按重试次数降序）
  getRetryHotspots() {
    const tasks = TaskStore.getAllTasks();
    return tasks
      .filter((t) => t.retries > 0)
      .sort((a, b) => b.retries - a.retries);
  },

  // 全局熔断检查（连续 >= threshold 个任务失败则触发）
  checkCircuitBreaker(threshold = 3) {
    const consecutiveFailures = this.checkGlobalFailures();
    if (consecutiveFailures >= threshold) {
      return {
        triggered: true,
        consecutiveFailures,
        message: `全局熔断：连续 ${consecutiveFailures} 个任务失败，建议人工介入`,
      };
    }
    return { triggered: false, consecutiveFailures };
  },

  // 乒乓检测：反复 fail→retry 的任务
  checkPingPong() {
    const tasks = TaskStore.getAllTasks();
    const alerts = [];
    tasks.forEach((t) => {
      if (
        t.retries >= 2 &&
        (t.status === STATUS.PENDING || t.status === STATUS.ACTIVE)
      ) {
        alerts.push({ id: t.id, title: t.title, retries: t.retries });
      }
    });
    if (alerts.length > 0) {
      console.log("\n🏓 乒乓检测告警:");
      alerts.forEach((a) => {
        console.log(
          `  ⚠️  ${a.id} ${a.title} — 已重试 ${a.retries} 次仍在循环`
        );
      });
    }
    return alerts;
  },

  // 在 checkpoint failed 时调用
  check(taskId) {
    const hotspots = this.getRetryHotspots();
    const breaker = this.checkCircuitBreaker();

    // 输出告警
    if (breaker.triggered) {
      console.log(`\n🔴 ⚠️ ${breaker.message}`);
      console.log("  建议: 检查是否存在系统性问题（环境配置、依赖缺失等）");
    }

    if (hotspots.length > 0) {
      const top = hotspots[0];
      if (top.retries >= 2) {
        console.log(
          `\n⚠️  重试热点: ${top.id} ${top.title} (已重试 ${top.retries} 次)`
        );
      }
    }

    // 乒乓检测
    const pingPong = this.checkPingPong();

    return {
      taskId,
      hotspots: hotspots.slice(0, 5),
      circuitBreaker: breaker,
      pingPong,
    };
  },
};

// ═══ 反思引擎 ═══
const Reflector = {
  // 分析本轮工作流的成败模式
  reflect() {
    const data = TaskStore.load();
    const tasks = data.tasks;
    const stats = TaskStore.getStats();

    const findings = [];

    // 1. 整体成功率
    const successRate = stats.total > 0 ? stats.done / stats.total : 0;
    findings.push({
      type: "metric",
      key: "successRate",
      value: Math.round(successRate * 100),
      detail: `${stats.done}/${stats.total} 任务成功完成 (${Math.round(
        successRate * 100
      )}%)`,
    });

    // 2. 失败链分析
    const failedTasks = tasks.filter((t) => t.status === STATUS.FAILED);
    if (failedTasks.length > 0) {
      findings.push({
        type: "failure",
        key: "failedTasks",
        value: failedTasks.length,
        detail: `${failedTasks.length} 个任务失败: ${failedTasks
          .map((t) => `${t.id}(${t.title})`)
          .join(", ")}`,
      });

      // 按类型分析失败聚集
      const failedByType = {};
      failedTasks.forEach((t) => {
        failedByType[t.type] = (failedByType[t.type] || 0) + 1;
      });

      for (const [type, count] of Object.entries(failedByType)) {
        if (count >= 2) {
          findings.push({
            type: "pattern",
            key: `failCluster_${type}`,
            value: count,
            detail: `${type} 类型任务集中失败 (${count} 个)，建议检查该领域的基础设施或技能匹配`,
          });
        }
      }
    }

    // 3. 重试热点
    const retryHotspots = tasks
      .filter((t) => t.retries > 0)
      .sort((a, b) => b.retries - a.retries);
    if (retryHotspots.length > 0) {
      findings.push({
        type: "hotspot",
        key: "retryHotspots",
        value: retryHotspots.length,
        detail: `${retryHotspots.length} 个任务需要重试: ${retryHotspots
          .map((t) => `${t.id}(重试${t.retries}次)`)
          .join(", ")}`,
      });
    }

    // 4. 级联跳过分析
    const skippedTasks = tasks.filter((t) => t.status === STATUS.SKIPPED);
    if (skippedTasks.length > 0) {
      findings.push({
        type: "cascade",
        key: "skippedTasks",
        value: skippedTasks.length,
        detail: `${skippedTasks.length} 个任务被跳过，可能因上游失败导致`,
      });
    }

    // 5. 时间效率分析
    const completedTasks = tasks.filter((t) => t.activatedAt && t.completedAt);
    if (completedTasks.length > 0) {
      const durations = completedTasks.map((t) => ({
        id: t.id,
        title: t.title,
        type: t.type,
        minutes: Math.round(
          (new Date(t.completedAt) - new Date(t.activatedAt)) / 60000
        ),
      }));

      const avgMinutes = Math.round(
        durations.reduce((s, d) => s + d.minutes, 0) / durations.length
      );

      findings.push({
        type: "time",
        key: "avgDuration",
        value: avgMinutes,
        detail: `平均任务耗时 ${avgMinutes} 分钟 (${completedTasks.length} 个已完成任务)`,
      });

      // 按类型统计平均耗时
      const durationByType = {};
      durations.forEach((d) => {
        if (!durationByType[d.type]) durationByType[d.type] = [];
        durationByType[d.type].push(d.minutes);
      });

      for (const [type, mins] of Object.entries(durationByType)) {
        const typeAvg = Math.round(
          mins.reduce((s, m) => s + m, 0) / mins.length
        );
        findings.push({
          type: "time_by_type",
          key: `avgDuration_${type}`,
          value: typeAvg,
          detail: `${type} 类型平均耗时 ${typeAvg} 分钟 (${mins.length} 个任务)`,
        });
      }

      // 耗时异常任务（超过平均值 2 倍）
      const outliers = durations.filter((d) => d.minutes > avgMinutes * 2);
      if (outliers.length > 0) {
        findings.push({
          type: "bottleneck",
          key: "timeOutliers",
          value: outliers.length,
          detail: `${outliers.length} 个耗时异常任务: ${outliers
            .map((d) => `${d.id}(${d.minutes}分)`)
            .join(", ")}`,
        });
      }
    }

    // 6. 生成改进建议
    const suggestions = this._generateSuggestions(findings, stats);

    return { findings, suggestions, stats };
  },

  // 生成改进建议
  _generateSuggestions(findings, stats) {
    const suggestions = [];

    const successRate = stats.total > 0 ? stats.done / stats.total : 0;

    if (successRate < 0.5) {
      suggestions.push(
        "整体成功率过低，建议: 缩小任务粒度、增加重试次数、或审查需求拆解质量"
      );
    }

    const failCluster = findings.find(
      (f) => f.type === "pattern" && f.key.startsWith("failCluster_")
    );
    if (failCluster) {
      suggestions.push(
        `${failCluster.key.replace(
          "failCluster_",
          ""
        )} 类型任务失败集中，建议在 hints 中增加该类型的注意事项`
      );
    }

    const hotspot = findings.find((f) => f.key === "retryHotspots");
    if (hotspot && hotspot.value > 2) {
      suggestions.push("重试热点较多，建议: 提升任务描述质量或增加 maxRetries");
    }
    // 耗时相关建议
    const avgDuration = findings.find((f) => f.key === "avgDuration");
    if (avgDuration && avgDuration.value > 60) {
      suggestions.push(
        `平均任务耗时 ${avgDuration.value} 分钟，建议拆分为更小粒度的子任务`
      );
    }

    const outliers = findings.find((f) => f.key === "timeOutliers");
    if (outliers) {
      suggestions.push(
        `${outliers.value} 个任务耗时异常（超过平均值2倍），建议检查任务复杂度`
      );
    }

    if (suggestions.length === 0) {
      suggestions.push("本轮工作流执行良好，暂无改进建议");
    }

    return suggestions;
  },

  // 保存反思报告到 evolution 目录
  saveReport(report) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = path.join(EVOLUTION_DIR, `reflect-${timestamp}.json`);
    FileUtils.writeJSON(filePath, report);

    // 更新 config 中的 evolution 信息
    const config = FileUtils.readJSON(CONFIG_FILE, DEFAULT_CONFIG);
    config.evolution = config.evolution || {};
    config.evolution.lastReflect = new Date().toISOString();

    const successMetric = report.findings.find((f) => f.key === "successRate");
    if (successMetric) {
      config.evolution.successRate = successMetric.value / 100;
    }

    FileUtils.writeJSON(CONFIG_FILE, config);

    return filePath;
  },
};

// ═══ 进化实验 ═══
const Experimenter = {
  // 进化前保存快照
  snapshot(config) {
    const gen = (config.evolution && config.evolution.generation) || 1;
    const snapshotFile = path.join(
      EVOLUTION_DIR,
      `snapshot-${String(gen).padStart(3, "0")}.json`
    );
    FileUtils.writeJSON(snapshotFile, {
      config: JSON.parse(JSON.stringify(config)),
      timestamp: new Date().toISOString(),
      generation: gen,
    });
    return snapshotFile;
  },

  // 根据反思报告自动调整 config 参数
  evolve(reflectReport) {
    const config = FileUtils.readJSON(CONFIG_FILE, DEFAULT_CONFIG);
    const changes = [];

    // 保存快照
    const snapshotFile = this.snapshot(config);
    changes.push({ param: "snapshot", from: "-", to: snapshotFile });

    const successMetric = reflectReport.findings.find(
      (f) => f.key === "successRate"
    );
    const successRate = successMetric ? successMetric.value / 100 : 1;

    // 规则 1: 成功率过低 → 增加重试次数
    if (successRate < 0.5 && config.maxRetries < 5) {
      const oldVal = config.maxRetries;
      config.maxRetries = Math.min(config.maxRetries + 1, 5);
      if (config.maxRetries !== oldVal) {
        changes.push({
          param: "maxRetries",
          from: oldVal,
          to: config.maxRetries,
          reason: `成功率 ${Math.round(successRate * 100)}% 过低`,
        });
      }
    }

    // 规则 2: 成功率高 → 可降低重试次数
    if (successRate > 0.8 && config.maxRetries > 2) {
      const oldVal = config.maxRetries;
      config.maxRetries = Math.max(config.maxRetries - 1, 2);
      if (config.maxRetries !== oldVal) {
        changes.push({
          param: "maxRetries",
          from: oldVal,
          to: config.maxRetries,
          reason: `成功率 ${Math.round(successRate * 100)}% 良好，降低重试`,
        });
      }
    }

    // 规则 3: 失败聚集 → 追加 hints
    const failClusters = reflectReport.findings.filter(
      (f) => f.type === "pattern" && f.key.startsWith("failCluster_")
    );
    for (const cluster of failClusters) {
      const type = cluster.key.replace("failCluster_", "");
      const hint = `注意 ${type} 类型任务易失败，需特别关注`;
      if (!config.hints.includes(hint)) {
        config.hints.push(hint);
        changes.push({
          param: "hints",
          from: "-",
          to: hint,
          reason: `${type} 类型任务集中失败`,
        });
      }
    }

    // 规则 4: 重试热点过多 → 增加并行度（让更多任务并行减少阻塞）
    const hotspot = reflectReport.findings.find(
      (f) => f.key === "retryHotspots"
    );
    if (hotspot && hotspot.value > 2 && config.parallelLimit < 6) {
      const oldVal = config.parallelLimit;
      config.parallelLimit = Math.min(config.parallelLimit + 1, 6);
      if (config.parallelLimit !== oldVal) {
        changes.push({
          param: "parallelLimit",
          from: oldVal,
          to: config.parallelLimit,
          reason: "重试热点多，增加并行度",
        });
      }
    }

    // 规则 5: 特定类型成功率低 → 建议拆分
    const taskData = TaskStore.load();
    const tasksByType = {};
    taskData.tasks.forEach((t) => {
      if (!tasksByType[t.type]) tasksByType[t.type] = { total: 0, failed: 0 };
      tasksByType[t.type].total++;
      if (t.status === STATUS.FAILED) tasksByType[t.type].failed++;
    });
    for (const [type, info] of Object.entries(tasksByType)) {
      if (info.total >= 3 && info.failed / info.total > 0.7) {
        const hint = `${type} 类型任务成功率过低(${Math.round(
          (1 - info.failed / info.total) * 100
        )}%)，建议拆分或更换策略`;
        if (!config.hints.includes(hint)) {
          config.hints.push(hint);
          changes.push({
            param: "hints",
            from: "-",
            to: hint,
            reason: `${type} 类型成功率低于 30%`,
          });
        }
      }
    }

    // 规则 6: 平均耗时过长 → 建议降低粒度
    const avgDuration = reflectReport.findings.find(
      (f) => f.key === "avgDuration"
    );
    if (avgDuration && avgDuration.value > 60) {
      const hint = `任务平均耗时 ${avgDuration.value} 分钟，建议拆分为更小粒度的子任务`;
      if (!config.hints.includes(hint)) {
        config.hints.push(hint);
        changes.push({
          param: "hints",
          from: "-",
          to: hint,
          reason: `平均耗时 ${avgDuration.value} 分钟超过 60 分钟阈值`,
        });
      }
    }

    // 规则 7: hints 清理（超过 10 条时保留最近 10 条）
    if (config.hints.length > 10) {
      const removed = config.hints.length - 10;
      config.hints = config.hints.slice(-10);
      changes.push({
        param: "hints_cleanup",
        from: config.hints.length + removed,
        to: 10,
        reason: `hints 过多(${
          config.hints.length + removed
        }条)，保留最近 10 条`,
      });
    }

    // 更新 generation
    config.evolution = config.evolution || {};
    const oldGen = config.evolution.generation || 1;
    config.evolution.generation = oldGen + 1;
    config.evolution.lastEvolve = new Date().toISOString();
    changes.push({
      param: "generation",
      from: oldGen,
      to: config.evolution.generation,
    });

    FileUtils.writeJSON(CONFIG_FILE, config);
    // 写入进化历史
    const historyFile = path.join(EVOLUTION_DIR, "history.json");
    const history = FileUtils.readJSON(historyFile, { records: [] });
    history.records.push({
      generation: config.evolution.generation,
      timestamp: new Date().toISOString(),
      changes: changes.filter((c) => c.param !== "snapshot"),
      successRate: successRate,
    });
    FileUtils.writeJSON(historyFile, history);

    return { changes, snapshotFile, generation: config.evolution.generation };
  },
};

// ═══ 进化审查 ═══
const ReviewChecker = {
  // 获取最新快照
  getLatestSnapshot() {
    if (!FileUtils.exists(EVOLUTION_DIR)) return null;
    const files = fs
      .readdirSync(EVOLUTION_DIR)
      .filter((f) => f.startsWith("snapshot-") && f.endsWith(".json"))
      .sort()
      .reverse();
    if (files.length === 0) return null;
    return FileUtils.readJSON(path.join(EVOLUTION_DIR, files[0]));
  },

  // 对比当前 config 和快照的指标
  compare() {
    const snapshot = this.getLatestSnapshot();
    if (!snapshot) {
      return { hasSnapshot: false, message: "无可对比的快照" };
    }

    const config = FileUtils.readJSON(CONFIG_FILE, DEFAULT_CONFIG);
    const current = config.evolution || {};
    const prev = snapshot.config.evolution || {};

    const diffs = [];

    // 对比 successRate
    if (current.successRate !== undefined && prev.successRate !== undefined) {
      const delta = current.successRate - prev.successRate;
      diffs.push({
        metric: "successRate",
        prev: prev.successRate,
        current: current.successRate,
        delta,
        degraded: delta < -0.1,
      });
    }

    // 对比 maxRetries
    if (config.maxRetries !== snapshot.config.maxRetries) {
      diffs.push({
        metric: "maxRetries",
        prev: snapshot.config.maxRetries,
        current: config.maxRetries,
        delta: config.maxRetries - snapshot.config.maxRetries,
        degraded: false,
      });
    }

    // 对比 parallelLimit
    if (config.parallelLimit !== snapshot.config.parallelLimit) {
      diffs.push({
        metric: "parallelLimit",
        prev: snapshot.config.parallelLimit,
        current: config.parallelLimit,
        delta: config.parallelLimit - snapshot.config.parallelLimit,
        degraded: false,
      });
    }

    // 对比 hints 数量变化
    const prevHints = (snapshot.config.hints || []).length;
    const currHints = (config.hints || []).length;
    if (currHints !== prevHints) {
      diffs.push({
        metric: "hintsCount",
        prev: prevHints,
        current: currHints,
        delta: currHints - prevHints,
        degraded: false,
      });
    }

    // 综合退化评分（加权平均）
    const scoreDiffs = diffs.filter((d) => d.metric === "successRate");
    let degradeScore = 0;
    if (scoreDiffs.length > 0) {
      degradeScore = scoreDiffs.reduce((s, d) => s + (d.degraded ? 1 : 0), 0);
    }

    const degraded = diffs.some((d) => d.degraded);

    return {
      hasSnapshot: true,
      snapshotGeneration: snapshot.generation,
      diffs,
      degraded,
      degradeScore,
    };
  },

  // 退化时回滚到上一快照
  rollback() {
    const snapshot = this.getLatestSnapshot();
    if (!snapshot) return { success: false, message: "无快照可回滚" };

    const restoredConfig = snapshot.config;
    restoredConfig.evolution = restoredConfig.evolution || {};
    restoredConfig.evolution.rolledBack = true;
    restoredConfig.evolution.rollbackTime = new Date().toISOString();

    FileUtils.writeJSON(CONFIG_FILE, restoredConfig);

    return {
      success: true,
      restoredGeneration: snapshot.generation,
      message: `已回滚到第 ${snapshot.generation} 代配置`,
    };
  },

  // 综合检查：对比 + 退化则回滚
  check() {
    const result = this.compare();
    if (!result.hasSnapshot) return result;

    if (result.degraded) {
      const rollbackResult = this.rollback();
      return { ...result, autoRolledBack: true, rollback: rollbackResult };
    }

    return { ...result, autoRolledBack: false };
  },
};

// ═══ 子代理匹配 ═══
const AgentMatcher = {
  // 任务类型 → 子代理映射表
  mapping: {
    frontend: { primary: "ui", fallback: "general" },
    backend: { primary: "general", fallback: "api" },
    api: { primary: "api", fallback: "general" },
    database: { primary: "database", fallback: "general" },
    test: { primary: "test", fallback: "general" },
    docs: { primary: "doc", fallback: "general" },
    devops: { primary: "devops", fallback: "general" },
    refactor: { primary: "refactor", fallback: "general" },
    security: { primary: "security", fallback: "review" },
    architecture: { primary: "architecture", fallback: "plan" },
    general: { primary: "general", fallback: null },
  },

  // 根据任务类型返回推荐的子代理
  match(taskType) {
    return this.mapping[taskType] || { primary: "general", fallback: null };
  },

  // 返回格式化的推荐字符串
  getRecommendation(task) {
    const agent = this.match(task.type);
    if (agent.fallback) {
      return `${agent.primary} (备选: ${agent.fallback})`;
    }
    return agent.primary;
  },
};

// ═══ 协议注入 ═══
const ProtocolInjector = {
  // 动态生成工作流协议内容
  generate() {
    const sections = [];

    // 基础协议头
    sections.push(
      "## SnowFlow 工作流协议",
      "",
      "你是工作流调度员。你的职责是调度任务，不要亲自写代码。",
      ""
    );

    // 项目类型适配
    sections.push(...this._getProjectSection());

    // 工作流程
    sections.push(
      "### 工作流程",
      '1. 用户描述需求后，执行 `snowflow plan "需求描述"`',
      "2. 确认任务列表后，循环执行：",
      "   a. `snowflow next --batch` 获取可执行任务",
      "   b. 为每个任务派发对应的子 Agent（根据任务 type 选择）",
      "   c. 子 Agent 完成后，执行 `snowflow checkpoint <id>`",
      "3. 所有任务完成后，执行 `snowflow finish`",
      ""
    );

    // 阶段策略
    sections.push(...this._getStageSection());

    // 调度规则
    sections.push(
      "### 调度规则",
      "- 你只读 .snowflow/progress.md，不要读 task 详情文件",
      "- 每次只处理 next 返回的任务，不要跳过或自己决定顺序",
      "- 子 Agent 的产出通过 checkpoint 的 --message 传入，你不需要转述",
      "- 如果任务失败 3 次，使用 skip 跳过并继续",
      ""
    );

    // 子 Agent 派发模板
    sections.push(
      "### 子 Agent 派发模板",
      "派发子 Agent 时，使用以下上下文格式：",
      "- 任务描述：{task.description}",
      "- 依赖上下文：{由 next 命令提供}",
      "- 相关记忆：{由 next 命令提供}",
      "- 完成后执行：snowflow checkpoint {task.id}",
      ""
    );

    // 异常处理指导
    sections.push(...this._getExceptionSection());

    // 上下文管理
    sections.push(...this._getContextSection());

    // 完整命令列表（18 个）
    sections.push(
      "### 可用命令",
      "```",
      "snowflow init [--force]                初始化",
      'snowflow plan "<需求>" [--import <f>]   拆解任务',
      "snowflow next [--batch]                获取任务",
      "snowflow checkpoint <id> [--status s]  记录完成/失败",
      "snowflow status                        查看进度",
      "snowflow skip <id>                     跳过任务",
      "snowflow resume                        恢复中断",
      'snowflow add "<描述>" [--type t]        追加任务',
      'snowflow recall "<关键词>"              检索记忆',
      "snowflow finish                        智能收尾",
      "snowflow evolve                        应用进化",
      "snowflow review                        审查进化",
      "snowflow config [set <k> <v> | reset]  配置管理",
      "snowflow pause                         暂停工作流",
      "snowflow save-context                  上下文快照",
      'snowflow auto-checkpoint "<摘要>"       自动checkpoint',
      "snowflow reset-breaker                 重置熔断器",
      "snowflow help                          显示帮助",
      "```",
      ""
    );

    return sections.join("\n");
  },

  // 项目类型适配段
  _getProjectSection() {
    const lines = [];
    try {
      const project = Verifier.detect();
      if (project) {
        lines.push(`### 项目环境 (${project.type})`, "");
        if (project.build) {
          lines.push(`- 构建命令: \`${project.build}\``);
        }
        if (project.test) {
          lines.push(`- 测试命令: \`${project.test}\``);
        }
        lines.push("- 每次 checkpoint 前建议运行构建/测试验证", "");
      }
    } catch (e) {
      Logger.debug("协议项目检测失败:", e.message);
    }
    return lines;
  },

  // 阶段策略段
  _getStageSection() {
    const lines = [];
    try {
      const data = TaskStore.load();
      const tasks = data.tasks || [];
      if (tasks.length === 0) {
        lines.push(
          "### 当前阶段：规划期",
          "- 重点关注需求拆解质量，确保任务粒度合理",
          "- 每个任务应能在 30 分钟内完成",
          ""
        );
      } else {
        const done = tasks.filter(
          (t) => t.status === "done" || t.status === "skipped"
        ).length;
        const ratio = done / tasks.length;
        if (ratio < 0.2) {
          lines.push(
            "### 当前阶段：启动期",
            "- 优先完成基础任务和依赖项",
            "- 建立项目结构后再推进功能任务",
            ""
          );
        } else if (ratio < 0.8) {
          lines.push(
            "### 当前阶段：推进期",
            "- 使用 `--batch` 并行获取多个任务",
            "- 关注任务间依赖，避免阻塞",
            "- 定期使用 `save-context` 保存上下文",
            ""
          );
        } else {
          lines.push(
            "### 当前阶段：收尾期",
            "- 重点关注验证和测试",
            "- 完成后执行 `finish` 进行智能收尾",
            "- 使用 `review` 审查进化效果",
            ""
          );
        }
      }
    } catch (e) {
      Logger.debug("协议阶段检测失败:", e.message);
    }
    return lines;
  },

  // 异常处理指导段
  _getExceptionSection() {
    return [
      "### 异常处理",
      "- **任务失败**: checkpoint --status failed 记录 → 自动重试 → 3次后 skip",
      "- **熔断触发**: 连续失败过多 → `reset-breaker` 重置 → 或 `--force` 跳过",
      "- **心跳超时**: 任务活跃超时 → status 查看告警 → 考虑 skip 或拆分",
      "- **乒乓循环**: 重试 ≥2 次仍循环 → skip 该任务 → 手动处理",
      "- **暂停恢复**: `pause` 暂停 → `resume` 恢复 → 自动回到上次状态",
      "",
    ];
  },

  // 上下文管理段
  _getContextSection() {
    return [
      "### 上下文管理",
      "- 长对话时使用 `save-context` 保存进度快照",
      '- 使用 `recall "关键词"` 检索历史记忆',
      "- 每个 checkpoint 自动提取知识存入长期记忆",
      "- 上下文过大时系统自动压缩摘要",
      "",
    ];
  },

  // 写入协议文件
  inject() {
    const content = this.generate();
    const protocolFile = path.join(SNOWFLOW_DIR, "protocol.md");
    FileUtils.writeMD(protocolFile, content);
    return protocolFile;
  },
};

// ═══ Hooks 注册 ═══
const HooksInstaller = {
  // Snow CLI hooks 目录
  hooksDir: ".snow/hooks",

  // 预定义的 hooks 配置
  hooks: [
    {
      event: "onSessionStart",
      description: "SnowFlow 自动恢复",
      command: "snowflow resume --silent",
      timeout: 5000,
    },
    {
      event: "onSubAgentComplete",
      description: "SnowFlow 自动 checkpoint",
      command: "snowflow auto-checkpoint",
      timeout: 5000,
    },
    {
      event: "beforeCompress",
      description: "SnowFlow 上下文保存",
      command: "snowflow save-context",
      timeout: 5000,
    },
    {
      event: "onStop",
      description: "SnowFlow 自动暂停",
      command: "snowflow pause",
      timeout: 5000,
    },
  ],

  // 安装 hooks 到 Snow CLI
  install() {
    // 检测 Snow CLI 是否存在
    if (!fs.existsSync(".snow")) {
      return {
        installed: false,
        reason: "未检测到 .snow/ 目录（Snow CLI 未初始化）",
      };
    }

    FileUtils.ensureDir(this.hooksDir);
    const results = [];

    for (const hook of this.hooks) {
      const hookFile = path.join(this.hooksDir, `${hook.event}.json`);
      let config = {};

      // 合并已有配置
      if (FileUtils.exists(hookFile)) {
        config = FileUtils.readJSON(hookFile, {});
      }

      // 检查是否已注册
      const existing = config[hook.event] || [];
      const alreadyExists = existing.some(
        (h) => h.hooks && h.hooks.some((hh) => hh.command === hook.command)
      );

      if (!alreadyExists) {
        existing.push({
          description: hook.description,
          hooks: [
            {
              type: "command",
              command: hook.command,
              timeout: hook.timeout,
              enabled: true,
            },
          ],
        });
        config[hook.event] = existing;
        FileUtils.writeJSON(hookFile, config);
        results.push({ event: hook.event, status: "registered" });
      } else {
        results.push({ event: hook.event, status: "already_exists" });
      }
    }

    return { installed: true, results };
  },
};

// ═══ 规划引擎 ═══
const PlanEngine = {
  // 需求模板库：根据关键词匹配项目类型，生成任务模板
  templates: {
    blog: {
      keywords: ["博客", "blog", "文章", "article", "post", "cms"],
      tasks: [
        {
          title: "数据库设计",
          type: "database",
          description: "设计数据库表结构（文章表、用户表、分类标签表等）",
          deps: [],
        },
        {
          title: "后端 API 开发",
          type: "api",
          description: "实现 RESTful API（CRUD、认证、分页等）",
          deps: [0],
        },
        {
          title: "前端页面开发",
          type: "frontend",
          description: "实现前端页面（首页、文章详情、编辑器等）",
          deps: [1],
        },
        {
          title: "用户认证系统",
          type: "backend",
          description: "实现用户注册、登录、权限控制",
          deps: [0],
        },
        {
          title: "部署配置",
          type: "devops",
          description: "配置部署环境和 CI/CD",
          deps: [1, 2],
        },
      ],
    },
    shop: {
      keywords: ["商城", "电商", "shop", "store", "购物", "商品", "订单"],
      tasks: [
        {
          title: "数据库设计",
          type: "database",
          description: "设计数据库表结构（商品表、订单表、用户表、支付表等）",
          deps: [],
        },
        {
          title: "商品管理 API",
          type: "api",
          description: "实现商品 CRUD、分类、搜索等接口",
          deps: [0],
        },
        {
          title: "订单系统 API",
          type: "api",
          description: "实现订单创建、支付、状态管理等接口",
          deps: [0],
        },
        {
          title: "用户系统",
          type: "backend",
          description: "实现用户注册、登录、地址管理",
          deps: [0],
        },
        {
          title: "商品展示页面",
          type: "frontend",
          description: "实现商品列表、详情、搜索页面",
          deps: [1],
        },
        {
          title: "购物车与结算页面",
          type: "frontend",
          description: "实现购物车、结算、支付页面",
          deps: [2, 3],
        },
        {
          title: "部署与测试",
          type: "devops",
          description: "配置部署和集成测试",
          deps: [4, 5],
        },
      ],
    },
    admin: {
      keywords: ["管理", "admin", "dashboard", "后台", "管理系统", "管理平台"],
      tasks: [
        {
          title: "数据库设计",
          type: "database",
          description: "设计数据库表结构",
          deps: [],
        },
        {
          title: "后端 API",
          type: "api",
          description: "实现核心 CRUD API 和权限控制",
          deps: [0],
        },
        {
          title: "认证与权限",
          type: "backend",
          description: "实现登录、角色、权限管理",
          deps: [0],
        },
        {
          title: "管理界面",
          type: "frontend",
          description: "实现管理后台 UI（表格、表单、图表）",
          deps: [1, 2],
        },
        {
          title: "测试与部署",
          type: "devops",
          description: "编写测试用例和部署配置",
          deps: [3],
        },
      ],
    },
    tool: {
      keywords: ["工具", "tool", "cli", "命令行", "脚本", "script", "自动化"],
      tasks: [
        {
          title: "架构设计",
          type: "architecture",
          description: "设计工具的核心架构和模块划分",
          deps: [],
        },
        {
          title: "核心功能实现",
          type: "backend",
          description: "实现核心业务逻辑",
          deps: [0],
        },
        {
          title: "CLI 接口",
          type: "backend",
          description: "实现命令行接口和参数解析",
          deps: [1],
        },
        {
          title: "文档编写",
          type: "docs",
          description: "编写使用文档和 README",
          deps: [2],
        },
        {
          title: "测试",
          type: "test",
          description: "编写单元测试和集成测试",
          deps: [1],
        },
      ],
    },
    service: {
      keywords: ["api", "服务", "service", "接口", "微服务", "server"],
      tasks: [
        {
          title: "数据库设计",
          type: "database",
          description: "设计数据模型和数据库架构",
          deps: [],
        },
        {
          title: "API 设计",
          type: "architecture",
          description: "设计 API 接口规范",
          deps: [],
        },
        {
          title: "API 实现",
          type: "api",
          description: "实现核心 API 接口",
          deps: [0, 1],
        },
        {
          title: "认证与中间件",
          type: "backend",
          description: "实现认证、限流、日志等中间件",
          deps: [2],
        },
        {
          title: "测试与文档",
          type: "test",
          description: "编写 API 测试和接口文档",
          deps: [2],
        },
        {
          title: "部署配置",
          type: "devops",
          description: "容器化和部署配置",
          deps: [3],
        },
      ],
    },
  },

  matchTemplate(description) {
    const lower = description.toLowerCase();
    let bestMatch = null;
    let bestScore = 0;

    for (const [name, template] of Object.entries(this.templates)) {
      const score = template.keywords.filter((kw) => lower.includes(kw)).length;
      if (score > bestScore) {
        bestScore = score;
        bestMatch = name;
      }
    }

    return bestMatch;
  },

  generateGenericTasks(description) {
    return [
      {
        title: "需求分析与设计",
        type: "architecture",
        description: `分析需求: ${description}，设计整体架构`,
        deps: [],
      },
      {
        title: "核心功能开发",
        type: "general",
        description: "实现核心业务逻辑",
        deps: [0],
      },
      {
        title: "辅助功能开发",
        type: "general",
        description: "实现辅助功能和边缘场景处理",
        deps: [1],
      },
      {
        title: "测试验证",
        type: "test",
        description: "编写测试用例并验证功能",
        deps: [1, 2],
      },
      {
        title: "文档与收尾",
        type: "docs",
        description: "编写文档，代码清理",
        deps: [3],
      },
    ];
  },

  plan(description) {
    const templateName = this.matchTemplate(description);
    let tasks;

    if (templateName) {
      tasks = JSON.parse(JSON.stringify(this.templates[templateName].tasks));
      console.log(`📋 匹配到模板: ${templateName}`);
    } else {
      tasks = this.generateGenericTasks(description);
      console.log("📋 使用通用模板");
    }

    // 动态分配 ID（基于当前已有任务）
    const existingTasks = TaskStore.load().tasks;
    const startNum =
      existingTasks.length > 0
        ? Math.max(
            ...existingTasks.map((t) => {
              const m = t.id.match(/^T(\d+)$/);
              return m ? parseInt(m[1], 10) : 0;
            })
          ) + 1
        : 1;

    // 为每个新任务分配 ID
    const idMap = {};
    tasks.forEach((t, i) => {
      const id = "T" + String(startNum + i).padStart(3, "0");
      idMap[i] = id;
      t.id = id;
    });

    // 解析相对索引依赖为实际 ID
    tasks.forEach((t) => {
      t.deps = (t.deps || []).map((dep) => {
        if (typeof dep === "number") {
          return idMap[dep] || dep;
        }
        return dep; // 已经是字符串 ID，保持不变
      });
    });

    tasks.forEach((t) => {
      if (!t.description.includes(description)) {
        t.description = `[${description}] ${t.description}`;
      }
    });

    return tasks;
  },

  // 从 Markdown 文件导入任务列表
  importFromMarkdown(filePath) {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const tasks = [];

    for (const line of lines) {
      const trimmed = line.trim();
      // 匹配: - [ ] T001: 标题 (type: xxx, deps: T001,T002)
      // 或简单: - [ ] 标题
      const match = trimmed.match(
        /^-\s*\[[ x]\]\s*(?:T\d+:\s*)?(.+?)(?:\s*\((.+)\))?$/
      );
      if (!match) continue;

      const title = match[1].trim();
      const meta = match[2] || "";

      let type = "general";
      let deps = [];

      const typeMatch = meta.match(/type:\s*(\w+)/);
      if (typeMatch && TASK_TYPES.includes(typeMatch[1])) {
        type = typeMatch[1];
      }

      const depsMatch = meta.match(/deps?:\s*([^)]+)/);
      if (depsMatch && depsMatch[1].trim() !== "none") {
        deps = depsMatch[1]
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean);
      }

      tasks.push({ title, type, description: title, deps });
    }

    return tasks;
  },
};

// ═══ 命令实现 ═══
function cmd_init(parsed) {
  if (FileUtils.exists(SNOWFLOW_DIR) && !parsed.flags.force) {
    console.log("⚠️  工作流已初始化。使用 --force 重新初始化。");
    return;
  }

  // force 模式：清除旧目录
  if (parsed.flags.force && FileUtils.exists(SNOWFLOW_DIR)) {
    fs.rmSync(SNOWFLOW_DIR, { recursive: true, force: true });
    console.log("🗑️  已清除旧的 .snowflow 目录");
  }

  // 创建目录结构
  FileUtils.ensureDir(SNOWFLOW_DIR);
  FileUtils.ensureDir(CONTEXT_DIR);
  FileUtils.ensureDir(EVOLUTION_DIR);

  // 创建初始文件
  FileUtils.writeJSON(CONFIG_FILE, DEFAULT_CONFIG);

  const now = new Date().toISOString();
  const initialTasks = {
    metadata: { name: "", createdAt: now, updatedAt: now },
    tasks: [],
  };
  FileUtils.writeJSON(TASKS_FILE, initialTasks);

  ProgressRenderer.update(initialTasks);

  FileUtils.writeMD(SUMMARY_FILE, "# 项目摘要\n\n_暂无摘要信息_\n");
  FileUtils.writeJSON(MEMORY_FILE, {
    entries: [],
    metadata: { totalExtracted: 0, lastUpdated: null },
  });

  // 注入工作流协议
  const protocolFile = ProtocolInjector.inject();

  // 注册 Snow CLI hooks
  const hooksResult = HooksInstaller.install();

  // 部署 Snow CLI 规则文件
  const ruleDeployed = [];
  if (fs.existsSync(".snow")) {
    const rulesDir = path.join(".snow", "rules");
    if (!fs.existsSync(rulesDir)) {
      fs.mkdirSync(rulesDir, { recursive: true });
    }
    const ruleFile = path.join(rulesDir, "snowflow.md");
    if (!FileUtils.exists(ruleFile) || parsed.flags.force) {
      fs.writeFileSync(ruleFile, SNOWFLOW_RULE_CONTENT, "utf-8");
      ruleDeployed.push(ruleFile);
    }
  }

  console.log("✅ 工作流已初始化！");
  console.log("");
  console.log("已创建:");
  console.log(`  📁 ${SNOWFLOW_DIR}/`);
  console.log(`  📁 ${CONTEXT_DIR}/`);
  console.log(`  📁 ${EVOLUTION_DIR}/`);
  console.log(`  📄 ${CONFIG_FILE}`);
  console.log(`  📄 ${TASKS_FILE}`);
  console.log(`  📄 ${PROGRESS_FILE}`);
  console.log(`  📄 ${SUMMARY_FILE}`);
  console.log(`  📄 ${MEMORY_FILE}`);
  console.log(`  📄 ${protocolFile}`);
  if (hooksResult.installed) {
    hooksResult.results.forEach((r) => {
      console.log(
        `  🔗 Hook ${r.event}: ${
          r.status === "registered" ? "已注册" : "已存在"
        }`
      );
    });
  }
  console.log("");
  if (!hooksResult.installed) {
    console.log(`  ℹ️  ${hooksResult.reason}`);
    console.log("  提示: 初始化 Snow CLI 后重新运行 init 可注册 hooks");
    console.log("");
  }
  if (ruleDeployed.length > 0) {
    ruleDeployed.forEach((f) => {
      console.log(`  📋 规则文件: ${f}`);
    });
    console.log("");
  }
  console.log('下一步: snowflow plan "你的需求描述"  拆解任务');
}

function cmd_plan(parsed) {
  const description = parsed.args[0];
  const importFile = parsed.flags.import;

  if (!description && !importFile) {
    console.error(
      '❌ 请提供需求描述: snowflow plan "你的需求" 或 --import <file>'
    );
    process.exit(1);
  }

  if (!FileUtils.exists(SNOWFLOW_DIR)) {
    console.error("❌ 工作流未初始化，请先运行: snowflow init");
    process.exit(1);
  }

  const data = TaskStore.load();
  if (data.tasks.length > 0 && !parsed.flags.force) {
    console.error("❌ 已存在任务列表，使用 --force 重新规划");
    process.exit(1);
  }

  // force 模式：先清除旧的 context 文件和任务数据
  if (parsed.flags.force && data.tasks.length > 0) {
    data.tasks.forEach((t) => {
      const contextFile = path.join(CONTEXT_DIR, `task-${t.id}.md`);
      if (FileUtils.exists(contextFile)) {
        fs.unlinkSync(contextFile);
      }
    });
    const emptyData = {
      metadata: data.metadata,
      tasks: [],
    };
    TaskStore.save(emptyData);
  }

  let taskTemplates;
  if (importFile) {
    // --import 模式：从 Markdown 文件导入
    if (!FileUtils.exists(importFile)) {
      console.error(`❌ 文件不存在: ${importFile}`);
      process.exit(1);
    }
    console.log(`\n📥 从文件导入: "${importFile}"\n`);
    const rawTasks = PlanEngine.importFromMarkdown(importFile);
    if (rawTasks.length === 0) {
      console.error("❌ 未从文件中解析到任何任务");
      process.exit(1);
    }
    // 分配动态 ID
    const existingTasks = TaskStore.load().tasks;
    const startNum =
      existingTasks.length > 0
        ? Math.max(
            ...existingTasks.map((t) => {
              const m = t.id.match(/^T(\d+)$/);
              return m ? parseInt(m[1], 10) : 0;
            })
          ) + 1
        : 1;
    const idMap = {};
    rawTasks.forEach((t, i) => {
      const id = "T" + String(startNum + i).padStart(3, "0");
      idMap[i] = id;
      t.id = id;
    });
    taskTemplates = rawTasks;
  } else {
    console.log(`\n🎯 分析需求: "${description}"\n`);
    taskTemplates = PlanEngine.plan(description);
  }

  // 构造完整的任务数组（使用 plan() 分配的动态 ID）
  const now = new Date().toISOString();
  const tasks = taskTemplates.map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    type: TASK_TYPES.includes(t.type) ? t.type : "general",
    status: STATUS.PENDING,
    deps: Array.isArray(t.deps) ? t.deps : [],
    retries: 0,
    createdAt: now,
    completedAt: null,
    summary: "",
  }));

  const newData = {
    metadata: {
      name: description,
      createdAt: now,
      updatedAt: now,
    },
    tasks,
  };

  TaskStore.save(newData);
  ProgressRenderer.update(newData);

  // 输出任务列表
  console.log(`✅ 已生成 ${tasks.length} 个任务:\n`);
  tasks.forEach((t) => {
    const deps = t.deps.length > 0 ? ` (依赖: ${t.deps.join(", ")})` : "";
    console.log(`  ${t.id} [${t.type}] ${t.title}${deps}`);
    console.log(`       ${t.description}`);
  });

  console.log(`\n📝 任务已写入 ${TASKS_FILE}`);
  console.log(`📊 进度已更新 ${PROGRESS_FILE}`);
  console.log("\n下一步: snowflow next  获取第一个可执行任务");
}
// next 命令 — 获取下一个可执行任务
function cmd_next(parsed) {
  if (!FileUtils.exists(SNOWFLOW_DIR)) {
    console.error("❌ 工作流未初始化，请先运行: snowflow init");
    process.exit(1);
  }

  // 心跳超时检查
  Heartbeat.check();

  // 暂停检查
  const config = FileUtils.readJSON(CONFIG_FILE, DEFAULT_CONFIG);
  if (config.paused && !parsed.flags.force) {
    console.log("⏸️  工作流已暂停。使用 resume 恢复或 --force 强制获取");
    return;
  }

  // 熔断检查
  const breaker = LoopDetector.checkCircuitBreaker();
  if (breaker.triggered && !parsed.flags.force) {
    console.log(`\n🛑 ${breaker.message}`);
    console.log("  使用 --force 可强制跳过熔断");
    console.log("  或运行: snowflow reset-breaker 重置熔断器");
    return;
  }

  const readyTasks = TaskStore.getReadyTasks();
  const allTasks = TaskStore.getAllTasks();

  if (readyTasks.length === 0) {
    const stats = TaskStore.getStats();
    if (stats.total === 0) {
      console.log('⚠️  暂无任务。请先运行: snowflow plan "需求描述"');
    } else if (stats.done + stats.skipped === stats.total) {
      console.log("🎉 所有任务已完成！");
    } else if (stats.active > 0) {
      console.log("⏳ 等待进行中的任务完成...");
      const activeTasks = allTasks.filter((t) => t.status === STATUS.ACTIVE);
      activeTasks.forEach((t) => {
        console.log(`  🔄 ${t.id} [${t.type}] ${t.title}`);
      });
    } else {
      console.log("⚠️  无可执行任务（可能有依赖阻塞）");
    }
    return;
  }

  const isBatch = parsed.flags.batch === true;

  if (isBatch) {
    // --batch 模式：返回所有可并行的就绪任务
    console.log(`\n📌 可并行任务 (${readyTasks.length}个):\n`);
    readyTasks.forEach((t, i) => {
      const depInfo =
        t.deps.length > 0
          ? "(依赖: " + t.deps.map((d) => d + " ✅").join(", ") + ")"
          : "(无依赖)";
      console.log(`  [${i + 1}] ${t.id} [${t.type}] ${t.title} ${depInfo}`);
      TaskStore.updateStatus(t.id, STATUS.ACTIVE);
    });
    console.log("\n所有任务已标记为 active。");
    console.log('完成后分别执行: snowflow checkpoint <id> --message "摘要"');
  } else {
    // 默认模式：返回第一个就绪任务
    const task = readyTasks[0];
    TaskStore.updateStatus(task.id, STATUS.ACTIVE);

    console.log("\n📌 下一个任务:\n");
    console.log(`  ID:    ${task.id}`);
    console.log(`  标题:  ${task.title}`);
    console.log(`  类型:  ${task.type}`);
    console.log(`  描述:  ${task.description}`);

    if (task.deps.length > 0) {
      const depStatus = task.deps.map((d) => {
        const depTask = TaskStore.getTask(d);
        const emoji = depTask ? STATUS_EMOJI[depTask.status] : "❓";
        const label = depTask
          ? depTask.status === STATUS.DONE
            ? "已完成"
            : depTask.status
          : "未知";
        return `${d} (${emoji} ${label})`;
      });
      console.log(`  依赖:  ${depStatus.join(", ")}`);

      // 输出依赖上下文
      const doneDepTasks = task.deps
        .map((d) => TaskStore.getTask(d))
        .filter((dt) => dt && dt.status === STATUS.DONE && dt.summary);
      if (doneDepTasks.length > 0) {
        console.log("\n  依赖上下文:");
        doneDepTasks.forEach((dt) => {
          console.log(`    ${dt.id} [${dt.title}]: ${dt.summary}`);
        });
      }
    } else {
      console.log("  依赖:  无");
    }
    // 输出构建的上下文
    const context = ContextBuilder.build(task);
    if (context.trim()) {
      console.log("\n  --- 上下文信息 ---");
      console.log(
        context
          .split("\n")
          .map((l) => "  " + l)
          .join("\n")
      );
    }

    // 推荐子代理
    const recommendation = AgentMatcher.getRecommendation(task);
    console.log(`\n  🤖 推荐子代理: ${recommendation}`);

    console.log(
      `\n  派发命令: 完成后执行 snowflow checkpoint ${task.id} --message "产出摘要"`
    );
  }
}

// checkpoint 命令 — 记录任务完成/失败
function cmd_checkpoint(parsed) {
  if (!FileUtils.exists(SNOWFLOW_DIR)) {
    console.error("❌ 工作流未初始化，请先运行: snowflow init");
    process.exit(1);
  }

  const taskId = parsed.args[0];
  if (!taskId) {
    console.error(
      '❌ 请提供任务 ID: snowflow checkpoint <id> --message "摘要"'
    );
    process.exit(1);
  }

  const data = TaskStore.load();
  const task = data.tasks.find((t) => t.id === taskId);
  if (!task) {
    console.error(`❌ 任务 ${taskId} 不存在`);
    process.exit(1);
  }
  if (task.status !== STATUS.ACTIVE) {
    console.error(
      `❌ 任务 ${taskId} 当前状态为 ${task.status}，只有 active 状态的任务才能 checkpoint`
    );
    process.exit(1);
  }

  const finalStatus = parsed.flags.status || "done";
  const message = parsed.flags.message || "";

  if (finalStatus === "done") {
    task.status = STATUS.DONE;
    task.completedAt = new Date().toISOString();
    task.summary = message;
    TaskStore.save(data);

    // 创建 context 文件
    const contextContent = [
      `# Task ${task.id}: ${task.title}`,
      "",
      `- **类型**: ${task.type}`,
      `- **状态**: ✅ done`,
      `- **完成时间**: ${task.completedAt}`,
      `- **描述**: ${task.description}`,
      "",
      "## 产出摘要",
      "",
      message || "_无摘要_",
      "",
    ].join("\n");
    const contextFile = path.join(CONTEXT_DIR, `task-${task.id}.md`);
    FileUtils.writeMD(contextFile, contextContent);

    ProgressRenderer.update(data);

    console.log(`\n✅ 任务 ${task.id} 已完成！`);
    console.log(`  标题: ${task.title}`);
    if (message) console.log(`  摘要: ${message}`);
    console.log(`  上下文: ${contextFile}`);

    // 自动 git commit
    const committed = GitAuto.autoCommit(task.id, task.title);
    if (committed) {
      console.log(`  📦 已自动提交: [SnowFlow] ${task.id}: ${task.title}`);
    }

    // 知识提取
    const extracted = KnowledgeExtractor.extract(
      message,
      task.id,
      task.title,
      task.type
    );
    if (extracted.length > 0) {
      console.log(`  🧠 已提取 ${extracted.length} 条知识到记忆库`);
    }

    // 滚动摘要检查
    SummaryRoller.check();

    console.log("\n下一步: snowflow next  获取下一个任务");
  } else if (finalStatus === "failed") {
    const config = FileUtils.readJSON(CONFIG_FILE, DEFAULT_CONFIG);
    const maxRetries = config.maxRetries || DEFAULT_CONFIG.maxRetries;
    task.retries = (task.retries || 0) + 1;

    if (task.retries < maxRetries) {
      // 可重试：重置为 pending
      task.status = STATUS.PENDING;
      TaskStore.save(data);
      ProgressRenderer.update(data);

      console.log(
        `\n⚠️  任务 ${task.id} 失败 (第 ${task.retries}/${maxRetries} 次)`
      );
      console.log(`  标题: ${task.title}`);
      if (message) console.log(`  原因: ${message}`);
      console.log("  状态已重置为 pending，可重试。");

      // 循环检测
      LoopDetector.check(taskId);

      console.log("\n下一步: snowflow next  重新获取任务");
    } else {
      // 超过重试上限：标记 failed 并级联跳过
      task.status = STATUS.FAILED;
      task.completedAt = new Date().toISOString();
      task.summary = message || "任务失败（超过最大重试次数）";
      TaskStore.save(data);

      // 级联跳过依赖此任务的后续任务（不跳过自身）
      const skippedIds = TaskStore.cascadeSkip(task.id, false);

      ProgressRenderer.update(TaskStore.load());

      console.log(`\n❌ 任务 ${task.id} 最终失败（已重试 ${task.retries} 次）`);
      console.log(`  标题: ${task.title}`);
      if (message) console.log(`  原因: ${message}`);

      // 报告级联跳过的任务
      if (skippedIds.length > 0) {
        console.log("\n  ⏭️  以下任务被级联跳过:");
        const allTasks = TaskStore.getAllTasks();
        skippedIds.forEach((sid) => {
          const st = allTasks.find((t) => t.id === sid);
          if (st) console.log(`    ${st.id} [${st.type}] ${st.title}`);
        });
      }

      // 循环检测 + 熔断检查
      LoopDetector.check(taskId);
    }
  } else {
    console.error(`❌ 无效的状态: ${finalStatus}（只支持 done 或 failed）`);
    process.exit(1);
  }
}

// status 命令 — 查看全局进度
function cmd_status(parsed) {
  if (!FileUtils.exists(SNOWFLOW_DIR)) {
    console.error("❌ 工作流未初始化，请先运行: snowflow init");
    process.exit(1);
  }

  // 心跳超时检查
  Heartbeat.check();

  const stats = TaskStore.getStats();
  const allTasks = TaskStore.getAllTasks();
  const data = TaskStore.load();
  const workflowName = data.metadata.name || "未命名";

  // --json 输出模式
  if (parsed.flags.json) {
    const jsonData = TaskStore.load();
    console.log(JSON.stringify({ stats, tasks: jsonData.tasks }, null, 2));
    return;
  }

  // 进度条：30 个字符
  const barLen = 30;
  const ratio =
    stats.total > 0 ? (stats.done + stats.skipped) / stats.total : 0;
  const filled = Math.round(ratio * barLen);
  const bar = "█".repeat(filled) + "░".repeat(barLen - filled);

  console.log("\n📊 SnowFlow 工作流状态\n");
  console.log(`  工作流: ${workflowName}`);
  console.log(
    `  进度:   [${bar}] ${Math.round(ratio * 100)}% (${
      stats.done + stats.skipped
    }/${stats.total})`
  );
  console.log("");
  console.log(
    `  ✅ 完成: ${stats.done}  |  🔄 进行中: ${stats.active}  |  ⏳ 待执行: ${stats.pending}  |  ❌ 失败: ${stats.failed}  |  ⏭️ 跳过: ${stats.skipped}`
  );

  // 按状态分组显示
  const groups = [
    { status: STATUS.ACTIVE, label: "🔄 进行中", emoji: "🔄" },
    { status: STATUS.PENDING, label: "⏳ 待执行", emoji: "⏳" },
    { status: STATUS.DONE, label: "✅ 已完成", emoji: "✅" },
    { status: STATUS.FAILED, label: "❌ 已失败", emoji: "❌" },
    { status: STATUS.SKIPPED, label: "⏭️ 已跳过", emoji: "⏭️" },
  ];

  groups.forEach((g) => {
    const tasksInGroup = allTasks.filter((t) => t.status === g.status);
    if (tasksInGroup.length > 0) {
      console.log(`\n  ${g.label}:`);
      tasksInGroup.forEach((t) => {
        const deps = t.deps.length > 0 ? ` (依赖: ${t.deps.join(", ")})` : "";
        console.log(`    ${t.id} [${t.type}] ${t.title}${deps}`);
      });
    }
  });

  console.log("");
}

// skip 命令 — 跳过任务（级联）
function cmd_skip(parsed) {
  if (!FileUtils.exists(SNOWFLOW_DIR)) {
    console.error("❌ 工作流未初始化，请先运行: snowflow init");
    process.exit(1);
  }

  const taskId = parsed.args[0];
  if (!taskId) {
    console.error("❌ 请提供任务 ID: snowflow skip <id>");
    process.exit(1);
  }

  const task = TaskStore.getTask(taskId);
  if (!task) {
    console.error(`❌ 任务 ${taskId} 不存在`);
    process.exit(1);
  }

  const skippedIds = TaskStore.cascadeSkip(taskId);

  if (skippedIds.length === 0) {
    console.log(`⚠️  任务 ${taskId} 无法跳过（当前状态: ${task.status}）`);
    return;
  }

  // 更新 progress
  ProgressRenderer.update(TaskStore.load());

  const allTasks = TaskStore.getAllTasks();
  console.log("\n⏭️  已跳过以下任务:");
  skippedIds.forEach((sid) => {
    const st = allTasks.find((t) => t.id === sid);
    const isCascade = sid !== taskId ? " (级联跳过)" : "";
    if (st) {
      console.log(`  ${st.id} [${st.type}] ${st.title}${isCascade}`);
    }
  });
  console.log(`\n共跳过 ${skippedIds.length} 个任务`);
}
// reset-breaker 命令 — 重置熔断器
function cmd_resetBreaker(parsed) {
  if (!FileUtils.exists(SNOWFLOW_DIR)) {
    console.error("❌ 工作流未初始化，请先运行: snowflow init");
    process.exit(1);
  }

  const data = TaskStore.load();
  const failedTasks = data.tasks.filter((t) => t.status === STATUS.FAILED);

  if (failedTasks.length === 0) {
    console.log("✅ 无需重置，没有失败的任务");
    return;
  }

  failedTasks.forEach((t) => {
    t.retries = 0;
  });
  TaskStore.save(data);

  console.log(`\n🔧 已重置 ${failedTasks.length} 个失败任务的重试计数`);
  failedTasks.forEach((t) => {
    console.log(`  ${t.id} [${t.type}] ${t.title}`);
  });
  console.log("\n现在可以使用 next 继续获取任务");
}

// resume 命令 — 中断恢复
function cmd_resume(parsed) {
  if (!FileUtils.exists(SNOWFLOW_DIR)) {
    if (parsed.flags.silent) return;
    console.error("❌ 工作流未初始化，请先运行: snowflow init");
    process.exit(1);
  }

  // 清除暂停标记
  const config = FileUtils.readJSON(CONFIG_FILE, DEFAULT_CONFIG);
  if (config.paused) {
    config.paused = false;
    FileUtils.writeJSON(CONFIG_FILE, config);
  }

  const data = TaskStore.load();
  const activeTasks = data.tasks.filter((t) => t.status === STATUS.ACTIVE);
  const isSilent = parsed.flags.silent === true;

  if (activeTasks.length === 0) {
    if (!isSilent) {
      const stats = TaskStore.getStats();
      if (stats.total === 0) {
        console.log('⚠️  暂无任务。请先运行: snowflow plan "需求描述"');
      } else if (stats.done + stats.skipped === stats.total) {
        console.log("🎉 所有任务已完成，无需恢复！");
      } else {
        console.log("✅ 无需恢复，没有中断的任务。");
      }
    }
    return;
  }

  // 将所有 active 任务重置为 pending
  activeTasks.forEach((t) => {
    t.status = STATUS.PENDING;
  });
  TaskStore.save(data);
  ProgressRenderer.update(data);

  if (!isSilent) {
    console.log(`\n🔄 已恢复 ${activeTasks.length} 个中断的任务:\n`);
    activeTasks.forEach((t) => {
      console.log(`  ${t.id} [${t.type}] ${t.title} (active → pending)`);
    });
    console.log("\n下一步: snowflow next  获取任务继续执行");
  }
}

// pause 命令 — 暂停工作流
function cmd_pause(parsed) {
  if (!FileUtils.exists(SNOWFLOW_DIR)) {
    console.error("❌ 工作流未初始化，请先运行: snowflow init");
    process.exit(1);
  }

  const data = TaskStore.load();
  const activeTasks = data.tasks.filter((t) => t.status === STATUS.ACTIVE);

  // 写入暂停标记
  const config = FileUtils.readJSON(CONFIG_FILE, DEFAULT_CONFIG);
  config.paused = true;
  FileUtils.writeJSON(CONFIG_FILE, config);

  // active → pending
  activeTasks.forEach((t) => {
    t.status = STATUS.PENDING;
  });
  TaskStore.save(data);
  ProgressRenderer.update(data);

  console.log("\n⏸️  工作流已暂停");
  if (activeTasks.length > 0) {
    console.log(`  已将 ${activeTasks.length} 个进行中任务重置为 pending:`);
    activeTasks.forEach((t) => {
      console.log(`    ${t.id} [${t.type}] ${t.title}`);
    });
  }
  console.log("\n恢复: snowflow resume");
}

// save-context 命令 — 上下文快照输出
function cmd_saveContext(parsed) {
  if (!FileUtils.exists(SNOWFLOW_DIR)) {
    console.error("❌ 工作流未初始化，请先运行: snowflow init");
    process.exit(1);
  }

  const stats = TaskStore.getStats();
  const data = TaskStore.load();
  const activeTasks = data.tasks.filter((t) => t.status === STATUS.ACTIVE);

  const sections = [];
  sections.push("# SnowFlow 上下文快照");
  sections.push(`\n**时间**: ${new Date().toISOString()}`);
  sections.push(`**进度**: ${stats.done}/${stats.total} (${stats.progress}%)`);

  // 当前进行中的任务
  if (activeTasks.length > 0) {
    sections.push("\n## 进行中任务");
    activeTasks.forEach((t) => {
      sections.push(`- ${t.id} [${t.type}] ${t.title}: ${t.description}`);
    });
  }

  // 项目摘要
  const summary = FileUtils.readMD(SUMMARY_FILE, "");
  if (summary && !summary.includes("_暂无摘要信息_")) {
    sections.push("\n## 项目摘要");
    sections.push(summary);
  }

  // 关键记忆
  const memories = MemoryStore.getAll();
  const keyMemories = memories.filter(
    (m) =>
      m.type === "remember" ||
      m.type === "architecture" ||
      m.type === "decision"
  );
  if (keyMemories.length > 0) {
    sections.push("\n## 关键记忆");
    keyMemories.slice(-10).forEach((m) => {
      sections.push(`- [${m.type}] ${m.content}`);
    });
  }

  const output = sections.join("\n");
  console.log(output);
}

// auto-checkpoint 命令 — 自动匹配 active 任务并 checkpoint
function cmd_autoCheckpoint(parsed) {
  if (!FileUtils.exists(SNOWFLOW_DIR)) {
    console.error("❌ 工作流未初始化，请先运行: snowflow init");
    process.exit(1);
  }

  const data = TaskStore.load();
  const activeTasks = data.tasks.filter((t) => t.status === STATUS.ACTIVE);

  if (activeTasks.length === 0) {
    console.log("⚠️  没有进行中的任务");
    return;
  }

  const message = parsed.args[0] || "";
  const finalStatus = parsed.flags.status || "done";

  let targetTask;
  if (activeTasks.length === 1) {
    targetTask = activeTasks[0];
  } else if (message) {
    // 多个 active 任务时用 BM25 匹配
    const scored = activeTasks.map((t) => ({
      task: t,
      score:
        BM25Search.search(
          message,
          [{ content: t.title + " " + t.description, id: t.id }],
          1
        )[0]?.score || 0,
    }));
    scored.sort((a, b) => b.score - a.score);
    targetTask = scored[0].task;
  } else {
    // 无消息时取第一个 active 任务
    targetTask = activeTasks[0];
  }

  // 复用 checkpoint 逻辑
  cmd_checkpoint({
    args: [targetTask.id],
    flags: { status: finalStatus, message },
  });

  if (activeTasks.length > 1) {
    console.log(`\n📌 自动匹配到: ${targetTask.id} ${targetTask.title}`);
  }
}

// add 命令 — 运行中追加任务
function cmd_add(parsed) {
  if (!FileUtils.exists(SNOWFLOW_DIR)) {
    console.error("❌ 工作流未初始化，请先运行: snowflow init");
    process.exit(1);
  }

  const description = parsed.args[0];
  if (!description) {
    console.error(
      '❌ 请提供任务描述: snowflow add "任务描述" [--type <type>] [--after <id>]'
    );
    process.exit(1);
  }

  const taskType = parsed.flags.type || "general";
  if (!TASK_TYPES.includes(taskType)) {
    console.error(`❌ 无效的任务类型: ${taskType}`);
    console.error(`支持的类型: ${TASK_TYPES.join(", ")}`);
    process.exit(1);
  }

  // 处理依赖：--after 可以是逗号分隔的多个 ID
  let deps = [];
  if (parsed.flags.after) {
    deps = parsed.flags.after.split(",").map((d) => d.trim());
    // 验证依赖的任务是否存在
    const allTasks = TaskStore.getAllTasks();
    const allIds = new Set(allTasks.map((t) => t.id));
    const invalidDeps = deps.filter((d) => !allIds.has(d));
    if (invalidDeps.length > 0) {
      console.error(`❌ 以下依赖任务不存在: ${invalidDeps.join(", ")}`);
      process.exit(1);
    }
  }

  const newTask = TaskStore.addTask({
    title: description,
    description: description,
    type: taskType,
    deps: deps,
  });

  // 更新 progress.md
  ProgressRenderer.update(TaskStore.load());

  console.log("\n✅ 已追加新任务:\n");
  console.log(`  ID:    ${newTask.id}`);
  console.log(`  标题:  ${newTask.title}`);
  console.log(`  类型:  ${newTask.type}`);
  const depStr = newTask.deps.length > 0 ? newTask.deps.join(", ") : "无";
  console.log(`  依赖:  ${depStr}`);
  console.log(`  状态:  ⏳ pending`);
  console.log("\n下一步: snowflow next  查看可执行任务");
}
// config 命令 — 查看/设置/重置配置
function cmd_config(parsed) {
  if (!FileUtils.exists(SNOWFLOW_DIR)) {
    console.error("❌ 工作流未初始化，请先运行: snowflow init");
    process.exit(1);
  }

  const EDITABLE_KEYS = [
    "maxRetries",
    "parallelLimit",
    "checkpointAutoCommit",
    "heartbeatTimeoutMinutes",
    "contextMaxSize",
    "summaryCompressThreshold",
    "memoryHalfLifeDays",
  ];

  const subCmd = parsed.args[0];
  const config = FileUtils.readJSON(CONFIG_FILE, DEFAULT_CONFIG);

  if (!subCmd) {
    // 查看配置
    console.log("\n⚙️  当前配置:\n");
    EDITABLE_KEYS.forEach((key) => {
      const val = config[key] !== undefined ? config[key] : DEFAULT_CONFIG[key];
      const def = DEFAULT_CONFIG[key];
      const mark = val !== def ? " (已修改)" : "";
      console.log(`  ${key} = ${JSON.stringify(val)}${mark}`);
    });
    return;
  }

  if (subCmd === "set") {
    const key = parsed.args[1];
    const val = parsed.args[2];
    if (!key || val === undefined) {
      console.error("❌ 用法: config set <key> <value>");
      process.exit(1);
    }
    if (!EDITABLE_KEYS.includes(key)) {
      console.error(`❌ 不支持的配置项: ${key}`);
      console.error(`支持的配置项: ${EDITABLE_KEYS.join(", ")}`);
      process.exit(1);
    }
    // 类型转换
    let typedVal;
    if (val === "true") typedVal = true;
    else if (val === "false") typedVal = false;
    else if (!isNaN(Number(val))) typedVal = Number(val);
    else typedVal = val;

    config[key] = typedVal;
    FileUtils.writeJSON(CONFIG_FILE, config);
    console.log(`✅ 已设置 ${key} = ${JSON.stringify(typedVal)}`);
    return;
  }

  if (subCmd === "reset") {
    FileUtils.writeJSON(CONFIG_FILE, { ...DEFAULT_CONFIG });
    console.log("✅ 配置已重置为默认值");
    return;
  }

  console.error(`❌ 未知子命令: ${subCmd}（支持: set, reset）`);
  process.exit(1);
}

// recall 命令 — 检索长期记忆
function cmd_recall(parsed) {
  if (!FileUtils.exists(SNOWFLOW_DIR)) {
    console.error("❌ 工作流未初始化，请先运行: snowflow init");
    process.exit(1);
  }

  const query = parsed.args[0];
  const memStats = MemoryStore.getStats();

  if (memStats.total === 0 && !parsed.flags.stats) {
    console.log("⚠️  记忆库为空。完成一些任务后会自动积累知识。");
    return;
  }

  // --stats: 记忆库详细统计
  if (parsed.flags.stats) {
    console.log("\n📊 记忆库统计\n");
    console.log(`  总条目: ${memStats.total}`);
    console.log("  按类型:");
    for (const [type, count] of Object.entries(memStats.byType)) {
      const emoji =
        type === "remember"
          ? "💡"
          : type === "decision"
          ? "🔧"
          : type === "architecture"
          ? "🏗️"
          : "📝";
      console.log(`    ${emoji} ${type}: ${count} 条`);
    }
    const entries = MemoryStore.getAll();
    if (entries.length > 0) {
      const oldest = entries[0].createdAt;
      const newest = entries[entries.length - 1].createdAt;
      console.log(`\n  最早记忆: ${oldest}`);
      console.log(`  最新记忆: ${newest}`);
      // 按来源统计
      const bySrc = {};
      entries.forEach((e) => {
        bySrc[e.source] = (bySrc[e.source] || 0) + 1;
      });
      const srcCount = Object.keys(bySrc).length;
      console.log(`  来源任务: ${srcCount} 个`);
    }
    return;
  }

  // --clean: 清理过期/低分记忆
  if (parsed.flags.clean) {
    const data = MemoryStore.load();
    const before = data.entries.length;
    if (before === 0) {
      console.log("⚠️  记忆库为空，无需清理");
      return;
    }
    // 保留最近 500 条，删除最旧的
    if (before > 500) {
      data.entries = data.entries.slice(-500);
    }
    // 删除内容过短的（< 10 字符）
    data.entries = data.entries.filter(
      (e) => e.content && e.content.length >= 10
    );
    const after = data.entries.length;
    data.metadata.totalExtracted = after;
    MemoryStore.save(data);
    console.log(
      `\n🧹 记忆库清理完成: ${before} → ${after} 条 (移除 ${before - after} 条)`
    );
    return;
  }

  // --export: 导出为 Markdown
  if (parsed.flags.export) {
    const entries = MemoryStore.getAll();
    const lines = [
      "# SnowFlow 记忆库导出",
      "",
      `> 导出时间: ${new Date().toISOString()}`,
      `> 总条目: ${entries.length}`,
      "",
    ];
    const byType = {};
    entries.forEach((e) => {
      if (!byType[e.type]) byType[e.type] = [];
      byType[e.type].push(e);
    });
    for (const [type, items] of Object.entries(byType)) {
      lines.push(`## ${type} (${items.length} 条)`, "");
      items.forEach((e) => {
        lines.push(`- **[${e.source}]** ${e.content}`);
        lines.push(`  _标签: ${e.tags.join(", ") || "无"} | ${e.createdAt}_`);
      });
      lines.push("");
    }
    const exportFile = path.join(SNOWFLOW_DIR, "memory-export.md");
    FileUtils.writeMD(exportFile, lines.join("\n"));
    console.log(`\n📤 记忆库已导出到: ${exportFile} (${entries.length} 条)`);
    return;
  }

  if (!query) {
    // 无查询词：显示所有记忆
    console.log(`\n🧠 记忆库 (共 ${memStats.total} 条)\n`);

    // 按类型统计
    console.log("  按类型统计:");
    for (const [type, count] of Object.entries(memStats.byType)) {
      const emoji =
        type === "remember"
          ? "💡"
          : type === "decision"
          ? "🔧"
          : type === "architecture"
          ? "🏗️"
          : "📝";
      console.log(`    ${emoji} ${type}: ${count} 条`);
    }

    const entries = MemoryStore.getAll();
    console.log("\n  最近记忆:");
    const recent = entries.slice(-10);
    recent.forEach((e) => {
      const emoji =
        e.type === "remember"
          ? "💡"
          : e.type === "decision"
          ? "🔧"
          : e.type === "architecture"
          ? "🏗️"
          : "📝";
      console.log(`    ${emoji} [${e.source}] ${e.content}`);
    });

    if (entries.length > 10) {
      console.log(
        `\n  ... 还有 ${entries.length - 10} 条，使用 recall "关键词" 搜索`
      );
    }
    return;
  }

  // 有查询词：搜索
  const results = MemoryStore.search(query);

  if (results.length === 0) {
    console.log(`\n🔍 未找到与 "${query}" 相关的记忆`);
    return;
  }

  console.log(`\n🔍 搜索 "${query}" — 找到 ${results.length} 条相关记忆:\n`);
  results.forEach((e, i) => {
    const emoji =
      e.type === "remember"
        ? "💡"
        : e.type === "decision"
        ? "🔧"
        : e.type === "architecture"
        ? "🏗️"
        : "📝";
    console.log(`  ${i + 1}. ${emoji} [${e.type}] ${e.content}`);
    console.log(
      `     来源: ${e.source} | 标签: ${e.tags.join(", ")} | ${e.createdAt}`
    );
  });
}

// finish 命令 — 智能收尾
function cmd_finish(parsed) {
  if (!FileUtils.exists(SNOWFLOW_DIR)) {
    console.error("❌ 工作流未初始化，请先运行: snowflow init");
    process.exit(1);
  }

  const stats = TaskStore.getStats();
  const data = TaskStore.load();
  const workflowName = data.metadata.name || "未命名";

  console.log("\n🏁 SnowFlow 工作流收尾\n");
  console.log(`  工作流: ${workflowName}`);

  // 1. 检查任务完成情况
  const unfinished = data.tasks.filter(
    (t) =>
      t.status !== STATUS.DONE &&
      t.status !== STATUS.SKIPPED &&
      t.status !== STATUS.FAILED
  );

  if (unfinished.length > 0) {
    console.log(`\n⚠️  还有 ${unfinished.length} 个未完成的任务:`);
    unfinished.forEach((t) => {
      const emoji = STATUS_EMOJI[t.status] || "❓";
      console.log(`  ${emoji} ${t.id} [${t.type}] ${t.title} (${t.status})`);
    });
    console.log(
      "\n提示: 完成所有任务后再运行 finish，或使用 skip 跳过不需要的任务"
    );
    return;
  }

  // 2. 运行验证
  console.log("\n--- 项目验证 ---");
  const verifyResult = Verifier.verify();
  if (!verifyResult.detected) {
    console.log("  ⚠️  未检测到已知项目类型，跳过验证");
  }

  // 3. 自动反思
  console.log("\n--- 工作流反思 ---");
  const reflectReport = Reflector.reflect();
  const reflectFile = Reflector.saveReport(reflectReport);

  console.log(
    `\n  📊 成功率: ${
      reflectReport.findings.find((f) => f.key === "successRate")?.detail ||
      "N/A"
    }`
  );

  if (reflectReport.findings.length > 1) {
    console.log("\n  📋 分析发现:");
    reflectReport.findings
      .filter((f) => f.key !== "successRate")
      .forEach((f) => {
        console.log(`    • ${f.detail}`);
      });
  }

  if (reflectReport.suggestions.length > 0) {
    console.log("\n  💡 改进建议:");
    reflectReport.suggestions.forEach((s) => {
      console.log(`    → ${s}`);
    });
  }

  console.log(`\n  📁 反思报告: ${reflectFile}`);

  // 3.5 自动进化
  console.log("\n--- 自动进化 ---");
  const evolveResult = Experimenter.evolve(reflectReport);
  console.log(`  📸 快照: ${evolveResult.snapshotFile}`);
  console.log(`  🔄 进化到第 ${evolveResult.generation} 代`);
  if (evolveResult.changes.filter((c) => c.reason).length > 0) {
    evolveResult.changes
      .filter((c) => c.reason)
      .forEach((c) => {
        console.log(`  • ${c.param}: ${c.from} → ${c.to} (${c.reason})`);
      });
  }

  // 4. 生成总结
  console.log("\n--- 工作流总结 ---\n");

  // 进度条
  const filled = Math.round(stats.progress / 10);
  const empty = 10 - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  console.log(
    `  进度: ${bar} ${stats.progress}% (${stats.done}/${stats.total})`
  );
  console.log(
    `  ✅ 完成: ${stats.done}  |  ❌ 失败: ${stats.failed}  |  ⏭️ 跳过: ${stats.skipped}`
  );

  // 已完成任务列表
  const doneTasks = data.tasks.filter((t) => t.status === STATUS.DONE);
  if (doneTasks.length > 0) {
    console.log("\n  已完成任务:");
    doneTasks.forEach((t) => {
      const summary = t.summary ? ` — ${t.summary}` : "";
      console.log(`    ✅ ${t.id} ${t.title}${summary}`);
    });
  }

  // 失败任务
  const failedTasks = data.tasks.filter((t) => t.status === STATUS.FAILED);
  if (failedTasks.length > 0) {
    console.log("\n  失败任务:");
    failedTasks.forEach((t) => {
      console.log(`    ❌ ${t.id} ${t.title} (重试 ${t.retries} 次)`);
    });
  }

  // 跳过的任务
  const skippedTasks = data.tasks.filter((t) => t.status === STATUS.SKIPPED);
  if (skippedTasks.length > 0) {
    console.log("\n  跳过的任务:");
    skippedTasks.forEach((t) => {
      console.log(`    ⏭️ ${t.id} ${t.title}`);
    });
  }

  // 4. 生成总结文件
  const summaryLines = [
    `# SnowFlow 工作流总结`,
    ``,
    `**工作流**: ${workflowName}`,
    `**完成时间**: ${new Date().toISOString()}`,
    `**进度**: ${stats.done}/${stats.total} (${stats.progress}%)`,
    ``,
    `## 任务完成情况`,
    ``,
    `| ID | 标题 | 状态 | 摘要 |`,
    `|----|------|------|------|`,
  ];

  data.tasks.forEach((t) => {
    const emoji = STATUS_EMOJI[t.status] || "❓";
    const summary = t.summary || "—";
    summaryLines.push(
      `| ${t.id} | ${t.title} | ${emoji} ${t.status} | ${summary} |`
    );
  });

  if (verifyResult.detected) {
    summaryLines.push(``);
    summaryLines.push(`## 验证结果`);
    summaryLines.push(``);
    summaryLines.push(`- 项目类型: ${verifyResult.type}`);
    if (verifyResult.build) {
      summaryLines.push(
        `- Build: ${verifyResult.build.success ? "✅ 通过" : "❌ 失败"}`
      );
    }
    if (verifyResult.test) {
      summaryLines.push(
        `- Test: ${verifyResult.test.success ? "✅ 通过" : "❌ 失败"}`
      );
    }
  }

  // 追加反思结果
  summaryLines.push(`## 反思分析`);
  summaryLines.push(``);
  reflectReport.findings.forEach((f) => {
    summaryLines.push(`- **${f.type}**: ${f.detail}`);
  });
  summaryLines.push(``);
  summaryLines.push(`### 改进建议`);
  summaryLines.push(``);
  reflectReport.suggestions.forEach((s) => {
    summaryLines.push(`- ${s}`);
  });
  summaryLines.push(``);

  const summaryFile = path.join(SNOWFLOW_DIR, "summary-final.md");
  FileUtils.writeMD(summaryFile, summaryLines.join("\n"));
  console.log(`\n📄 总结已保存: ${summaryFile}`);

  // 5. 最终 git commit
  const committed = GitAuto.autoCommit("FINISH", workflowName);
  if (committed) {
    console.log(`📦 最终提交: [SnowFlow] FINISH: ${workflowName}`);
  }

  console.log("\n🎉 工作流已完成！");
}

// evolve 命令 — 应用进化参数
function cmd_evolve(parsed) {
  if (!FileUtils.exists(SNOWFLOW_DIR)) {
    console.error("❌ 工作流未初始化，请先运行: snowflow init");
    process.exit(1);
  }

  console.log("\n🧬 SnowFlow 进化引擎\n");

  // 查找最新的反思报告
  if (!FileUtils.exists(EVOLUTION_DIR)) {
    console.error("❌ 没有找到进化目录，请先运行 finish 生成反思报告");
    process.exit(1);
  }

  const files = fs
    .readdirSync(EVOLUTION_DIR)
    .filter((f) => f.startsWith("reflect-") && f.endsWith(".json"))
    .sort()
    .reverse();

  if (files.length === 0) {
    console.error("❌ 没有找到反思报告，请先运行 finish 生成反思报告");
    process.exit(1);
  }

  const latestFile = path.join(EVOLUTION_DIR, files[0]);
  const reflectReport = FileUtils.readJSON(latestFile);
  if (!reflectReport || !reflectReport.findings) {
    console.error("❌ 反思报告格式无效");
    process.exit(1);
  }

  console.log(`  📄 使用反思报告: ${latestFile}`);

  // 应用进化
  const result = Experimenter.evolve(reflectReport);

  console.log(`\n  📸 快照已保存: ${result.snapshotFile}`);
  console.log(`  🔄 进化到第 ${result.generation} 代\n`);

  if (result.changes.length > 0) {
    console.log("  参数变化:");
    result.changes.forEach((c) => {
      if (c.reason) {
        console.log(`    ${c.param}: ${c.from} → ${c.to} (${c.reason})`);
      } else {
        console.log(`    ${c.param}: ${c.from} → ${c.to}`);
      }
    });
  }

  console.log("\n✅ 进化完成！");
  console.log("下一步: snowflow review  查看进化效果");
}

// review 命令 — 对比进化前后指标
function cmd_review(parsed) {
  if (!FileUtils.exists(SNOWFLOW_DIR)) {
    console.error("❌ 工作流未初始化，请先运行: snowflow init");
    process.exit(1);
  }

  console.log("\n📊 SnowFlow 进化审查\n");

  const result = ReviewChecker.check();

  if (!result.hasSnapshot) {
    console.log("  ⚠️  " + result.message);
    console.log("  提示: 先运行 evolve 生成快照后再审查");
    return;
  }

  console.log(`  对比快照: 第 ${result.snapshotGeneration} 代\n`);

  if (result.diffs.length === 0) {
    console.log("  ✅ 无指标变化");
  } else {
    console.log("  指标对比:");
    result.diffs.forEach((d) => {
      const arrow = d.delta > 0 ? "📈" : d.delta < 0 ? "📉" : "➡️";
      const sign = d.delta > 0 ? "+" : "";
      console.log(
        `    ${arrow} ${d.metric}: ${d.prev} → ${d.current} (${sign}${
          typeof d.delta === "number" ? d.delta.toFixed(2) : d.delta
        })`
      );
    });
  }

  if (result.degraded) {
    console.log("\n  🔴 检测到退化！");
    if (result.autoRolledBack && result.rollback) {
      console.log(`  ↩️  ${result.rollback.message}`);
    }
  } else {
    console.log("\n  ✅ 进化效果正常，未检测到退化");
  }
}

// ═══ CLI 入口 ═══
function parseArgs(argv) {
  const result = { command: null, args: [], flags: {} };

  // 短参数映射
  const SHORT_FLAGS = {
    f: "force",
    b: "batch",
    v: "verbose",
    s: "status",
    m: "message",
    t: "type",
    i: "import",
  };

  // 布尔型短参数（不消费下一个参数作为值）
  const BOOLEAN_SHORT = new Set(["f", "b", "v"]);

  // 布尔型长参数
  const BOOLEAN_LONG = new Set([
    "force",
    "batch",
    "verbose",
    "help",
    "silent",
    "json",
    "stats",
    "clean",
    "export",
  ]);

  if (argv.length === 0) return result;

  let i = 0;

  // 第一个参数如果不是 flag，则当作命令
  if (!argv[0].startsWith("-")) {
    result.command = argv[0];
    i = 1;
  }
  while (i < argv.length) {
    const arg = argv[i];

    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        // --flag=value 格式
        const key = arg.substring(2, eqIdx);
        const val = arg.substring(eqIdx + 1);
        result.flags[key] = val;
      } else {
        const key = arg.substring(2);
        if (BOOLEAN_LONG.has(key)) {
          // 布尔型长参数，不消费下一个参数
          result.flags[key] = true;
        } else if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
          // 检查下一个参数是否是值（不以 - 开头）
          result.flags[key] = argv[i + 1];
          i++;
        } else {
          // 布尔标志
          result.flags[key] = true;
        }
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      // 短参数 -x
      const shortKey = arg.substring(1);
      const longKey = SHORT_FLAGS[shortKey] || shortKey;
      if (BOOLEAN_SHORT.has(shortKey)) {
        // 布尔型短参数，不消费下一个参数
        result.flags[longKey] = true;
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        result.flags[longKey] = argv[i + 1];
        i++;
      } else {
        result.flags[longKey] = true;
      }
    } else {
      result.args.push(arg);
    }
    i++;
  }

  // 如果没有命令但 args 中有非 flag 值，取第一个作为命令
  if (!result.command && result.args.length > 0) {
    result.command = result.args.shift();
  }

  return result;
}

function showHelp() {
  console.log(`
SnowFlow — Snow CLI 全自动工作流调度引擎

用法: snowflow <command> [options]

命令:
  init [--force]                    初始化工作流目录
  plan "<需求描述>" [--import <file>] 拆解需求为任务列表
  next [--batch]                    获取下一个可执行任务
  checkpoint <id> [--status done|failed] [--message "..."]
                                    记录任务完成/失败
  status                            查看全局进度
  skip <id>                         跳过任务（级联）
  resume                            中断恢复
  add "<描述>" [--type <type>] [--after <id>]
                                    追加新任务
  recall "<关键词>" [--stats|--clean|--export]
                                    检索/统计/清理/导出记忆
  finish                            智能收尾
  evolve                            应用进化参数
  review                            审查进化效果
  config [set <key> <value> | reset] 查看/设置/重置配置
  pause                             暂停工作流
  save-context                      输出上下文快照
  auto-checkpoint "<摘要>" [--status done|failed]
                                    自动匹配 active 任务并 checkpoint
  reset-breaker                     重置熔断器（连续失败后解锁 next）
  help                              显示帮助信息

任务类型: frontend, backend, api, database, test, docs,
          devops, refactor, security, architecture, general

通用选项: --verbose, -v      显示详细日志信息
`);
}

const COMMANDS = {
  init: cmd_init,
  plan: cmd_plan,
  next: cmd_next,
  checkpoint: cmd_checkpoint,
  status: cmd_status,
  skip: cmd_skip,
  resume: cmd_resume,
  add: cmd_add,
  recall: cmd_recall,
  finish: cmd_finish,
  evolve: cmd_evolve,
  review: cmd_review,
  config: cmd_config,
  pause: cmd_pause,
  "save-context": cmd_saveContext,
  "auto-checkpoint": cmd_autoCheckpoint,
  "reset-breaker": cmd_resetBreaker,
  help: () => showHelp(),
};

function main() {
  const parsed = parseArgs(process.argv.slice(2));

  // 设置 verbose 模式
  if (parsed.flags.verbose || parsed.flags.v) {
    Logger.setVerbose(true);
  }

  if (!parsed.command || parsed.command === "help" || parsed.flags.help) {
    showHelp();
    process.exit(0);
  }

  const handler = COMMANDS[parsed.command];
  if (!handler) {
    console.error(`❌ 未知命令: ${parsed.command}`);
    console.error('运行 "snowflow help" 查看帮助');
    process.exit(1);
  }

  try {
    handler(parsed);
  } catch (err) {
    console.error(`❌ 执行失败: ${err.message}`);
    process.exit(1);
  }
}

main();
