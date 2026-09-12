/**
 * 书源 JS 代码高亮（轻量词法扫描）
 * ------------------------------------------------
 * 书源编辑页只需要「读得清」的高亮，不引入 CodeMirror / Prism 这类编辑器依赖：
 * 这里把代码切成 token（注释 / 字符串 / 模板 / 正则 / 数字 / 关键字 / 字面量 /
 * 内建对象 / 书源宿主 API / 函数名 / 属性 / 标点），交给 JsCodeEditor 一次性
 * innerHTML 写入高亮层（移动端 WebView 上，逐 token 建 DOM 节点才是卡顿来源）。
 *
 * 约定：
 * - 纯函数、无副作用：扫描失败（未闭合字符串 / 正则、非法字符）时按「剩余内容
 *   原样输出」处理，绝不抛错 —— 高亮不该让编辑器卡住或白屏；
 * - 只做词法级判断，不做语法分析（对象字面量与代码块不区分），书源脚本体量下足够。
 */

/** token 类型（配色见 index.css 的 --code-* 变量） */
export type JsTokenKind =
  | "plain"
  | "space"
  | "comment"
  | "string"
  | "regex"
  | "number"
  | "keyword"
  | "literal"
  | "builtin"
  | "api"
  | "fn"
  | "prop"
  | "punct";

export interface JsToken {
  kind: JsTokenKind;
  text: string;
}

/**
 * token → Tailwind 颜色类。
 * 这些类名必须以字面量出现在源码里，Tailwind 才能扫描到并生成对应工具类。
 */
const TOKEN_CLASS: Record<JsTokenKind, string> = {
  plain: "",
  space: "",
  comment: "text-code-comment italic",
  string: "text-code-string",
  regex: "text-code-string",
  number: "text-code-number",
  keyword: "text-code-keyword",
  literal: "text-code-literal",
  builtin: "text-code-builtin",
  api: "text-code-api",
  fn: "text-code-fn",
  prop: "",
  punct: "text-text-2",
};

/** JS 关键字（含 async / await / get / set 等常用上下文关键字） */
const KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "finally",
  "for",
  "from",
  "function",
  "get",
  "if",
  "import",
  "in",
  "instanceof",
  "let",
  "new",
  "of",
  "return",
  "set",
  "static",
  "switch",
  "throw",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

/** 字面量与自身引用 */
const LITERALS = new Set([
  "true",
  "false",
  "null",
  "undefined",
  "NaN",
  "Infinity",
  "this",
  "super",
]);

/** 书源宿主 API（docs/book-source-api.md），单独配色便于辨认可用能力 */
const HOST_API = new Set(["http", "html", "util", "base64", "cryptoUtil", "webview", "console"]);

/** 沙箱内可用的标准内建 */
const BUILTIN = new Set([
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Symbol",
  "BigInt",
  "Math",
  "JSON",
  "Date",
  "RegExp",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "Proxy",
  "Reflect",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "EvalError",
  "URIError",
  "ReferenceError",
  "ArrayBuffer",
  "Uint8Array",
  "Int8Array",
  "Uint16Array",
  "Int16Array",
  "Uint32Array",
  "Int32Array",
  "Float32Array",
  "Float64Array",
  "Intl",
  "globalThis",
  "arguments",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURIComponent",
  "decodeURIComponent",
  "encodeURI",
  "decodeURI",
  "escape",
  "unescape",
  "structuredClone",
]);

const NUMBER_RE =
  /^(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*\.?\d*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)n?/;

const UNICODE_ID_START = /[\p{L}\p{Nl}$_]/u;
const UNICODE_ID_PART = /[\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\p{Pc}$_\u200C\u200D]/u;

function isIdStart(code: number): boolean {
  if (code < 128) {
    return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36;
  }
  return UNICODE_ID_START.test(String.fromCharCode(code));
}

function isIdPart(code: number): boolean {
  if (code < 128) {
    return (
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 95 ||
      code === 36
    );
  }
  return UNICODE_ID_PART.test(String.fromCharCode(code));
}

/** 上一个有效 token 之后是否允许出现正则字面量（否则 `/` 是除号） */
function regexAllowed(prev: JsToken | undefined): boolean {
  if (!prev) return true;
  if (prev.kind === "punct") return !")]}".includes(prev.text);
  return prev.kind === "keyword";
}

/**
 * 扫描 JS 源码为 token 序列（顺序即原文顺序，拼接 token.text 还原原文）。
 */
