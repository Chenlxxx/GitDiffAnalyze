# 项目内安装与使用

## 安装
将本压缩包解压到仓库根目录，最终路径应为：

`.opencode/skills/release-review/`

## 运行
在 Claude Code / OpenCode 中打开当前仓库后，可直接输入：

`请使用 release-review skill，先运行 scripts/compat_local_review.py 读取 .opencode/skills/release-review/analysis-bundle，对当前仓库产出 final-report.json，再基于 JSON 命中结果和 external-evidence.jsonl 的公开佐证追踪调用链；只对 auto_fix_eligible=true 的 confirmed high 项做最小代码整改，最后完善中文 final-report.md 并说明修改了什么。`

更强一些的指令是：

`请立即使用 release-review skill。先执行机器复核脚本，检测项目类型、扫描 manifest/lockfile、源码使用点和可选构建日志，输出 confirmed / likely / downgraded / rejected / needs-human 的 final-report.json；然后结合当前仓库逐项验证调用链，并把 external-evidence.jsonl 中高可信公开证据作为佐证；只允许修改 auto_fix_eligible=true 的 confirmed high 项，其他项只写报告。完成后说明修改文件、修改原因和验证结果。除非缺少必要文件，否则不要先问我是否继续。`

也可以手工先运行：

`python .opencode/skills/release-review/scripts/compat_local_review.py --bundle .opencode/skills/release-review/analysis-bundle --repo-root . --out final-report.md`

## 可选 Word 导出
生成 `final-report.md` 后，可继续要求：

`再导出 final-report.docx。`
