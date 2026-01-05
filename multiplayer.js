/*
Multiplayer link-based signaling (file: multiplayer.js)
- Non-invasive: adds window.Multiplayer namespace
- Supports manual link exchange (host -> guest via offer link, guest -> host via answer link)
- Uses WebRTC DataChannel for real-time messages
- ICE uses Google's STUN server by default

Usage overview (see README instructions below after file created):
- Host: Multiplayer.createLobby() -> returns { shareLink }
  -> Share that link with your friend
- Guest: Multiplayer.joinFromUrl(window.location.href) OR Multiplayer.joinFromOfferString(offerPayloadString)
  -> Guest will produce an "answer link" (string) to send back to host
- Host: open the answer link (or call Multiplayer.setAnswerFromString(answerString)) to finish the handshake

Design notes:
- Host should be authoritative (send periodic full snapshots)
- Clients should send inputs/deltas (small messages each frame)
- Message format: JSON: { type: 'input'|'snapshot'|'chat'|'meta', payload: {...} }
- This module does not automatically hook into your game — call send/receive handlers yourself
*/

(function(window){
    const STUN_SERVERS = [{ urls: ['stun:stun.l.google.com:19302'] }];

    // helpers
    function log(...args){ console.log('[MP]', ...args); }
    function err(...args){ console.error('[MP]', ...args); }
    function utf8ToB64(str){ return btoa(unescape(encodeURIComponent(str))); }
    function b64ToUtf8(b64){ return decodeURIComponent(escape(atob(b64))); }

    function waitForIceGatheringComplete(pc, timeout=3000){
        return new Promise((resolve)=>{
            if (pc.iceGatheringState === 'complete') return resolve();
            function check(){ if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', check); resolve(); } }
            pc.addEventListener('icegatheringstatechange', check);
            setTimeout(()=>{ try { pc.removeEventListener('icegatheringstatechange', check); } catch(e){}; resolve(); }, timeout);
        });
    }

    // encode/decode signaling payloads into short strings safe for URLs
    function encodePayload(obj){ try{ return utf8ToB64(JSON.stringify(obj)); } catch(e){ err('encodePayload failed', e); return null; } }
    function decodePayload(str){ try{ return JSON.parse(b64ToUtf8(str)); } catch(e){ err('decodePayload failed', e); return null; } }

    // public API object
    const MP = {
        pc: null,
        dc: null,
        isHost: false,
        connected: false,
        events: {},
        gatheredCandidates: [],

        on(ev, cb){ (this.events[ev] = this.events[ev] || []).push(cb); },
        _emit(ev, ...args){ (this.events[ev]||[]).forEach(f=>{ try{ f(...args);}catch(e){err('event cb',e);} }); },

        // create a new RTCPeerConnection and a datachannel (host)
        async createLobby(){
            if (this.pc) this.close();
            this.isHost = true; this.gatheredCandidates = [];
            this.pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });

            // collect ICE
            this.pc.addEventListener('icecandidate', (ev)=>{ if(ev.candidate) this.gatheredCandidates.push(ev.candidate.toJSON()); });

            // create datachannel for game messages
            this.dc = this.pc.createDataChannel('game', { ordered: true });
            this._attachDataChannel(this.dc);

            // create offer
            const offer = await this.pc.createOffer();
            await this.pc.setLocalDescription(offer);
            // wait for ICE
            await waitForIceGatheringComplete(this.pc, 5000);

            const payload = { desc: this.pc.localDescription.toJSON(), candidates: this.gatheredCandidates };
            const encoded = encodePayload(payload);
            const shareLink = `${location.origin}${location.pathname}#host=${encoded}`;
            this._emit('lobbyCreated', { shareLink });
            log('lobby created, shareLink ready');
            return { shareLink }; // caller shows/copies this link
        },

        // Join from a full url that contains #host=... payload
        async joinFromUrl(url){
            const hash = (new URL(url)).hash.slice(1);
            const parts = new URLSearchParams(hash);
            if (parts.has('host')){
                const encoded = parts.get('host');
                return await this.joinFromOfferString(encoded);
            }
            throw new Error('No host offer found in URL');
        },

        // Guest side: receives host offer payload string (base64) and returns an answer link string for host
        async joinFromOfferString(encodedOffer){
            const offerPayload = decodePayload(encodedOffer);
            if (!offerPayload || !offerPayload.desc) throw new Error('Invalid offer payload');

            if (this.pc) this.close();
            this.isHost = false; this.gatheredCandidates = [];
            this.pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
            this.pc.addEventListener('icecandidate', (ev)=>{ if(ev.candidate) this.gatheredCandidates.push(ev.candidate.toJSON()); });

            // when datachannel is created by host, attach it
            this.pc.addEventListener('datachannel', (ev)=>{ this.dc = ev.channel; this._attachDataChannel(this.dc); });

            const remoteDesc = new RTCSessionDescription(offerPayload.desc);
            await this.pc.setRemoteDescription(remoteDesc);
            // add remote candidates (if any)
            if (Array.isArray(offerPayload.candidates)){
                for (let c of offerPayload.candidates){ try{ await this.pc.addIceCandidate(c); } catch(e){ /* ignore */ } }
            }

            const answer = await this.pc.createAnswer();
            await this.pc.setLocalDescription(answer);
            // wait for ICE
            await waitForIceGatheringComplete(this.pc, 5000);

            const payload = { desc: this.pc.localDescription.toJSON(), candidates: this.gatheredCandidates };
            const encodedAnswer = encodePayload(payload);
            const answerLink = `${location.origin}${location.pathname}#answer=${encodedAnswer}`;
            this._emit('answerCreated', { answerLink });
            log('answer created for host. Send this link to host.');
            return { answerLink, encodedAnswer };
        },

        // Host uses this to accept answer returned by guest (paste the answer string or open the answer link in same tab)
        async setAnswerFromUrl(url){
            const hash = (new URL(url)).hash.slice(1);
            const parts = new URLSearchParams(hash);
            if (!parts.has('answer')) throw new Error('No answer found in URL');
            const encoded = parts.get('answer');
            return await this.setAnswerFromString(encoded);
        },

        async setAnswerFromString(encodedAnswer){
            if (!this.pc) throw new Error('No active PC — create lobby first');
            const answerPayload = decodePayload(encodedAnswer);
            if (!answerPayload || !answerPayload.desc) throw new Error('Invalid answer payload');

            const remoteDesc = new RTCSessionDescription(answerPayload.desc);
            await this.pc.setRemoteDescription(remoteDesc);
            if (Array.isArray(answerPayload.candidates)){
                for (let c of answerPayload.candidates){ try{ await this.pc.addIceCandidate(c); } catch(e){ /* ignore */ } }
            }
            log('answer applied — awaiting connection');
            return true;
        },

        _attachDataChannel(dc){
            dc.onopen = ()=>{ this.connected = true; log('datachannel open'); this._emit('open'); };
            dc.onclose = ()=>{ this.connected = false; log('datachannel closed'); this._emit('close'); };
            dc.onerror = (e)=>{ err('dc error', e); };
            dc.onmessage = (ev)=>{
                try{
                    const msg = JSON.parse(ev.data);
                    this._emit('message', msg);
                    // convenience emit by type
                    if (msg && msg.type) this._emit('msg:' + msg.type, msg.payload);
                } catch(e){ err('invalid incoming message', ev.data); }
            };
        },

        send(type, payload){
            if (!this.dc || this.dc.readyState !== 'open') return false;
            try{ this.dc.send(JSON.stringify({ type, payload, t: Date.now() })); return true; } catch(e){ err('send failed', e); return false; }
        },

        // small helper wrappers for common message types
        sendInput(inputObj){ return this.send('input', inputObj); },
        sendSnapshot(snapshotObj){ return this.send('snapshot', snapshotObj); },
        sendChat(txt){ return this.send('chat', { text: txt }); },

        close(){
            try{ if (this.dc) { try{ this.dc.close(); } catch(e){}; this.dc = null; } } catch(e){}
            try{ if (this.pc) { this.pc.close(); this.pc = null; } } catch(e){}
            this.connected = false; this.isHost = false; this.gatheredCandidates = [];
            this._emit('close');
        }
    };

    // auto-detect when page opened with an answer on host side — helpful flow: host creates lobby and later opens answer link in same tab
    // This is passive and will only attempt to apply answer if MP.pc exists and URL contains answer
    function tryAutoApplyAnswerFromUrl(){
        try{
            const hash = location.hash.slice(1);
            const parts = new URLSearchParams(hash);
            if (parts.has('answer') && MP.pc){
                const encoded = parts.get('answer');
                MP.setAnswerFromString(encoded).then(()=>{
                    log('Auto-applied answer from URL');
                    // clear hash to avoid re-applying
                    try{ history.replaceState(null, '', location.pathname + location.search); } catch(e){}
                }).catch(e=>{ err('auto-apply failed', e); });
            }
        }catch(e){}
    }
    // run once on load
    window.addEventListener('load', ()=>{ tryAutoApplyAnswerFromUrl(); });

    // expose
        // =============================
    // AUTO POPUP UI (ZERO SETUP MODE)
    // =============================
    async function autoPopup(){
        try{
            if (MP.pc) return;

            // ---------- EMBEDDED OVERLAY UI ----------
            const overlay = document.createElement('div');
            overlay.id = 'mp-overlay';
            overlay.innerHTML = `
                <style>
                    #mp-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:999999;display:flex;align-items:center;justify-content:center}
                    #mp-box{background:#111;color:#fff;width:420px;max-width:92vw;border-radius:12px;padding:16px;font-family:Arial}
                    #mp-box h2{margin:0 0 8px 0}
                    #mp-box button{padding:10px 14px;margin:6px 4px;border-radius:8px;border:none;cursor:pointer}
                    #mp-box input{width:100%;padding:8px;border-radius:6px;border:none}
                    #mp-box .row{margin:8px 0}
                    #mp-box .muted{opacity:.8;font-size:12px}
                    #mp-status{font-size:12px;margin-top:6px}
                </style>
                <div id="mp-box">
                    <h2>Multiplayer</h2>
                    <div class="row">
                        <button id="mp-host">HOST</button>
                        <button id="mp-join">JOIN</button>
                        <button id="mp-close" style="float:right">X</button>
                    </div>
                    <div id="mp-content"></div>
                    <div id="mp-status" class="muted">Status: idle</div>
                </div>
            `;
            document.body.appendChild(overlay);

            const content = overlay.querySelector('#mp-content');
            const statusEl = overlay.querySelector('#mp-status');
            const setStatus = (t)=> statusEl.textContent = 'Status: ' + t;

            overlay.querySelector('#mp-close').onclick = ()=> overlay.remove();

            // ---------- AUTO COPY ----------
            function copyValue(v){
                navigator.clipboard?.writeText(v).catch(()=>{});
            }

            // ---------- PING ----------
            let pingInterval = null, lastPing = 0;
            function startPing(){
                stopPing();
                pingInterval = setInterval(()=>{
                    lastPing = performance.now();
                    MP.send('meta', { ping:true, t:lastPing });
                }, 1000);
            }
            function stopPing(){ if (pingInterval){ clearInterval(pingInterval); pingInterval=null; } }

            MP.on('msg:meta', (p)=>{
                if (p && p.ping && typeof p.t === 'number'){
                    MP.send('meta', { pong:true, t:p.t });
                }
                if (p && p.pong && typeof p.t === 'number'){
                    const ms = Math.round(performance.now() - p.t);
                    setStatus('connected • ping ' + ms + 'ms');
                }
                // SPAWN SYNC
                if (p && p.spawn){
                    window.__MP_SPAWN__ = p.spawn;
                }
            });
                }
                if (p && p.pong && typeof p.t === 'number'){
                    const ms = Math.round(performance.now() - p.t);
                    setStatus('connected • ping ' + ms + 'ms');
                }
            });

            MP.on('open', ()=>{ 
                setStatus('connected'); 
                startPing();
                // HOST decides spawn position
                if (MP.isHost){
                    const spawn = { x: 0, y: 0 };
                    MP.send('meta', { spawn });
                }
            });
            MP.on('close', ()=>{ setStatus('disconnected'); stopPing(); });

            // ---------- HOST ----------
            overlay.querySelector('#mp-host').onclick = async ()=>{
                setStatus('creating lobby…');
                const lobby = await MP.createLobby();
                content.innerHTML = `
                    <div class="row"><div class="muted">Share this link</div>
                        <input readonly id="mp-host-link" value="${lobby.shareLink}">
                        <button id="mp-copy-host">COPY</button>
                    </div>
                    <div class="row"><div class="muted">Paste ANSWER link</div>
                        <input id="mp-answer" placeholder="paste answer link">
                        <button id="mp-connect">CONNECT</button>
                    </div>
                `;
                const hostInput = content.querySelector('#mp-host-link');
                hostInput.onclick = ()=> hostInput.select();
                content.querySelector('#mp-copy-host').onclick = ()=> copyValue(hostInput.value);
                content.querySelector('#mp-connect').onclick = async ()=>{
                    const ans = content.querySelector('#mp-answer').value;
                    if (!ans) return alert('NO ANSWER LINK 💀');
                    setStatus('connecting…');
                    await MP.setAnswerFromUrl(ans);
                };
            };

            // ---------- JOIN ----------
            overlay.querySelector('#mp-join').onclick = async ()=>{
                setStatus('joining…');
                const join = await MP.joinFromUrl(window.location.href);
                content.innerHTML = `
                    <div class="row"><div class="muted">Send back to host</div>
                        <input readonly id="mp-answer-link" value="${join.answerLink}">
                        <button id="mp-copy-ans">COPY</button>
                    </div>
                    <div class="row muted">Waiting for host…</div>
                `;
                const ansInput = content.querySelector('#mp-answer-link');
                ansInput.onclick = ()=> ansInput.select();
                content.querySelector('#mp-copy-ans').onclick = ()=> copyValue(ansInput.value);
            };
        } catch(e){
            console.error('[MP UI ERROR]', e);
            alert('MULTIPLAYER FAILED 💥');
        }
    }

    window.addEventListener('load', ()=>{
        setTimeout(autoPopup, 300);
    });

    window.Multiplayer = MP;

})(window);
