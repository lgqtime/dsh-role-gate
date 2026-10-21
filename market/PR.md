# awesome-dsh-plugin 上架材料

## PR 文件

将 `market/lgqtime__dsh-role-gate.yml` 复制到 awesome-dsh-plugin 仓库的：

```text
data/plugins/lgqtime__dsh-role-gate.yml
```

不要手工编辑 README，目录会由 `data/plugins/*.yml` 生成。

## PR 标题

```text
Add dsh-role-gate
```

## PR 正文

```markdown
## What

Adds RoleGate, a per-session identity layer for DSH: tool/skill allowlists,
multi-parent identity inheritance, one-click switching, and a new-session picker.
Identities are persisted per session; subagents and forks inherit the parent
identity; a `draft` flag is an advisory badge only.

## Links

- Repo: https://github.com/lgqtime/dsh-role-gate
- Release: https://github.com/lgqtime/dsh-role-gate/releases/tag/v0.1.0
- npm: not published (GitHub-only install; npm 2FA unavailable)

## Checks

- `dsh.bundle` + `cordis.patch.yml` present in `package.json`
- `node --test test/*.test.mjs` — 31/31 passing
- Tested on DSH 0.2.1-rc.2
- Public repo with the `dsh-plugin` topic
- GitHub Actions `test` passes
- Pure JS, no build step; GitHub source install supported
```

## 提交前检查

- 仓库创建已满 1 天（CI 自动检查）。
- GitHub 仓库已添加 `dsh-plugin` topic。
- 仓库是 public，且 `package.json` 中 `dsh.bundle` 与 `cordis.patch.yml` 存在。
- npm 可选：未发布也能上架，市场会回退到 GitHub Release tarball 或源码安装。
- 描述与实际代码一致，不使用营销词。
