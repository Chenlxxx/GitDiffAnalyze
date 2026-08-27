#!/usr/bin/env python3
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
    "new Vue(...)": r"\bnew\s+Vue\s*\(",
    "Vue.extend": r"\bVue\.extend\s*\(",
    "Vue.use": r"\bVue\.use\s*\(",
    "Vue.prototype": r"\bVue\.prototype\b",
    "filters": r"\|\s*[A-Za-z_$][\w$]*",
    ".sync": r"\.sync\b",
    "$listeners": r"\$listeners\b",
    "$scopedSlots": r"\$scopedSlots\b",
    "$set/$delete": r"\$(set|delete)\s*\(",
    "createApp": r"\bcreateApp\s*\(",
    "defineProps/defineEmits": r"\bdefine(Props|Emits|Model|Options)\s*\(",
}


def load_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def load_bundle(bundle: Path) -> Tuple[Dict[str, Any], List[Dict[str, Any]], Dict[str, Dict[str, Any]]]:
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
    return manifest, risks if isinstance(risks, list) else [], evidence


def walk_files(root: Path) -> Iterable[Path]:
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".cache")]
        for name in filenames:
            p = Path(dirpath) / name
            if p.name in MANIFEST_NAMES or p.suffix in SOURCE_EXTS:
                yield p


def rel(root: Path, path: Path) -> str:
    try:
        return str(path.relative_to(root)).replace("\\", "/")
    except ValueError:
        return str(path).replace("\\", "/")


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
        chr(96) + r"([^" + chr(96) + r"\n]{3,120})" + chr(96),
        r"\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?:#[A-Za-z_$][\w$]*)?(?:\([^\)\n]{0,120}\))?",
        r"\b[A-Z][A-Za-z0-9_$]+(?:#[A-Za-z_$][\w$]*)?(?:\([^\)\n]{0,120}\))?",
        r"\b[A-Za-z0-9_.-]+(?:Config|Options|Builder|Client|Router|Store|Plugin|Factory|Manager|Strategy|Handler|Interceptor|Consumer|Provider|Request|Response|Exception|Timeout|Socket|Connection|Cache|Auth|Scheme)\b",
        r"\b(?:[a-z][a-z0-9]*[._-]){1,}[a-z][a-z0-9_-]*\b",
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


def terms_for_risk(risk: Dict[str, Any], evidence: Dict[str, Dict[str, Any]]) -> List[str]:
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
    return clean_terms(raw, 80)


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
            line = text.count("\n", 0, idx) + 1
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
                hits.append({"pattern": label, "file": rel(root, p), "line": text.count("\n", 0, m.start()) + 1})
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
            diagnostics.append({"source": "command: " + command, "returncode": completed.returncode, "text": (completed.stdout or "") + "\n" + (completed.stderr or "")})
        except Exception as exc:
            diagnostics.append({"source": "command: " + command, "error": str(exc), "text": ""})
    return diagnostics


def scan_diagnostics(diagnostics: List[Dict[str, Any]], terms: List[str]) -> List[Dict[str, Any]]:
    hits = []
    generic = re.compile(r"\b(error|failed|failure|exception|cannot find symbol|cannot find module|module not found|type error|ts\d{4}|vue-tsc|vite|webpack|maven|gradle)\b", re.I)
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
    lines.extend(["", "## 四、ClaudeCode 复核要求", "基于 final-report.json 继续追踪 confirmed/likely 项的 wrapper、adapter、service、controller/job/consumer 调用链，并把误报项降级或推翻。"])
    out.write_text("\n".join(lines), encoding="utf-8")


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
    manifest, risks, evidence = load_bundle(bundle)
    project = detect_project(root)
    vue_hits = scan_vue_patterns(root)
    diagnostics = read_diagnostics(args.diagnostics, root, args.check_command, args.check_timeout)
    component_hits = scan_manifests(root, component_terms(manifest))

    reviews = []
    for risk in risks:
        terms = terms_for_risk(risk, evidence)
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
        reviews.append({"risk": risk, "terms": terms, "usage": usage, "dependency_hits": dep_hits, "diagnostic_hits": diag_hits, "status": status, "reason": reason})

    out = Path(args.out).resolve()
    write_outputs(out, manifest, project, vue_hits, diagnostics, reviews)
    print(json.dumps({"out": str(out), "json": str(out.with_suffix(".json")), "risk_count": len(reviews)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
