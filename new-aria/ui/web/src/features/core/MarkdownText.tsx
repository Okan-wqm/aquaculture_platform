import { useMemo, type ReactNode } from 'react';
import { parseMarkdownBlocks, type MarkdownBlock } from './markdown-blocks.ts';
import './MarkdownText.css';

function Heading({ level, text }: { readonly level: number; readonly text: string }): ReactNode {
  // The page already owns <h1>; report headings start one level lower.
  const shifted = Math.min(level + 1, 6);
  switch (shifted) {
    case 2:
      return <h2>{text}</h2>;
    case 3:
      return <h3>{text}</h3>;
    case 4:
      return <h4>{text}</h4>;
    case 5:
      return <h5>{text}</h5>;
    default:
      return <h6>{text}</h6>;
  }
}

function Block({ block }: { readonly block: MarkdownBlock }): ReactNode {
  switch (block.type) {
    case 'heading':
      return <Heading level={block.level} text={block.text} />;
    case 'paragraph':
      return <p>{block.text}</p>;
    case 'list':
      return block.ordered ? (
        <ol>
          {block.items.map((item, index) => (
            <li key={`${index}-${item}`}>{item}</li>
          ))}
        </ol>
      ) : (
        <ul>
          {block.items.map((item, index) => (
            <li key={`${index}-${item}`}>{item}</li>
          ))}
        </ul>
      );
    case 'code':
      return (
        <pre className="md__code" data-language={block.language ?? undefined} tabIndex={0}>
          <code>{block.text}</code>
        </pre>
      );
    case 'quote':
      return <blockquote>{block.text}</blockquote>;
    case 'rule':
      return <hr />;
    case 'table': {
      const [header, ...body] = block.rows;
      return (
        <div className="md__table-wrap">
          <table>
            {header !== undefined ? (
              <thead>
                <tr>
                  {header.map((cell, index) => (
                    <th key={`${index}-${cell}`} scope="col">
                      {cell}
                    </th>
                  ))}
                </tr>
              </thead>
            ) : null}
            <tbody>
              {body.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={`${cellIndex}-${cell}`}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    default:
      return null;
  }
}

/** Renders markdown as escaped text with block-level styling only; never injects HTML. */
export function MarkdownText({ markdown }: { readonly markdown: string }): ReactNode {
  const blocks = useMemo(() => parseMarkdownBlocks(markdown), [markdown]);
  if (blocks.length === 0) {
    return <p className="muted">Rapor boş.</p>;
  }
  return (
    <article className="md">
      {blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </article>
  );
}
