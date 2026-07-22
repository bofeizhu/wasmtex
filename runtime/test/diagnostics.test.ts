// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source.
//
// Unit tests for the pure §5.1 diagnostics parser (M1 item 8). Two layers:
//   (1) FIXTURE CORPUS — every transcript under fixtures/diagnostics/ (captured
//       verbatim from the pinned TL2023 engine, see GENERATOR.md) parsed to its
//       EXACT Diagnostic[] (not just counts), so extraction is proven against
//       real engine output, not folklore (M1 rebase-proofing rule 2).
//   (2) HOSTILE / PATHOLOGICAL INPUTS — 10 MB single line, deeply nested and
//       unbalanced parens, CRLF, empty/non-string — asserting the parser is
//       TOTAL (never throws), bounded (dedup + cap), and fast.
// No wasm, no worker: parseDiagnostics is a pure string→array function.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAX_DIAGNOSTICS, MAX_MESSAGE_LENGTH, parseDiagnostics } from '../src/diagnostics';
import type { Diagnostic } from '../src/protocol';

const fixturesDir = fileURLToPath(new URL('./fixtures/diagnostics/', import.meta.url));

/** Read a fixture, stripping the leading `# generator:` note line(s); the rest is verbatim. */
function readFixture(name: string): string {
  const raw = readFileSync(fixturesDir + name, 'utf8');
  const lines = raw.split('\n');
  let i = 0;
  while (i < lines.length && lines[i]!.startsWith('# ')) i += 1;
  return lines.slice(i).join('\n');
}

// ---------------------------------------------------------------------------
// (1) Fixture corpus — exact expected Diagnostic[] per real transcript
// ---------------------------------------------------------------------------

const UNDEFINED_CS: Diagnostic[] = [
  { severity: 'error', message: 'Undefined control sequence.', file: 'main.tex', line: 4 },
];

const cases: ReadonlyArray<readonly [string, Diagnostic[]]> = [
  // Undefined control sequence — identical on both engines. The pdfTeX variant
  // additionally emits `! ==> Fatal error occurred …`, which must be EXCLUDED so
  // the two engines agree bit-for-bit on the diagnostic.
  ['undefined-control-sequence.xetex.txt', UNDEFINED_CS],
  ['undefined-control-sequence.pdftex.txt', UNDEFINED_CS],

  // File-not-found (missing \input): an ordinary `! ` error whose message keeps
  // the filename verbatim (M4 extracts it later); `! Emergency stop.` excluded.
  [
    'missing-input-file.txt',
    [
      {
        severity: 'error',
        message: "LaTeX Error: File `nosuchinputfile.tex' not found.",
        file: 'main.tex',
        line: 4,
      },
    ],
  ],

  // File-not-found (missing \usepackage) — both engines. Line 3 is where TeX
  // reports the location (after the excluded Emergency stop).
  [
    'missing-package.txt',
    [
      {
        severity: 'error',
        message: "LaTeX Error: File `nosuchpackagexyz.sty' not found.",
        file: 'main.tex',
        line: 3,
      },
    ],
  ],
  [
    'missing-package.pdftex.txt',
    [
      {
        severity: 'error',
        message: "LaTeX Error: File `nosuchpackagexyz.sty' not found.",
        file: 'main.tex',
        line: 3,
      },
    ],
  ],

  // Undefined references — the doc reruns to the 5-pass cap, so each warning is
  // printed 5×; global dedup collapses them to three. "There were undefined
  // references." carries no `on input line` and so has no line.
  [
    'undefined-references.txt',
    [
      {
        severity: 'warning',
        message: "LaTeX Warning: Reference `nosuchlabel' on page 1 undefined on input line 3.",
        file: 'main.tex',
        line: 3,
      },
      {
        severity: 'warning',
        message: "LaTeX Warning: Citation `nosuchcite' on page 1 undefined on input line 3.",
        file: 'main.tex',
        line: 3,
      },
      { severity: 'warning', message: 'LaTeX Warning: There were undefined references.', file: 'main.tex' },
    ],
  ],

  // THE subfile case: the error is inside \input{chapters/broken}, so the paren
  // stack attributes it to the SUBFILE, not the root — what naive parsers miss.
  [
    'error-in-subfile.txt',
    [{ severity: 'error', message: 'Undefined control sequence.', file: 'chapters/broken.tex', line: 4 }],
  ],

  // Package/Class warnings: the `(name)` continuation line is folded into the
  // message, and the warning is attributed to the .sty/.cls being read (its own
  // input line), demonstrating stack attribution for warnings too.
  [
    'package-warning.txt',
    [
      {
        severity: 'warning',
        message:
          'Package localpkg Warning: This package is deliberately noisy and warns across two lines on input line 3.',
        file: 'localpkg.sty',
        line: 3,
      },
    ],
  ],
  [
    'class-warning.txt',
    [
      {
        severity: 'warning',
        message: 'Class localcls Warning: This class is deliberately noisy on two lines on input line 4.',
        file: 'localcls.cls',
        line: 4,
      },
    ],
  ],

  // A document missing \end{document}: the ONLY `! ` line is `! Emergency stop.`
  // with no preceding root-cause error, so the terminator is PROMOTED to an error
  // (a failed compile must never yield an empty diagnostics array). The stack is
  // already empty (main.tex closed at EOF), hence no file/line.
  ['no-end-document.txt', [{ severity: 'error', message: 'Emergency stop.' }]],

  // Clean compile — zero diagnostics.
  ['clean.txt', []],

  // Overfull box — EXCLUDED by default (fixture proves it): zero diagnostics.
  ['overfull-box.txt', []],
];

