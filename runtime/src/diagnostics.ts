// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   The log-parsing rules below were derived from (a) the DESIGN.md §5.1
//   Diagnostic shape and (b) DIRECT OBSERVATION of the pinned engines' real
//   transcripts (the fixtures under test/fixtures/diagnostics/, captured from
//   dist/'s busytex wasm). NO third-party TeX-log parser — MIT, GPL, or
//   otherwise — was read, copied, or adapted; the extraction strategy
//   (parenthesis file-tracking + `! ` error lines + `LaTeX/Package/Class
//   Warning:` families) is common TeX-output folklore reconstructed here from
//   first principles against those captures. Not derived from any GPL/AGPL
//   source (DESIGN.md §2).
//
// ---------------------------------------------------------------------------
// The diagnostics parser (M1 item 8). A PURE, zero-dependency, browser-safe
// function: `parseDiagnostics(log)` turns a raw engine transcript into the
// structured `Diagnostic[]` the §5.1 result carries, so hosts (and the LLM
// agents that drive them, §10) never regex transcripts themselves.
//
// It lives in `src/` and is imported ONLY by the main-thread client
// (`client.ts`, `assembleResult`) — never by `worker/`. Diagnostics are
// derived client-side from the raw `log` on the wire, so a TeX-Live rebase that
// changes transcript wording touches only this file and its fixtures, never the
// worker bundle or the protocol (M1 rebase-proofing rule 2; DESIGN.md §5.1
// keeps `Diagnostic` off `ResultMessage` for exactly this reason).
//
// WHAT IT EXTRACTS (each rule grounded in a real fixture):
//   * TeX errors — any `! <message>` line becomes a `severity:'error'`
//     diagnostic (message = the text after `! `). The `File `x' not found`
//     forms (missing \usepackage / \input) are ordinary `! ` errors whose
//     message carries the filename verbatim, so M4's bundle resolution can
//     extract it later without a new structured field. TeX *terminator* notices
//     — `! Emergency stop.` and `! ==> Fatal error occurred …` — are dropped
//     ONLY when a real error already precedes them in the same failure (pending
//     or emitted): they are that error's consequence, and pdfTeX prints one
//     where XeTeX does not, so dropping keeps the two engines' output identical
//     for the same fault. A *standalone* terminator with no preceding error
//     (e.g. a document missing \end{document}, whose only `! ` line is
//     `! Emergency stop.`) is instead PROMOTED to an error, so a failed compile
//     never returns an empty diagnostics array (§5.2, §10).
//   * Error line numbers — the first `l.<n>` context line after the error
//     (TeX's location report), skipping the interposed terminator notice so a
//     File-not-found error still gets its `l.<n>`.
//   * LaTeX / Package / Class warnings — `LaTeX Warning:`, `Package <n>
//     Warning:`, `Class <n> Warning:`; `on input line <n>` → line;
//     multi-line continuations (`(<name>)`-prefixed, or indented for LaTeX
//     warnings) folded into one message.
//   * File attribution — a parenthesis stack mirrors TeX's `(file … )`
//     open/close nesting; a diagnostic's `file` is the innermost open file
//     when it printed. This is what points an error inside an \input'd subfile
//     at the SUBFILE (fixture error-in-subfile) rather than the root — the
//     case naive line-scanners get wrong.
//
// WHAT IT EXCLUDES (by design, per the M1 plan): Overfull/Underfull \hbox/\vbox
// messages (fixture overfull-box proves zero diagnostics). Font substitution
// warnings (`LaTeX Font Warning:`) are also not extracted — only the three
// warning families above are.
//
// KNOWN LIMITATIONS (each deliberate, and pinned by a test):
//   * file:line-error mode. The worker drives the engines in
//     `--interaction=nonstopmode` WITHOUT `-file-line-error` (worker/core.ts),
//     so errors print in the classic `! <message>` + `l.<n>` two-line form —
//     never the `./file.tex:12: <message>` one-line form. Our real transcripts
//     confirm this, so the file:line form is intentionally NOT parsed; if a
//     future engine invocation turned that mode on, those lines would go
//     unextracted until a rule + fixture were added (M1 rebase-proofing 2).
//   * 79/80-column path wraps. TeX breaks its terminal output at
//     `max_print_line` (~79 cols), so a very long `(/…/pkg.sty` path can wrap
//     mid-token onto the next line. The stack tracker does NOT rejoin the two
//     halves: it pushes the pre-wrap prefix and the trailing `)` still pops it,
//     so nesting stays BALANCED and self-heals on close — only a diagnostic
//     emitted while that one wrapped file is the innermost open would show the
//     truncated path. No real fixture wraps (the pinned bundle's paths are
//     short); the `diagnostics.test.ts` "path wrapped at TeX's column limit"
//     case pins this current behavior.
//
// ROBUSTNESS: the function is TOTAL — it never throws and its output is bounded
// (deduplicated, capped at {@link MAX_DIAGNOSTICS}), so a pathological or
// hostile transcript (a 10 MB single line, deeply nested or unbalanced parens,
// CRLF endings) degrades attribution but cannot crash a host or exhaust memory.
//
// This module ALSO exports {@link extractMissingFiles} — a structured extractor
// for the filenames a compile reported as MISSING (the "File `x' not found" /
// "I can't find file `x'" forms). It drives the §5.4(b) on-demand missing-file
// retry (worker/core.ts), so the "which files did kpathsea fail to find" rule
// lives HERE with the rest of the transcript-wording knowledge rather than being
// re-derived in the worker — a rebase that reworded it touches only this file.
// ---------------------------------------------------------------------------

