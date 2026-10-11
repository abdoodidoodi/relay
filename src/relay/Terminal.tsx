import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Search, X, ChevronDown, ChevronUp } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import type { RelayTransport } from './api';
import { errorText } from './api';
import { ReplayGate } from './replay';

export default function Terminal({ sessionId, transport, generation = 0 }: { sessionId: string; transport: RelayTransport; generation?: number }) {
  const container = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!container.current) return;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    let frame = 0;
    let lastSize = '';
    setError('');
    const terminal = new XTerm({
      fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, monospace', fontSize: 13, lineHeight: 1.25,
      cursorBlink: true, cursorStyle: 'bar', scrollback: 10000, allowProposedApi: false,
      theme: { background: '#151719', foreground: '#d5d8db', cursor: '#a7c4b5', selectionBackground: '#35453f', black: '#202326', red: '#dd8a85', green: '#a4bea3', yellow: '#d4c091', blue: '#98b5d1', magenta: '#bd9bc4', cyan: '#91bfbf', white: '#d5d8db', brightBlack: '#757b80', brightRed: '#eca09c', brightGreen: '#bad3b9', brightYellow: '#e4d3a7', brightBlue: '#aec7e0', brightMagenta: '#d2b0d8', brightCyan: '#afd5d5', brightWhite: '#f1f2f3' },
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    terminal.loadAddon(fit); terminal.loadAddon(search); terminal.open(container.current);
    termRef.current = terminal; searchRef.current = search;
    const gate = new ReplayGate(sessionId, bytes => { if (!disposed) terminal.write(new Uint8Array(bytes)); });
    const report = (e: unknown) => { if (!disposed) setError(errorText(e)); };
    const resize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (disposed || !container.current?.clientWidth || !container.current.clientHeight) return;
        fit.fit();
        const size = `${terminal.cols}:${terminal.rows}`;
        if (lastSize !== size) { lastSize = size; void transport.resize(sessionId, terminal.cols, terminal.rows).catch(report); }
      });
    };
    const observer = new ResizeObserver(resize); observer.observe(container.current);
    const encoder = new TextEncoder();
    const input = terminal.onData(data => { void transport.write(sessionId, Array.from(encoder.encode(data))).catch(report); });
    const binary = terminal.onBinary(data => { void transport.write(sessionId, Array.from(data, char => char.charCodeAt(0) & 255)).catch(report); });
    terminal.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown') return true;
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && ['n', 'k', 'i', ','].includes(event.key.toLowerCase())) return false;
      if (modifier && event.key.toLowerCase() === 'f') { event.preventDefault(); setSearchOpen(true); return false; }
      if (modifier && event.key.toLowerCase() === 'c' && terminal.hasSelection()) {
        event.preventDefault(); void navigator.clipboard.writeText(terminal.getSelection()).catch(report); return false;
      }
      if (modifier && event.key.toLowerCase() === 'v') {
        event.preventDefault();
        void navigator.clipboard.readText().then(text => { if (!disposed) terminal.paste(text); }).catch(report); return false;
      }
      return true;
    });
    // Listener establishment must finish before requesting the overlapping replay.
    void (async () => {
      const unlisten = await transport.onOutput(output => gate.output(output));
      if (disposed) { unlisten(); return; }
      unsubscribe = unlisten;
      const replay = await transport.attach(sessionId);
      if (disposed) return;
      gate.replay(replay); resize(); terminal.focus();
    })().catch(report);
    return () => {
      disposed = true; gate.dispose(); unsubscribe?.(); observer.disconnect(); cancelAnimationFrame(frame);
      input.dispose(); binary.dispose(); terminal.dispose();
      if (termRef.current === terminal) { termRef.current = null; searchRef.current = null; }
      // Backend owns PTYs. Changing a tab or HMR must never stop its process.
    };
  }, [sessionId, transport, generation, retry]);

  useEffect(() => { if (query) searchRef.current?.findNext(query, { incremental: true }); }, [query]);
  return <div className="terminal-shell">
    {searchOpen && <div className="terminal-search"><Search size={14} /><input autoFocus aria-label="Find in terminal" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (event.shiftKey) searchRef.current?.findPrevious(query); else searchRef.current?.findNext(query); } if (event.key === 'Escape') { setSearchOpen(false); termRef.current?.focus(); } }} placeholder="Find in terminal" /><button aria-label="Previous match" onClick={() => searchRef.current?.findPrevious(query)}><ChevronUp size={15} /></button><button aria-label="Next match" onClick={() => searchRef.current?.findNext(query)}><ChevronDown size={15} /></button><button aria-label="Close search" onClick={() => { setSearchOpen(false); termRef.current?.focus(); }}><X size={15} /></button></div>}
    {error && <div className="terminal-error" role="alert"><span>{error}</span><button onClick={() => setRetry(value => value + 1)}>Reconnect</button></div>}
    <div className="terminal-host" ref={container} />
  </div>;
}
