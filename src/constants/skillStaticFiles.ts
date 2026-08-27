/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export const SKILL_MD = `---
name: release-review
description: 读取随本 skill 附带的 analysis-bundle（上游三方件升级风险清单），结合当前代码仓库逐项验证，并追踪受影响 API 在本仓库中的多层调用链路，输出基于真实代码证据的中文升级复核报告。适用于已将本 skill 安装到使用方代码仓库、希望对依赖升级风险做落地复核的场景。
---

当用户要求运行或使用 release-review skill 时，直接执行以下工作流，不要先请求确认（除非必需文件缺失）。

## 输入位置
分析输入位于**本 skill 目录下**的 \`analysis-bundle/\` 子目录（与本 SKILL.md 同级）。
不要假设任何固定绝对路径——本 skill 可能被安装在 \`.claude/skills/release-review/\`、\`.opencode/skills/release-review/\` 或其他框架的 skills 目录下。请基于本 SKILL.md 所在目录定位以下文件（路径相对本 SKILL.md）：

1. \`analysis-bundle/manifest.json\` — 升级范围、风险计数、project_background、analysis_mode
2. \`analysis-bundle/file-risk.json\` — 风险项清单（含 affectedApis、排查建议、整改建议）
3. \`analysis-bundle/diff-evidence.jsonl\` — 每条风险的上游证据（source_snippet、related_commits、suspect_apis）
4. \`analysis-bundle/external-evidence.jsonl\` — 联网采集的公开踩坑/Issue/安全库证据，以及 \`reference_only=true\` 的普通网页参考链接；网页参考只供人工点开判断
5. \`analysis-bundle/unresolved-questions.json\` — 待人工确认问题
6. \`analysis-bundle/platform-summary.md\` — 平台侧分析摘要

若不确定安装路径，可用 glob 搜索 \`**/release-review/analysis-bundle/manifest.json\` 定位。
\`manifest.json\` 的 \`schema_version\` / \`bundle_schema_version\` 为 2 时，优先使用 v2 字段：\`ecosystem\`、\`package_coordinates\`、\`affected_symbols\`、\`risk_type\`、\`trigger_condition\`、\`failure_signatures\`、\`source_file\`、\`source_url\`、\`local_search_terms\`、\`external_evidence_count\`、\`external_evidence_sources\`。
\`manifest.json\` 的 \`analysis_mode\` 标识风险来源：\`changelog\`=上游变更日志，\`full_diff\` 系列=上游两版本间源码 Diff。\`project_background\` 是使用方项目背景。

## 核心目标
bundle 里每条风险项都是「上游视角的待验证假设 + 已有证据」，**不是**本仓库的最终结论。
你的任务是把每条假设拿到当前代码仓库验证：它在本仓库**是否真实命中**、命中后**会沿哪条调用链路影响到哪些业务入口**。不要停留在复述 bundle。

## 工作流

### 1. 先运行机器复核，再读取结果
优先运行本 skill 附带脚本（路径相对本 SKILL.md）：

\`python scripts/compat_local_review.py --bundle analysis-bundle --repo-root . --out final-report.md\`

如果用户提供了已有构建/类型检查日志，把它们作为诊断证据传入：

\`python scripts/compat_local_review.py --bundle analysis-bundle --repo-root . --diagnostics build.log --out final-report.md\`

只有在用户明确授权运行本地构建/测试命令时，才追加 \`--check-command "npm run build"\`、\`--check-command "mvn test"\` 等参数。
脚本会先检测项目类型，再扫描 manifest/lockfile、源码使用点、Vue SFC 模式和可选诊断日志，输出 \`final-report.json\`，每条风险状态为 \`confirmed | likely | downgraded | rejected | needs-human\`。

### 2. 读取并理解 bundle 与机器 JSON
读完上述 bundle 文件和 \`final-report.json\`，建立风险项清单；对每条记下其受影响 API 符号（affectedApis / suspect_apis / affected_symbols / local_search_terms）与上游证据（source_snippet）。如存在 \`external-evidence.jsonl\`，只把它作为公开经验佐证和搜索词来源，不能替代本仓库代码证据。

### 3. 逐项做多层调用链路追踪（本 skill 的核心价值）
对每条高/中风险项，**不要只搜一层直接调用**，要追踪完整链路：

a. **定位直接使用点**：搜索对受影响 API（类/接口/方法/字段/配置项名）的直接引用——import、new、方法调用、继承、实现、注解、配置文件中的类名。
b. **向上追踪调用链**：找到直接使用点后，继续追踪**谁调用了它们**——包装类(wrapper)、适配器(adapter)、门面(facade)、工具类、基类，一层层向上，直到业务入口（Controller / Service 公开方法 / 定时任务 / 消息消费者 / 对外接口）。画出「上游变更 API → 本仓库封装层 → 业务入口」的完整链路。
c. **覆盖间接/隐式使用**：注意纯文本搜索易漏的命中方式——反射、SPI/ServiceLoader、依赖注入(Spring Bean / @Autowired)、AOP 切面、动态代理、配置驱动实例化、字节码增强、序列化框架。
d. **识别运行时故障面**：判断变更在编译期暴露还是仅运行时暴露（默认行为变化、序列化/协议格式变化等），以及触发的具体场景。
e. **结论**：以 \`final-report.json\` 的机器状态为起点，基于证据把该风险项**确认 / likely / 降级 / 推翻 / 待人工确认**，给出受影响的具体文件、完整调用链、故障模式。

### 4. 输出报告
脚本会先生成机器版 \`final-report.md\`。你需要基于 \`final-report.json\` 和真实代码继续完善同一个 \`final-report.md\`：补充调用链、业务入口、误报/漏报判断和整改建议。ClaudeCode 负责解释调用链和整改，不要从零搜索。

## 执行规则
- 优先读 manifest 的 \`project_background\`，但代码证据与背景描述冲突时以代码为准。
- \`full_diff\` 系列时，\`diff-evidence.jsonl\` 的 \`source_snippet\` 与 \`related_commits\` 是源码级证据，可直接据此定位本仓库调用点。
- v2 bundle 中 \`local_search_terms\` 与 \`affected_symbols.search_variants\` 是本地检索首选锚点，优先于宽泛标题词。
- \`external-evidence.jsonl\` 中 \`trust_level=official|maintainer|security\` 且 \`confidence >= 0.7\` 的记录可作为强佐证；社区记录只用于提示可能的故障模式或补充搜索词。
- \`external-evidence.jsonl\` 中 \`reference_only=true\` 的网页搜索结果只作为人工参考链接，不得参与最终风险确认或打分。
- 仓库未使用某个被引用 API → 明确说明并降级/排除，不要硬凑。
- 无法仅凭当前仓库证明的内容 → 放入「待人工确认问题」，不要臆测。
- 对 bundle 中**所有**风险项统一处理，不要只分析第一条。

## 中文报告结构
在仓库根目录生成 \`final-report.md\`：

# 三方件升级复核报告

## 一、执行摘要
升级范围 / 风险项总数 / 已确认高风险项 / 已降级或不适用项 / 待人工确认项 / 最终总体判断

## 二、已确认成立的风险项
对每一项：风险标题 / 风险等级 / 在本仓库成立的原因 / 受影响文件与**完整调用链（上游 API → 封装层 → 业务入口）** / 故障模式（编译期还是运行时、触发场景）/ 整改建议

## 三、已降级或不适用的风险项
对每一项：风险标题 / 上游假设 / 为什么在本仓库不成立或风险降低

## 四、待人工确认问题
列出无法仅凭当前仓库证明的内容。

## 五、受影响模块与调用链汇总
按业务入口与调用链归纳，标出每条链路经过的关键封装层。

## 六、建议整改与测试计划
按优先级排列，优先覆盖高风险项。

## 七、证据附录
列出使用的 bundle 文件，以及检查过的关键仓库文件路径。

## 可选 Word 导出
生成 \`final-report.md\` 后，如用户要求 Word 输出，运行本 skill 目录下脚本（路径相对本 SKILL.md）：
\`python scripts/export_docx.py final-report.md final-report.docx\`

参考本 skill 目录下的 \`references/example-report.md\` 获取风格示例。
`;

