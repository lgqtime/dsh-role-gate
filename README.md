# RoleGate 身份层

[![test](https://github.com/lgqtime/dsh-role-gate/actions/workflows/test.yml/badge.svg)](https://github.com/lgqtime/dsh-role-gate/actions/workflows/test.yml)

为 DeepSeek Harness 提供按会话切换的“身份层”：每个身份携带一组工具、技能授权与行为指令，支持多父并集继承；切换不产生对话消息，从**下一步**开始改变工具可见性、技能门禁与系统提示。

## 功能

- **多父继承**：`inherits` 是 DAG；工具/技能取并集，指令按祖先优先拼接，每个身份只出现一次。
- **动态切换**：输入框下方的身份胶囊、`/identity` 命令、`role_gate` 工具三个入口。
- **下一步生效**：切换只更新选择；`agent/pre-step` 才替换工具限制，当前步不中断。
- **执行层工具限制**：通过 `agent.ctx.tools.restrict({ allow })` 真正隐藏工具，隐藏工具的调用返回 `UNKNOWN_TOOL`。
- **技能加载门禁**：技能目录仍显示全部，但未列入当前身份的技能加载会被拒绝；不产生额外对话消息。
- **AI 辅助创建**：`role_gate_author` 提供目录、草稿脚手架、创建/修改/删除；写盘必须 `confirmed=true`。
- **对话式补充**：`update` 支持 `addTools / removeTools / addSkills / removeSkills`，补一个工具或技能不必重发完整数组。
- **新会话选择器**：新对话的 New Session 行也显示身份选择器；选中的身份写入 `pending`，在该会话创建时自动应用并清除。
- **UI 新建/编辑对话框**：身份面板里的“新建身份”和每行的铅笔按钮打开表单，可编辑标题、描述、继承、工具/技能勾选、指令、联网兜底和草稿状态；“让 AI 补全”会把当前设计写进输入框交给模型。
- **显式草稿标记**：`draft: true` 显示“待完善”，只是提示；身份仍可切换、仍可应用，取消草稿只是去掉标记。
- **本地能力检索**：`role_gate_find_local` 搜索工具与技能，标注 visible/hidden、authorized/blocked。
- **子代理/fork 继承**：子会话继承父会话身份，避免用子代理绕过限制。
- **按会话持久化**：当前身份写入 `$DSH_HOME/role-gate/state.json`，重启/恢复后保留。

## 安装

从插件市场安装，或直接：

```sh
dsh plugin --profile web add dsh-role-gate
```

本地开发时以 bundle 形式安装进当前 profile：

```text
plugin_manager action=install_bundle target=<本地仓库路径>
```

安装后刷新 Web 页面；客户端 bundle 不会在没有 dev 构建 watcher 的情况下自动热更新。

如果安装后组合树里出现重复的 `role-gate` 行（bundle patch 的 `insert` 与已有的 `cordis.yml` 行同时存在），把 `cordis.patch.yml` 的 `insert` 改成空数组 `[]`，只保留 profile 中的唯一行。

## 使用

### 创建身份

在对话里说：

> 用 RoleGate 创建一个代码审查身份，只读代码、能跑测试，不要联网。

模型会先调用 `role_gate_author action=catalog`，再 `action=propose` 给出草稿，展示给你确认，最后 `action=create confirmed=true` 落盘。

也可以点输入框下方 `身份 ▾` → `新建身份`，在表单里直接勾选工具/技能、填写指令并保存。每行身份右侧的铅笔按钮可以编辑已有身份；勾选“草稿”只会加一个“待完善”标记，**不影响切换和使用**，取消草稿只是去掉标记。

需要 AI 帮你补全时，在编辑对话框点 `让 AI 补全`，当前设计会写入输入框，由模型查目录、指出缺口并给出补充建议。

身份定义示例：

```json
{
  "version": 1,
  "identities": {
    "code-review": {
      "name": "code-review",
      "title": "代码审查",
      "description": "只读审查与最小修复",
      "inherits": ["reader"],
      "tools": ["read", "grep", "glob", "edit"],
      "skills": ["tdd"],
      "instructions": "以审查者口吻工作，先读再改，改完跑测试。",
      "allowWebFallback": false,
      "draft": false
    }
  }
}
```

### 切换

- UI：输入框下方的 `身份：… ▾` 胶囊，展开后选择。
- 命令：`/identity code-review`、`/identity list`、`/identity none`。
- 模型工具：`role_gate action=switch name=code-review`，或 `action=clear`。

切换后当前步不变，**下一步**生效。UI 会显示 `下一步生效` 标记。

### 新会话

点“新建会话”后，New Session 行右侧会出现 `身份 · 新会话 ▾`。选中身份会写入 `state.json` 的 `pending`；发送第一条消息创建会话时自动应用并清除。选择“未启用”会清除 pending。pending 只被下一个新会话消费一次；子代理和 fork 仍优先继承父会话身份。

### 能力语义

- `tools: ["*"]`：该 agent 当前已知的全部工具（全局 + preset scoped）；`tools: []`：除 3 个 RoleGate 元工具外无工具。
- `skills: ["*"]`：所有技能可加载；`skills: []`：任何技能加载都被拒绝。
- `skills` 非空时自动保留 `skill` 工具，否则技能无法加载。
- `allowWebFallback` 为 true 时自动加入配置的联网工具（默认 `web_search`、`web_fetch`）。
- `draft: true` 只是“待完善”标记，身份仍可应用和切换；它不改变工具/技能授权，也不影响默认身份继承。
- 常驻元工具 `role_gate`、`role_gate_find_local`、`role_gate_author` 永远可见，保证任何身份都能切回 `none`。
- preset scoped 工具也在 `allow` 名单里显式列出，因此会被同时从模型工具面过滤并在执行层拒绝。

### 指令优先级

身份系统提示会写明：

1. 优先使用当前身份的工具/技能；
2. 不足时调用 `role_gate_find_local` 搜索本地目录；
3. 只有本地没有合适能力且联网工具可见时，才联网；
4. 身份指令不覆盖用户当前轮的直接请求。

## 数据与配置

数据目录：`$DSH_HOME/role-gate/`（未设置 `DSH_HOME` 时为 `~/.dsh`）。

- `identities.json`：身份库。
- `state.json`：每个会话当前选中的身份，以及新会话的 `pending` 选择。
- `identities.corrupt-<时间>.json` / `state.corrupt-<时间>.json`：损坏文件的隔离副本。

`cordis.patch.yml`（首次安装）或 profile 的 `cordis.yml` 中 `role-gate` 行可配置：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `defaultIdentity` | `null` | 新会话默认身份 |
| `webTools` | `["web_search","web_fetch"]` | 联网兜底工具名 |
| `allowWebFallbackByDefault` | `true` | 身份未显式设置时的默认 |
| `enforceSkills` | `true` | 是否启用技能门禁 |
| `sectionOrder` | `450` | 身份系统提示段顺序 |
| `maxInstructionsChars` | `16000` | 单身份指令上限 |
| `maxResolvedInstructionsChars` | `32000` | 继承拼接后上限 |
| `maxStateEntries` | `500` | 会话状态记录上限 |

## 已知边界

- `ctx.tools.restrict` 只过滤继承层（全局/祖先 scope）；agent 自身层注册的工具无法被 restriction 掩蔽。RoleGate 会用 `system-prompt/assemble` 过滤 + `tools.guard` 执行拒绝按身份处理它们，但 Plugin/Tool 检查器的 registry 视图仍可能看到这些工具。
- 切换身份会更新 `desired`，但工具限制在 `agent/pre-step` 才替换；当前步已经发出的工具调用不会被中途撤回。
- 模型主动切换会留下一个 tool call 卡片；切换动作本身不产生 user/assistant 消息。UI/命令路径不产生模型消息，但 `/identity` 会留下一个 command 节点。
- UI 对话框的保存按钮视为用户确认；模型通过 `role_gate_author` 写入仍必须显式传 `confirmed=true`。
- 把正在使用的身份改成 `draft: true` 只改变提示标记，不会清空当前会话，也不会改变已应用的权限。
- 隐藏 `skill` 工具（例如 `skills: []` 且 `tools` 不含 `skill`）时，DSH 的 skill 目录会追加一条系统级替换消息；它不是 user/assistant 消息，但对话界面会出现目录更新。`skills` 非空的身份会自动保留 `skill`，通常不会触发。
- 用户显式 `/skillname` 注入不走 `skill` 工具，不受技能门禁影响（用户覆盖优先）。
- 使用 `persona.complete: true` 的 preset 会丢弃其他 system-prompt section，包括 RoleGate 的身份段。
- 身份库是 `$DSH_HOME` 级全局数据，不按 profile 隔离。
- 身份定义不支持 UI 内编辑；创建/修改走对话中的 `role_gate_author`。

## 开发

```text
node --check index.js
node --check client.js
node --test test/*.test.mjs
```

插件只使用 Node 内置模块，不依赖任何 DSH 包；工具 schema 使用原始 JSON Schema，客户端组件通过 `window.__ModuleLoader__` 注册。
