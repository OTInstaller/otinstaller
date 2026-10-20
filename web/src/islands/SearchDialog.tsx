// The quick search dialog: opened from the header button, "/" or Ctrl+K; searches as you type.
import { useEffect, useRef, useState } from "preact/hooks";
import { api, type SearchResult, type ToolSummary } from "../lib/api";
import { inputLabel } from "../lib/format";

const SUGGESTIONS = ["email", "username", "phone", "domain", "whois", "breach", "image"];

export default function SearchDialog() {
  const dlg = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<ToolSummary[] | null>(null);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const open = () => {
      if (dlg.current && !dlg.current.open) dlg.current.showModal();
      requestAnimationFrame(() => input.current?.select());
    };
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target.closest("input, textarea, select, [contenteditable]");
      if ((e.key === "k" || e.key === "K") && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        open();
      } else if (e.key === "/" && !typing) {
        e.preventDefault();
        open();
      }
    };
    const onOpen = (e: Event) => {
      const t = (e.target as HTMLElement).closest("[data-open-search]");
      if (t) {
        e.preventDefault();
        open();
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onOpen);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onOpen);
    };
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setResults(null);
      return;
    }
    setBusy(true);
    setFailed(false);
    const t = setTimeout(() => {
      api<SearchResult>(`/tools?q=${encodeURIComponent(term)}&limit=8`)
        .then((r) => {
          setResults(r.results);
          setActive(0);
        })
        .catch(() => {
          setResults([]);
          setFailed(true);
        })
        .finally(() => setBusy(false));
    }, 180);
    return () => clearTimeout(t);
  }, [q]);

  const hrefOf = (t: ToolSummary) => (t.kind === "guide" ? `/guides/${t.namespace}/${t.name}` : `/${t.namespace}/${t.name}`);
  const go = () => {
    const pick = results?.[active];
    window.location.href = pick ? hrefOf(pick) : `/search?q=${encodeURIComponent(q.trim())}`;
  };
  const onInputKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      // A search input eats the first Escape to clear itself; close straight away instead.
      e.preventDefault();
      dlg.current?.close();
      return;
    }
    if (!results?.length) {
      if (e.key === "Enter" && q.trim()) go();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      go();
    }
  };

  return (
    <dialog ref={dlg} class="sdlg" aria-label="Search the registry" onClick={(e) => { if (e.target === dlg.current) dlg.current?.close(); }}>
      <div class="sdlg-box">
        <div class="sdlg-field">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
          <input
            ref={input}
            type="search"
            placeholder="Search tools and guides"
            value={q}
            onInput={(e) => setQ((e.target as HTMLInputElement).value)}
            onKeyDown={onInputKey}
            aria-label="Search tools and guides"
            aria-controls="sdlg-results"
            autocomplete="off"
          />
          <kbd class="kbd">Esc</kbd>
        </div>
        <div id="sdlg-results" class="sdlg-results" role="listbox" aria-busy={busy}>
          {results === null ? (
            <div class="sdlg-empty">
              <p class="small muted">Try</p>
              <div class="row">
                {SUGGESTIONS.map((s) => (
                  <button class="chip" type="button" onClick={() => setQ(s)}>{s}</button>
                ))}
              </div>
            </div>
          ) : results.length === 0 ? (
            <p class="sdlg-empty muted">
              {busy ? "Searching…" : failed ? <>The registry did not answer. <a href={`/search?q=${encodeURIComponent(q)}`}>Search the site instead</a>.</> : <>Nothing matches. <a href={`/search?q=${encodeURIComponent(q)}`}>Search everything</a>.</>}
            </p>
          ) : (
            <ul class="list-plain">
              {results.map((t, i) => (
                <li>
                  <a href={hrefOf(t)} role="option" aria-selected={i === active} class={i === active ? "is-active" : undefined} onMouseEnter={() => setActive(i)}>
                    <span class="sdlg-ref">
                      <span class="ns">{t.namespace}/</span>{t.name}
                      {t.kind === "guide" && <span class="badge plain">guide</span>}
                    </span>
                    <span class="sdlg-sum">{t.summary}</span>
                    {t.inputs.length > 0 && <span class="sdlg-meta">{t.inputs.slice(0, 3).map(inputLabel).join(" · ")}</span>}
                  </a>
                </li>
              ))}
              <li class="sdlg-all">
                <a href={`/search?q=${encodeURIComponent(q.trim())}`}>All results for “{q.trim()}” →</a>
              </li>
            </ul>
          )}
        </div>
        <div class="sdlg-foot small muted">
          <span><kbd class="kbd">↑</kbd> <kbd class="kbd">↓</kbd> to move</span>
          <span><kbd class="kbd">↵</kbd> to open</span>
        </div>
      </div>
    </dialog>
  );
}