describe('parseDiagnostics — real transcript fixtures (exact Diagnostic[])', () => {
  it.each(cases)('extracts the exact diagnostics from %s', (name, expected) => {
    const actual = parseDiagnostics(readFixture(name));
    expect(actual).toEqual(expected);
  });

  it('the subfile error is attributed to the subfile with a concrete line (the case naive parsers miss)', () => {
    const [diag, ...rest] = parseDiagnostics(readFixture('error-in-subfile.txt'));
    expect(rest).toHaveLength(0);
    expect(diag).toBeDefined();
    expect(diag!.severity).toBe('error');
    expect(diag!.file).toBe('chapters/broken.tex'); // NOT main.tex
    expect(diag!.line).toBe(4);
  });

  it('overfull/underfull boxes are excluded (no diagnostics for a box-only document)', () => {
    const text = readFixture('overfull-box.txt');
    expect(text).toContain('Overfull \\hbox'); // the fixture really does contain the box message
    expect(parseDiagnostics(text)).toEqual([]);
  });

  it('the missing-package message keeps the filename verbatim for M4 bundle resolution', () => {
    const [diag] = parseDiagnostics(readFixture('missing-package.txt'));
    expect(diag?.message).toContain("nosuchpackagexyz.sty"); // extractable filename, no new structured field
  });
});

// ---------------------------------------------------------------------------
// (2) Extraction rules in isolation (small synthetic strings)
// ---------------------------------------------------------------------------

