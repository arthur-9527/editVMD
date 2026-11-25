/**
 * 侧边栏 AI 的 Markdown 渲染测试。
 *
 * 重点验证「安全」而不是「功能全」：
 *   AI 输出是外部内容，任何一段都可能带 <!-- --> <script> onerror= 之类，
 *   所以每条断言都在钉死「不会变成可执行 HTML」。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  escapeHtml,
  renderMarkdown,
  safeHref,
  stripEditorPrefix,
} from "../src/ai/markdown.ts";

test("HTML 特殊字符全部转义", () => {
  assert.equal(
    escapeHtml(`<script>&"'\u0027</script>`),
    "&lt;script&gt;&amp;&quot;&#39;&#39;&lt;/script&gt;",
  );
});

test("脚本标签不会以标签形式出现", () => {
  const html = renderMarkdown('<script>alert(1)</script>');
  assert.ok(!html.includes("<script"), html);
  assert.ok(html.includes("&lt;script&gt;"), html);
});

test("事件属性被转义，无法触发 handler", () => {
  const html = renderMarkdown('<img src=x onerror="alert(1)">');
  assert.ok(!/<img/i.test(html), html);
  assert.ok(!/onerror="/i.test(html), html.replace(/&quot;/g, '"'));
});

test("只放行 http(s) 链接", () => {
  assert.equal(safeHref("https://a.com/x"), "https://a.com/x");
  assert.equal(safeHref("http://a.com"), "http://a.com");
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref("data:text/html,<script>"), null);
  assert.equal(safeHref("/api/local"), null);
});

test("恶意链接退化为纯文本（不会被渲染成 a 标签）", () => {
  const html = renderMarkdown("[点我](javascript:alert(1))");
  assert.ok(!html.includes("<a "), html);
  assert.ok(html.includes("javascript:alert(1)"), html);
});

test("合法链接渲染成带 rel 的外链", () => {
  const html = renderMarkdown("[官网](https://example.com)");
  assert.ok(html.includes('href="https://example.com"'), html);
  assert.ok(html.includes('rel="noopener noreferrer"'), html);
  assert.ok(html.includes('target="_blank"'), html);
});

test("围栏代码块：内容转义且保留语言标记", () => {
  const html = renderMarkdown('```python\nprint("<b>")\n```');
  assert.ok(html.includes('<code class="language-python">'), html);
  assert.ok(html.includes("&lt;b&gt;"), html);
  assert.ok(!html.includes("<b>"), html);
});

test("行内代码优先于其它行内规则", () => {
  const html = renderMarkdown("`**not bold**`");
  assert.ok(html.includes("<code>**not bold**</code>"), html);
  assert.ok(!html.includes("<strong>"), html);
});

test("标题 / 列表 / 引用 / 水平线", () => {
  assert.ok(renderMarkdown("## 二级").includes("<h2>二级</h2>"));
  assert.ok(renderMarkdown("- a\n- b").includes("<ul>"));
  assert.ok(renderMarkdown("1. x").includes("<ol>"));
  assert.ok(renderMarkdown("> q").includes("<blockquote>"));
  assert.ok(renderMarkdown("---").includes("<hr />"));
});

test("列表能正确闭合（切换段落不留悬空标签）", () => {
  const html = renderMarkdown("- a\n\n段落");
  assert.ok(html.includes("</ul>"), html);
  assert.ok(html.indexOf("</ul>") < html.indexOf("<p>段落</p>"), html);
});

test("粗体 / 斜体 / 删除线", () => {
  const html = renderMarkdown("**B** *I* ~~D~~");
  assert.ok(html.includes("<strong>B</strong>"), html);
  assert.ok(html.includes("<em>I</em>"), html);
  assert.ok(html.includes("<del>D</del>"), html);
});

test("空输入返回空字符串", () => {
  assert.equal(renderMarkdown(""), "");
});

test("剥掉编辑器上下文前缀，只留用户原文", () => {
  const sent = "[编辑器上下文] 模型=a.pmx · 当前帧=3\n[用户消息] 帮我看下这个动作";
  assert.equal(stripEditorPrefix(sent), "帮我看下这个动作");
});

test("没有前缀时原样返回（不误伤普通文本）", () => {
  assert.equal(stripEditorPrefix("普通问题"), "普通问题");
});
