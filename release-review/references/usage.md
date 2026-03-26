# 项目内安装与使用

## 安装
将本压缩包解压到仓库根目录，最终路径应为：

`.opencode/skills/release-review/`

## 运行
在 Claude Code / OpenCode 中打开当前仓库后，可直接输入：

`请使用 release-review skill，读取 .opencode/skills/release-review/analysis-bundle，对当前仓库进行复核，并在仓库根目录生成中文 final-report.md。`

更强一些的指令是：

`请立即使用 release-review skill。读取 .opencode/skills/release-review/analysis-bundle 中的全部风险项，结合当前仓库逐项验证，并输出中文 final-report.md。除非缺少必要文件，否则不要先问我是否继续。`

## 可选 Word 导出
生成 `final-report.md` 后，可继续要求：

`再导出 final-report.docx。`