import type { Diagnostic } from './protocol';

/**
 * Hard cap on the number of diagnostics returned (DESIGN.md §5.1). A
 * pathological transcript cannot make the result unbounded: once this many
 * DISTINCT diagnostics are collected, parsing stops. 100 is comfortably above
 * any real compile's error/warning count while staying small enough to surface
 * whole in a host UI or an agent prompt.
 */
export const MAX_DIAGNOSTICS = 100;

/**
 * Longest a single diagnostic `message` may be. A hostile 10 MB `! …` line
 * would otherwise become a 10 MB message; we truncate (with an ellipsis) so the
 * output stays bounded. Real TeX messages are well under this.
 */
export const MAX_MESSAGE_LENGTH = 2000;

/**
 * Deepest the parenthesis file-stack may grow. Real nesting is a handful of
 * levels; this only bounds memory against a hostile line of unbalanced `(`.
 * Past it, further opens are dropped (attribution degrades; nothing crashes).
 */
const MAX_STACK_DEPTH = 4096;

/** Most continuation lines folded into one warning (bounds runaway folding). */
const MAX_WARNING_CONTINUATION_LINES = 16;

/** A file-stack entry: an open file's name, or `null` for a non-file `( … )`. */
type StackEntry = string | null;

/** A TeX error awaiting its `l.<n>` location (mutable; `undefined` = not yet seen). */
interface PendingError {
  message: string;
  file: string | undefined;
  line: number | undefined;
}

/** A warning being assembled across its (possibly multi-line) body. */
interface PendingWarning {
  /** The message fragments, in order — joined with single spaces on finalize. */
  readonly parts: string[];
  /** The package/class name for `(<name>)` continuation matching, or `null` for a `LaTeX Warning:`. */
  readonly source: string | null;
  /** The innermost open file when the warning started. */
  readonly file: string | undefined;
}

/** Drop a leading `./` so a stacked `./main.tex` reports as the project path `main.tex`. */
function stripDotSlash(path: string): string {
  return path.startsWith('./') ? path.slice(2) : path;
}

/**
 * Does the token right after a `(` look like a filename (vs. prose like
 * `(preloaded …`, `(TeX Live …`, `(1 page …`)? A path separator or a short
 * dotted extension (`.tex`, `.cls`, `.fd`, …) is the signal. Prose tokens are
 * pushed as `null` so the stack stays BALANCED without polluting attribution.
 */
