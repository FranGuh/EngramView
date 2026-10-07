import { Children, Fragment, memo, useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileCode, GitCommit, Terminal } from "lucide-react";

interface MarkdownContentProps {
  content: string;
}

const FILE_PATH_REGEX =
  /(?:[a-zA-Z]:[\\/]|[.~]?[\\/])?[-a-zA-Z0-9_.~–—/\\]+\.(?:json|jsx|html|tsx|swift|toml|yaml|scss|cmd|exe|yml|txt|sh|bat|cpp|hpp|java|ruby|vue|svelte|py|js|ts|rs|md|css|c|h|go|rb|php)(?![a-zA-Z0-9_])/i;

const DOMAIN_TOKEN_PATTERN = new RegExp(
  [
    "(\\b(?:Ctrl|Cmd|Alt|Shift|Option)\\s*\\+\\s*[A-Za-z0-9]+\\b)",
    "(<[a-zA-Z0-9_, -]+>)",
    "((?:[a-zA-Z]:[\\\\/]|[.~]?[\\\\/])?[-a-zA-Z0-9_.~–—/\\\\]+\\.(?:json|jsx|html|tsx|swift|toml|yaml|scss|cmd|exe|yml|txt|sh|bat|cpp|hpp|java|ruby|vue|svelte|py|js|ts|rs|md|css|c|h|go|rb|php)(?![a-zA-Z0-9_]))",
    "(\\b_[a-zA-Z0-9_]+\\b|\\b[a-zA-Z0-9_]+\\(\\))",
    "(\\b(?=[0-9a-f]{7,8}\\b)(?:[a-f]*[0-9][a-f0-9]*)\\b)",
    "(\\((?:[0-9]+|[a-zA-Z])\\)(?=\\s|$))",
  ].join("|"),
  "gi",
);

function renderDomainTokens(value: string): ReactNode {
  if (!value) return value;

  DOMAIN_TOKEN_PATTERN.lastIndex = 0;
  if (!DOMAIN_TOKEN_PATTERN.test(value)) {
    return value;
  }

  DOMAIN_TOKEN_PATTERN.lastIndex = 0;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let tokenIndex = 0;

  for (const match of value.matchAll(DOMAIN_TOKEN_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      nodes.push(value.slice(cursor, index));
    }

    const token = match[0];
    const key = `token-${cursor}-${tokenIndex++}`;

    if (/^(?:Ctrl|Cmd|Alt|Shift|Option)\s*\+/i.test(token)) {
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
    } else if (FILE_PATH_REGEX.test(token)) {
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

  if (cursor < value.length) {
    nodes.push(value.slice(cursor));
  }

  return <Fragment>{nodes}</Fragment>;
}

function enrichChildren(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      return renderDomainTokens(child);
    }
    return child;
  });
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

const markdownComponents: Components = {
  p: ({ children, node: _node, ...props }) => <p {...props}>{enrichChildren(children)}</p>,
  li: ({ children, node: _node, ...props }) => <li {...props}>{enrichChildren(children)}</li>,
  blockquote: ({ children, node: _node, ...props }) => <blockquote {...props}>{enrichChildren(children)}</blockquote>,
  strong: ({ children, node: _node, ...props }) => <strong {...props}>{enrichChildren(children)}</strong>,
  em: ({ children, node: _node, ...props }) => <em {...props}>{enrichChildren(children)}</em>,
  th: ({ children, node: _node, ...props }) => <th {...props}>{enrichChildren(children)}</th>,
  td: ({ children, node: _node, ...props }) => <td {...props}>{enrichChildren(children)}</td>,
  h1: ({ children, node: _node, ...props }) => <h1 {...props}>{enrichChildren(children)}</h1>,
  h2: ({ children, node: _node, ...props }) => <h2 {...props}>{enrichChildren(children)}</h2>,
  h3: ({ children, node: _node, ...props }) => <h3 {...props}>{enrichChildren(children)}</h3>,
  h4: ({ children, node: _node, ...props }) => <h4 {...props}>{enrichChildren(children)}</h4>,
  h5: ({ children, node: _node, ...props }) => <h5 {...props}>{enrichChildren(children)}</h5>,
  h6: ({ children, node: _node, ...props }) => <h6 {...props}>{enrichChildren(children)}</h6>,
  table: ({ children, node: _node, ...props }) => (
    <div className="markdown-table-wrap">
      <table {...props}>{children}</table>
    </div>
  ),
  a: ({ href, children, node: _node, ...props }) => (
    <a href={href} rel="noreferrer" target="_blank" {...props}>
      {children}
    </a>
  ),
  code: ({ className, children, node: _node, ...props }) => {
    const isBlock = Boolean(className) || (typeof children === "string" && children.includes("\n"));
    if (isBlock) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }

    const text = typeof children === "string" ? children : "";
    if (text) {
      if (FILE_PATH_REGEX.test(text)) {
        return (
          <code className="inline-filepath" title={text} {...props}>
            <FileCode className="inline-token-icon" />
            {text}
          </code>
        );
      }
      if (/^[0-9a-f]{7,8}$/i.test(text)) {
        return (
          <code className="inline-git-hash" title={`Git commit hash ${text}`} {...props}>
            <GitCommit className="inline-token-icon" />
            {text}
          </code>
        );
      }
      if (/^\b_[a-zA-Z0-9_]+\b$/i.test(text) || /^[a-zA-Z0-9_]+\(\)$/i.test(text)) {
        return (
          <code className="inline-identifier" {...props}>
            {text}
          </code>
        );
      }
    }

    return <code {...props}>{children}</code>;
  },
};

function MarkdownContentBase({ content }: MarkdownContentProps) {
  const processed = useMemo(() => preprocessContent(content), [content]);

  return (
    <article className="markdown-content">
      <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
        {processed}
      </ReactMarkdown>
    </article>
  );
}

export const MarkdownContent = memo(MarkdownContentBase);
