// Re-renders a view in place instead of replacing it, so CSS transitions actually run between states
// and focus, scroll and text selection survive. Matches nodes by position; anything that doesn't line up
// is simply replaced, so the worst case is what innerHTML would have done anyway.
const same = (a, b) => a.nodeType === b.nodeType && a.nodeName === b.nodeName && (a.nodeType !== 1 || (a.id === b.id && a.getAttribute('data-key') === b.getAttribute('data-key')));

function attrs(a, b) {
  // A form control's live value belongs to the user until the state behind it really changes.
  if (a.tagName === 'INPUT') {
    if (a.getAttribute('value') !== b.getAttribute('value') && a !== document.activeElement) a.value = b.getAttribute('value') || '';
    if (a.checked !== b.hasAttribute('checked')) a.checked = b.hasAttribute('checked');
  }
  [...a.attributes].forEach((x) => { if (!b.hasAttribute(x.name) && !(a.tagName === 'DETAILS' && x.name === 'open')) a.removeAttribute(x.name); });
  [...b.attributes].forEach((x) => { if (a.getAttribute(x.name) !== x.value) a.setAttribute(x.name, x.value); });
}

function children(a, b) {
  let x = a.firstChild, y = b.firstChild;
  while (y) {
    const ny = y.nextSibling;
    if (!x) a.appendChild(y);
    else {
      const nx = x.nextSibling;
      if (!same(x, y)) a.replaceChild(y, x);
      else if (x.nodeType !== 1) { if (x.nodeValue !== y.nodeValue) x.nodeValue = y.nodeValue; }
      else node(x, y);
      x = nx;
    }
    y = ny;
  }
  while (x) { const nx = x.nextSibling; a.removeChild(x); x = nx; }
}

function node(a, b) {
  attrs(a, b);
  if (a.tagName === 'TEXTAREA') {
    if (a.defaultValue !== b.defaultValue) { a.defaultValue = b.defaultValue; if (a !== document.activeElement) a.value = b.defaultValue; }
    return;
  }
  const pick = a.tagName === 'SELECT' ? [...b.options].findIndex((o) => o.hasAttribute('selected')) : -1;
  children(a, b);
  if (pick > -1 && a !== document.activeElement) a.selectedIndex = pick;
}

export function morph(el, html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  children(el, t.content);
}