function looksLikeFilename(token: string): boolean {
  if (token.length === 0 || token.length > 1024) return false;
  if (token.includes('/')) return true;
  return /\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(token);
}

/**
 * Is this the trimmed message of a pure TeX *terminator* notice (not a
 * root-cause error)? `! Emergency stop.` and `! ==> Fatal error occurred …`
 * are the two the pinned engines emit (fixtures missing-package /
 * missing-package.pdftex / undefined-control-sequence.pdftex).
 */
function isTerminatorMessage(message: string): boolean {
  return /^Emergency stop\b/.test(message) || message.includes('Fatal error occurred');
}

/** Classify a warning-start line into its family + source name (or `null` if not one). */
function matchWarningStart(line: string): { readonly source: string | null } | null {
  if (line.startsWith('LaTeX Warning:')) return { source: null };
  const pkg = /^Package (\S{1,128}) Warning:/.exec(line);
  if (pkg) return { source: pkg[1] ?? null };
  const cls = /^Class (\S{1,128}) Warning:/.exec(line);
  if (cls) return { source: cls[1] ?? null };
  return null;
}

/**
 * If `line` continues the current warning, return its folded text; else `null`.
 * Package/Class continuations are `(<source>)`-prefixed (LaTeX's `\MessageBreak`
 * form, fixtures package-warning / class-warning); a `LaTeX Warning:` (no
 * source) continues on any indented non-blank line.
 */
function continuationText(line: string, source: string | null): string | null {
  if (source !== null) {
    const prefix = `(${source})`;
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
    return null;
  }
  // A source-less LaTeX warning wraps onto an indented line. Require the line to
  // carry real text (not just stray parens/whitespace) so an indented stack-close
  // `)` line is NOT swallowed into the message — in real transcripts a blank line
  // always separates a warning from a following `)`, but a hostile log might not.
  // (The paren stack is updated for the line regardless, so nesting stays correct.)
  if (/^\s/.test(line) && /[^()\s]/.test(line)) return line.trim();
  return null;
}

/** The last `on input line <n>` in a (folded) message — TeX's location, if any. */
function lastInputLine(message: string): number | undefined {
  const re = /on input line (\d+)/g;
  let match: RegExpExecArray | null;
  let last: number | undefined;
  while ((match = re.exec(message)) !== null) {
    const n = Number(match[1]);
    if (Number.isFinite(n)) last = n;
  }
  return last;
}

/**
 * Parse a raw engine transcript into structured {@link Diagnostic}s
 * (DESIGN.md §5.1). Pure and total: it allocates no I/O, never throws, and
 * returns a deduplicated, {@link MAX_DIAGNOSTICS}-capped array. Order is the
 * order each distinct diagnostic first appears in the log.
 *
 * Deduplication is by the full `(severity, message, file, line)` tuple and is
 * GLOBAL, not merely consecutive: a multi-pass compile reprints the same
 * warnings every pass (an unresolved `\ref` reruns to the pass cap — fixture
 * undefined-references has five identical passes), so consecutive-only dedup
 * would leak the repeats. Keeping the first occurrence subsumes the
 * consecutive case and collapses the cross-pass repeats a host would not want.
 */
