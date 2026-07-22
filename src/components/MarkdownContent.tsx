import { Fragment, memo, useMemo, type ReactNode } from "react";
import { FileCode, GitCommit, Terminal } from "lucide-react";

interface MarkdownContentProps {
  content: string;
}

const INLINE_PATTERN = new RegExp(
  [
    "(`[^`]+`)",
    "(\\[[^\\]]+\\]\\(https?:\\/\\/[^)\\s]+\\))",
    "(\\*{2}[^*]+\\*{2})",
    "(\\*[^*\n]+\\*)",
    "(\\b(?:Ctrl|Cmd|Alt|Shift|Option)\\s*\\+\\s*[A-Za-z0-9]+\\b)",
    "(<[a-zA-Z0-9_, -]+>)",
    "((?:[a-zA-Z]:[\\\\/]|[.~]?[\\\\/])?[a-zA-Z0-9_.-–—\\\\/]+\\.(?:py|html|js|jsx|ts|tsx|json|rs|md|css|scss|cmd|exe|toml|yaml|yml|txt|sh|bat|cpp|c|h|hpp|go|java|kt|swift|rb|php|vue|svelte))",
    "(\\b_[a-zA-Z0-9_]+\\b|\\b[a-zA-Z0-9_]+\\(\\))",
    "(\\b(?=[0-9a-f]{7,8}\\b)(?:[a-f]*[0-9][a-f0-9]*)\\b)",
    "(\\((?:[0-9]+|[a-zA-Z])\\)(?=\\s|$))",
  ].join("|"),
  "gi",
);

function renderInline(value: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let tokenIndex = 0;

  for (const match of value.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) nodes.push(value.slice(cursor, index));

    const token = match[0];
    const key = `${keyPrefix}-${tokenIndex}`;
    tokenIndex += 1;

    if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("[")) {
      const linkMatch = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
      if (linkMatch) {
        nodes.push(
          <a key={key} href={linkMatch[2]} rel="noreferrer" target="_blank">
            {linkMatch[1]}
          </a>,
        );
      } else {
        nodes.push(token);
      }
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*")) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else if (/^(?:Ctrl|Cmd|Alt|Shift|Option)\s*\+/i.test(token)) {
      const parts = token.split("+").map((p) => p.trim());
      nodes.push(
        <span key={key} className="inline-kbd-wrap">
          {parts.map((part, pIdx) => (
            <Fragment key={`${key}-${pIdx}`}>
              {pIdx > 0 ? " + " : null}
              <kbd className="inline-kbd">{part}</kbd>
            </Fragment>
          ))}
        </span>,
      );
    } else if (token.startsWith("<") && token.endsWith(">")) {
      nodes.push(
        <span key={key} className="inline-angle-tag">
          <Terminal className="inline-token-icon" />
          {token}
        </span>,
      );
    } else if (/\.(?:py|html|js|jsx|ts|tsx|json|rs|md|css|scss|cmd|exe|toml|yaml|yml|txt|sh|bat|cpp|c|h|hpp|go|java|kt|swift|rb|php|vue|svelte)$/i.test(token)) {
      nodes.push(
        <code key={key} className="inline-filepath" title={token}>
          <FileCode className="inline-token-icon" />
          {token}
        </code>,
      );
    } else if (/^\b_[a-zA-Z0-9_]+\b$/i.test(token) || /^[a-zA-Z0-9_]+\(\)$/i.test(token)) {
      nodes.push(
        <code key={key} className="inline-identifier">
          {token}
        </code>,
      );
    } else if (/^[0-9a-f]{7,8}$/i.test(token)) {
      nodes.push(
        <code key={key} className="inline-git-hash" title={`Git commit hash ${token}`}>
          <GitCommit className="inline-token-icon" />
          {token}
        </code>,
      );
    } else if (/^\((?:[0-9]+|[a-zA-Z])\)$/.test(token)) {
      nodes.push(
        <span key={key} className="inline-num-badge">
          {token}
        </span>,
      );
    } else {
      nodes.push(token);
    }

    cursor = index + token.length;
  }

  if (cursor < value.length) nodes.push(value.slice(cursor));
  return nodes;
}

function splitTableRow(line: string) {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableDivider(line: string) {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function preprocessContent(raw: string): string {
  if (!raw) return "";

  // Preserve code blocks (``` ... ```) intact during prose preprocessing
  const codeBlocks: string[] = [];
  let text = raw.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `__CODE_BLOCK_PLACEHOLDER_${codeBlocks.length - 1}__`;
  });

  // 1. Unescape literal \n escape sequences in prose
  text = text.replace(/\\n/g, "\n");

  // 2. Format common section labels into separate bolded paragraphs
  text = text.replace(
    /(?:^|\s+)(What|Why|Where|Learned|Context|Summary|Details|Resolution|Impact|Notes?|Results?|Background|Problem|Solution|Actions?|Fixes?|Cause):/gi,
    (_, key, offset) => {
      const precedingChar = offset > 0 ? text[offset - 1] : "\n";
      const prefix = precedingChar === "\n" ? "" : "\n\n";
      return `${prefix}**${key}:**`;
    },
  );

  // 3. Format inline list markers like (1), (2), (3)... with newlines
  text = text.replace(/(\S)\s+(\((?:[0-9]+|[a-zA-Z])\)\s+)/g, "$1\n$2");

  // Restore code blocks intact
  text = text.replace(/__CODE_BLOCK_PLACEHOLDER_(\d+)__/g, (_, idx) => {
    return codeBlocks[Number(idx)] ?? "";
  });

  return text;
}