export const OPENAI_YAML = `interface:
  display_name: Release Review
  short_description: 基于内置风险包对当前仓库做中文升级复核
`;

export const EXAMPLE_REPORT_MD = `# 三方件升级复核报告

## 一、执行摘要
本报告对内置 analysis-bundle 中的三条 HttpClient 5.5 风险项进行了仓库级复核。复核目标不是重复上游 changelog 结论，而是确认这些结论在当前仓库中是否真实命中，以及命中后会影响哪些调用链与业务流程。

## 二、已确认成立的风险项
### 1. 自动重定向策略收紧
- 风险等级：高
- 成立原因：在当前仓库中发现默认自动重定向的 HttpClient 构造方式，并在请求发送前手动设置了 Authorization 头。
- 受影响位置：\`src/auth/OAuthClient.java\`、\`src/gateway/TokenRelay.java\`
- 故障模式：遇到 302 时可能不再自动跳转，而是抛出 Redirect rejected 或 ClientProtocolException。
- 整改建议：关闭自动重定向，改为显式处理 3xx，并避免跨跳转传递敏感头。

## 三、已降级或不适用的风险项
### 1. 某风险项名称
- 上游假设：……
- 复核结论：当前仓库未发现对应 API 使用点，因此暂不构成直接风险。

## 四、待人工确认问题
- 是否存在运行时动态注入的认证拦截器，未在代码仓中体现。
- 是否有外部网关层对缓存头或重定向做二次改写。

## 五、受影响模块与调用链汇总
- OAuth 登录链路
- SSO 单点登录重定向链路
- 多租户缓存调用链

## 六、建议整改与测试计划
1. 优先修复高风险认证与缓存隔离问题。
2. 增加针对 Digest、缓存共享与 302 重定向的回归测试。
3. 对关键集成链路补充端到端验证。

## 七、证据附录
- 使用的 bundle：\`manifest.json\`、\`file-risk.json\`、\`diff-evidence.jsonl\`、\`external-evidence.jsonl\`、\`platform-summary.md\`
- 检查过的仓库文件：按实际扫描结果填写
`;