export function parseDiagnostics(log: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (typeof log !== 'string' || log.length === 0) return out;

  // Split on CRLF, lone CR, or LF so Windows/classic-Mac transcripts parse the
  // same as Unix ones (hostile-input contract).
  const lines = log.split(/\r\n|\r|\n/);

  const stack: StackEntry[] = [];
  const seen = new Set<string>();
  let pendingError: PendingError | null = null;
  let pendingWarning: PendingWarning | null = null;
  let continuationCount = 0;
  // Has any error been finalized? Gates terminator handling: a terminator after a
  // real error is that error's consequence (drop); a standalone one is promoted.
  let hasEmittedError = false;

  /** Innermost open file (top-most non-`null` stack entry), project-relative. */
  const currentFile = (): string | undefined => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const entry = stack[i];
      if (entry != null) return stripDotSlash(entry);
    }
    return undefined;
  };

  /** Update the parenthesis file-stack from one line's `(`/`)` runs. */
  const updateStack = (line: string): void => {
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '(') {
        let j = i + 1;
        while (j < line.length) {
          const d = line[j];
          if (d === ' ' || d === '\t' || d === '(' || d === ')') break;
          j++;
        }
        const token = line.slice(i + 1, j);
        if (stack.length < MAX_STACK_DEPTH) stack.push(looksLikeFilename(token) ? token : null);
        i = j - 1; // resume after the token (the loop's ++ steps onto line[j])
      } else if (c === ')') {
        if (stack.length > 0) stack.pop();
      }
    }
  };

  /** Push a diagnostic (dedup + message-length + cap guards). Returns false at the cap. */
  const emit = (diag: Diagnostic): boolean => {
    if (out.length >= MAX_DIAGNOSTICS) return false;
    const message =
      diag.message.length > MAX_MESSAGE_LENGTH ? `${diag.message.slice(0, MAX_MESSAGE_LENGTH)}…` : diag.message;
    const key = JSON.stringify([diag.severity, message, diag.file ?? null, diag.line ?? null]);
    if (seen.has(key)) return true;
    seen.add(key);
    out.push(message === diag.message ? diag : { ...diag, message });
    return true;
  };

  const flushError = (): void => {
    if (!pendingError) return;
    const p = pendingError;
    pendingError = null;
    hasEmittedError = true; // a real error was finalized (even if dedup drops the copy)
    emit({
      severity: 'error',
      message: p.message,
      ...(p.file !== undefined ? { file: p.file } : {}),
      ...(p.line !== undefined ? { line: p.line } : {}),
    });
  };

  const flushWarning = (): void => {
    if (!pendingWarning) return;
    const p = pendingWarning;
    pendingWarning = null;
    const message = p.parts.join(' ').replace(/\s+/g, ' ').trim();
    const line = lastInputLine(message);
    emit({
      severity: 'warning',
      message,
      ...(p.file !== undefined ? { file: p.file } : {}),
      ...(line !== undefined ? { line } : {}),
    });
  };

  try {
    for (const line of lines) {
      if (out.length >= MAX_DIAGNOSTICS) break;

      // (1) Continuation of an in-progress warning.
      if (pendingWarning) {
        if (line.trim().length === 0) {
          flushWarning(); // a blank line ends the warning body
        } else {
          const cont = continuationText(line, pendingWarning.source);
          if (cont !== null && continuationCount < MAX_WARNING_CONTINUATION_LINES) {
            pendingWarning.parts.push(cont);
            continuationCount += 1;
            updateStack(line);
            continue;
          }
          flushWarning(); // not a continuation → finalize, then process this line below
        }
      }

      // (2) Error line `! <message>`.
      if (line.startsWith('!')) {
        const message = line.slice(1).trim();
        if (message.length > 0) {
          if (isTerminatorMessage(message)) {
            // A terminator (Emergency stop / ==> Fatal error) is normally the
            // CONSEQUENCE of a real error: if one is pending, keep it alive so its
            // `l.<n>` — printed AFTER the terminator, e.g. File-not-found — still
            // attaches; if one was already emitted, just drop the terminator. But
            // a STANDALONE terminator (no error pending or emitted, e.g. a document
            // missing \end{document} whose only `! ` line is `! Emergency stop.`)
            // is the primary failure signal — PROMOTE it to a pending error (which
            // then absorbs any following `l.<n>` and its stacked file) so a failed
            // compile is never silent (§5.2).
            if (!pendingError && !hasEmittedError) {
              pendingError = { message, file: currentFile(), line: undefined };
            }
            updateStack(line);
            continue;
          }
          flushError(); // a genuinely new error — emit the previous one first
          pendingError = { message, file: currentFile(), line: undefined };
          updateStack(line);
          continue;
        }
        // a lone `!` — fall through and treat as ordinary text
      }

      // (3) `l.<n>` location line — completes the pending error.
      if (pendingError && pendingError.line === undefined && line.startsWith('l.')) {
        const m = /^l\.(\d+)/.exec(line);
        if (m) {
          pendingError.line = Number(m[1]);
          flushError();
          updateStack(line);
          continue;
        }
      }

      // (4) Warning start (`LaTeX` / `Package <n>` / `Class <n>` Warning:).
      const warn = matchWarningStart(line);
      if (warn) {
        flushError(); // keep emission order: a preceding error comes out first
        continuationCount = 0;
        pendingWarning = { parts: [line.replace(/\s+$/, '')], source: warn.source, file: currentFile() };
        updateStack(line);
        continue;
      }

      // (5) Any other line — only the file-stack is affected. Blank/prompt lines
      // deliberately do NOT flush a pending error: TeX interposes blanks and an
      // "Enter file name:" prompt between a File-not-found error and its l.<n>.
      updateStack(line);
    }

    // Finalize anything still open at end-of-log (order: warning body may hold the
    // last emitted item; a bare error with no l.<n> flushes with line undefined).
    flushWarning();
    flushError();
  } catch {
    // Unreachable by construction (every branch is total), but the §5.1 contract
    // is that a host never sees this throw — return whatever was collected.
    return out;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Missing-file extraction (DESIGN.md §5.4(b))
// ---------------------------------------------------------------------------

/**
 * Cap on distinct missing filenames {@link extractMissingFiles} returns. A hostile
 * transcript full of fabricated "File `x' not found" lines cannot make the output
 * unbounded; a real compile misses a handful of files at most.
 */
export const MAX_MISSING_FILES = 64;

// A missing input the engine named: the LaTeX kernel's `File `X' not found` (the
// `! LaTeX Error: File `…' not found.` line — a missing \usepackage / \input /
// \documentclass, the dominant form; fixtures missing-package{,.pdftex} and
// missing-input-file capture the .sty and .tex variants), OR plain-TeX/kpathsea's
// `I can't find file `X'`. In both, the name sits between a backtick and a
// straight quote. Matched in ONE pass so results stay in transcript order.
const MISSING_FILE = /File `([^'\n]+)' not found|I can't find file `([^'\n]+)'/g;

/**
 * Extract the filenames a compile reported as MISSING from a raw engine
 * transcript — the structured input to the §5.4(b) missing-file retry. Pure and
 * total: never throws; returns a deduplicated, transcript-order,
 * {@link MAX_MISSING_FILES}-capped list (each name WITH its extension, e.g.
 * `siunitx.sty`, `ctexart.cls`, `nosuchinputfile.tex`).
 *
 * The worker (worker/core.ts) feeds this a FAILED pass's transcript to decide
 * whether an unloaded on-demand tier might supply the file; the client could
 * equally call it on `result.log`. Because it drives an OPTIMISTIC retry (mount
 * the tier, recompile once — worker-local, no network), the list only needs to be
 * a SOUND signal that files are missing plus the names for a future filename→bundle
 * index; it need not be exhaustive. A genuine TeX error that is NOT a missing file
 * (an undefined control sequence, a syntax error) yields `[]`, so it never
 * triggers a spurious tier download (verified against the diagnostics fixtures).
 */
export function extractMissingFiles(log: string): string[] {
  const out: string[] = [];
  if (typeof log !== 'string' || log.length === 0) return out;
  const seen = new Set<string>();
  MISSING_FILE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MISSING_FILE.exec(log)) !== null) {
    const name = (match[1] ?? match[2] ?? '').trim();
    if (name.length === 0 || seen.has(name)) continue;
    if (out.length >= MAX_MISSING_FILES) break;
    seen.add(name);
    out.push(name);
  }
  return out;
}
