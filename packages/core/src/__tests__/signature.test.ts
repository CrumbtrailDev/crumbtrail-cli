import { describe, it, expect, beforeEach } from 'vitest';
import { computeElementSignature, computeElementPath, hashString } from '../signature';

describe('signature', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('hashString is deterministic and stable', () => {
    expect(hashString('button:nth-of-type(1)')).toBe(hashString('button:nth-of-type(1)'));
    expect(hashString('a')).not.toBe(hashString('b'));
  });

  it('hashString matches pinned FNV-1a outputs (guards against algorithm regression)', () => {
    // Pre-computed FNV-1a 32-bit, base36. A swap to FNV-1 or a constant change breaks these.
    expect(hashString('button:nth-of-type(1)')).toBe('1wfs6e6');
    expect(hashString('button[data-bug-id=save]')).toBe('1t0r0qk');
  });

  it('same element yields the same signature across calls', () => {
    document.body.innerHTML = '<div><button>Save</button></div>';
    const el = document.querySelector('button')!;
    expect(computeElementSignature(el).sig).toBe(computeElementSignature(el).sig);
  });

  it('distinct sibling buttons get distinct signatures', () => {
    document.body.innerHTML = '<div><button>A</button><button>B</button></div>';
    const [a, b] = Array.from(document.querySelectorAll('button'));
    expect(computeElementSignature(a).sig).not.toBe(computeElementSignature(b).sig);
  });

  it('prefers a stable id attribute and stops the path there', () => {
    document.body.innerHTML = '<main><section><button data-bug-id="save-btn">Save</button></section></main>';
    const el = document.querySelector('button')!;
    const { path } = computeElementSignature(el);
    expect(path).toBe('button[data-bug-id="save-btn"]');
  });

  it('quotes the value so a real test id is a legal selector', () => {
    // Bare values are legal CSS only when they happen to be identifiers.
    // querySelectorAll throws on every one of these unquoted.
    for (const id of ['cart/item', 'checkout.pay', '2fa-submit']) {
      document.body.innerHTML = `<button data-testid="${id}">go</button>`;
      const el = document.querySelector('button')!;
      const { path } = computeElementSignature(el);
      expect(path).toBe(`button[data-testid="${id}"]`);
      expect(document.querySelectorAll(path)).toHaveLength(1);
    }
  });

  it('escapes a value carrying a quote or a backslash', () => {
    document.body.innerHTML = '<button id=\'say"hi\'>go</button>';
    const el = document.querySelector('button')!;
    expect(computeElementPath(el)).toBe('button[id="say\\"hi"]');
  });

  it('disambiguates same-tag siblings by nth-of-type', () => {
    document.body.innerHTML = '<ul><li>1</li><li>2</li><li>3</li></ul>';
    const third = document.querySelectorAll('li')[2];
    expect(computeElementPath(third)).toContain('li:nth-of-type(3)');
  });

  it('does not throw on a detached element', () => {
    const orphan = document.createElement('button');
    expect(() => computeElementSignature(orphan)).not.toThrow();
  });
});

import { describeElement } from '../utils';

describe('describeElement signature integration', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('attaches sig and path to the descriptor', () => {
    document.body.innerHTML = '<button data-bug-id="save">Save</button>';
    const desc = describeElement(document.querySelector('button')!);
    expect(desc.sig).toBeTypeOf('string');
    expect(desc.path).toBe('button[data-bug-id="save"]');
  });
});
