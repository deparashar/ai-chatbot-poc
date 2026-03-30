/**
 * Converts a subset of Markdown to safe HTML.
 * Supports: headings, bold, italic, inline code, code blocks,
 * tables, unordered/ordered lists, horizontal rules.
 */
export function renderMarkdown(text) {
  // Escape HTML
  let s = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Fenced code blocks (```...```)
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    return `<pre><code>${code.trimEnd()}</code></pre>`;
  });

  // Tables: detect lines with | separators
  s = renderTables(s);

  // Headings
  s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^## (.+)$/gm,  '<h2>$1</h2>');
  s = s.replace(/^# (.+)$/gm,   '<h1>$1</h1>');

  // Bold / italic / inline code
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*(.+?)\*/g,     '<em>$1</em>');
  s = s.replace(/`([^`]+)`/g,     '<code>$1</code>');

  // Horizontal rule
  s = s.replace(/^---$/gm, '<hr>');

  // Lists
  s = renderLists(s);

  // Wrap remaining plain lines in <p>
  s = s.split('\n').map(line => {
    if (!line.trim()) return '';
    if (/^<(h[123]|ul|ol|li|hr|p|pre|table|div)/.test(line)) return line;
    return `<p>${line}</p>`;
  }).join('');

  return s;
}

/**
 * Detects Markdown tables and converts them to HTML <table>.
 */
function renderTables(text) {
  const lines = text.split('\n');
  const result = [];
  let i = 0;

  while (i < lines.length) {
    // A table needs: header row | separator row (with dashes) | data rows
    if (
      i + 1 < lines.length &&
      lines[i].includes('|') &&
      lines[i + 1].includes('|') &&
      /^[\s|:-]+$/.test(lines[i + 1])
    ) {
      const headerCells = parseTableRow(lines[i]);
      i += 2; // skip header + separator

      let html = '<table><thead><tr>';
      for (const cell of headerCells) {
        html += `<th>${cell}</th>`;
      }
      html += '</tr></thead><tbody>';

      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        const cells = parseTableRow(lines[i]);
        html += '<tr>';
        for (let c = 0; c < headerCells.length; c++) {
          html += `<td>${cells[c] || ''}</td>`;
        }
        html += '</tr>';
        i++;
      }

      html += '</tbody></table>';
      result.push(html);
    } else {
      result.push(lines[i]);
      i++;
    }
  }

  return result.join('\n');
}

function parseTableRow(line) {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(c => c.trim());
}

/**
 * Converts Markdown list lines to HTML lists.
 */
function renderLists(text) {
  const lines = text.split('\n');
  const result = [];
  let inUl = false;
  let inOl = false;

  for (const line of lines) {
    const ulMatch = line.match(/^[•\-]\s+(.+)$/);
    const olMatch = line.match(/^\d+\.\s+(.+)$/);

    if (ulMatch) {
      if (!inUl) { result.push('<ul>'); inUl = true; }
      if (inOl) { result.push('</ol>'); inOl = false; }
      result.push(`<li>${ulMatch[1]}</li>`);
    } else if (olMatch) {
      if (!inOl) { result.push('<ol>'); inOl = true; }
      if (inUl) { result.push('</ul>'); inUl = false; }
      result.push(`<li>${olMatch[1]}</li>`);
    } else {
      if (inUl) { result.push('</ul>'); inUl = false; }
      if (inOl) { result.push('</ol>'); inOl = false; }
      result.push(line);
    }
  }

  if (inUl) result.push('</ul>');
  if (inOl) result.push('</ol>');

  return result.join('\n');
}