function isBlockStart(lines: string[], index: number) {
  const line = lines[index] ?? "";
  return (
    /^\s*```/.test(line) ||
    /^#{1,6}\s+/.test(line) ||
    /^\s*>\s?/.test(line) ||
    /^\s*([-+*])\s+/.test(line) ||
    /^\s*\d+[.)]\s+/.test(line) ||
    /^\s*(---+|___+|\*\*\*+)\s*$/.test(line) ||
    /^\s*\*\*(What|Why|Where|Learned|Context|Summary|Details|Resolution|Impact|Notes?|Results?|Background|Problem|Solution|Actions?|Fixes?|Cause):\*\*/i.test(line) ||
    (line.includes("|") && isTableDivider(lines[index + 1] ?? ""))
  );
}

function MarkdownContentBase({ content }: MarkdownContentProps) {
  const blocks = useMemo(() => {
    const processed = preprocessContent(content);
    const lines = processed.replace(/\r\n?/g, "\n").split("\n");
    const result: ReactNode[] = [];
    let index = 0;

    while (index < lines.length) {
      const line = lines[index];

      if (!line.trim()) {
        index += 1;
        continue;
      }

      const fenceMatch = line.match(/^\s*```([^\s`]*)\s*$/);
      if (fenceMatch) {
        const code: string[] = [];
        index += 1;
        while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
          code.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        result.push(
          <pre key={`code-${index}`} data-language={fenceMatch[1] || undefined}>
            <code>{code.join("\n")}</code>
          </pre>,
        );
        continue;
      }

      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const Heading = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
        result.push(
          <Heading key={`heading-${index}`}>
            {renderInline(headingMatch[2], `heading-${index}`)}
          </Heading>,
        );
        index += 1;
        continue;
      }

      if (/^\s*(---+|___+|\*\*\*+)\s*$/.test(line)) {
        result.push(<hr key={`rule-${index}`} />);
        index += 1;
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        const quote: string[] = [];
        while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
          quote.push(lines[index].replace(/^\s*>\s?/, ""));
          index += 1;
        }
        result.push(
          <blockquote key={`quote-${index}`}>
            {quote.map((quoteLine, quoteIndex) => (
              <Fragment key={`quote-line-${quoteIndex}`}>
                {quoteIndex > 0 ? <br /> : null}
                {renderInline(quoteLine, `quote-${index}-${quoteIndex}`)}
              </Fragment>
            ))}
          </blockquote>,
        );
        continue;
      }

      const unorderedMatch = line.match(/^\s*[-+*]\s+(.+)$/);
      const orderedMatch = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (unorderedMatch || orderedMatch) {
        const ordered = Boolean(orderedMatch);
        const items: string[] = [];
        const itemPattern = ordered ? /^\s*\d+[.)]\s+(.+)$/ : /^\s*[-+*]\s+(.+)$/;
        while (index < lines.length) {
          const item = lines[index].match(itemPattern);
          if (!item) break;
          items.push(item[1]);
          index += 1;
        }
        const List = ordered ? "ol" : "ul";
        result.push(
          <List key={`list-${index}`}>
            {items.map((item, itemIndex) => (
              <li key={`item-${itemIndex}`}>{renderInline(item, `item-${index}-${itemIndex}`)}</li>
            ))}
          </List>,
        );
        continue;
      }

      if (line.includes("|") && isTableDivider(lines[index + 1] ?? "")) {
        const headers = splitTableRow(line);
        const rows: string[][] = [];
        index += 2;
        while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
          rows.push(splitTableRow(lines[index]));
          index += 1;
        }
        result.push(
          <div className="markdown-table-wrap" key={`table-${index}`}>
            <table>
              <thead>
                <tr>{headers.map((header, cellIndex) => <th key={cellIndex}>{renderInline(header, `th-${index}-${cellIndex}`)}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>{headers.map((_, cellIndex) => <td key={cellIndex}>{renderInline(row[cellIndex] ?? "", `td-${index}-${rowIndex}-${cellIndex}`)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>,
        );
        continue;
      }

      const paragraph: string[] = [line.trim()];
      index += 1;
      while (index < lines.length && lines[index].trim() && !isBlockStart(lines, index)) {
        paragraph.push(lines[index].trim());
        index += 1;
      }
      result.push(
        <p key={`paragraph-${index}`}>
          {paragraph.map((paragraphLine, lineIndex) => (
            <Fragment key={lineIndex}>
              {lineIndex > 0 ? <br /> : null}
              {renderInline(paragraphLine, `paragraph-${index}-${lineIndex}`)}
            </Fragment>
          ))}
        </p>,
      );
    }

    return result;
  }, [content]);

  return <article className="markdown-content">{blocks}</article>;
}

export const MarkdownContent = memo(MarkdownContentBase);
