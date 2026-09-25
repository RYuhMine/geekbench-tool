// ==UserScript==
// @name         Geekbench Tool
// @namespace    http://tampermonkey.net/
// @version      6.1
// @description  Collect links + extract Build values. Auto-pagination (live DOM), parallel workers, persistent settings.
// @author       RYuh/ RYuhMine / Reimu Hakurei
// @match        https://browser.geekbench.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @connect      browser.geekbench.com
// ==/UserScript==

(function () {
    'use strict';

    // ── Storage ───────────────────────────────────────────────────────────────
    const S = {
        get: (k, d) => { try { return JSON.parse(GM_getValue(k, JSON.stringify(d))); } catch { return d; } },
        set: (k, v) => GM_setValue(k, JSON.stringify(v)),
    };

    const KEY_LINKS      = 'gbt_links';
    const KEY_RESULTS    = 'gbt_results';
    const KEY_AUTOPAGING = 'gbt_autopaging';
    const KEY_SETTINGS   = 'gbt_settings';
    const KEY_LOG        = 'gbt_log';

    const getLinks    = () => S.get(KEY_LINKS, []);
    const getResults  = () => S.get(KEY_RESULTS, {});
    const saveLinks   = v => S.set(KEY_LINKS, v);
    const saveResults = v => S.set(KEY_RESULTS, v);

    // Persistent settings with defaults
    const defaultSettings = { collDelay: 1, extDelay: 0.6, workers: 3, fromPage: 1, toPage: '', forceGb6: false };
    function loadSettings() { return { ...defaultSettings, ...S.get(KEY_SETTINGS, {}) }; }
    function saveSetting(key, val) {
        const s = loadSettings(); s[key] = val; S.set(KEY_SETTINGS, s);
    }

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const scoreIdFromUrl = url => url.trim().replace(/\/$/, '').split('/').pop();

    // gbExtFromUrl: if forceGb6 toggle is ON and URL is v7 → use .gb6 instead of .gb7
    function gbExtFromUrl(url, forceGb6) {
        const m = url.match(/\/v(\d+)\//);
        if (!m) return '.gb6';
        const ver = m[1];
        if (ver === '7' && forceGb6) return '.gb6';
        return `.gb${ver}`;
    }

    const resultsToText  = r => Object.entries(r).map(([b,ids]) => `${b} - ${ids.join(', ')}`).join('\n');

    // Find Build field — match by name regardless of language (id=41 or name contains build-like field)
    function findBuild(obj) {
        if (Array.isArray(obj)) {
            for (const i of obj) { const r = findBuild(i); if (r) return r; }
        } else if (obj && typeof obj === 'object') {
            if ((obj.id === 41 || obj.name === 'Build') && obj.value !== undefined && String(obj.value).trim()) {
                return String(obj.value).trim();
            }
            for (const v of Object.values(obj)) { const r = findBuild(v); if (r) return r; }
        }
        return null;
    }

    function fetchBuild(url, forceGb6) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url.trim().replace(/\/$/, '') + gbExtFromUrl(url, forceGb6),
                responseType: 'json',
                onload(resp) {
                    if (resp.status !== 200) { reject(new Error(`HTTP ${resp.status}`)); return; }
                    const b = findBuild(resp.response);
                    b ? resolve(b) : reject(new Error('Build field not found'));
                },
                onerror() { reject(new Error('Network error')); }
            });
        });
    }

    function collectLinksFromPage() {
        const saved = new Set(getLinks());
        let added = 0;
        document.querySelectorAll('a[href]').forEach(a => {
            const href = a.href;
            if (/browser\.geekbench\.com\/v\d+\/(cpu|compute)\/\d+$/.test(href)) {
                if (!saved.has(href)) { saved.add(href); added++; }
            }
        });
        saveLinks([...saved]);
        return { total: saved.size, added };
    }

    function pageUrl(base, page) {
        if (/[?&]page=\d+/.test(base)) return base.replace(/([?&]page=)\d+/, `$1${page}`);
        return base + (base.includes('?') ? '&' : '?') + `page=${page}`;
    }

    // ── Auto-paging (runs on every page load) ─────────────────────────────────
    function checkAutoPaging() {
        const session = S.get(KEY_AUTOPAGING, null);
        if (!session) return;
        const { baseUrl, currentPage, toPage, delay } = session;
        const { total, added } = collectLinksFromPage();
        const hasNext = !!document.querySelector('a[rel="next"], ul.pagination .next:not(.disabled) a, li.next:not(.disabled) a');
        const nextPage = currentPage + 1;
        const shouldContinue = hasNext && (toPage === 0 || nextPage <= toPage);
        const logs = S.get(KEY_LOG, []);
        logs.push(`Page ${currentPage}: +${added} links (total: ${total})${!shouldContinue ? ' — done.' : ''}`);
        S.set(KEY_LOG, logs);
        if (shouldContinue) {
            S.set(KEY_AUTOPAGING, { ...session, currentPage: nextPage });
            setTimeout(() => { window.location.href = pageUrl(baseUrl, nextPage); }, (delay || 0) * 1000);
        } else {
            S.set(KEY_AUTOPAGING, null);
        }
    }

    // ── UI helpers ─────────────────────────────────────────────────────────────
    const el = (tag, css, html) => {
        const e = document.createElement(tag);
        if (css) e.style.cssText = css;
        if (html !== undefined) e.innerHTML = html;
        return e;
    };
    const mkBtn = (text, bg) => {
        const b = el('button', `flex:1;background:${bg};border:none;border-radius:6px;color:#fff;font-weight:600;cursor:pointer;padding:7px 8px;font-size:12px;`);
        b.textContent = text; return b;
    };
    const addLog = (logEl, msg) => {
        const d = document.createElement('div'); d.textContent = msg;
        logEl.appendChild(d); logEl.scrollTop = logEl.scrollHeight;
    };
    const setStatus = (el, msg, color) => { el.textContent = msg; el.style.color = color || '#6b7280'; };

    // ── Main panel ────────────────────────────────────────────────────────────
    function createPanel() {
        if (document.getElementById('gbt-panel')) return;

        const panel = el('div', `
            position:fixed;top:60px;right:20px;width:460px;max-height:93vh;
            background:#111827;border:1px solid #374151;border-radius:12px;
            box-shadow:0 12px 40px rgba(0,0,0,.7);font-family:'Segoe UI',sans-serif;
            font-size:13px;color:#e5e7eb;z-index:999999;
            display:flex;flex-direction:column;overflow:hidden;
        `);
        panel.id = 'gbt-panel';

        // Header
        const hdr = el('div', `
            display:flex;align-items:center;justify-content:space-between;
            padding:11px 16px;background:#1f2937;border-bottom:1px solid #374151;
            cursor:move;user-select:none;flex-shrink:0;
        `);
        hdr.innerHTML = `<span style="font-weight:700;font-size:14px;color:#f9fafb">⚡ Geekbench Tool</span>`;
        const closeBtn = el('button', `background:none;border:none;color:#9ca3af;cursor:pointer;font-size:20px;line-height:1;padding:0`);
        closeBtn.textContent = '×'; hdr.appendChild(closeBtn);

        // Tabs
        const tabBar = el('div', `display:flex;background:#1f2937;border-bottom:1px solid #374151;flex-shrink:0;`);
        const TABS = ['Collector', 'Links', 'Build Extractor', 'Results'];
        const tabEls = TABS.map((t, i) => {
            const tb = el('button', `flex:1;background:none;border:none;border-bottom:2px solid transparent;color:#9ca3af;cursor:pointer;padding:8px 2px;font-size:11px;font-weight:600;`);
            tb.textContent = t; tabBar.appendChild(tb); return tb;
        });
        const panes = TABS.map(() => el('div', `display:none;flex-direction:column;flex:1;overflow:hidden;min-height:0;`));

        function switchTab(i) {
            tabEls.forEach((t, j) => {
                t.style.color = j === i ? '#f9fafb' : '#9ca3af';
                t.style.borderBottomColor = j === i ? '#3b82f6' : 'transparent';
            });
            panes.forEach((p, j) => { p.style.display = j === i ? 'flex' : 'none'; });
            if (i === 1) refreshLinksTab();
            if (i === 3) refreshResults();
        }
        tabEls.forEach((t, i) => t.onclick = () => switchTab(i));

        const settings = loadSettings();

        // ── PANE 0: Collector ─────────────────────────────────────────────────
        const p0 = panes[0];

        const urlRow = el('div', `display:flex;flex-direction:column;gap:4px;padding:10px 14px 4px;flex-shrink:0;`);
        const urlLabel = el('div', `font-size:11px;color:#6b7280;`, 'Search URL (page= auto-incremented):');
        const urlInput = el('input', `width:100%;box-sizing:border-box;background:#0f172a;border:1px solid #374151;border-radius:6px;color:#93c5fd;font-size:11px;padding:6px 8px;`);
        urlInput.placeholder = 'https://browser.geekbench.com/v6/cpu/search?page=1&q=YourDevice';
        if (/\/search\?/.test(location.href)) urlInput.value = location.href;
        urlRow.append(urlLabel, urlInput);

        const settingsRow = el('div', `display:flex;gap:8px;padding:6px 14px;flex-shrink:0;align-items:center;flex-wrap:wrap;`);
        const mkNumInput = (val, min, step, width, saveKey) => {
            const inp = el('input', `width:${width||50}px;background:#0f172a;border:1px solid #374151;border-radius:6px;color:#93c5fd;font-size:12px;padding:3px 6px;text-align:center;`);
            inp.type='number'; inp.value=val; inp.min=min; if(step) inp.step=step;
            if (saveKey) inp.addEventListener('change', () => saveSetting(saveKey, inp.value));
            return inp;
        };
        const mkLabel = t => el('span', `font-size:11px;color:#9ca3af;white-space:nowrap;`, t);

        const fromInp  = mkNumInput(settings.fromPage, '1', null, 45, 'fromPage');
        const toInp    = mkNumInput(settings.toPage, '1', null, 45, 'toPage');
        toInp.placeholder = '∞';
        const delayInp = mkNumInput(settings.collDelay, '0', '0.5', 45, 'collDelay');

        settingsRow.append(
            mkLabel('From:'), fromInp,
            mkLabel('To:'), toInp,
            mkLabel('Delay (s):'), delayInp,
            el('span',`font-size:10px;color:#4b5563;`,'0=none')
        );

        const collLog = el('div', `flex:1;overflow-y:auto;margin:4px 14px;padding:6px;min-height:70px;background:#0f172a;border:1px solid #1e293b;border-radius:6px;font-size:11px;color:#94a3b8;`);
        const collStatus = el('div', `padding:4px 14px;font-size:11px;color:#6b7280;flex-shrink:0;`);
        const collFooter = el('div', `display:flex;gap:6px;padding:10px 14px;background:#1f2937;border-top:1px solid #374151;flex-shrink:0;flex-wrap:wrap;`);

        const btnCollectThis = mkBtn('+ This page', '#1d4ed8');
        const btnAutoScan    = mkBtn('▶ Auto-scan', '#065f46');
        const btnStopScan    = mkBtn('⏹ Stop', '#374151');
        const btnClearLinks  = mkBtn('🗑 Clear', '#3f1515');
        btnStopScan.style.display = 'none';
        collFooter.append(btnCollectThis, btnAutoScan, btnStopScan, btnClearLinks);
        p0.append(urlRow, settingsRow, collLog, collStatus, collFooter);

        // Restore logs from auto-paging
        S.get(KEY_LOG, []).forEach(l => addLog(collLog, l));
        S.set(KEY_LOG, []);
        if (S.get(KEY_AUTOPAGING, null)) {
            addLog(collLog, `[Auto-scan running] Waiting for next page...`);
            btnAutoScan.style.display = 'none'; btnStopScan.style.display = 'flex';
        }
        setStatus(collStatus, `Saved: ${getLinks().length} links`, '#6b7280');

        btnCollectThis.onclick = () => {
            const { total, added } = collectLinksFromPage();
            addLog(collLog, `+ ${added} new from this page (total: ${total})`);
            setStatus(collStatus, `Saved: ${total} links`, '#6b7280');
            refreshLinksTab();
        };

        btnAutoScan.onclick = () => {
            const base = urlInput.value.trim();
            if (!base) { addLog(collLog, '[!] Enter a search URL first'); return; }
            const from  = parseInt(fromInp.value) || 1;
            const to    = parseInt(toInp.value) || 0;
            const delay = parseFloat(delayInp.value) || 0;
            const { total, added } = collectLinksFromPage();
            addLog(collLog, `Page ${from} (current): +${added} (total: ${total})`);
            const hasNext = !!document.querySelector('a[rel="next"], ul.pagination .next:not(.disabled) a, li.next:not(.disabled) a');
            const nextPage = from + 1;
            if (!hasNext || (to !== 0 && nextPage > to)) {
                addLog(collLog, '✓ Done.'); setStatus(collStatus, `Done. ${total} links.`, '#34d399'); return;
            }
            S.set(KEY_AUTOPAGING, { baseUrl: base, currentPage: nextPage, toPage: to, delay });
            S.set(KEY_LOG, []);
            addLog(collLog, `→ Navigating to page ${nextPage}...`);
            btnAutoScan.style.display = 'none'; btnStopScan.style.display = 'flex';
            setTimeout(() => { window.location.href = pageUrl(base, nextPage); }, delay * 1000);
        };

        btnStopScan.onclick = () => {
            S.set(KEY_AUTOPAGING, null);
            addLog(collLog, '[!] Auto-scan cancelled');
            btnStopScan.style.display = 'none'; btnAutoScan.style.display = 'flex';
            setStatus(collStatus, `Stopped. ${getLinks().length} links saved.`, '#f59e0b');
        };

        btnClearLinks.onclick = () => {
            if (!confirm('Clear all collected links?')) return;
            saveLinks([]); addLog(collLog, '[i] Links cleared');
            setStatus(collStatus, 'Saved: 0 links', '#6b7280');
            refreshLinksTab();
        };

        // ── PANE 1: Links (view + edit) ───────────────────────────────────────
        const p1 = panes[1];
        const linksInfo = el('div', `padding:8px 14px 4px;font-size:11px;color:#6b7280;flex-shrink:0;`);
        const linksArea = el('textarea', `
            flex:1;margin:4px 14px;background:#0f172a;border:1px solid #374151;border-radius:6px;
            color:#93c5fd;font-size:11px;padding:8px;resize:none;font-family:monospace;
        `);
        linksArea.placeholder = 'One URL per line. Edit freely — saved on blur.';

        const linksFooter = el('div', `display:flex;gap:6px;padding:10px 14px;background:#1f2937;border-top:1px solid #374151;flex-shrink:0;`);
        const btnSaveLinks = mkBtn('💾 Save edits', '#1d4ed8');
        const btnCopyLinks = mkBtn('📋 Copy all links', '#374151');
        linksFooter.append(btnSaveLinks, btnCopyLinks);
        p1.append(linksInfo, linksArea, linksFooter);

        function refreshLinksTab() {
            const links = getLinks();
            linksArea.value = links.join('\n');
            linksInfo.textContent = `${links.length} links collected — edit freely, then click Save`;
        }

        linksArea.addEventListener('blur', () => {
            const lines = linksArea.value.split('\n').map(l=>l.trim()).filter(l=>l.startsWith('http'));
            saveLinks([...new Set(lines)]);
            linksInfo.textContent = `${lines.length} links saved`;
        });

        btnSaveLinks.onclick = () => {
            const lines = linksArea.value.split('\n').map(l=>l.trim()).filter(l=>l.startsWith('http'));
            saveLinks([...new Set(lines)]);
            linksInfo.textContent = `✓ Saved ${lines.length} links`;
        };

        btnCopyLinks.onclick = () => {
            const text = getLinks().join('\n');
            try { GM_setClipboard(text); } catch { navigator.clipboard.writeText(text); }
            btnCopyLinks.textContent = '✓ Copied!';
            setTimeout(() => { btnCopyLinks.textContent = '📋 Copy all links'; }, 2000);
        };

        // ── PANE 2: Build Extractor ───────────────────────────────────────────
        const p2 = panes[2];
        const extNote = el('div', `padding:8px 14px 4px;font-size:11px;color:#6b7280;flex-shrink:0;`, 'Uses links from Collector/Links tab. GB version auto-detected from URL.');

        const extSettRow = el('div', `display:flex;gap:8px;padding:4px 14px 6px;flex-shrink:0;align-items:center;flex-wrap:wrap;`);
        const extDelayInp   = mkNumInput(settings.extDelay, '0', '0.1', 50, 'extDelay');
        const extWorkersInp = mkNumInput(settings.workers, '1', '1', 45, 'workers');

        // ── gb6/gb7 toggle ────────────────────────────────────────────────────
        let forceGb6 = !!settings.forceGb6;

        const toggleWrap = el('div', `display:flex;align-items:center;gap:5px;margin-left:4px;`);
        const toggleLabel = el('span', `font-size:11px;color:#9ca3af;white-space:nowrap;`, 'v7→');
        const toggleTrack = el('div', `
            position:relative;width:38px;height:20px;border-radius:10px;cursor:pointer;
            transition:background .2s;flex-shrink:0;
            background:${forceGb6 ? '#1d4ed8' : '#374151'};
        `);
        const toggleThumb = el('div', `
            position:absolute;top:3px;width:14px;height:14px;border-radius:50%;background:#fff;
            transition:left .2s;left:${forceGb6 ? '21px' : '3px'};
        `);
        const toggleValLabel = el('span', `font-size:11px;font-weight:600;white-space:nowrap;
            color:${forceGb6 ? '#60a5fa' : '#9ca3af'};`,
            forceGb6 ? '.gb6' : '.gb7'
        );
        toggleTrack.appendChild(toggleThumb);
        toggleWrap.append(toggleLabel, toggleTrack, toggleValLabel);

        toggleTrack.onclick = () => {
            forceGb6 = !forceGb6;
            saveSetting('forceGb6', forceGb6);
            toggleTrack.style.background = forceGb6 ? '#1d4ed8' : '#374151';
            toggleThumb.style.left = forceGb6 ? '21px' : '3px';
            toggleValLabel.textContent = forceGb6 ? '.gb6' : '.gb7';
            toggleValLabel.style.color = forceGb6 ? '#60a5fa' : '#9ca3af';
        };
        // ─────────────────────────────────────────────────────────────────────

        extSettRow.append(
            mkLabel('Delay (s):'), extDelayInp,
            mkLabel('Workers:'), extWorkersInp,
            el('span',`font-size:10px;color:#4b5563;`,'parallel'),
            toggleWrap
        );

        const extLog = el('div', `flex:1;overflow-y:auto;margin:0 14px;padding:6px;min-height:70px;background:#0f172a;border:1px solid #1e293b;border-radius:6px;font-size:11px;color:#94a3b8;`);
        const extStatus = el('div', `padding:4px 14px;font-size:11px;color:#6b7280;flex-shrink:0;`);
        const extFooter = el('div', `display:flex;gap:6px;padding:10px 14px;background:#1f2937;border-top:1px solid #374151;flex-shrink:0;`);

        const extBtnRun      = mkBtn('▶ Extract Builds', '#065f46');
        const extBtnStop     = mkBtn('⏹ Stop', '#374151');
        const extBtnClearRes = mkBtn('🗑 Clear results', '#3f1515');
        extBtnStop.disabled = true; extBtnStop.style.opacity = '0.4';
        extFooter.append(extBtnRun, extBtnStop, extBtnClearRes);
        p2.append(extNote, extSettRow, extLog, extStatus, extFooter);

        let extRunning = false;

        extBtnRun.onclick = async () => {
            const allUrls = getLinks();
            if (!allUrls.length) { addLog(extLog, '[!] No links. Use Collector first.'); return; }

            const delay   = parseFloat(extDelayInp.value) || 0;
            const workers = Math.max(1, parseInt(extWorkersInp.value) || 1);
            extRunning = true;
            extBtnRun.disabled = true; extBtnRun.style.opacity = '0.4';
            extBtnStop.disabled = false; extBtnStop.style.opacity = '1';

            const results = getResults();
            const todo = allUrls.filter(url => {
                const id = scoreIdFromUrl(url);
                return !Object.values(results).some(ids => ids.includes(id));
            });
            const skipped = allUrls.length - todo.length;
            const extLabel = forceGb6 ? ' [v7→.gb6 ON]' : '';
            addLog(extLog, `${todo.length} to process, ${skipped} already done. Workers: ${workers}${extLabel}`);

            let idx = 0;
            let done = 0;
            const total = todo.length;

            async function worker(wId) {
                while (extRunning) {
                    const myIdx = idx++;
                    if (myIdx >= total) break;
                    const url = todo[myIdx];
                    const scoreId = scoreIdFromUrl(url);
                    const ext = gbExtFromUrl(url, forceGb6);
                    addLog(extLog, `[W${wId}] → ${scoreId} (${ext})`);
                    try {
                        const build = await fetchBuild(url, forceGb6);
                        const r = getResults();
                        if (r[build]) r[build].push(scoreId);
                        else r[build] = [scoreId];
                        saveResults(r);
                        addLog(extLog, `[W${wId}] ✓ "${build}"`);
                    } catch(e) {
                        addLog(extLog, `[W${wId}] [!] ${scoreId}: ${e.message}`);
                    }
                    done++;
                    setStatus(extStatus, `${done}/${total}`, '#6b7280');
                    refreshResults();
                    if (delay > 0) await sleep(delay * 1000);
                }
            }

            const workerPromises = [];
            for (let i = 0; i < workers; i++) {
                await sleep(i * 50);
                workerPromises.push(worker(i + 1));
            }
            await Promise.all(workerPromises);

            extRunning = false;
            extBtnRun.disabled = false; extBtnRun.style.opacity = '1';
            extBtnStop.disabled = true;  extBtnStop.style.opacity = '0.4';
            const finalResults = getResults();
            setStatus(extStatus, `✓ Done. ${Object.keys(finalResults).length} unique builds.`, '#34d399');
            switchTab(3);
        };

        extBtnStop.onclick = () => { extRunning = false; addLog(extLog, '[!] Stopping after current requests...'); };

        extBtnClearRes.onclick = () => {
            if (!confirm('Clear all results?')) return;
            saveResults({}); addLog(extLog, '[i] Results cleared'); refreshResults();
        };

        // ── PANE 3: Results ───────────────────────────────────────────────────
        const p3 = panes[3];
        const resInfo = el('div', `padding:8px 14px 4px;font-size:11px;color:#6b7280;flex-shrink:0;`);
        const resArea = el('textarea', `
            flex:1;margin:4px 14px 8px;background:#0f172a;border:1px solid #1e293b;border-radius:6px;
            color:#34d399;font-size:12px;padding:8px;resize:none;font-family:monospace;min-height:200px;
        `);
        resArea.readOnly = true;
        const resFooter = el('div', `display:flex;gap:6px;padding:10px 14px;background:#1f2937;border-top:1px solid #374151;flex-shrink:0;`);
        const resBtnCopy = mkBtn('📋 Copy all', '#1d4ed8');
        resFooter.appendChild(resBtnCopy);
        p3.append(resInfo, resArea, resFooter);

        resBtnCopy.onclick = () => {
            if (!resArea.value) return;
            try { GM_setClipboard(resArea.value); } catch { navigator.clipboard.writeText(resArea.value); }
            resBtnCopy.textContent = '✓ Copied!';
            setTimeout(() => { resBtnCopy.textContent = '📋 Copy all'; }, 2000);
        };

        function refreshResults() {
            const results = getResults();
            const links = getLinks();
            resArea.value = resultsToText(results);
            const nBuilds = Object.keys(results).length;
            const nIds = Object.values(results).reduce((a,b) => a+b.length, 0);
            resInfo.textContent = `${nBuilds} unique builds · ${nIds} IDs · ${links.length} links`;
            setStatus(collStatus, `Saved: ${links.length} links`, '#6b7280');
        }

        // ── Assemble ──────────────────────────────────────────────────────────
        const body = el('div', `display:flex;flex-direction:column;flex:1;overflow:hidden;min-height:0;`);
        panes.forEach(p => body.appendChild(p));
        panel.append(hdr, tabBar, body);
        document.body.appendChild(panel);

        switchTab(0);
        refreshResults();

        // Drag
        let sx,sy,sl,st,dragging=false;
        hdr.addEventListener('mousedown', e => {
            dragging=true; sx=e.clientX; sy=e.clientY;
            const r=panel.getBoundingClientRect(); sl=r.left; st=r.top; panel.style.right='auto';
        });
        document.addEventListener('mousemove', e => {
            if(!dragging) return;
            panel.style.left=(sl+e.clientX-sx)+'px'; panel.style.top=(st+e.clientY-sy)+'px';
        });
        document.addEventListener('mouseup', () => { dragging=false; });
        closeBtn.onclick = () => panel.remove();
    }

    // ── Boot ──────────────────────────────────────────────────────────────────
    checkAutoPaging();

    function addTrigger() {
        if (document.getElementById('gbt-trigger')) return;
        const b = el('button', `
            position:fixed;bottom:28px;right:22px;background:#1d4ed8;color:#fff;
            border:none;border-radius:50px;padding:10px 18px;font-size:14px;
            font-weight:700;cursor:pointer;z-index:999998;
            box-shadow:0 4px 20px rgba(29,78,216,.5);
        `);
        b.id = 'gbt-trigger'; b.textContent = '⚡ GB Tool';
        b.onclick = () => { const p = document.getElementById('gbt-panel'); if (p) p.remove(); else createPanel(); };
        document.body.appendChild(b);
        if (S.get(KEY_AUTOPAGING, null)) createPanel();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addTrigger);
    else addTrigger();

})();
