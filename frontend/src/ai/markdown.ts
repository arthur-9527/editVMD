/**
 * 零依赖的安全 Markdown 渲染。
 *
 * 为什么不引 marked + DOMPurify：
 *   本项目前端目前没有任何 Markdown 依赖，为了侧边栏再加两个包不值得；
 *   而「先转义 → 再渲染」的极简实现，天然免疫 AI 输出里的 HTML 注入，
 *   比「渲染后 sanitize」更保守（白名单外的东西一开始就不会被当成 HTML）。
 *
 * 支持：围栏代码块、行内代码、粗体、斜体、标题、无序/有序列表、
 *       引用、水平线、链接（仅 http/https）。
 * 不支持（有意）：原始 HTML、图片、表格、脚注。
 */

/** HTML 转义 —— 一切渲染的第一步 */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 只放行 http(s) 链接，其余返回 null（防 javascript:/data: 注入） */
export function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (/^https?:\/\/[^\s]+$/i.test(url)) return url;
  return null;
}

/** 行内渲染：**粗** *斜* `code` [text](url) */
function renderInline(text: string): string {
  let out = escapeHtml(text);

  // 行内代码优先，避免其中内容被后续规则改写
  const codes: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(code);
    return `\u0000CODE${codes.length - 1}\u0000`;
  });

  // 链接：先匹配 Markdown 语法
  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (match: string, label: string, href: string) => {
      const safe = safeHref(href.replace(/&amp;/g, "&"));
      if (!safe) return match;
      const target = escapeHtml(safe);
      return `<a href="${target}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    },
  );

  // 裸链接（不含上面已转成 <a> 的）
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_m, prefix: string, url: string) => {
    const safe = safeHref(url.replace(/&amp;/g, "&"));
    if (!safe) return `${prefix}${url}`;
    return `${prefix}<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });

  out = out
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");

  // 还原行内代码
  out = out.replace(/\u0000CODE(\d+)\u0000/g, (_m, idx: string) => {
    const code = codes[Number(idx)] ?? "";
    return `<code>${code}</code>`;
  });

  return out;
}

/**
 * 渲染 Markdown 为安全 HTML 字符串。
 *
 * 返回的 HTML 可以直接放进 dangerouslySetInnerHTML —— 因为所有
 * 文本都已 escapeHtml，唯一生成的标签是我们自己拼的。
 */
export function renderMarkdown(source: string): string {
  if (!source) return "";

  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];

  let listType: "ul" | "ol" | null = null;
  let inQuote = false;

  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };
  const closeQuote = () => {
    if (inQuote) {
      html.push("</blockquote>");
      inQuote = false;
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";

    // ---- 围栏代码块 ----
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      closeList();
      closeQuote();
      const lang = fence[1] ?? "";
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i] ?? "")) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      html.push(`<pre><code${cls}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    // ---- 空行 ----
    if (!line.trim()) {
      closeList();
      closeQuote();
      continue;
    }

    // ---- 标题 ----
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      closeQuote();
      const level = heading[1]!.length;
      html.push(`<h${level}>${renderInline(heading[2] ?? "")}</h${level}>`);
      continue;
    }

    // ---- 水平线 ----
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      closeList();
      closeQuote();
      html.push("<hr />");
      continue;
    }

    // ---- 引用 ----
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      closeList();
      if (!inQuote) {
        html.push("<blockquote>");
        inQuote = true;
      }
      html.push(`<p>${renderInline(quote[1] ?? "")}</p>`);
      continue;
    }
    closeQuote();

    // ---- 无序列表 ----
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      if (listType !== "ul") {
        closeList();
        html.push("<ul>");
        listType = "ul";
      }
      html.push(`<li>${renderInline(ul[1] ?? "")}</li>`);
      continue;
    }

    // ---- 有序列表 ----
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ol) {
      if (listType !== "ol") {
        closeList();
        html.push("<ol>");
        listType = "ol";
      }
      html.push(`<li>${renderInline(ol[1] ?? "")}</li>`);
      continue;
    }

    // ---- 普通段落 ----
    closeList();
    html.push(`<p>${renderInline(line)}</p>`);
  }

  closeList();
  closeQuote();
  return html.join("\n");
}

/**
 * 剥掉编辑器附加的标记，只留用户原文。
 *
 * 与参考项目剥 `[用户连接了 …]` 是同一手法：发给模型的是富文本，
 * 展示给用户的是原文。
 */
export function stripEditorPrefix(text: string): string {
  return text
    .replace(/^\s*\[编辑器上下文\][^\n]*\n?/g, "")
    .replace(/^\s*\[用户消息\]\s*/g, "")
    .trim();
}