export const USAGE_MD = `# 安装与使用

## 安装
把本压缩包解压到你的 coding agent 的 skills 目录下，最终形成 \`<skills>/release-review/\` 目录：
- Claude Code: \`.claude/skills/release-review/\`
- OpenCode: \`.opencode/skills/release-review/\`
- 其他框架：放到该框架识别 skill 的目录即可。

解压后 \`analysis-bundle/\` 应与 \`SKILL.md\` 同级。本 skill 不依赖任何固定绝对路径。

## 运行
在使用方代码仓库中打开 agent 后输入：

\`请使用 release-review skill，先运行 scripts/compat_local_review.py 读取随它附带的 analysis-bundle，对当前仓库产出 final-report.json，再基于 JSON 命中结果和 external-evidence.jsonl 的公开佐证追踪调用链并完善中文 final-report.md。除非缺少必要文件，否则不要先问我是否继续。\`

也可以手工先运行：

\`python .opencode/skills/release-review/scripts/compat_local_review.py --bundle .opencode/skills/release-review/analysis-bundle --repo-root . --out final-report.md\`

## 可选 Word 导出
生成 \`final-report.md\` 后，可继续要求：

\`再导出 final-report.docx。\`
`;

export const COMPAT_LOCAL_REVIEW_PY = `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Local release-review scanner.

Reads analysis-bundle v1/v2, detects project ecosystems, scans dependency
manifests/lockfiles, source usage points, Vue SFC patterns, and optional build
diagnostics. It writes a machine-readable final-report.json plus a compact
Markdown draft for ClaudeCode to enrich with call chains and remediation.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple


SKIP_DIRS = {".git", "node_modules", "target", "dist", "build", ".idea", ".vscode", ".opencode", ".claude", "__pycache__"}
SOURCE_EXTS = {".java", ".kt", ".groovy", ".js", ".jsx", ".ts", ".tsx", ".vue", ".py", ".go", ".rs", ".cs", ".xml", ".yaml", ".yml", ".json", ".properties", ".toml"}
MANIFEST_NAMES = {
    "pom.xml": "maven",
    "build.gradle": "gradle",
    "build.gradle.kts": "gradle",
    "package.json": "javascript",
    "package-lock.json": "npm-lock",
    "pnpm-lock.yaml": "pnpm-lock",
    "yarn.lock": "yarn-lock",
    "bun.lock": "bun-lock",
    "tsconfig.json": "typescript",
    "vite.config.ts": "vite",
    "vite.config.js": "vite",
    "vue.config.js": "vue",
    "nuxt.config.ts": "nuxt",
    "pyproject.toml": "python",
    "requirements.txt": "python",
    "poetry.lock": "python-lock",
    "uv.lock": "python-lock",
    "go.mod": "go",
    "Cargo.toml": "rust",
    "Cargo.lock": "rust-lock",
    "composer.json": "php",
    "composer.lock": "php-lock",
}
NOISE = {
    "string", "builder", "default", "this", "returns", "return", "collection", "object", "boolean",
    "integer", "long", "double", "float", "class", "interface", "public", "private", "static",
    "http", "https", "apache", "software", "version", "added", "fixed", "changed", "removed",
    "contributed", "the", "and", "for", "with", "from", "that", "null", "true", "false"
}
VUE_PATTERNS = {
    "new Vue(...)": r"\\bnew\\s+Vue\\s*\\(",
    "Vue.extend": r"\\bVue\\.extend\\s*\\(",
    "Vue.use": r"\\bVue\\.use\\s*\\(",
    "Vue.prototype": r"\\bVue\\.prototype\\b",
    "filters": r"\\|\\s*[A-Za-z_$][\\w$]*",
    ".sync": r"\\.sync\\b",
    "$listeners": r"\\$listeners\\b",
    "$scopedSlots": r"\\$scopedSlots\\b",
    "$set/$delete": r"\\$(set|delete)\\s*\\(",
    "createApp": r"\\bcreateApp\\s*\\(",
    "defineProps/defineEmits": r"\\bdefine(Props|Emits|Model|Options)\\s*\\(",
}


def load_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def load_bundle(bundle: Path) -> Tuple[Dict[str, Any], List[Dict[str, Any]], Dict[str, Dict[str, Any]], Dict[str, List[Dict[str, Any]]]]:
    manifest = load_json(bundle / "manifest.json", {})
    risks = load_json(bundle / "file-risk.json", [])
    evidence: Dict[str, Dict[str, Any]] = {}
    ev_path = bundle / "diff-evidence.jsonl"
    if ev_path.exists():
        for line in ev_path.read_text(encoding="utf-8", errors="ignore").splitlines():
            if not line.strip():
                continue
            try:
                item = json.loads(line)
                evidence[str(item.get("id", ""))] = item
            except Exception:
                continue
    external: Dict[str, List[Dict[str, Any]]] = {}
    ext_path = bundle / "external-evidence.jsonl"
    if ext_path.exists():
        for line in ext_path.read_text(encoding="utf-8", errors="ignore").splitlines():
            if not line.strip():
                continue
            try:
                item = json.loads(line)
                risk_id = str(item.get("risk_id", ""))
                if risk_id:
                    external.setdefault(risk_id, []).append(item)
            except Exception:
                continue
    return manifest, risks if isinstance(risks, list) else [], evidence, external


def walk_files(root: Path) -> Iterable[Path]:
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".cache")]
        for name in filenames:
            p = Path(dirpath) / name
            if p.name in MANIFEST_NAMES or p.suffix in SOURCE_EXTS:
                yield p


def rel(root: Path, path: Path) -> str:
    try:
        return str(path.relative_to(root)).replace("\\\\", "/")
    except ValueError:
        return str(path).replace("\\\\", "/")


def detect_project(root: Path) -> Dict[str, Any]:
    manifests = []
    ecosystems = set()
    scripts: Dict[str, List[str]] = {}
    for p in walk_files(root):
        kind = MANIFEST_NAMES.get(p.name)
        if not kind:
            continue
        manifests.append({"path": rel(root, p), "kind": kind})
        ecosystems.add(kind.split("-")[0])
        if p.name == "package.json":
            data = load_json(p, {})
            if isinstance(data, dict):
                scripts[rel(root, p)] = sorted((data.get("scripts") or {}).keys())
    if any(p.suffix == ".vue" for p in walk_files(root)):
        ecosystems.add("vue")
    return {"ecosystems": sorted(ecosystems), "manifests": manifests[:300], "scripts": scripts}


def clean_terms(values: Iterable[Any], limit: int = 80) -> List[str]:
    out: List[str] = []
    for value in values:
        if value is None:
            continue
        term = str(value).strip().strip(chr(96) + "'" + '"' + " [](){}.,;:")
        if len(term) < 3 or len(term) > 160:
            continue
        low = term.lower()
        compact = re.sub(r"[^a-z0-9_$#.@/-]+", "", low)
        if not compact or compact in NOISE or low in NOISE or compact.isdigit():
            continue
        if not any(existing.lower() == low for existing in out):
            out.append(term)
        if len(out) >= limit:
            break
    return out


def terms_from_text(text: Any) -> List[str]:
    text = "" if text is None else (text if isinstance(text, str) else json.dumps(text, ensure_ascii=False))
    raw: List[str] = []
    patterns = [
        chr(96) + r"([^" + chr(96) + r"\\n]{3,120})" + chr(96),
        r"\\b[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)+(?:#[A-Za-z_$][\\w$]*)?(?:\\([^\\)\\n]{0,120}\\))?",
        r"\\b[A-Z][A-Za-z0-9_$]+(?:#[A-Za-z_$][\\w$]*)?(?:\\([^\\)\\n]{0,120}\\))?",
        r"\\b[A-Za-z0-9_.-]+(?:Config|Options|Builder|Client|Router|Store|Plugin|Factory|Manager|Strategy|Handler|Interceptor|Consumer|Provider|Request|Response|Exception|Timeout|Socket|Connection|Cache|Auth|Scheme)\\b",
        r"\\b(?:[a-z][a-z0-9]*[._-]){1,}[a-z][a-z0-9_-]*\\b",
    ]
    for pattern in patterns:
        for m in re.finditer(pattern, text):
            raw.append(m.group(1) if m.groups() else m.group(0))
    return clean_terms(raw)


def component_terms(manifest: Dict[str, Any]) -> List[str]:
    raw = [manifest.get("component"), manifest.get("repo")]
    coords = manifest.get("package_coordinates")
    if isinstance(coords, dict):
        raw.extend(coords.values())
    tokens: List[str] = []
    for value in raw:
        text = "" if value is None else str(value)
        tokens.extend(re.findall(r"[A-Za-z0-9_.@/-]+", text))
    expanded = []
    for token in tokens:
        token = token.strip("/").replace(".git", "")
        if "/" in token:
            expanded.append(token.rsplit("/", 1)[-1])
        expanded.append(token)
    return clean_terms(expanded, 30)


def terms_for_risk(risk: Dict[str, Any], evidence: Dict[str, Dict[str, Any]], external: Dict[str, List[Dict[str, Any]]]) -> List[str]:
    raw: List[Any] = []
    for key in ("affectedApis", "code_investigation_guide", "local_search_terms", "failure_signatures"):
        val = risk.get(key)
        raw.extend(val if isinstance(val, list) else [val])
    for sym in risk.get("affected_symbols") or []:
        if isinstance(sym, dict):
            raw.append(sym.get("name"))
            variants = sym.get("search_variants")
            raw.extend(variants if isinstance(variants, list) else [])
    ev = evidence.get(str(risk.get("id", "")), {})
    for key in ("suspect_apis", "sample_failure_signatures", "local_search_terms"):
        val = ev.get(key)
        raw.extend(val if isinstance(val, list) else [val])
    raw.extend(terms_from_text(ev.get("source_snippet") or ev.get("hypothesis") or ""))
    raw.extend(terms_from_text(risk.get("source_file")))
    for ext in external.get(str(risk.get("id", "")), []):
        if ext.get("reference_only"):
            continue
        for key in ("matched_terms", "extracted_terms", "failure_signatures"):
            val = ext.get(key)
            raw.extend(val if isinstance(val, list) else [val])
        for sym in ext.get("affected_symbols") or []:
            if isinstance(sym, dict):
                raw.append(sym.get("name"))
    return clean_terms(raw, 80)


def trusted_external_evidence(external: Dict[str, List[Dict[str, Any]]], risk_id: str) -> List[Dict[str, Any]]:
    items = []
    for item in external.get(str(risk_id), []):
        trust = str(item.get("trust_level", ""))
        confidence = float(item.get("confidence") or 0)
        if trust in {"official", "maintainer", "security"} or confidence >= 0.7:
            items.append({
                "source_type": item.get("source_type"),
                "trust_level": trust,
                "confidence": confidence,
                "title": item.get("title"),
                "source_url": item.get("source_url"),
                "matched_terms": item.get("matched_terms") or [],
                "signal": item.get("signal")
            })
    return sorted(items, key=lambda x: x.get("confidence", 0), reverse=True)[:8]


def scan_usage(root: Path, terms: List[str]) -> List[Dict[str, Any]]:
    matches = []
    lowered = [(t, t.lower()) for t in terms if len(t) >= 3]
    if not lowered:
        return matches
    for p in walk_files(root):
        if p.name in MANIFEST_NAMES or p.suffix not in SOURCE_EXTS:
            continue
        text = p.read_text(encoding="utf-8", errors="ignore")
        lower = text.lower()
        lines = text.splitlines()
        for term, low in lowered:
            idx = lower.find(low)
            if idx < 0:
                continue
            line = text.count("\\n", 0, idx) + 1
            matches.append({"term": term, "file": rel(root, p), "line": line, "snippet": (lines[line - 1] if line - 1 < len(lines) else "")[:260].strip()})
            if len(matches) >= 120:
                return matches
    return matches


def scan_manifests(root: Path, terms: List[str]) -> List[Dict[str, Any]]:
    matches = []
    lowered = [(t, re.sub(r"[^a-z0-9]+", "", t.lower())) for t in terms]
    for p in walk_files(root):
        kind = MANIFEST_NAMES.get(p.name)
        if not kind:
            continue
        text = p.read_text(encoding="utf-8", errors="ignore")
        compact = re.sub(r"[^a-z0-9]+", "", text.lower())
        lines = text.splitlines()
        for term, normalized in lowered:
            if len(normalized) < 3 or normalized not in compact:
                continue
            line_no = 1
            snippet = ""
            for idx, line in enumerate(lines, start=1):
                if term.lower() in line.lower() or normalized in re.sub(r"[^a-z0-9]+", "", line.lower()):
                    line_no = idx
                    snippet = line[:260].strip()
                    break
            matches.append({"term": term, "file": rel(root, p), "line": line_no, "kind": kind, "snippet": snippet})
            if len(matches) >= 120:
                return matches
    return matches


def scan_vue_patterns(root: Path) -> List[Dict[str, Any]]:
    hits = []
    for p in walk_files(root):
        if p.suffix != ".vue":
            continue
        text = p.read_text(encoding="utf-8", errors="ignore")
        for label, pattern in VUE_PATTERNS.items():
            m = re.search(pattern, text)
            if m:
                hits.append({"pattern": label, "file": rel(root, p), "line": text.count("\\n", 0, m.start()) + 1})
    return hits


def read_diagnostics(paths: List[str], root: Path, commands: List[str], timeout: int) -> List[Dict[str, Any]]:
    diagnostics = []
    for raw in paths:
        path = Path(raw)
        try:
            diagnostics.append({"source": str(path), "text": path.read_text(encoding="utf-8", errors="ignore")})
        except Exception as exc:
            diagnostics.append({"source": str(path), "error": str(exc), "text": ""})
    for command in commands:
        try:
            completed = subprocess.run(command, cwd=str(root), shell=True, capture_output=True, text=True, timeout=timeout, errors="replace")
            diagnostics.append({"source": "command: " + command, "returncode": completed.returncode, "text": (completed.stdout or "") + "\\n" + (completed.stderr or "")})
        except Exception as exc:
            diagnostics.append({"source": "command: " + command, "error": str(exc), "text": ""})
    return diagnostics


def scan_diagnostics(diagnostics: List[Dict[str, Any]], terms: List[str]) -> List[Dict[str, Any]]:
    hits = []
    generic = re.compile(r"\\b(error|failed|failure|exception|cannot find symbol|cannot find module|module not found|type error|ts\\d{4}|vue-tsc|vite|webpack|maven|gradle)\\b", re.I)
    lowered = [(t, t.lower()) for t in terms if len(t) >= 4]
    for diag in diagnostics:
        for line_no, line in enumerate(str(diag.get("text", "")).splitlines(), start=1):
            low = line.lower()
            term = next((t for t, tlow in lowered if tlow in low), "")
            if not term and not generic.search(line):
                continue
            hits.append({"term": term or "build-diagnostic", "source": diag.get("source", ""), "line": line_no, "snippet": line[:320].strip()})
            if len(hits) >= 120:
                return hits
    return hits


def classify_status(terms: List[str], usage: List[Dict[str, Any]], dep_hits: List[Dict[str, Any]], diag_hits: List[Dict[str, Any]], component_hits: List[Dict[str, Any]], project: Dict[str, Any], vue_hits: List[Dict[str, Any]], risk: Dict[str, Any]) -> str:
    if not terms:
        return "needs-human"
    if usage or diag_hits:
        return "confirmed"
    if dep_hits:
        risk_text = json.dumps(risk, ensure_ascii=False).lower()
        if "vue" in project.get("ecosystems", []) and vue_hits and any(k in risk_text for k in ["vue", "router", "pinia", "vite", "component", "sfc"]):
            return "likely"
        return "likely"
    if not component_hits:
        return "rejected"
    return "downgraded"


def score_for(risk: Dict[str, Any], status: str) -> Tuple[int, str]:
    base = {"high": 72, "medium": 50, "low": 25}.get(str(risk.get("severity", "")).lower(), 25)
    delta = {"confirmed": 24, "likely": 12, "downgraded": -8, "rejected": -18, "needs-human": 0}.get(status, 0)
    score = max(1, min(100, base + delta))
    severity = "high" if score >= 70 else ("medium" if score >= 40 else "low")
    return score, severity


def write_outputs(out: Path, manifest: Dict[str, Any], project: Dict[str, Any], vue_hits: List[Dict[str, Any]], diagnostics: List[Dict[str, Any]], reviews: List[Dict[str, Any]]) -> None:
    review_json = out.with_suffix(".json")
    payload = {"manifest": manifest, "project": project, "vue_hits": vue_hits, "diagnostics": [{"source": d.get("source"), "returncode": d.get("returncode"), "error": d.get("error")} for d in diagnostics], "reviews": reviews}
    review_json.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    counts = {k: sum(1 for r in reviews if r["status"] == k) for k in ["confirmed", "likely", "downgraded", "rejected", "needs-human"]}
    lines = [
        "# 三方件升级本地复核报告",
        "",
        "## 一、机器复核摘要",
        f"- 组件：{manifest.get('component', '')}",
        f"- 升级范围：{manifest.get('from_ref', '')} -> {manifest.get('to_ref', '')}",
        f"- Bundle schema：{manifest.get('schema_version') or manifest.get('bundle_schema_version') or 'v1'}",
        f"- 检测到生态：{', '.join(project.get('ecosystems', [])) or '未识别'}",
        f"- confirmed：{counts['confirmed']} / likely：{counts['likely']} / downgraded：{counts['downgraded']} / rejected：{counts['rejected']} / needs-human：{counts['needs-human']}",
        "",
        "## 二、项目结构信号",
        "~~~json",
        json.dumps(project, ensure_ascii=False, indent=2)[:6000],
        "~~~",
        "",
        "## 三、逐项机器复核结论",
    ]
    for item in reviews:
        risk = item["risk"]
        lines.extend(["", f"### {risk.get('id')} {risk.get('title')}", f"- 状态：{item['status']}", f"- 分数：{risk.get('final_score')} ({risk.get('final_severity')})", f"- 原因：{item['reason']}"])
        lines.append("- 搜索词：" + (", ".join(item.get("terms", [])[:20]) or "无"))
        if item.get("usage"):
            lines.append("- 源码命中：")
            for hit in item["usage"][:10]:
                lines.append(f"  - {hit['term']} -> {hit['file']}:{hit['line']} {hit['snippet']}")
        if item.get("dependency_hits"):
            lines.append("- Manifest/lockfile 命中：")
            for hit in item["dependency_hits"][:10]:
                lines.append(f"  - {hit['term']} -> {hit['file']}:{hit['line']} {hit['snippet']}")
        if item.get("diagnostic_hits"):
            lines.append("- 诊断命中：")
            for hit in item["diagnostic_hits"][:10]:
                lines.append(f"  - {hit['term']} -> {hit['source']}:{hit['line']} {hit['snippet']}")
        if item.get("external_evidence"):
            lines.append("- 高可信外部证据：")
            for ext in item["external_evidence"][:5]:
                lines.append(f"  - [{ext.get('trust_level')} {ext.get('confidence')}] {ext.get('title')} {ext.get('source_url')}")
    lines.extend(["", "## 四、ClaudeCode 复核要求", "基于 final-report.json 继续追踪 confirmed/likely 项的 wrapper、adapter、service、controller/job/consumer 调用链，并把误报项降级或推翻。"])
    out.write_text("\\n".join(lines), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Scan a local repo against analysis-bundle and emit final-report.md/json.")
    parser.add_argument("--bundle", required=True, help="analysis-bundle directory")
    parser.add_argument("--repo-root", default=".", help="local repository root")
    parser.add_argument("--out", default="final-report.md", help="Markdown report path")
    parser.add_argument("--diagnostics", action="append", default=[], help="existing build/test/typecheck log")
    parser.add_argument("--check-command", action="append", default=[], help="command to run only after user approval")
    parser.add_argument("--check-timeout", type=int, default=180)
    args = parser.parse_args()

    root = Path(args.repo_root).resolve()
    bundle = Path(args.bundle).resolve()
    manifest, risks, evidence, external = load_bundle(bundle)
    project = detect_project(root)
    vue_hits = scan_vue_patterns(root)
    diagnostics = read_diagnostics(args.diagnostics, root, args.check_command, args.check_timeout)
    component_hits = scan_manifests(root, component_terms(manifest))

    reviews = []
    for risk in risks:
        terms = terms_for_risk(risk, evidence, external)
        usage = scan_usage(root, terms)
        dep_hits = scan_manifests(root, terms + component_terms(manifest))
        diag_hits = scan_diagnostics(diagnostics, terms + component_terms(manifest))
        status = classify_status(terms, usage, dep_hits, diag_hits, component_hits, project, vue_hits, risk)
        final_score, final_severity = score_for(risk, status)
        risk["final_score"] = final_score
        risk["final_severity"] = final_severity
        if status == "confirmed":
            reason = "源码使用点或构建/类型检查诊断命中。"
        elif status == "likely":
            reason = "依赖 manifest/lockfile 或框架专项信号命中，但还需要追踪调用链。"
        elif status == "rejected":
            reason = "未在 manifest/lockfile 或源码中发现该组件/风险关键词，当前仓库大概率不适用。"
        elif status == "needs-human":
            reason = "bundle 缺少稳定搜索词，需要人工从上游证据反推。"
        else:
            reason = "组件存在但未发现直接使用点，暂降级。"
        reviews.append({"risk": risk, "terms": terms, "usage": usage, "dependency_hits": dep_hits, "diagnostic_hits": diag_hits, "external_evidence": trusted_external_evidence(external, str(risk.get("id", ""))), "status": status, "reason": reason})

    out = Path(args.out).resolve()
    write_outputs(out, manifest, project, vue_hits, diagnostics, reviews)
    print(json.dumps({"out": str(out), "json": str(out.with_suffix(".json")), "risk_count": len(reviews)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`;

