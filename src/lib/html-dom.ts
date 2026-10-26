/**
 * Real HTML DOM Parser & Element Locator (PHASE J1 - A1)
 * Parses each page once via node-html-parser and locates elements by nearest
 * Arabic landmark ("الهيدر" | "القايمة" | "الفوتر" | "المحتوى الرئيسي")
 * plus nearest heading ("قسم «…»"), visible text, CSS selector, and collapsed snippet <= 200 chars.
 */
import { parse, HTMLElement, Node, NodeType } from 'node-html-parser';
import { FindingWhere } from '../types/contract';

export type { FindingWhere };
export { HTMLElement };

export interface ParsedPageDom {
  root: HTMLElement;
  pageUrl: string;
  locate: (el: HTMLElement | null | undefined) => FindingWhere;
  defaultWhere: (label?: string, snippetOverride?: string) => FindingWhere;
}

export function collapseWhitespace(input: string | undefined | null): string {
  if (!input) return '';
  return input.replace(/\s+/g, ' ').trim();
}

export function decodeUrlForDisplay(rawUrl: string | undefined | null): string {
  if (!rawUrl) return '';
  try {
    return decodeURI(rawUrl);
  } catch {
    try {
      return decodeURIComponent(rawUrl);
    } catch {
      return rawUrl;
    }
  }
}

function getTagName(node: Node | null | undefined): string {
  if (!node || node.nodeType !== NodeType.ELEMENT_NODE) return '';
  return ((node as HTMLElement).rawTagName || (node as HTMLElement).tagName || '').toLowerCase();
}

export function isInsideNoscriptOrTemplate(el: HTMLElement | null | undefined): boolean {
  let curr: Node | null | undefined = el;
  while (curr) {
    const tag = getTagName(curr);
    if (tag === 'noscript' || tag === 'template' || tag === 'script' || tag === 'style') {
      return true;
    }
    curr = curr.parentNode;
  }
  return false;
}

export function isElementAriaHidden(el: HTMLElement | null | undefined): boolean {
  let curr: Node | null | undefined = el;
  while (curr) {
    if (curr.nodeType === NodeType.ELEMENT_NODE) {
      const elem = curr as HTMLElement;
      const ariaHidden = (elem.getAttribute('aria-hidden') || '').trim().toLowerCase();
      if (ariaHidden === 'true') return true;
    }
    curr = curr.parentNode;
  }
  return false;
}

function detectNearestLandmarkAr(
  el: HTMLElement
): 'الهيدر' | 'القايمة' | 'الفوتر' | 'المحتوى الرئيسي' {
  let curr: Node | null | undefined = el;
  let sawHeader = false;

  while (curr) {
    if (curr.nodeType === NodeType.ELEMENT_NODE) {
      const elem = curr as HTMLElement;
      const tag = getTagName(elem);
      const role = (elem.getAttribute('role') || '').toLowerCase();
      const clsId = `${elem.getAttribute('id') || ''} ${elem.getAttribute('class') || ''}`.toLowerCase();

      if (tag === 'head' || tag === 'meta' || tag === 'title' || tag === 'link') {
        return 'الهيدر';
      }
      if (
        tag === 'nav' ||
        role === 'navigation' ||
        /\b(nav|navbar|menu|main-menu|primary-menu|navigation)\b/.test(clsId)
      ) {
        return 'القايمة';
      }
      if (
        tag === 'footer' ||
        role === 'contentinfo' ||
        /\b(footer|site-footer|colophon|bottom-bar)\b/.test(clsId)
      ) {
        return 'الفوتر';
      }
      if (
        tag === 'header' ||
        role === 'banner' ||
        /\b(header|site-header|masthead|top-bar|topbar)\b/.test(clsId)
      ) {
        sawHeader = true;
      }
      if (tag === 'main' || role === 'main') {
        if (!sawHeader) return 'المحتوى الرئيسي';
      }
    }
    curr = curr.parentNode;
  }

  if (sawHeader) return 'الهيدر';
  return 'المحتوى الرئيسي';
}

function findNearestHeadingText(el: HTMLElement): string {
  const headingSelector = 'h1, h2, h3, h4, h5, h6';
  const tag = getTagName(el);
  if (/^h[1-6]$/.test(tag)) {
    return collapseWhitespace(el.text).slice(0, 60);
  }

  let curr: Node | null | undefined = el;
  while (curr && curr.nodeType === NodeType.ELEMENT_NODE) {
    const elem = curr as HTMLElement;
    const elemTag = getTagName(elem);
    if (elemTag === 'body' || elemTag === 'html' || elemTag === 'head') break;

    // 1. Check preceding siblings for a heading
    const parent = elem.parentNode as HTMLElement | null;
    if (parent && parent.childNodes) {
      const siblings = parent.childNodes.filter(
        n => n.nodeType === NodeType.ELEMENT_NODE
      ) as HTMLElement[];
      const idx = siblings.indexOf(elem);
      for (let i = idx - 1; i >= 0; i--) {
        const sib = siblings[i];
        const sibTag = getTagName(sib);
        if (/^h[1-6]$/.test(sibTag)) {
          const txt = collapseWhitespace(sib.text);
          if (txt) return txt.slice(0, 60);
        }
      }
    }

    // 2. If curr is a sectioning/grouping container, check the first heading inside it
    if (
      elemTag === 'section' ||
      elemTag === 'article' ||
      elemTag === 'aside' ||
      elemTag === 'footer' ||
      elemTag === 'header' ||
      elemTag === 'nav' ||
      elemTag === 'form' ||
      elemTag === 'div' ||
      elemTag === 'main'
    ) {
      const h = elem.querySelector(headingSelector);
      if (h) {
        const txt = collapseWhitespace(h.text);
        if (txt) return txt.slice(0, 60);
      }
    }

    curr = curr.parentNode;
  }

  return '';
}