describe('parseDiagnostics — extraction rules', () => {
  it('deduplicates identical diagnostics globally, not just consecutively', () => {
    const log = ['! Alpha.', 'l.1 x', '! Beta.', 'l.2 x', '! Alpha.', 'l.1 x'].join('\n');
    expect(parseDiagnostics(log)).toEqual([
      { severity: 'error', message: 'Alpha.', line: 1 },
      { severity: 'error', message: 'Beta.', line: 2 },
    ]);
  });

  it('drops a terminator that FOLLOWS a real error (it is that error’s consequence)', () => {
    const log = ['! Undefined control sequence.', 'l.9 x', '!  ==> Fatal error occurred, no output PDF file produced!'].join(
      '\n',
    );
    expect(parseDiagnostics(log)).toEqual([{ severity: 'error', message: 'Undefined control sequence.', line: 9 }]);
  });

  it('PROMOTES a standalone terminator to an error (a failed compile is never silent)', () => {
    // No `! …` root-cause precedes it → Emergency stop IS the failure signal.
    expect(parseDiagnostics('(./main.tex\n! Emergency stop.\n<*> main.tex')).toEqual([
      { severity: 'error', message: 'Emergency stop.', file: 'main.tex' },
    ]);
    // A promoted terminator still absorbs a following l.<n> and its stacked file.
    expect(parseDiagnostics('(./a.tex\n! Emergency stop.\nl.42 \\x')).toEqual([
      { severity: 'error', message: 'Emergency stop.', file: 'a.tex', line: 42 },
    ]);
  });

  it('the engine-level "I can\'t find file" form is a plain error with the filename in the message', () => {
    // The LaTeX pipeline wraps missing files as `! LaTeX Error: File … not found`
    // (see fixtures); the raw engine phrasing is handled by the same `! ` rule.
    const log = ["! I can't find file `missing.tex'.", 'l.7 \\input missing'].join('\n');
    expect(parseDiagnostics(log)).toEqual([
      { severity: 'error', message: "I can't find file `missing.tex'.", line: 7 },
    ]);
  });

  it('folds an indented LaTeX-warning continuation into one message', () => {
    const log = ['LaTeX Warning: A long warning that wraps', '                onto a second line on input line 12.', ''].join(
      '\n',
    );
    expect(parseDiagnostics(log)).toEqual([
      {
        severity: 'warning',
        message: 'LaTeX Warning: A long warning that wraps onto a second line on input line 12.',
        line: 12,
      },
    ]);
  });

  it('does not swallow an indented stack-close ")" line into a source-less warning message', () => {
    // A `)` on its own indented line (no blank separator) closes a file; it must
    // NOT be folded into the LaTeX warning, and the stack must still pop.
    const log = ['(./main.tex (./sub.sty', 'LaTeX Warning: A warning on input line 5.', '  )', '! Boom.', 'l.7 x'].join(
      '\n',
    );
    expect(parseDiagnostics(log)).toEqual([
      { severity: 'warning', message: 'LaTeX Warning: A warning on input line 5.', file: 'sub.sty', line: 5 },
      // sub.sty closed by the indented `)` → the error recovers main.tex.
      { severity: 'error', message: 'Boom.', file: 'main.tex', line: 7 },
    ]);
  });

  it('takes the innermost open file across nested opens/closes that share a line', () => {
    const log = ['(./main.tex (./a.sty (./b.sty', '! Undefined control sequence.', 'l.3 \\boom'].join('\n');
    const [diag] = parseDiagnostics(log);
    expect(diag?.file).toBe('b.sty'); // deepest still-open file
  });

  it('recovers the outer file after an inner file closes on a shared line', () => {
    const log = ['(./main.tex (./a.sty))', '(./main.tex', '! Undefined control sequence.', 'l.3 \\boom'].join('\n');
    // a.sty and the first main.tex both closed by `))`; the second (./main.tex is open.
    const [diag] = parseDiagnostics(log);
    expect(diag?.file).toBe('main.tex');
  });

  it('attributes to no file when the stack is empty at the error', () => {
    const log = ['! Undefined control sequence.', 'l.1 \\boom'].join('\n');
    expect(parseDiagnostics(log)).toEqual([{ severity: 'error', message: 'Undefined control sequence.', line: 1 }]);
  });

  it('does not treat prose parentheses as file opens', () => {
    // `(preloaded …)`, `(1 page…)` — none look like filenames, so the real file wins.
    const log = ['(./main.tex', 'Output (1 page, 796 bytes) and (preloaded stuff)', '! Boom.', 'l.2 x'].join('\n');
    expect(parseDiagnostics(log)?.[0]?.file).toBe('main.tex');
  });

  it('does NOT extract file:line-error mode lines (our pipeline never emits them — documented limitation)', () => {
    // `-file-line-error` would print `./file.tex:12: <msg>`; the worker runs
    // nonstopmode WITHOUT it, so such a line is not a diagnostic here.
    const log = './main.tex:12: Undefined control sequence.';
    expect(parseDiagnostics(log)).toEqual([]);
  });

  it('a path wrapped at TeX’s column limit self-heals the stack; only the wrapped file shows a truncated name', () => {
    // TeX broke `(/texmf/.../averylongp|ackagename.sty` across a 79-col boundary.
    // Current documented behavior: the pre-wrap prefix is what attributes while
    // that file is innermost open; the trailing `)` still balances the stack, so
    // a later error recovers the correct (short) file.
    const log = [
      '(./main.tex (/texmf/tex/latex/averylongpackagepath/averylongp',
      'ackagename.sty',
      '! Undefined control sequence.',
      'l.5 \\boom',
      ') ', // the wrapped .sty closes here → stack self-heals to main.tex
      '! Missing $ inserted.',
      'l.9 \\oops',
    ].join('\n');
    const out = parseDiagnostics(log);
    expect(out).toHaveLength(2);
    // (1) inside the wrapped file: attribution is the PRE-WRAP prefix (truncated).
    expect(out[0]).toEqual({
      severity: 'error',
      message: 'Undefined control sequence.',
      file: '/texmf/tex/latex/averylongpackagepath/averylongp',
      line: 5,
    });
    // (2) after it closes: the stack recovered — the outer file is correct.
    expect(out[1]).toEqual({ severity: 'error', message: 'Missing $ inserted.', file: 'main.tex', line: 9 });
  });
});