export const EXPORT_DOCX_PY = `#!/usr/bin/env python3
import sys
from pathlib import Path
from docx import Document
from docx.oxml.ns import qn

def md_to_docx(md_path: str, docx_path: str):
    md = Path(md_path).read_text(encoding="utf-8")
    doc = Document()
    style = doc.styles["Normal"]
    style.font.name = "SimSun"
    style._element.rPr.rFonts.set(qn("w:eastAsia"), "SimSun")

    for raw in md.splitlines():
        line = raw.rstrip()
        if not line:
            doc.add_paragraph("")
            continue
        if line.startswith("# "):
            p = doc.add_paragraph()
            r = p.add_run(line[2:])
            r.bold = True
        elif line.startswith("## "):
            p = doc.add_paragraph()
            r = p.add_run(line[3:])
            r.bold = True
        elif line.startswith("### "):
            p = doc.add_paragraph()
            r = p.add_run(line[4:])
            r.bold = True
        elif line.startswith("- "):
            p = doc.add_paragraph(style=None)
            p.style = doc.styles["List Bullet"]
            r = p.add_run(line[2:])
        else:
            p = doc.add_paragraph()
            r = p.add_run(line)
        r.font.name = "SimSun"
        r._element.rPr.rFonts.set(qn("w:eastAsia"), "SimSun")

    doc.save(docx_path)

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: export_docx.py <input.md> <output.docx>")
        sys.exit(1)
    md_to_docx(sys.argv[1], sys.argv[2])
`;