export function tokenizeJs(source: string): JsToken[] {
  const out: JsToken[] = [];
  const n = source.length;
  let prev: JsToken | undefined;

  function push(kind: JsTokenKind, text: string): void {
    if (!text) return;
    const token: JsToken = { kind, text };
    out.push(token);
    // 空白不参与「上一个有效 token」判断（决定 `/` 是正则还是除号、是否成员访问）
    if (kind !== "space") prev = token;
  }

  /** 行内空白后的下一个非空白字符（用于判断「标识符后紧跟 (」＝函数调用） */
  function nextNonSpace(from: number): string {
    let j = from;
    while (j < n) {
      const c = source[j];
      if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") return c;
      j++;
    }
    return "";
  }

  /** 字符串 / 模板串结尾（未闭合时止于行尾，避免整段代码被染色） */
  function readString(start: number, quote: string): number {
    let j = start + 1;
    while (j < n) {
      const c = source[j];
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === quote) return j + 1;
      if (c === "\n") return j;
      j++;
    }
    return n;
  }

  /** 正则字面量；不像正则（跨行未闭合）时返回 -1 */
  function readRegex(start: number): number {
    let j = start + 1;
    let inClass = false;
    while (j < n) {
      const c = source[j];
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === "\n") return -1;
      if (inClass) {
        if (c === "]") inClass = false;
      } else if (c === "[") {
        inClass = true;
      } else if (c === "/") {
        j++;
        while (j < n && isIdPart(source.charCodeAt(j))) j++;
        return j;
      }
      j++;
    }
    return -1;
  }

  function readNumber(start: number): number {
    const m = NUMBER_RE.exec(source.slice(start, start + 64));
    return m ? start + m[0].length : start + 1;
  }

  function classify(word: string, after: number): JsTokenKind {
    const isCall = nextNonSpace(after) === "(";
    // 成员访问优先：`http.get` 的 get 是方法名，不是关键字
    if (prev !== undefined && prev.kind === "punct" && prev.text === ".") {
      return isCall ? "fn" : "prop";
    }
    if (KEYWORDS.has(word)) return "keyword";
    if (LITERALS.has(word)) return "literal";
    if (HOST_API.has(word)) return "api";
    if (BUILTIN.has(word)) return "builtin";
    return isCall ? "fn" : "plain";
  }

  /**
   * 扫描一段代码。
   * @param stopAtBrace 模板串插值 `${` 内使用：遇到配对的 `}` 就停下（不消费）
   * @returns 停止位置（下一个待扫描的下标）
   */
  function scanCode(start: number, stopAtBrace: boolean): number {
    let i = start;
    let depth = 0;
    while (i < n) {
      const c = source[i];
      if (stopAtBrace && c === "}" && depth === 0) return i;

      // 空白
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        let j = i + 1;
        while (j < n) {
          const w = source[j];
          if (w !== " " && w !== "\t" && w !== "\n" && w !== "\r") break;
          j++;
        }
        push("space", source.slice(i, j));
        i = j;
        continue;
      }

      // 注释
      if (c === "/" && source[i + 1] === "/") {
        let j = i + 2;
        while (j < n && source[j] !== "\n") j++;
        push("comment", source.slice(i, j));
        i = j;
        continue;
      }
      if (c === "/" && source[i + 1] === "*") {
        const end = source.indexOf("*/", i + 2);
        const j = end < 0 ? n : end + 2;
        push("comment", source.slice(i, j));
        i = j;
        continue;
      }

      // 正则 or 除号
      if (c === "/") {
        if (regexAllowed(prev)) {
          const end = readRegex(i);
          if (end > i) {
            push("regex", source.slice(i, end));
            i = end;
            continue;
          }
        }
        push("punct", c);
        i++;
        continue;
      }

      // 字符串 / 模板串
      if (c === '"' || c === "'") {
        const end = readString(i, c);
        push("string", source.slice(i, end));
        i = end;
        continue;
      }
      if (c === "`") {
        i = scanTemplate(i);
        continue;
      }

      // 数字
      if ((c >= "0" && c <= "9") || (c === "." && source[i + 1] >= "0" && source[i + 1] <= "9")) {
        const end = readNumber(i);
        push("number", source.slice(i, end));
        i = end;
        continue;
      }

      // 标识符 / 关键字
      if (isIdStart(source.charCodeAt(i))) {
        let j = i + 1;
        while (j < n && isIdPart(source.charCodeAt(j))) j++;
        const word = source.slice(i, j);
        push(classify(word, j), word);
        i = j;
        continue;
      }

      // 其它单字符标点
      if (c === "{" || c === "(" || c === "[") depth++;
      else if (c === "}" || c === ")" || c === "]") depth = Math.max(0, depth - 1);
      push("punct", c);
      i++;
    }
    return n;
  }

  /** 模板串：字符串片段按字符串着色，`${}` 内的表达式递归扫描 */
  function scanTemplate(start: number): number {
    let i = start + 1;
    let chunk = start;
    while (i < n) {
      const c = source[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        i++;
        push("string", source.slice(chunk, i));
        return i;
      }
      if (c === "$" && source[i + 1] === "{") {
        push("string", source.slice(chunk, i + 2));
        i = scanCode(i + 2, true);
        if (i < n && source[i] === "}") {
          push("punct", "}");
          i++;
        }
        chunk = i;
        continue;
      }
      i++;
    }
    push("string", source.slice(chunk, n));
    return n;
  }

  scanCode(0, false);
  return out;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

/**
 * 高亮为可直接写入 `<pre>` 的 HTML（token 拼回原文，跨行 token 不切分）。
 * 末尾补一个空格：`<pre>` 不会为末尾换行生成行盒，光标停在最后一行时高亮层会缺一行。
 */
export function highlightJsHtml(source: string): string {
  let html = "";
  for (const token of tokenizeJs(source)) {
    const cls = TOKEN_CLASS[token.kind];
    const text = escapeHtml(token.text);
    html += cls ? `<span class="${cls}">${text}</span>` : text;
  }
  if (source.endsWith("\n")) html += " ";
  return html;
}

/** 代码行数（至少 1 行，供行号槽使用） */
export function jsLineCount(source: string): number {
  let lines = 1;
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) lines++;
  }
  return lines;
}