// ---------------------------------------------------------------------------
// (3) Hostile / pathological inputs — total, bounded, fast
// ---------------------------------------------------------------------------

describe('parseDiagnostics — hostile inputs (never throws, bounded output)', () => {
  it('empty string and non-string inputs return []', () => {
    expect(parseDiagnostics('')).toEqual([]);
    expect(parseDiagnostics(null as unknown as string)).toEqual([]);
    expect(parseDiagnostics(undefined as unknown as string)).toEqual([]);
    expect(parseDiagnostics(42 as unknown as string)).toEqual([]);
  });

  it('a 10 MB single line does not throw and truncates the message to a bound', () => {
    const started = Date.now();
    const line = '!' + 'x'.repeat(10_000_000);
    const out = parseDiagnostics(line);
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe('error');
    expect(out[0]!.message.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH + 1); // + the ellipsis
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('a 10 MB single non-marker line yields no diagnostics and does not throw', () => {
    expect(parseDiagnostics('a'.repeat(10_000_000))).toEqual([]);
  });

  it('deeply nested parentheses do not throw or exhaust memory', () => {
    const log = '('.repeat(500_000) + '\n! Boom.\nl.1 x';
    const out = parseDiagnostics(log);
    expect(out).toHaveLength(1);
    expect(out[0]!.message).toBe('Boom.');
  });

  it('unbalanced closing parentheses do not throw (stack clamps at empty)', () => {
    const log = ')'.repeat(500_000) + '\n(./main.tex\n! Boom.\nl.1 x';
    expect(parseDiagnostics(log)).toEqual([{ severity: 'error', message: 'Boom.', file: 'main.tex', line: 1 }]);
  });

  it('unbalanced opening parentheses leave the parser total (attribution degrades, no crash)', () => {
    const log = '(./a.sty (./b.sty (./c.sty\n! Boom.\nl.1 x';
    const [diag] = parseDiagnostics(log);
    expect(diag?.severity).toBe('error');
    expect(diag?.file).toBe('c.sty'); // innermost of the never-closed opens
  });

  it('CRLF line endings parse identically to LF', () => {
    const lf = readFixture('undefined-control-sequence.xetex.txt');
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(parseDiagnostics(crlf)).toEqual(parseDiagnostics(lf));
    expect(parseDiagnostics(crlf)).toEqual(UNDEFINED_CS);
  });

  it('lone CR line endings parse identically to LF', () => {
    const lf = readFixture('undefined-control-sequence.xetex.txt');
    const cr = lf.replace(/\n/g, '\r');
    expect(parseDiagnostics(cr)).toEqual(UNDEFINED_CS);
  });

  it('caps the diagnostics array at MAX_DIAGNOSTICS', () => {
    const parts: string[] = [];
    for (let i = 0; i < 400; i += 1) parts.push(`! Distinct error number ${i}.`, `l.${i} x`);
    const out = parseDiagnostics(parts.join('\n'));
    expect(out).toHaveLength(MAX_DIAGNOSTICS);
    expect(MAX_DIAGNOSTICS).toBe(100);
    // The first 100 distinct errors, in order.
    expect(out[0]).toEqual({ severity: 'error', message: 'Distinct error number 0.', line: 0 });
    expect(out[99]).toEqual({ severity: 'error', message: 'Distinct error number 99.', line: 99 });
  });

  it('a pathological alternation of opens and warnings stays bounded and fast', () => {
    const started = Date.now();
    const parts: string[] = [];
    for (let i = 0; i < 100_000; i += 1) parts.push('(./f.sty', 'LaTeX Warning: Repeated warning on input line 1.', '');
    const out = parseDiagnostics(parts.join('\n'));
    // All identical → dedup to one.
    expect(out).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