function buildElementSelector(el: HTMLElement): string {
  const parts: string[] = [];
  let curr: Node | null | undefined = el;
  let depth = 0;

  while (curr && curr.nodeType === NodeType.ELEMENT_NODE && depth < 4) {
    const elem = curr as HTMLElement;
    const tag = getTagName(elem);
    if (!tag || tag === 'html' || tag === 'body') break;

    const id = (elem.getAttribute('id') || '').trim();
    if (id && /^[a-zA-Z0-9_-]+$/.test(id)) {
      parts.unshift(`${tag}#${id}`);
      break;
    }

    if (tag === 'meta') {
      const name = elem.getAttribute('name') || elem.getAttribute('property');
      if (name) {
        parts.unshift(`meta[name="${name}"]`);
        break;
      }
    }

    const rawClass = (elem.getAttribute('class') || '').trim();
    const classes = rawClass
      .split(/\s+/)
      .filter(c => c && /^[a-zA-Z0-9_-]+$/.test(c))
      .slice(0, 2);

    const seg = classes.length > 0 ? `${tag}.${classes.join('.')}` : tag;
    parts.unshift(seg);

    curr = elem.parentNode;
    depth++;
  }

  return parts.join(' > ') || getTagName(el) || 'element';
}

function stripNonVisibleSubtrees(rawHtml: string): string {
  return rawHtml
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function extractElementVisibleText(el: HTMLElement): string {
  const directText = collapseWhitespace(stripNonVisibleSubtrees(el.innerHTML || el.text || ''));
  if (directText) {
    return directText.slice(0, 120);
  }
  const fallbacks = [
    el.getAttribute('alt'),
    el.getAttribute('aria-label'),
    el.getAttribute('placeholder'),
    el.getAttribute('title'),
    el.getAttribute('value'),
    el.getAttribute('content'),
    el.getAttribute('name')
  ];
  for (const fb of fallbacks) {
    const clean = collapseWhitespace(fb);
    if (clean) return clean.slice(0, 120);
  }
  return '';
}

function buildCollapsedSnippet(el: HTMLElement): string {
  const raw = collapseWhitespace(
    el
      .toString()
      .replace(/<style\b[\s\S]*?<\/style>/gi, '')
      .replace(/<script\b[\s\S]*?<\/script>/gi, '')
  );
  if (raw.length <= 200) return raw;
  return `${raw.slice(0, 197)}...`;
}

export function locateElement(
  el: HTMLElement | null | undefined,
  pageUrl: string = ''
): FindingWhere {
  if (!el) {
    return {
      pageUrl,
      sectionAr: 'المحتوى الرئيسي',
      visibleText: '',
      selector: 'document',
      snippet: ''
    };
  }

  const landmarkAr = detectNearestLandmarkAr(el);
  const headingText = findNearestHeadingText(el);
  const sectionAr = headingText
    ? `${landmarkAr}، قسم «${headingText}»`
    : landmarkAr;

  return {
    pageUrl,
    sectionAr,
    visibleText: extractElementVisibleText(el),
    selector: buildElementSelector(el),
    snippet: buildCollapsedSnippet(el)
  };
}

export function isSharedTemplateSectionAr(sectionAr: string | undefined): boolean {
  if (!sectionAr) return false;
  return (
    sectionAr.startsWith('الهيدر') ||
    sectionAr.startsWith('القايمة') ||
    sectionAr.startsWith('الفوتر')
  );
}

export function parsePageHtml(html: string, pageUrl: string): ParsedPageDom {
  const root = parse(html || '', {
    lowerCaseTagName: false,
    comment: false
  });

  const titleEl = root.querySelector('title');
  const h1El = root.querySelector('h1');
  const defaultTitle =
    collapseWhitespace(titleEl?.text) ||
    collapseWhitespace(h1El?.text) ||
    decodeUrlForDisplay(pageUrl);

  return {
    root,
    pageUrl,
    locate: (el: HTMLElement | null | undefined) => locateElement(el, pageUrl),
    defaultWhere: (label?: string, snippetOverride?: string): FindingWhere => ({
      pageUrl,
      sectionAr: 'المحتوى الرئيسي',
      visibleText: collapseWhitespace(label || defaultTitle).slice(0, 120),
      selector: 'document',
      snippet: collapseWhitespace(snippetOverride || `<title>${defaultTitle}</title>`).slice(0, 200)
    })
  };
}
